import { newId, activeCopperLayerIds } from './pcbDoc.js';

/**
 * Basic Manhattan point-to-point Auto Router.
 * This connects pads on the same net using simple orthogonal tracks.
 * In a professional EDA, this would be an A* maze router avoiding obstacles,
 * but this serves to demonstrate the workflow.
 */
export function autoRoute(doc, padCentersByNet) {
    const newTracks = [];
    const stack = activeCopperLayerIds(doc);
    let layerIndex = 0;

    for (const [net, pts] of padCentersByNet.entries()) {
        // Skip empty nets or ground/power nets if we had polygons (for now route all)
        if (pts.length < 2 || net === '0') continue;

        const layer = stack[layerIndex % stack.length];
        layerIndex += 1;

        // Connect each point to the next in a daisy chain
        for (let i = 0; i < pts.length - 1; i++) {
            const start = pts[i];
            const end = pts[i+1];
            
            // Simple L-shape route (Manhattan)
            // Go horizontally first, then vertically
            const corner = [end[0], start[1]];
            
            newTracks.push({
                id: newId('tr'),
                layer: layer,
                widthMm: doc.meta.defaultTrackMm || 0.35,
                net: net,
                points: [
                    [start[0], start[1]],
                    [corner[0], corner[1]],
                    [end[0], end[1]]
                ]
            });
        }
    }

    return newTracks;
}
