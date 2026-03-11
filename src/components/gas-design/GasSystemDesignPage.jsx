import React, { useState, useCallback, useEffect, useRef } from 'react';
import {
    ReactFlow,
    Controls,
    Background,
    addEdge,
    applyNodeChanges,
    applyEdgeChanges,
    Panel,
    useReactFlow,
    useUpdateNodeInternals,
    ReactFlowProvider,
    getNodesBounds,
    getViewportForBounds
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { CylinderNode, MFCNode, MixerNode, HumidifierNode, OutputNode, YSplitterNode, CombinerNode, VOCBubblerNode, PermeationOvenNode } from './CustomNodes';
import './GasSystemDesignPage.css';
import { Network, Plus, Trash2, GitCommit, X, Play, Wand2, Download, Calculator, ListOrdered, Activity } from 'lucide-react';
import { nanoid } from 'nanoid';
import { toPng } from 'html-to-image';
import { jsPDF } from 'jspdf';
import { UnitConverterWidget } from './UnitConverterWidget';

const nodeTypes = {
    cylinder: CylinderNode,
    mfc: MFCNode,
    mixer: MixerNode,
    humidifier: HumidifierNode,
    y_splitter: YSplitterNode,
    combiner: CombinerNode,
    analysis_output: OutputNode,
    voc_bubbler: VOCBubblerNode,
    permeation_oven: PermeationOvenNode,
};

const initialNodes = [];
const initialEdges = [];

const evaluateFlow = (nodes, edges) => {
    let nodeData = {};
    nodes.forEach(n => nodeData[n.id] = { ...n.data, flowOut: null });

    let changed = true;
    let iterations = 0;
    while (changed && iterations < 100) {
        changed = false;
        iterations++;
        nodes.forEach(node => {
            const inEdges = edges.filter(e => e.target === node.id);
            const inFlows = inEdges.map(e => nodeData[e.source]?.flowOut).filter(Boolean);

            let newFlowOut = null;
            if (node.type === 'cylinder') {
                const isPercent = node.data.concUnit === '%';
                const isPpm = node.data.concUnit === 'ppm';
                let conc = node.data.concValue || 0;
                conc = isPercent ? conc / 100 : (isPpm ? conc / 1e6 : conc / 1e9);

                const carrier = node.data.carrier || 'Air';
                const gasName = node.data.gasName || '';

                let comps = {};
                if (gasName && gasName.toUpperCase() !== carrier.toUpperCase()) {
                    comps[carrier] = 1 - conc;
                    comps[gasName] = conc;
                } else {
                    comps[carrier] = 1; // Pure gas
                }
                newFlowOut = { flow: null, components: comps };
            } else if (node.type === 'mfc') {
                const input = inFlows[0];
                if (input) {
                    const max = node.data.maxFlow || 1000;
                    let target = node.data.setpoint || 0;

                    // Hardware physics rules (0-1% acts as 0, hard cap at max)
                    if (target > 0 && target < (max * 0.02)) target = 0;
                    if (target > max) target = max;

                    newFlowOut = { flow: target, components: input.components };
                }
            } else if (node.type === 'mixer' || node.type === 'combiner') {
                let totalFlow = 0;
                let absComponents = {};
                for (let inf of inFlows) {
                    if (inf.flow !== null) {
                        totalFlow += inf.flow;
                        for (let gas in inf.components) {
                            absComponents[gas] = (absComponents[gas] || 0) + (inf.components[gas] * inf.flow);
                        }
                    }
                }
                if (totalFlow > 0) {
                    let newComp = {};
                    for (let gas in absComponents) newComp[gas] = absComponents[gas] / totalFlow;
                    newFlowOut = { flow: totalFlow, components: newComp };
                } else {
                    newFlowOut = { flow: 0, components: {} };
                }
            } else if (node.type === 'humidifier') {
                const input = inFlows[0];
                if (input && input.flow > 0) {
                    const temp = node.data.temperature !== undefined ? node.data.temperature : 25;
                    // Antoine equation for water vapor pressure (mmHg)
                    const vaporPressure = Math.pow(10, 8.07131 - (1730.63 / (233.426 + temp)));
                    const satRatio = vaporPressure / 760; // Fraction of total pressure that is H2O

                    // The incoming dry gas picks up water vapor, expanding the total volume.
                    // Q_wet = Q_dry / (1 - P_water/P_total)
                    // Therefore the added water flow = Q_wet - Q_dry
                    const waterFlow = (satRatio / (1 - satRatio)) * input.flow;
                    let totalFlow = input.flow + waterFlow; // This expansion is physically correct (e.g. 116.3 sccm dry -> ~120 sccm wet at 25C)

                    let newComp = {};
                    for (let gas in input.components) {
                        newComp[gas] = (input.components[gas] * input.flow) / totalFlow;
                    }
                    newComp['H2O'] = waterFlow / totalFlow;
                    newFlowOut = { flow: totalFlow, components: newComp };
                }
            } else if (node.type === 'voc_bubbler') {
                const input = inFlows[0];
                if (input && input.flow > 0) {
                    const temp = node.data.temperature !== undefined ? node.data.temperature : 25;
                    const chemical = node.data.chemical || 'Ethanol';
                    // Default Antoine consts (A, B, C) for typical VOCs
                    let A = 8.20417, B = 1642.89, C = 230.3; // Ethanol
                    if (chemical === 'Acetone') { A = 7.02447; B = 1161.0; C = 224.0; }
                    else if (chemical === 'Toluene') { A = 6.95464; B = 1344.8; C = 219.48; }
                    else if (chemical === 'Hexane') { A = 6.87776; B = 1171.53; C = 224.366; }

                    const vaporPressure = Math.pow(10, A - (B / (C + temp))); // mmHg
                    const satRatio = Math.min(0.999, Math.max(0.0001, vaporPressure / 760));

                    const vocFlow = (satRatio / (1 - satRatio)) * input.flow;
                    let totalFlow = input.flow + vocFlow;

                    let newComp = {};
                    for (let gas in input.components) {
                        newComp[gas] = (input.components[gas] * input.flow) / totalFlow;
                    }
                    newComp[chemical] = vocFlow / totalFlow;
                    newFlowOut = { flow: totalFlow, components: newComp };
                }
            } else if (node.type === 'permeation_oven') {
                const input = inFlows[0];
                if (input && input.flow > 0) {
                    const chemical = node.data.chemical || 'H2S';
                    const emissionRate_ng_min = node.data.emissionRate || 1000; // ng/min

                    // MW approx. (user should idealistically set this, we use standard defaults for now)
                    let MW = 34.1; // H2S default
                    if (chemical === 'Ethanol') MW = 46.07;
                    else if (chemical === 'Acetone') MW = 58.08;
                    else if (chemical === 'Toluene') MW = 92.14;
                    else if (chemical === 'Hexane') MW = 86.18;

                    // Permeation calculation:
                    // PPM = (Emission Rate (ng/min) * 24.45) / (Sweep Flow (sccm) * Molecular Weight * 1000)
                    const sweepFlow = input.flow;
                    const ppm = (emissionRate_ng_min * 24.45) / (sweepFlow * MW * 1000);
                    const frac = ppm / 1e6;

                    // Treat sweep flow as effectively unchanged due to ultra-low mass addition
                    let totalFlow = input.flow;

                    let newComp = {};
                    for (let gas in input.components) {
                        newComp[gas] = input.components[gas] * (1 - frac);
                    }
                    newComp[chemical] = frac;
                    newFlowOut = { flow: totalFlow, components: newComp };
                }
            } else if (node.type === 'y_splitter') {
                const input = inFlows[0];
                if (input) {
                    newFlowOut = { flow: input.flow / 2, components: input.components };
                }
            } else if (node.type === 'analysis_output') {
                const input = inFlows[0];
                if (!input) {
                    newFlowOut = { flow: 0, components: {} };
                } else {
                    let comps = { ...input.components };
                    // Simulate Gas Phase Titration Reaction: NO + O3 -> NO2 + O2
                    if (comps['NO'] && comps['O3']) {
                        const reactedFrac = Math.min(comps['NO'], comps['O3']);
                        comps['NO'] -= reactedFrac;
                        comps['O3'] -= reactedFrac;
                        comps['NO2'] = (comps['NO2'] || 0) + reactedFrac;
                        comps['O2'] = (comps['O2'] || 0) + reactedFrac;
                        if (comps['NO'] <= 1e-12) delete comps['NO'];
                        if (comps['O3'] <= 1e-12) delete comps['O3'];
                    }
                    newFlowOut = { flow: input.flow, components: comps };
                }
            }

            if (JSON.stringify(newFlowOut) !== JSON.stringify(nodeData[node.id].flowOut)) {
                nodeData[node.id].flowOut = newFlowOut;
                changed = true;
            }
        });
    }

    return nodeData;
};

const GasSystemDesignInner = () => {
    const reactFlowWrapper = useRef(null);
    const [nodes, setNodes] = useState(initialNodes);
    const [edges, setEdges] = useState(initialEdges);
    const [isSimulating, setIsSimulating] = useState(false);
    const [isConverterOpen, setIsConverterOpen] = useState(false);
    const [editingNodeId, setEditingNodeId] = useState(null);
    const { screenToFlowPosition } = useReactFlow();
    const [sidebarWidth, setSidebarWidth] = useState(200);

    const handleMouseDown = useCallback((e) => {
        e.preventDefault();
        const startX = e.clientX;
        const startWidth = sidebarWidth;

        const onMouseMove = (moveEvent) => {
            let newWidth = startWidth + (moveEvent.clientX - startX);
            if (newWidth < 150) newWidth = 150;
            if (newWidth > 400) newWidth = 400;
            setSidebarWidth(newWidth);
        };

        const onMouseUp = () => {
            document.removeEventListener('mousemove', onMouseMove);
            document.removeEventListener('mouseup', onMouseUp);
            document.body.style.cursor = 'default';
        };

        document.addEventListener('mousemove', onMouseMove);
        document.addEventListener('mouseup', onMouseUp);
        document.body.style.cursor = 'col-resize';
    }, [sidebarWidth]);

    const onNodesChange = useCallback((changes) => {
        setNodes((nds) => applyNodeChanges(changes, nds));
    }, []);

    const onEdgesChange = useCallback((changes) => {
        setEdges((eds) => applyEdgeChanges(changes, eds));
    }, []);

    const onConnect = useCallback((connection) => {
        setEdges((eds) => addEdge({ ...connection, animated: true, style: { strokeWidth: 2 } }, eds));
    }, []);

    const updateNodeInternals = useUpdateNodeInternals();

    const handleNodeDataChange = useCallback((nodeId, field, value) => {
        setNodes((nds) =>
            nds.map((node) => {
                if (node.id === nodeId) {
                    return { ...node, data: { ...node.data, [field]: value } };
                }
                return node;
            })
        );
        if (field === 'ports') {
            updateNodeInternals(nodeId);
        }
    }, [updateNodeInternals]);

    useEffect(() => {
        if (!isSimulating) {
            // clear flow out when simulation is off
            const nextNodes = nodes.map(n => {
                if (n.data.flowOut !== null) {
                    return { ...n, data: { ...n.data, flowOut: null } };
                }
                return n;
            });
            if (nodes.some(n => n.data.flowOut !== null)) {
                setNodes(nextNodes);
            }
            return;
        }

        const newNodeDataMap = evaluateFlow(nodes, edges);
        let shouldUpdate = false;
        const nextNodes = nodes.map(n => {
            const evaluatedFlow = newNodeDataMap[n.id].flowOut;
            if (JSON.stringify(n.data.flowOut) !== JSON.stringify(evaluatedFlow)) {
                shouldUpdate = true;
                return { ...n, data: { ...n.data, flowOut: evaluatedFlow } };
            }
            return n;
        });
        if (shouldUpdate) {
            setNodes(nextNodes);
        }
    }, [nodes, edges, isSimulating]);

    const [isAutoDesignOpen, setIsAutoDesignOpen] = useState(false);
    const [isProtocolOpen, setIsProtocolOpen] = useState(false);
    const [protocolSteps, setProtocolSteps] = useState([{ duration: 60, targetConc: 10 }]);
    const [autoParams, setAutoParams] = useState({
        totalFlow: 1000,
        gasName: 'NH3',
        targetConc: 10,
        targetConcUnit: 'ppm',
        sourceConc: 1000,
        sourceConcUnit: 'ppm',
        targetRh: 50,
        sharedCarrier: true,
        useVocBubbler: false,
        usePermeationOven: false
    });

    const handleAutoGenerate = () => {
        const totalFlow = parseFloat(autoParams.totalFlow) || 0;
        const targetRh = parseFloat(autoParams.targetRh) || 0;
        const targetConc = parseFloat(autoParams.targetConc) || 0;
        const sourceConc = parseFloat(autoParams.sourceConc) || 0;
        const { gasName, targetConcUnit, sourceConcUnit } = autoParams;

        // Math derived from physical dilution equations
        const temp = 25;
        const vaporPressure = Math.pow(10, 8.07131 - (1730.63 / (233.426 + temp)));
        const satPartial = Math.max(0.0001, vaporPressure / 760);

        const fracH2O = (Math.min(targetRh, 99) / 100) * satPartial;
        const qWater = totalFlow * fracH2O;
        const qWetCarrier = (qWater * (1 - satPartial)) / satPartial;

        const conv = (v, u) => u === '%' ? (v / 100) : (u === 'ppm' ? (v / 1e6) : (v / 1e9));
        const targetFrac = conv(targetConc, targetConcUnit);
        const sourceFrac = conv(sourceConc, sourceConcUnit);

        let qGas = 0;
        let qBubblerCarrier = 0;
        let qPermeationSweep = 0;

        if (autoParams.useVocBubbler) {
            // Source is pure liquid bubbler (Antoine)
            const chemical = gasName || 'Ethanol';
            let A = 8.20417, B = 1642.89, C = 230.3; // Ethanol default
            if (chemical === 'Acetone') { A = 7.02447; B = 1161.0; C = 224.0; }
            else if (chemical === 'Toluene') { A = 6.95464; B = 1344.8; C = 219.48; }
            else if (chemical === 'Hexane') { A = 6.87776; B = 1171.53; C = 224.366; }

            const vp = Math.pow(10, A - (B / (C + temp))); // mmHg
            const satRatio = Math.min(0.999, Math.max(0.0001, vp / 760));

            // total target gas flow needed
            const qTargetGas = totalFlow * targetFrac;
            // how much dry carrier is needed to pull that much vapor
            qBubblerCarrier = qTargetGas * ((1 - satRatio) / satRatio);
            qGas = qBubblerCarrier + qTargetGas;
        } else if (autoParams.usePermeationOven) {
            // High sweep flow to capture trace emission rate. 
            // We'll arbitrarily set a fixed sweep flow (e.g. 50 sccm) to drive it, 
            // but the math assumes negligible mass added so sweep ~ equals output flow of the node.
            qPermeationSweep = 50;
            qGas = qPermeationSweep;
        } else {
            if (sourceFrac > 0) qGas = (totalFlow * targetFrac) / sourceFrac;
        }

        let qDryCarrier = totalFlow - qGas - qWater - qWetCarrier;
        if (qDryCarrier < 0) qDryCarrier = 0;

        const startX = 0;
        const startY = 100;

        const useHumidity = targetRh > 0;
        const useSharedCarrier = autoParams.sharedCarrier && useHumidity;

        const newNodes = [];

        // Estimate sensible MFC Max sizes based on desired flows (1, 5, 10, 50, 100, 500, etc)
        const getMfcSize = (req) => {
            const sizes = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 5000, 10000];
            return sizes.find(s => req <= s) || 10000;
        };

        // Target Gas Path
        if (autoParams.useVocBubbler) {
            const size = getMfcSize(qBubblerCarrier);
            newNodes.push(
                { id: 'ad_gas_cyl', type: 'cylinder', position: { x: startX, y: startY }, data: { gasName: 'Air', carrier: 'Air', concValue: 100, concUnit: '%', flowOut: null, onChange: handleNodeDataChange } },
                { id: 'ad_gas_mfc', type: 'mfc', position: { x: startX + 200, y: startY }, data: { setpoint: parseFloat(qBubblerCarrier.toFixed(2)), maxFlow: size, flowOut: null, onChange: handleNodeDataChange } },
                { id: 'ad_gas_bubbler', type: 'voc_bubbler', position: { x: startX + 450, y: startY }, data: { chemical: autoParams.gasName || 'Ethanol', temperature: 25, flowOut: null, onChange: handleNodeDataChange } }
            );
        } else if (autoParams.usePermeationOven) {
            const size = getMfcSize(qPermeationSweep);
            const chemical = autoParams.gasName || 'H2S';
            let MW = 34.1; // H2S default
            if (chemical === 'Ethanol') MW = 46.07;
            else if (chemical === 'Acetone') MW = 58.08;
            else if (chemical === 'Toluene') MW = 92.14;

            // Calc reverse emission rate needed to hit the target targetFrac
            // frac = Emission(ng/min) * 24.45 / (Sweep(sccm) * MW * 1000)
            // Emission = frac * Sweep * MW * 1000 / 24.45
            // But actually we have a total dilution downstream! 
            // We need targetFrac out of the FINAL totalFlow, which equals frac needed out of sweepFlow diluted
            // Final moles target = totalFlow * targetFrac. 
            // So we just use totalFlow in the reverse calculation!
            const requiredEmission = (totalFlow * targetFrac * MW * 1000) / 24.45;

            newNodes.push(
                { id: 'ad_gas_cyl', type: 'cylinder', position: { x: startX, y: startY }, data: { gasName: 'Air', carrier: 'Air', concValue: 100, concUnit: '%', flowOut: null, onChange: handleNodeDataChange } },
                { id: 'ad_gas_mfc', type: 'mfc', position: { x: startX + 200, y: startY }, data: { setpoint: parseFloat(qPermeationSweep.toFixed(2)), maxFlow: size, flowOut: null, onChange: handleNodeDataChange } },
                { id: 'ad_gas_oven', type: 'permeation_oven', position: { x: startX + 450, y: startY }, data: { chemical: chemical, emissionRate: parseFloat(requiredEmission.toFixed(2)), flowOut: null, onChange: handleNodeDataChange } }
            );
        } else {
            const size = getMfcSize(qGas);
            newNodes.push(
                { id: 'ad_gas_cyl', type: 'cylinder', position: { x: startX, y: startY }, data: { gasName, carrier: 'N2', concValue: sourceConc, concUnit: sourceConcUnit, flowOut: null, onChange: handleNodeDataChange } },
                { id: 'ad_gas_mfc', type: 'mfc', position: { x: startX + 250, y: startY }, data: { setpoint: parseFloat(qGas.toFixed(2)), maxFlow: size, flowOut: null, onChange: handleNodeDataChange } }
            );
        }

        if (!useSharedCarrier) {
            newNodes.push(
                // Dry Carrier Path
                { id: 'ad_dry_cyl', type: 'cylinder', position: { x: startX, y: startY + 150 }, data: { gasName: 'Air', carrier: 'Air', concValue: 100, concUnit: '%', flowOut: null, onChange: handleNodeDataChange } },
                { id: 'ad_dry_mfc', type: 'mfc', position: { x: startX + 250, y: startY + 150 }, data: { setpoint: parseFloat(qDryCarrier.toFixed(2)), maxFlow: getMfcSize(qDryCarrier), flowOut: null, onChange: handleNodeDataChange } }
            );

            if (useHumidity) {
                newNodes.push(
                    // Wet Carrier Path
                    { id: 'ad_wet_cyl', type: 'cylinder', position: { x: startX, y: startY + 300 }, data: { gasName: 'Air', carrier: 'Air', concValue: 100, concUnit: '%', flowOut: null, onChange: handleNodeDataChange } },
                    { id: 'ad_wet_mfc', type: 'mfc', position: { x: startX + 250, y: startY + 300 }, data: { setpoint: parseFloat(qWetCarrier.toFixed(2)), maxFlow: getMfcSize(qWetCarrier), flowOut: null, onChange: handleNodeDataChange } },
                    { id: 'ad_humidifier', type: 'humidifier', position: { x: startX + 500, y: startY + 300 }, data: { temperature: 25, flowOut: null, onChange: handleNodeDataChange } }
                );
            }
        } else {
            // Shared Carrier Path using Y-Splitter
            newNodes.push(
                { id: 'ad_carrier_cyl', type: 'cylinder', position: { x: startX, y: startY + 225 }, data: { gasName: 'Air', carrier: 'Air', concValue: 100, concUnit: '%', flowOut: null, onChange: handleNodeDataChange } },
                { id: 'ad_carrier_split', type: 'y_splitter', position: { x: startX + 150, y: startY + 225 }, data: { flowOut: null, onChange: handleNodeDataChange } },
                { id: 'ad_dry_mfc', type: 'mfc', position: { x: startX + 300, y: startY + 150 }, data: { setpoint: parseFloat(qDryCarrier.toFixed(2)), maxFlow: getMfcSize(qDryCarrier), flowOut: null, onChange: handleNodeDataChange } },
                { id: 'ad_wet_mfc', type: 'mfc', position: { x: startX + 300, y: startY + 300 }, data: { setpoint: parseFloat(qWetCarrier.toFixed(2)), maxFlow: getMfcSize(qWetCarrier), flowOut: null, onChange: handleNodeDataChange } },
                { id: 'ad_humidifier', type: 'humidifier', position: { x: startX + 500, y: startY + 300 }, data: { temperature: 25, flowOut: null, onChange: handleNodeDataChange } }
            );
        }

        newNodes.push(
            // Combiner & Output
            { id: 'ad_combiner', type: 'combiner', position: { x: startX + 750, y: startY + 150 }, data: { ports: useHumidity ? 3 : 2, flowOut: null, onChange: handleNodeDataChange } },
            { id: 'ad_output', type: 'analysis_output', position: { x: startX + 1000, y: startY + 150 }, data: { flowOut: null, targetConcUnit, onChange: handleNodeDataChange } }
        );

        const newEdges = [
            { id: 'e_ad_1', source: 'ad_gas_cyl', target: 'ad_gas_mfc', animated: true, style: { strokeWidth: 2 } }
        ];

        if (autoParams.useVocBubbler) {
            newEdges.push(
                { id: 'e_ad_bubbler_1', source: 'ad_gas_mfc', target: 'ad_gas_bubbler', animated: true, style: { strokeWidth: 2 } },
                { id: 'e_ad_5', source: 'ad_gas_bubbler', target: 'ad_combiner', targetHandle: 'in-0', animated: true, style: { strokeWidth: 2 } }
            );
        } else if (autoParams.usePermeationOven) {
            newEdges.push(
                { id: 'e_ad_oven_1', source: 'ad_gas_mfc', target: 'ad_gas_oven', animated: true, style: { strokeWidth: 2 } },
                { id: 'e_ad_5', source: 'ad_gas_oven', target: 'ad_combiner', targetHandle: 'in-0', animated: true, style: { strokeWidth: 2 } }
            );
        } else {
            newEdges.push(
                { id: 'e_ad_5', source: 'ad_gas_mfc', target: 'ad_combiner', targetHandle: 'in-0', animated: true, style: { strokeWidth: 2 } }
            );
        }

        newEdges.push(
            { id: 'e_ad_6', source: 'ad_dry_mfc', target: 'ad_combiner', targetHandle: 'in-1', animated: true, style: { strokeWidth: 2 } },
            { id: 'e_ad_8', source: 'ad_combiner', target: 'ad_output', animated: true, style: { strokeWidth: 2 } }
        );

        if (!useSharedCarrier) {
            newEdges.push(
                { id: 'e_ad_2', source: 'ad_dry_cyl', target: 'ad_dry_mfc', animated: true, style: { strokeWidth: 2 } }
            );
            if (useHumidity) {
                newEdges.push(
                    { id: 'e_ad_3', source: 'ad_wet_cyl', target: 'ad_wet_mfc', animated: true, style: { strokeWidth: 2 } },
                    { id: 'e_ad_4', source: 'ad_wet_mfc', target: 'ad_humidifier', animated: true, style: { strokeWidth: 2 } },
                    { id: 'e_ad_7', source: 'ad_humidifier', target: 'ad_combiner', targetHandle: 'in-2', animated: true, style: { strokeWidth: 2 } }
                );
            }
        } else {
            // Edges for shared carrier path
            newEdges.push(
                { id: 'e_ad_shared_1', source: 'ad_carrier_cyl', target: 'ad_carrier_split', animated: true, style: { strokeWidth: 2 } },
                { id: 'e_ad_shared_top', source: 'ad_carrier_split', target: 'ad_dry_mfc', sourceHandle: 'out1', animated: true, style: { strokeWidth: 2 } },
                { id: 'e_ad_shared_bot', source: 'ad_carrier_split', target: 'ad_wet_mfc', sourceHandle: 'out2', animated: true, style: { strokeWidth: 2 } },
                { id: 'e_ad_4', source: 'ad_wet_mfc', target: 'ad_humidifier', animated: true, style: { strokeWidth: 2 } },
                { id: 'e_ad_7', source: 'ad_humidifier', target: 'ad_combiner', targetHandle: 'in-2', animated: true, style: { strokeWidth: 2 } }
            );
        }

        setNodes(newNodes);
        setEdges(newEdges);
        setIsAutoDesignOpen(false);
        setIsSimulating(true);

        setTimeout(() => updateNodeInternals('ad_combiner'), 50);
    };

    const onNodeDoubleClick = useCallback((event, node) => {
        if (node.type === 'analysis_output') {
            setIsAutoDesignOpen(true);
        } else if (node.type !== 'mixer' && node.type !== 'y_splitter') {
            setEditingNodeId(node.id);
        }
    }, []);

    const onDragOver = useCallback((event) => {
        event.preventDefault();
        event.dataTransfer.dropEffect = 'move';
    }, []);

    const onDrop = useCallback(
        (event) => {
            event.preventDefault();
            const type = event.dataTransfer.getData('application/reactflow');
            if (typeof type === 'undefined' || !type) return;

            const position = screenToFlowPosition({
                x: event.clientX,
                y: event.clientY,
            });

            const newNode = {
                id: nanoid(6),
                type,
                position,
                data: { onChange: handleNodeDataChange, flowOut: null },
            };

            setNodes((nds) => nds.concat(newNode));
        },
        [screenToFlowPosition, handleNodeDataChange]
    );

    const onDragStart = (event, nodeType) => {
        event.dataTransfer.setData('application/reactflow', nodeType);
        event.dataTransfer.effectAllowed = 'move';
    };

    const onEdgeDoubleClick = useCallback((event, edge) => {
        setEditingNodeId(edge.id); // Re-use the modal setup for edges
    }, []);

    const handleEdgeDataChange = useCallback((edgeId, field, value) => {
        setEdges((eds) =>
            eds.map((edge) => {
                if (edge.id === edgeId) {
                    return { ...edge, data: { ...edge.data, [field]: value } };
                }
                return edge;
            })
        );
    }, []);

    const clearGraph = () => {
        if (window.confirm('Are you sure you want to clear the canvas?')) {
            setNodes([]);
            setEdges([]);
        }
    };

    const handleDownloadPdf = async () => {
        if (!reactFlowWrapper.current) return;

        // Hide UI elements we don't want in the PDF
        const controls = reactFlowWrapper.current.querySelector('.react-flow__controls');
        const minimap = reactFlowWrapper.current.querySelector('.react-flow__minimap');
        if (controls) controls.style.display = 'none';
        if (minimap) minimap.style.display = 'none';

        try {
            // Get the bounding box of the graph to know dimensions to slice out, or just export the whole wrapper canvas
            // ReactFlow provides `getViewportForBounds` or we can just grab everything visible as an image.

            // Wait for any animations to finish
            await new Promise(r => setTimeout(r, 200));

            const targetElement = reactFlowWrapper.current;

            // filter out the UI tools to make it look clean
            const filter = (node) => {
                if (node.classList) {
                    return !node.classList.contains('react-flow__panel') &&
                        !node.classList.contains('react-flow__controls') &&
                        !node.classList.contains('react-flow__minimap');
                }
                return true;
            };

            const imgData = await toPng(targetElement, {
                backgroundColor: '#0f172a',
                pixelRatio: 2,
                filter: filter
            });

            // Calculate a good fit for A4 page (landscape)
            const pdf = new jsPDF({
                orientation: 'landscape',
                unit: 'mm',
                format: 'a4'
            });

            const pdfWidth = pdf.internal.pageSize.getWidth();
            const pdfHeight = pdf.internal.pageSize.getHeight();

            const imgRatio = targetElement.offsetWidth / targetElement.offsetHeight;
            const pdfRatio = pdfWidth / pdfHeight;

            let finalWidth = pdfWidth;
            let finalHeight = pdfHeight;
            let finalX = 0;
            let finalY = 0;

            if (imgRatio > pdfRatio) {
                // Image is wider than page ratio
                finalHeight = pdfWidth / imgRatio;
                finalY = (pdfHeight - finalHeight) / 2;
            } else {
                // Image is taller than page ratio
                finalWidth = pdfHeight * imgRatio;
                finalX = (pdfWidth - finalWidth) / 2;
            }

            // Title and Date
            pdf.setFontSize(14);
            pdf.setTextColor(200, 200, 200);
            pdf.text('Gas Dilution System Schematic', 10, 10);
            pdf.setFontSize(10);
            pdf.text(`Generated: ${new Date().toLocaleString()}`, 10, 16);

            pdf.addImage(imgData, 'PNG', finalX, finalY, finalWidth, finalHeight);
            pdf.save(`gas_system_schematic_${new Date().toISOString().split('T')[0]}.pdf`);
        } catch (error) {
            console.error('Failed to generate PDF:', error);

            // Ensure UI elements are restored on error
            if (controls) controls.style.display = '';
            if (minimap) minimap.style.display = '';

            alert('Failed to generate PDF. Please check the console for errors.');
        }
    };

    const editingNode = nodes.find(n => n.id === editingNodeId);
    const editingEdge = edges.find(e => e.id === editingNodeId);
    const editingItem = editingNode || editingEdge;
    const isEditingEdge = !!editingEdge;

    return (
        <div className="gas-design-container">
            <div className="design-header">
                <div style={{ display: 'flex', alignItems: 'center', gap: '12px', justifyContent: 'space-between' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                        <div className="icon-wrapper" style={{ background: 'rgba(168, 85, 247, 0.15)', borderColor: 'rgba(168, 85, 247, 0.3)', padding: 6, borderRadius: 12, border: '1px solid' }}>
                            <Network size={20} color="#a855f7" />
                        </div>
                        <h1 className="page-title" style={{ fontSize: '1.2rem', fontWeight: 600, margin: 0 }}>Design of Gas Dilution System</h1>
                    </div>
                </div>
                <p className="subtitle" style={{ fontSize: '0.85rem', color: 'var(--text-muted)', marginTop: 8, marginBottom: 0 }}>
                    Drag and drop components to build and simulate your gas flow schematic.
                </p>
            </div>

            <div className="design-content">
                <div className="toolbox-panel" style={{ width: sidebarWidth, position: 'relative' }}>
                    {/* Drag Handle */}
                    <div
                        onMouseDown={handleMouseDown}
                        style={{
                            position: 'absolute',
                            top: 0,
                            right: -5,
                            width: '10px',
                            height: '100%',
                            cursor: 'col-resize',
                            zIndex: 10,
                        }}
                    />
                    <h3 className="toolbox-title">Toolbox</h3>
                    <p style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginTop: 0, marginBottom: 12 }}>Drag these into the grid.</p>

                    <div className="tool-item" draggable onDragStart={(e) => onDragStart(e, 'cylinder')} style={{ '--tool-color': '#3b82f6', display: 'flex', alignItems: 'center', gap: '8px', padding: '8px' }}>
                        <img src={`${import.meta.env.BASE_URL}gas_icons/cylinder.svg?v=2`} alt="" style={{ width: 24, height: 24, borderRadius: 4, objectFit: 'cover' }} /> <span>Gas Cylinder</span>
                    </div>
                    <div className="tool-item" draggable onDragStart={(e) => onDragStart(e, 'mfc')} style={{ '--tool-color': '#10b981', display: 'flex', alignItems: 'center', gap: '8px', padding: '8px' }}>
                        <img src={`${import.meta.env.BASE_URL}gas_icons/mfc.svg?v=2`} alt="" style={{ width: 24, height: 24, borderRadius: 4, objectFit: 'cover' }} /> <span>Mass Flow Controller</span>
                    </div>
                    <div className="tool-item" draggable onDragStart={(e) => onDragStart(e, 'mixer')} style={{ '--tool-color': '#f59e0b', display: 'flex', alignItems: 'center', gap: '8px', padding: '8px' }}>
                        <img src={`${import.meta.env.BASE_URL}gas_icons/mixer.svg?v=2`} alt="" style={{ width: 24, height: 24, borderRadius: 4, objectFit: 'cover' }} /> <span>Gas Mixer Node</span>
                    </div>
                    <div className="tool-item" draggable onDragStart={(e) => onDragStart(e, 'y_splitter')} style={{ '--tool-color': '#a855f7', display: 'flex', alignItems: 'center', gap: '8px', padding: '8px' }}>
                        <img src={`${import.meta.env.BASE_URL}gas_icons/y_splitter.svg?v=2`} alt="" style={{ width: 24, height: 24, borderRadius: 4, objectFit: 'cover' }} /> <span>Y-Splitter</span>
                    </div>
                    <div className="tool-item" draggable onDragStart={(e) => onDragStart(e, 'combiner')} style={{ '--tool-color': '#f59e0b', display: 'flex', alignItems: 'center', gap: '8px', padding: '8px' }}>
                        <img src={`${import.meta.env.BASE_URL}gas_icons/combiner.svg?v=2`} alt="" style={{ width: 24, height: 24, borderRadius: 4, objectFit: 'cover' }} /> <span>Combiner Hub</span>
                    </div>
                    <div className="tool-item" draggable onDragStart={(e) => onDragStart(e, 'humidifier')} style={{ '--tool-color': '#0ea5e9', display: 'flex', alignItems: 'center', gap: '8px', padding: '8px' }}>
                        <img src={`${import.meta.env.BASE_URL}gas_icons/humidifier.svg?v=2`} alt="" style={{ width: 24, height: 24, borderRadius: 4, objectFit: 'cover' }} /> <span>Wet Humidifier</span>
                    </div>
                    <div className="tool-item" draggable onDragStart={(e) => onDragStart(e, 'voc_bubbler')} style={{ '--tool-color': '#f43f5e', display: 'flex', alignItems: 'center', gap: '8px', padding: '8px' }}>
                        <img src={`${import.meta.env.BASE_URL}gas_icons/humidifier.svg?v=2`} alt="" style={{ width: 24, height: 24, borderRadius: 4, objectFit: 'cover', filter: 'hue-rotate(150deg)' }} /> <span>VOC Bubbler</span>
                    </div>
                    <div className="tool-item" draggable onDragStart={(e) => onDragStart(e, 'permeation_oven')} style={{ '--tool-color': '#d946ef', display: 'flex', alignItems: 'center', gap: '8px', padding: '8px' }}>
                        <img src={`${import.meta.env.BASE_URL}gas_icons/combiner.svg?v=2`} alt="" style={{ width: 24, height: 24, borderRadius: 4, objectFit: 'cover', filter: 'hue-rotate(300deg)' }} /> <span>Permeation Oven</span>
                    </div>
                    <div className="tool-item" draggable onDragStart={(e) => onDragStart(e, 'analysis_output')} style={{ '--tool-color': '#ec4899', display: 'flex', alignItems: 'center', gap: '8px', padding: '8px' }}>
                        <img src={`${import.meta.env.BASE_URL}gas_icons/output.svg?v=4`} alt="" style={{ width: 24, height: 24, borderRadius: 4, objectFit: 'cover' }} /> <span>Output</span>
                    </div>

                    <div style={{ marginTop: 'auto', display: 'flex', flexDirection: 'column', gap: 8 }}>
                        <button
                            className="icon-btn"
                            onClick={() => setIsSimulating(!isSimulating)}
                            style={{
                                background: isSimulating ? 'rgba(16,185,129,0.2)' : 'rgba(15,23,42,0.8)',
                                color: isSimulating ? '#10b981' : '#f8fafc',
                                border: '1px solid',
                                borderColor: isSimulating ? '#10b981' : 'rgba(255,255,255,0.1)'
                            }}
                        >
                            <Play size={14} fill={isSimulating ? "currentColor" : "none"} />
                            {isSimulating ? "Stop Simulating" : "Simulate Flow"}
                        </button>
                        <button
                            className="icon-btn small"
                            onClick={clearGraph}
                            style={{ background: 'rgba(239, 68, 68, 0.1)', color: '#ef4444', borderColor: 'rgba(239, 68, 68, 0.2)' }}
                        >
                            <Trash2 size={14} /> Clear System
                        </button>
                        <button
                            className="icon-btn small"
                            onClick={() => setIsAutoDesignOpen(true)}
                            style={{ background: 'rgba(56, 189, 248, 0.1)', color: '#38bdf8', borderColor: 'rgba(56, 189, 248, 0.2)' }}
                        >
                            <Wand2 size={14} /> Auto Generate
                        </button>
                        <button
                            className="icon-btn small"
                            onClick={() => setIsProtocolOpen(true)}
                            style={{ background: 'rgba(234, 179, 8, 0.1)', color: '#eab308', borderColor: 'rgba(234, 179, 8, 0.2)', marginTop: 8 }}
                        >
                            <ListOrdered size={14} /> Step Protocol
                        </button>
                        <button
                            className="icon-btn small"
                            onClick={handleDownloadPdf}
                            style={{ background: 'rgba(236, 72, 153, 0.1)', color: '#ec4899', borderColor: 'rgba(236, 72, 153, 0.2)', marginTop: 8 }}
                        >
                            <Download size={14} /> Download PDF
                        </button>
                        <button
                            className="icon-btn small"
                            onClick={() => setIsConverterOpen(!isConverterOpen)}
                            style={{ background: 'rgba(168, 85, 247, 0.1)', color: '#a855f7', borderColor: 'rgba(168, 85, 247, 0.2)', marginTop: 8 }}
                        >
                            <Calculator size={14} /> Unit Converter
                        </button>
                    </div>
                </div>

                <div className="flow-area" ref={reactFlowWrapper}>
                    <ReactFlow
                        nodes={nodes}
                        edges={edges.map(e => {
                            let label;
                            if (isSimulating) {
                                let flowV = 0;
                                const sourceNode = nodes.find(n => n.id === e.source);
                                if (sourceNode && sourceNode.data?.flowOut?.flow > 0) {
                                    flowV = sourceNode.data.flowOut.flow;
                                } else {
                                    const targetNode = nodes.find(n => n.id === e.target);
                                    if (targetNode && targetNode.type === 'mfc') {
                                        flowV = targetNode.data.setpoint || 0;
                                    }
                                }

                                let labelParts = [];
                                if (flowV > 0) {
                                    labelParts.push(`${parseFloat(flowV).toFixed(1)} sccm`);

                                    // Dead volume / lag time calculation
                                    if (e.data && e.data.length && e.data.diameter) {
                                        // Length is in cm. Diameter is in inches. 
                                        const radiusCm = (parseFloat(e.data.diameter) * 2.54) / 2;
                                        const lengthCm = parseFloat(e.data.length);
                                        // Volume in cm^3 = mL
                                        const volume_mL = Math.PI * Math.pow(radiusCm, 2) * lengthCm;
                                        // sccm = standard cubic centimeters per minute = mL/min
                                        // flow in mL/s = flowV / 60
                                        const lag_seconds = volume_mL / (flowV / 60);
                                        labelParts.push(`Lag: ${lag_seconds.toFixed(1)} s`);
                                    }
                                }
                                if (labelParts.length > 0) {
                                    label = labelParts.join('\n');
                                }
                            }
                            return {
                                ...e,
                                animated: isSimulating ? e.animated : false,
                                label,
                                labelStyle: { fill: '#38bdf8', fontWeight: 600, fontSize: 11, fontFamily: 'Inter, sans-serif' },
                                labelBgStyle: { fill: 'rgba(15, 23, 42, 0.95)', stroke: 'rgba(56, 189, 248, 0.4)', strokeWidth: 1, fillOpacity: 1 },
                                labelBgPadding: [6, 4],
                                labelBgBorderRadius: 4
                            };
                        })}
                        onNodesChange={onNodesChange}
                        onEdgesChange={onEdgesChange}
                        onConnect={onConnect}
                        onDrop={onDrop}
                        onDragOver={onDragOver}
                        onNodeDoubleClick={onNodeDoubleClick}
                        onEdgeDoubleClick={onEdgeDoubleClick}
                        nodeTypes={nodeTypes}
                        fitView
                    >
                        <Background color="#334155" gap={20} size={1} />
                    </ReactFlow>
                </div>
            </div>

            {isConverterOpen && (
                <UnitConverterWidget onClose={() => setIsConverterOpen(false)} />
            )}

            {editingItem && (
                <div className="modal-overlay" onClick={() => setEditingNodeId(null)}>
                    <div className="modal-content" style={{ maxWidth: 300, background: 'rgba(15, 23, 42, 0.95)' }} onClick={e => e.stopPropagation()}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: '1px solid rgba(255,255,255,0.1)', paddingBottom: '12px', marginBottom: '16px' }}>
                            <h3 style={{ margin: 0, fontSize: '1.1rem', color: '#f8fafc' }}>
                                {isEditingEdge ? 'Edit Tubing Data' : `Edit ${editingItem.type} Data`}
                            </h3>
                            <button onClick={() => setEditingNodeId(null)} style={{ background: 'transparent', border: 'none', color: '#94a3b8', cursor: 'pointer' }}><X size={18} /></button>
                        </div>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
                            {isEditingEdge ? (
                                <>
                                    <div className="input-row">
                                        <label>Tubing Length (cm)</label>
                                        <input type="number" value={editingEdge.data?.length || ''} onChange={e => handleEdgeDataChange(editingEdge.id, 'length', parseFloat(e.target.value) || 0)} placeholder="e.g. 100" />
                                    </div>
                                    <div className="input-row">
                                        <label>Inner Diameter (inches)</label>
                                        <select value={editingEdge.data?.diameter || '0.125'} onChange={e => handleEdgeDataChange(editingEdge.id, 'diameter', e.target.value)}>
                                            <option value="0.0625">1/16" (1.59 mm)</option>
                                            <option value="0.125">1/8" (3.18 mm)</option>
                                            <option value="0.25">1/4" (6.35 mm)</option>
                                        </select>
                                    </div>
                                    <div style={{ fontSize: '0.75rem', color: '#10b981', background: 'rgba(16, 185, 129, 0.1)', padding: 8, borderRadius: 4, marginTop: 4 }}>
                                        Setting dimensions allows the simulator to calculate physical Dead Volume and gas propagation Lag Time.
                                    </div>
                                </>
                            ) : (
                                <>
                                    {editingItem.type === 'cylinder' && (
                                        <>
                                            <div className="input-row">
                                                <label>Gas Name</label>
                                                <input type="text" value={editingItem.data.gasName || ''} onChange={e => handleNodeDataChange(editingItem.id, 'gasName', e.target.value)} placeholder="e.g. NH3" />
                                            </div>
                                            <div className="input-row">
                                                <label>Carrier Gas</label>
                                                <input type="text" value={editingItem.data.carrier || ''} onChange={e => handleNodeDataChange(editingItem.id, 'carrier', e.target.value)} placeholder="e.g. Air" />
                                            </div>
                                            <div className="input-row">
                                                <label>Concentration</label>
                                                <div style={{ display: 'flex', gap: '4px' }}>
                                                    <input type="number" style={{ width: '60px' }} value={editingItem.data.concValue === 0 ? '' : editingItem.data.concValue} onChange={e => handleNodeDataChange(editingItem.id, 'concValue', parseFloat(e.target.value) || 0)} />
                                                    <select style={{ flex: 1 }} value={editingItem.data.concUnit || 'ppm'} onChange={e => handleNodeDataChange(editingItem.id, 'concUnit', e.target.value)}>
                                                        <option value="ppm">ppm</option>
                                                        <option value="ppb">ppb</option>
                                                        <option value="%">%</option>
                                                    </select>
                                                </div>
                                            </div>
                                            <div style={{ paddingBottom: 8, borderBottom: '1px solid rgba(255,255,255,0.05)', marginBottom: 8 }} />
                                            <div className="input-row">
                                                <label>Gas Cylinder Volume (Liters)</label>
                                                <input type="number" value={editingItem.data.cylinderVolume || 10} onChange={e => handleNodeDataChange(editingItem.id, 'cylinderVolume', parseFloat(e.target.value) || 0)} placeholder="e.g. 50" />
                                            </div>
                                            <div className="input-row">
                                                <label>Fill Pressure (psi)</label>
                                                <input type="number" value={editingItem.data.cylinderPressure || 2000} onChange={e => handleNodeDataChange(editingItem.id, 'cylinderPressure', parseFloat(e.target.value) || 0)} placeholder="e.g. 2000" />
                                            </div>
                                            <div className="input-row">
                                                <label>Estimated Cost ($)</label>
                                                <input type="number" value={editingItem.data.cylinderPrice || 0} onChange={e => handleNodeDataChange(editingItem.id, 'cylinderPrice', parseFloat(e.target.value) || 0)} placeholder="e.g. 500" />
                                            </div>
                                            {editingItem.data.flowOut && editingItem.data.flowOut.flow > 0 && (
                                                <div style={{ marginTop: 8, padding: 8, background: 'rgba(56, 189, 248, 0.1)', borderRadius: 4, fontSize: '0.8rem', color: '#38bdf8' }}>
                                                    {(() => {
                                                        const volLiters = editingItem.data.cylinderVolume || 10;
                                                        const pPsi = editingItem.data.cylinderPressure || 2000;
                                                        const cost = editingItem.data.cylinderPrice || 0;
                                                        const flowSccm = editingItem.data.flowOut.flow;

                                                        // 1 atm = 14.7 psi. Standard volume = V * (P / 14.7) 
                                                        const stdLiters = volLiters * (pPsi / 14.7);
                                                        const stdScc = stdLiters * 1000;

                                                        const minutes = stdScc / flowSccm;
                                                        const hours = minutes / 60;
                                                        const days = hours / 24;

                                                        let lifeStr = days > 1 ? `${days.toFixed(1)} days` : `${hours.toFixed(1)} hours`;
                                                        let costStr = cost > 0 ? `$${(cost / hours).toFixed(2)}/hr` : '';

                                                        return (
                                                            <>
                                                                <div><strong>Continuous Lifespan:</strong> {lifeStr}</div>
                                                                {costStr && <div><strong>Operation Cost:</strong> {costStr}</div>}
                                                            </>
                                                        );
                                                    })()}
                                                </div>
                                            )}
                                        </>
                                    )}
                                    {editingItem.type === 'mfc' && (
                                        <>
                                            <div className="input-row">
                                                <label>Set Flow Rate (sccm)</label>
                                                <input
                                                    type="number"
                                                    value={editingItem.data.setpoint !== undefined ? editingItem.data.setpoint : 0}
                                                    onChange={e => handleNodeDataChange(editingItem.id, 'setpoint', parseFloat(e.target.value) || 0)}
                                                />
                                            </div>
                                            <div className="input-row">
                                                <label>Max Flow Capacity (sccm)</label>
                                                <input
                                                    type="number"
                                                    value={editingItem.data.maxFlow !== undefined ? editingItem.data.maxFlow : 1000}
                                                    onChange={e => handleNodeDataChange(editingItem.id, 'maxFlow', parseFloat(e.target.value) || 0)}
                                                />
                                            </div>
                                            <div style={{ fontSize: '0.7rem', color: '#f59e0b', marginTop: 4 }}>
                                                Note: Useful range is typically 2% to 100% of Max Flow.
                                            </div>
                                        </>
                                    )}
                                    {editingItem.type === 'humidifier' && (
                                        <div className="input-row">
                                            <label>Water Temperature (°C)</label>
                                            <input type="number" value={editingItem.data.temperature !== undefined ? editingItem.data.temperature : 25} onChange={e => handleNodeDataChange(editingItem.id, 'temperature', parseFloat(e.target.value) || 0)} />
                                        </div>
                                    )}
                                    {editingItem.type === 'voc_bubbler' && (
                                        <>
                                            <div className="input-row">
                                                <label>Chemical</label>
                                                <select value={editingItem.data.chemical || 'Ethanol'} onChange={e => handleNodeDataChange(editingItem.id, 'chemical', e.target.value)}>
                                                    <option value="Ethanol">Ethanol</option>
                                                    <option value="Acetone">Acetone</option>
                                                    <option value="Toluene">Toluene</option>
                                                    <option value="Hexane">Hexane</option>
                                                </select>
                                            </div>
                                            <div className="input-row">
                                                <label>Liquid Temperature (°C)</label>
                                                <input type="number" value={editingItem.data.temperature !== undefined ? editingItem.data.temperature : 25} onChange={e => handleNodeDataChange(editingItem.id, 'temperature', parseFloat(e.target.value) || 25)} />
                                            </div>
                                        </>
                                    )}
                                    {editingItem.type === 'permeation_oven' && (
                                        <>
                                            <div className="input-row">
                                                <label>Chemical</label>
                                                <select value={editingItem.data.chemical || 'H2S'} onChange={e => handleNodeDataChange(editingItem.id, 'chemical', e.target.value)}>
                                                    <option value="H2S">H2S</option>
                                                    <option value="Ethanol">Ethanol</option>
                                                    <option value="Acetone">Acetone</option>
                                                    <option value="Toluene">Toluene</option>
                                                </select>
                                            </div>
                                            <div className="input-row">
                                                <label>Emission Rate (ng/min)</label>
                                                <input type="number" value={editingItem.data.emissionRate !== undefined ? editingItem.data.emissionRate : 1000} onChange={e => handleNodeDataChange(editingItem.id, 'emissionRate', parseFloat(e.target.value) || 1000)} />
                                            </div>
                                        </>
                                    )}
                                    {editingItem.type === 'combiner' && (
                                        <div className="input-row">
                                            <label>Number of Input Ports</label>
                                            <input type="number" min="2" max="10" value={editingItem.data.ports !== undefined ? editingItem.data.ports : 2} onChange={e => handleNodeDataChange(editingItem.id, 'ports', parseInt(e.target.value) || 2)} />
                                        </div>
                                    )}
                                </>
                            )}
                        </div>
                        <div style={{ marginTop: '20px', display: 'flex', justifyContent: 'flex-end' }}>
                            <button onClick={() => setEditingNodeId(null)} className="btn-secondary">Close</button>
                        </div>
                    </div>
                </div>
            )}

            {isProtocolOpen && (
                <div className="modal-overlay" onClick={() => setIsProtocolOpen(false)}>
                    <div className="modal-content" style={{ maxWidth: 600, width: '100%', background: 'rgba(15, 23, 42, 0.95)' }} onClick={e => e.stopPropagation()}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: '1px solid rgba(255,255,255,0.1)', paddingBottom: '12px', marginBottom: '16px' }}>
                            <h3 style={{ margin: 0, fontSize: '1.1rem', color: '#f8fafc', display: 'flex', alignItems: 'center', gap: 8 }}><Activity size={18} color="#eab308" /> Step Protocol Generator</h3>
                            <button onClick={() => setIsProtocolOpen(false)} style={{ background: 'transparent', border: 'none', color: '#94a3b8', cursor: 'pointer' }}><X size={18} /></button>
                        </div>
                        <div style={{ color: '#94a3b8', fontSize: '0.85rem', marginBottom: 16 }}>
                            Define a dynamic recipe to run a sequence of target concentrations automatically. Export the recipe as a Python hardware script for MFCs (e.g., Alicat / Brooks / Bronkhorst).
                        </div>

                        <div style={{ maxHeight: '300px', overflowY: 'auto', marginBottom: 16, display: 'flex', flexDirection: 'column', gap: 8, paddingRight: 4 }}>
                            {protocolSteps.map((step, idx) => (
                                <div key={idx} style={{ display: 'flex', gap: 8, alignItems: 'center', background: 'rgba(0,0,0,0.2)', padding: 8, borderRadius: 6, border: '1px solid rgba(255,255,255,0.05)' }}>
                                    <span style={{ color: '#64748b', fontSize: '0.8rem', width: 20 }}>{idx + 1}.</span>
                                    <div style={{ display: 'flex', gap: 4, alignItems: 'center', flex: 1 }}>
                                        <label style={{ fontSize: '0.75rem', color: '#94a3b8' }}>Target ({autoParams.targetConcUnit})</label>
                                        <input type="number" value={step.targetConc} onChange={e => {
                                            const newSteps = [...protocolSteps];
                                            newSteps[idx].targetConc = parseFloat(e.target.value);
                                            setProtocolSteps(newSteps);
                                        }} style={{ width: 80, padding: 4 }} />
                                    </div>
                                    <div style={{ display: 'flex', gap: 4, alignItems: 'center', flex: 1 }}>
                                        <label style={{ fontSize: '0.75rem', color: '#94a3b8' }}>Hold Time (min)</label>
                                        <input type="number" value={step.duration} onChange={e => {
                                            const newSteps = [...protocolSteps];
                                            newSteps[idx].duration = parseFloat(e.target.value);
                                            setProtocolSteps(newSteps);
                                        }} style={{ width: 80, padding: 4 }} />
                                    </div>
                                    <button onClick={() => setProtocolSteps(protocolSteps.filter((_, i) => i !== idx))} style={{ background: 'transparent', color: '#ef4444', border: 'none', cursor: 'pointer', padding: 4 }}><Trash2 size={16} /></button>
                                </div>
                            ))}
                            <button onClick={() => setProtocolSteps([...protocolSteps, { duration: 60, targetConc: 10 }])} className="btn-secondary" style={{ alignSelf: 'flex-start', marginTop: 8 }}>+ Add Step</button>
                        </div>

                        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', borderTop: '1px solid rgba(255,255,255,0.1)', paddingTop: 16 }}>
                            <button onClick={() => {
                                let script = "# Auto-Generated Protocol Script for MFCs\nimport time\nimport serial\n\n";
                                script += "# NOTE: Adjust COM port and command formats for your specific MFCs (e.g., Alicat \\r commands)\n";
                                script += "# ser = serial.Serial('/dev/ttyUSB0', 19200, timeout=1)\n\n";
                                script += "def set_flow(address, setpoint):\n";
                                script += "    # cmd = f'{address}{setpoint}\\r'\n";
                                script += "    # ser.write(cmd.encode())\n";
                                script += "    print(f'Setting MFC {address} to {setpoint:.2f} sccm')\n\n";
                                script += "print('--- Starting Protocol ---')\n\n";

                                const totalFlow = parseFloat(autoParams.totalFlow) || 1000;
                                let sourceConcFrac = 1;
                                if (autoParams.sourceConcUnit === 'ppm') sourceConcFrac = autoParams.sourceConc / 1e6;
                                else if (autoParams.sourceConcUnit === 'ppb') sourceConcFrac = autoParams.sourceConc / 1e9;
                                else sourceConcFrac = autoParams.sourceConc / 100;

                                protocolSteps.forEach((s, i) => {
                                    let targetFrac = 1;
                                    if (autoParams.targetConcUnit === 'ppm') targetFrac = s.targetConc / 1e6;
                                    else if (autoParams.targetConcUnit === 'ppb') targetFrac = s.targetConc / 1e9;
                                    else targetFrac = s.targetConc / 100;

                                    let qGas = 0;
                                    if (sourceConcFrac > 0) {
                                        qGas = (totalFlow * targetFrac) / sourceConcFrac;
                                    }
                                    let qCarrier = totalFlow - qGas;
                                    if (qCarrier < 0) qCarrier = 0;

                                    script += `# Step ${i + 1}: Target ${s.targetConc} ${autoParams.targetConcUnit} for ${s.duration} minutes\n`;
                                    script += `set_flow('A', ${qGas}) # Source/Target Gas Flow\n`;
                                    script += `set_flow('B', ${qCarrier}) # Balance/Carrier Flow\n`;
                                    script += `print('Waiting ${s.duration} minutes...')\n`;
                                    script += `time.sleep(${s.duration * 60})\n\n`;
                                });
                                script += "print('--- Protocol Complete ---')\n";
                                script += "set_flow('A', 0.0)\nset_flow('B', 0.0)\n";

                                const blob = new Blob([script], { type: 'text/plain' });
                                const url = URL.createObjectURL(blob);
                                const a = document.createElement('a');
                                a.href = url;
                                a.download = 'mfc_sequence_protocol.py';
                                a.click();
                            }} style={{ padding: '8px 16px', background: 'var(--accent-primary)', color: 'white', border: 'none', borderRadius: 6, fontWeight: 600, cursor: 'pointer', display: 'flex', gap: 6, alignItems: 'center' }}>
                                <Download size={14} /> Export Python Driver
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {isAutoDesignOpen && (
                <div className="modal-overlay" onClick={() => setIsAutoDesignOpen(false)}>
                    <div className="modal-content" style={{ maxWidth: 400, background: 'rgba(15, 23, 42, 0.95)' }} onClick={e => e.stopPropagation()}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: '1px solid rgba(255,255,255,0.1)', paddingBottom: '12px', marginBottom: '16px' }}>
                            <h3 style={{ margin: 0, fontSize: '1.1rem', color: '#f8fafc', display: 'flex', alignItems: 'center', gap: 8 }}><Wand2 size={18} color="#38bdf8" /> Auto-Design System</h3>
                            <button onClick={() => setIsAutoDesignOpen(false)} style={{ background: 'transparent', border: 'none', color: '#94a3b8', cursor: 'pointer' }}><X size={18} /></button>
                        </div>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
                            <div className="input-row">
                                <label>Target Total Flow (sccm)</label>
                                <input type="number" value={autoParams.totalFlow} onChange={e => setAutoParams({ ...autoParams, totalFlow: e.target.value })} />
                            </div>
                            <div className="input-row">
                                <label>Target Humidity (%RH)</label>
                                <input type="number" min="0" max="99" value={autoParams.targetRh} onChange={e => setAutoParams({ ...autoParams, targetRh: e.target.value })} />
                            </div>
                            <div className="input-row">
                                <label>Target Gas Name</label>
                                <input type="text" value={autoParams.gasName} onChange={e => setAutoParams({ ...autoParams, gasName: e.target.value })} />
                            </div>
                            <div className="input-row">
                                <label>Target Gas Conc.</label>
                                <div style={{ display: 'flex', gap: '4px' }}>
                                    <input type="number" style={{ width: '80px' }} value={autoParams.targetConc} onChange={e => setAutoParams({ ...autoParams, targetConc: e.target.value })} />
                                    <select style={{ flex: 1 }} value={autoParams.targetConcUnit} onChange={e => setAutoParams({ ...autoParams, targetConcUnit: e.target.value })}>
                                        <option value="ppm">ppm</option>
                                        <option value="ppb">ppb</option>
                                        <option value="%">%</option>
                                    </select>
                                </div>
                            </div>
                            <div className="input-row">
                                <label>Source Cyl. Conc.</label>
                                <div style={{ display: 'flex', gap: '4px' }}>
                                    <input type="number" style={{ width: '80px' }} value={autoParams.sourceConc} onChange={e => setAutoParams({ ...autoParams, sourceConc: e.target.value })} />
                                    <select style={{ flex: 1 }} value={autoParams.sourceConcUnit} onChange={e => setAutoParams({ ...autoParams, sourceConcUnit: e.target.value })}>
                                        <option value="ppm">ppm</option>
                                        <option value="ppb">ppb</option>
                                        <option value="%">%</option>
                                    </select>
                                </div>
                            </div>

                            {parseFloat(autoParams.targetRh) > 0 && (
                                <div className="input-row" style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 8 }}>
                                    <label style={{ margin: 0 }}>Use Shared Carrier Cylinder (Y-Splitter)</label>
                                    <input
                                        type="checkbox"
                                        checked={autoParams.sharedCarrier}
                                        onChange={e => setAutoParams({ ...autoParams, sharedCarrier: e.target.checked })}
                                        style={{ width: 'auto', margin: 0, cursor: 'pointer' }}
                                    />
                                </div>
                            )}

                            <div style={{ display: 'flex', gap: '8px' }}>
                                <label style={{
                                    flex: 1,
                                    display: 'flex',
                                    alignItems: 'center',
                                    gap: '8px',
                                    cursor: 'pointer',
                                    padding: '8px',
                                    background: 'rgba(0,0,0,0.3)',
                                    borderRadius: '6px',
                                    border: '1px solid rgba(255,255,255,0.05)',
                                    opacity: autoParams.usePermeationOven ? 0.4 : 1
                                }}>
                                    <input type="checkbox" disabled={autoParams.usePermeationOven} checked={autoParams.useVocBubbler} onChange={e => setAutoParams(prev => ({ ...prev, useVocBubbler: e.target.checked }))} style={{ accentColor: '#f43f5e', transform: 'scale(1.1)' }} />
                                    <span style={{ fontSize: '0.8rem', color: '#f8fafc' }}>VOC Bubbler</span>
                                </label>
                                <label style={{
                                    flex: 1,
                                    display: 'flex',
                                    alignItems: 'center',
                                    gap: '8px',
                                    cursor: 'pointer',
                                    padding: '8px',
                                    background: 'rgba(0,0,0,0.3)',
                                    borderRadius: '6px',
                                    border: '1px solid rgba(255,255,255,0.05)',
                                    opacity: autoParams.useVocBubbler ? 0.4 : 1
                                }}>
                                    <input type="checkbox" disabled={autoParams.useVocBubbler} checked={autoParams.usePermeationOven} onChange={e => setAutoParams(prev => ({ ...prev, usePermeationOven: e.target.checked }))} style={{ accentColor: '#d946ef', transform: 'scale(1.1)' }} />
                                    <span style={{ fontSize: '0.8rem', color: '#f8fafc' }}>Permeation Oven</span>
                                </label>
                            </div>

                            {(!autoParams.usePermeationOven && !autoParams.useVocBubbler && (autoParams.targetConcUnit === 'ppb' || (autoParams.targetConcUnit === 'ppm' && parseFloat(autoParams.targetConc) < 1))) && (
                                <div style={{ fontSize: '0.8rem', color: '#f59e0b', background: 'rgba(245, 158, 11, 0.1)', padding: '8px', borderRadius: '4px', border: '1px solid rgba(245, 158, 11, 0.2)' }}>
                                    <strong>Warning:</strong> For trace concentrations ({autoParams.targetConc} {autoParams.targetConcUnit}), standard gas cylinders require extremely low MFC flows. Consider using a <strong>Permeation Oven</strong> instead.
                                </div>
                            )}

                            <button
                                onClick={handleAutoGenerate}
                                style={{ marginTop: 8, padding: '10px', background: 'var(--accent-primary)', color: 'white', border: 'none', borderRadius: 6, fontWeight: 600, cursor: 'pointer' }}
                            >
                                Generate Full Matrix
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
};

// Wrap with ReactFlowProvider so we can use flow hooks
export default function GasSystemDesignPage() {
    return (
        <ReactFlowProvider>
            <GasSystemDesignInner />
        </ReactFlowProvider>
    );
}
