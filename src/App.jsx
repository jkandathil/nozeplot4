import { useState, useCallback, useEffect } from 'react';
import { useDropzone } from 'react-dropzone';
import {
  LayoutDashboard,
  FileText,
  Settings,
  UploadCloud,
  BarChart2,
  Folder
} from 'lucide-react';
import { AnimatePresence } from 'framer-motion';
import './App.css';
import { fileManager } from './utils/db';
const logo = `${import.meta.env.BASE_URL}logo_noze_circle.png`;

// Components (We will create these next)
import Sidebar from './components/Sidebar';
import ChartArea from './components/ChartArea';
import EmptyState from './components/EmptyState';
import NormalizePage from './components/NormalizePage';
import AromaAnalysisPage from './components/AromaAnalysisPage';
import RecoveryAnalysisPage from './components/RecoveryAnalysisPage';
import ManufacturingVariationPage from './components/ManufacturingVariationPage';
import CSVPlotterPage from './components/CSVPlotterPage';
import GasDilutionMathPage from './components/GasDilutionMathPage';
import PolymerCBMixPage from './components/PolymerCBMixPage';
import GasSystemDesignPage from './components/gas-design/GasSystemDesignPage';
import MLStudioPage from './components/MLStudioPage';
import SeparabilityAnalysisPage from './components/SeparabilityAnalysisPage';
import SensitivityAnalysisPage from './components/SensitivityAnalysisPage';
import { Calculator as CalcIcon, FlaskConical, Network } from 'lucide-react';

import FolderCompareAromaPage from './components/FolderCompareAromaPage';
import TSNEPage from './components/TSNEPage';
import HelpPage from './components/HelpPage';
import AromaUnitCapturePage from './components/AromaUnitCapturePage';
import SerialMonitorPage from './components/SerialMonitorPage';
import { parseFile } from './utils/fileParser';
import { getBrowserStorageEstimate, uploadWorkloadHints } from './utils/browserCapacityHints.js';
import { buildAuCaptureFileName } from './utils/auCaptureFilename.js';
import { FENOSE_MODEL_FOLDER_NAME, FENOSE_SYNTHETIC_FOLDER_NAME } from './utils/fenoseWorkspace.js';
import { extractChronoSortKey } from './utils/recoveryChronoSort.js';
import {
  generateSyntheticFenoseRows,
  buildSyntheticFenoseFileName,
  parseConcentrationsList,
  computeCalibrationFromFiles,
  groupFenoseCalibrationFilesByDevice,
  resolveSyntheticCalibration,
  deviceSuffixForSyntheticFile,
  FENOSE_SYNTH_UNKNOWN_KEY,
  SYNTHETIC_DEFAULT_DEVICE_SUFFIX,
} from './utils/fenoseSyntheticDataset.js';

const RESERVED_WORKSPACE_FOLDER_NAMES = new Set(
  [FENOSE_MODEL_FOLDER_NAME, FENOSE_SYNTHETIC_FOLDER_NAME].map((s) => String(s).toLowerCase())
);

/** Serial monitor exports (CSV/TXT with timestamps). */
const SERIAL_DATA_FOLDER_NAME = 'serial_data';

/** Keep sidebar metadata but drop row payloads so huge FeNOse_synthetic/ folders do not OOM React on refresh. */
function workspaceFilesForReactState(all) {
  if (!Array.isArray(all) || all.length === 0) return all;
  const synthFolderIds = new Set();
  for (const f of all) {
    if (
      f.isFolder &&
      String(f.name).toLowerCase() === FENOSE_SYNTHETIC_FOLDER_NAME.toLowerCase()
    ) {
      synthFolderIds.add(String(f.id));
    }
  }
  if (synthFolderIds.size === 0) return all;
  return all.map((f) => {
    if (f.isFolder) return f;
    if (!synthFolderIds.has(String(f.folderId))) return f;
    if (!Array.isArray(f.data) || f.data.length === 0) return f;
    const { data: _d, file: _fb, csvText: _t, csvSnapshot: _s, ...rest } = f;
    return rest;
  });
}

function App() {
  const [files, setFiles] = useState([]);
  const [selectedFileId, setSelectedFileId] = useState(null);
  const [parsedData, setParsedData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [activePage, setActivePage] = useState('dashboard');

  // User Name State
  const [userName, setUserName] = useState(localStorage.getItem('userName') || 'User');
  const [isNameModalOpen, setIsNameModalOpen] = useState(!localStorage.getItem('userName'));
  const [nameInput, setNameInput] = useState('');

  // Save name function
  const handleNameSubmit = (e) => {
    e.preventDefault();
    if (nameInput.trim()) {
      localStorage.setItem('userName', nameInput.trim());
      setUserName(nameInput.trim());
      setIsNameModalOpen(false);
    }
  };

  // Load files from DB on mount
  useEffect(() => {
    const loadFiles = async () => {
      try {
        const rawSaved = await fileManager.getAllFiles();
        const savedFiles = workspaceFilesForReactState(rawSaved);
        if (savedFiles && savedFiles.length > 0) {
          setFiles(savedFiles);
        }

        // Restore Workspace Session mappings seamlessly
        const restoredStateStr = localStorage.getItem('noze_restored_state');
        if (restoredStateStr && rawSaved) {
          try {
            const restoredState = JSON.parse(restoredStateStr);
            if (restoredState.activePage) setActivePage(restoredState.activePage);

            if (restoredState.selectedFileId) {
              const mainFileObj = rawSaved.find(f => f.id === restoredState.selectedFileId);
              console.log("Noze Match Main File:", mainFileObj);
              if (mainFileObj) {
                setSelectedFileId(restoredState.selectedFileId);
                if (mainFileObj.data) {
                  console.log("Using cached DB JSON Data for Main File");
                  setParsedData({
                    id: mainFileObj.id,
                    fileName: mainFileObj.name,
                    data: mainFileObj.data,
                    meta: { fields: mainFileObj.data.length > 0 ? Object.keys(mainFileObj.data[0]) : [] }
                  });
                } else if (mainFileObj.file) {
                  console.log("Attempting inline map Parse Main File", mainFileObj.name);
                  try {
                    const parsed = await parseFile(mainFileObj);
                    console.log("Successfully map Parsed Main File:", parsed);
                    setParsedData(parsed);
                  } catch (e) { console.error("Restore parse fail on main file", e); }
                } else {
                  try {
                    const parsed = await parseFile(mainFileObj);
                    setParsedData(parsed);
                  } catch (e) {
                    console.error("Restore parse fail on main file (IndexedDB)", e);
                  }
                }
              }
            }

            if (restoredState.compareFileIds && Array.isArray(restoredState.compareFileIds)) {
              setCompareFileIds(restoredState.compareFileIds);
              const restoredComparables = [];
              for (const cId of restoredState.compareFileIds) {
                const cfile = rawSaved.find(f => f.id === cId);
                if (cfile) {
                  if (cfile.data) {
                    console.log("Using cached DB JSON for Comparison:", cfile.name);
                    restoredComparables.push({
                      id: cfile.id,
                      fileName: cfile.name,
                      data: cfile.data,
                      meta: { fields: cfile.data.length > 0 ? Object.keys(cfile.data[0]) : [] }
                    });
                  } else if (cfile.file) {
                    console.log("Attempting inline map Parse Compare File", cfile.name);
                    try {
                      const parsed = await parseFile(cfile);
                      console.log("Successfully map Parsed Compare File:", parsed);
                      restoredComparables.push({
                        id: cfile.id,
                        fileName: cfile.name,
                        data: parsed.data,
                        meta: parsed.meta || { fields: Object.keys(parsed.data[0] || {}) }
                      });
                    } catch (e) {
                      console.error("Restore parse fail on compare file", e);
                    }
                  } else {
                    try {
                      const parsed = await parseFile(cfile);
                      restoredComparables.push({
                        id: cfile.id,
                        fileName: cfile.name,
                        data: parsed.data,
                        meta: parsed.meta || { fields: Object.keys(parsed.data[0] || {}) }
                      });
                    } catch (e) {
                      console.error("Restore parse fail on compare file (IndexedDB)", e);
                    }
                  }
                }
              }
              console.log("Final Restored Comparables Array:", restoredComparables);
              setCompareDataList(restoredComparables);
            }
          } catch (e) {
            console.error("Could not parse LocalStorage restore state:", e);
          }
          localStorage.removeItem('noze_restored_state');
        }
      } catch (error) {
        console.error("Failed to load files from storage:", error);
      }
    };
    loadFiles();
  }, []);

  // Common handler for adding files to processing queue
  const addFiles = useCallback(async (newFiles, targetFolderId = null) => {
    // Filter non-CSV/Excel files
    const validFiles = Array.from(newFiles).filter(file => {
      const name = file.name.toLowerCase();
      return name.endsWith('.csv') || name.endsWith('.xls') || name.endsWith('.xlsx');
    });

    if (validFiles.length === 0) return;

    const totalUploadBytes = validFiles.reduce((sum, file) => sum + (typeof file.size === 'number' ? file.size : 0), 0);
    try {
      const est = await getBrowserStorageEstimate();
      const hints = uploadWorkloadHints(totalUploadBytes, est);
      if (hints.severity === 'severe' && hints.messages.length > 0) {
        const ok = window.confirm(`${hints.messages.join('\n\n')}\n\nUpload these files anyway?`);
        if (!ok) return;
      } else if (
        hints.severity === 'warn' &&
        hints.messages.length > 0 &&
        totalUploadBytes >= 50 * 1024 * 1024
      ) {
        const ok = window.confirm(`${hints.messages.join('\n\n')}\n\nContinue with upload?`);
        if (!ok) return;
      }
    } catch {
      /* ignore capacity probe failures */
    }

    const formattedFiles = validFiles.map(file => ({
      id: Math.random().toString(36).substr(2, 9),
      name: file.webkitRelativePath || file.name,
      path: file.webkitRelativePath || file.name,
      file: file,
      type: file.type,
      folderId: targetFolderId,
      createdAt: typeof file.lastModified === 'number' ? file.lastModified : Date.now(),
    }));

    // Persist to DB
    try {
      await Promise.all(formattedFiles.map(f => fileManager.saveFile(f)));
    } catch (e) {
      console.error("Failed to save files to storage:", e);
    }

    setFiles(prev => [...prev, ...formattedFiles]);
  }, []);

  const onDrop = useCallback((acceptedFiles) => {
    addFiles(acceptedFiles);
  }, [addFiles]);

  const { getRootProps, getInputProps, isDragActive, open } = useDropzone({
    onDrop,
    accept: {
      'text/csv': ['.csv'],
      'application/vnd.ms-excel': ['.csv', '.xls'],
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': ['.xlsx']
    },
    noClick: true, // Always disable click on global container to prevent interference with other UI
    noKeyboard: true
  });

  const handleManualUpload = (e, targetFolderId = null) => {
    if (e.target.files && e.target.files.length > 0) {
      addFiles(e.target.files, targetFolderId);
    }
  };

  const handleCreateFolder = async (folderName) => {
    const newFolder = {
      id: `folder_${Math.random().toString(36).substr(2, 9)}`,
      name: folderName,
      isFolder: true,
      createdAt: Date.now()
    };
    try {
      await fileManager.saveFile(newFolder);
      setFiles(prev => [...prev, newFolder]);
    } catch (e) {
      console.error("Failed to create folder:", e);
    }
  };

  const handleAromaUnitCaptureSave = useCallback(async ({ folderName, data, savingAtMs }) => {
    if (!data?.length) return;
    const resolvedName = buildAuCaptureFileName(
      data,
      savingAtMs != null ? new Date(savingAtMs) : new Date()
    );
    const sampleN = Math.min(data.length, 40);
    const sampleBlob = new Blob([JSON.stringify(data.slice(0, sampleN))]);
    const approxSize = Math.max(
      1,
      Math.round((sampleBlob.size / sampleN) * data.length)
    );
    let folderId;
    try {
      const existing = await fileManager.getAllFiles();
      const match = existing.find((f) => f.isFolder && f.name === folderName);
      if (match) {
        folderId = match.id;
      } else {
        folderId = `folder_${Math.random().toString(36).substr(2, 9)}`;
        await fileManager.saveFile({
          id: folderId,
          name: folderName,
          isFolder: true,
          createdAt: Date.now(),
        });
      }
      const fileId = Math.random().toString(36).substr(2, 9);
      await fileManager.saveFile({
        id: fileId,
        name: resolvedName,
        folderId,
        data,
        size: approxSize,
        createdAt: Date.now(),
      });
      const refreshed = await fileManager.getAllFiles();
      setFiles(refreshed);
    } catch (e) {
      console.error('AU capture save failed:', e);
      throw e;
    }
  }, []);

  // Save arbitrary JSON payloads into a workspace folder (used by ML Studio model saving)
  /** FeNOse ML Studio: add synthetic curated-style CSV rows into workspace folder FeNOse_synthetic/ (not mixed with real data). */
  const handleAddSyntheticFenoseToWorkspace = useCallback(async (opts = {}) => {
    /**
     * t-SNE / callers: save exact pre-generated rows so workspace CSVs match embedding inputs
     * (same seeds and row counts as generateSyntheticFenoseRows in the caller).
     */
    if (Array.isArray(opts.prebuiltRuns) && opts.prebuiltRuns.length > 0) {
      const runs = opts.prebuiltRuns;
      const existing = await fileManager.getAllFiles();
      let folderId;
      let syntheticFolderCreatedAt = null;
      const folderMatch = existing.find(
        (f) => f.isFolder && String(f.name).toLowerCase() === FENOSE_SYNTHETIC_FOLDER_NAME.toLowerCase()
      );
      if (folderMatch) {
        folderId = folderMatch.id;
      } else {
        folderId = `folder_${Math.random().toString(36).substr(2, 9)}`;
        syntheticFolderCreatedAt = Date.now();
        await fileManager.saveFile({
          id: folderId,
          name: FENOSE_SYNTHETIC_FOLDER_NAME,
          isFolder: true,
          createdAt: syntheticFolderCreatedAt,
        });
      }
      const leanForState = [];
      const YIELD_EVERY = 20;
      let written = 0;
      for (let i = 0; i < runs.length; i++) {
        const run = runs[i];
        const data = run?.data;
        if (!Array.isArray(data) || data.length === 0) continue;
        const ppb = Number(run.ppb);
        const replicateIndex = Math.max(0, Math.floor(Number(run.replicateIndex) || 0));
        const devSuf = String(run.deviceSuffix || SYNTHETIC_DEFAULT_DEVICE_SUFFIX).replace(
          /[^\d\-a-z]/gi,
          ''
        );
        const name = buildSyntheticFenoseFileName({ ppb, replicateIndex, deviceSuffix: devSuf });
        const sampleN = Math.min(data.length, 32);
        const approxSize = Math.max(
          1024,
          Math.round((JSON.stringify(data.slice(0, sampleN)).length / sampleN) * data.length)
        );
        const fileId = Math.random().toString(36).substr(2, 9);
        const createdAt = Date.now();
        await fileManager.saveFile({
          id: fileId,
          name,
          folderId: String(folderId),
          data,
          size: approxSize,
          createdAt,
        });
        leanForState.push({ id: fileId, name, folderId: String(folderId), size: approxSize, createdAt });
        written++;
        if (written % YIELD_EVERY === 0) {
          await new Promise((resolve) => setTimeout(resolve, 0));
        }
      }
      setFiles((prev) => {
        const ids = new Set(prev.map((f) => f.id));
        const out = [...prev];
        if (syntheticFolderCreatedAt != null && !ids.has(folderId)) {
          out.push({
            id: folderId,
            name: FENOSE_SYNTHETIC_FOLDER_NAME,
            isFolder: true,
            createdAt: syntheticFolderCreatedAt,
          });
          ids.add(folderId);
        }
        for (const row of leanForState) {
          if (!ids.has(row.id)) {
            out.push(row);
            ids.add(row.id);
          }
        }
        return out;
      });
      return { count: written, folderName: FENOSE_SYNTHETIC_FOLDER_NAME };
    }

    const conc =
      opts.concentrationsText != null
        ? parseConcentrationsList(opts.concentrationsText)
        : Array.isArray(opts.concentrations)
          ? opts.concentrations.filter((n) => Number.isFinite(n) && n >= 0)
          : [];
    if (conc.length < 1) {
      throw new Error('Add at least one concentration (ppb), e.g. 0,10,25,50.');
    }
    const reps = Math.max(1, Math.min(200, Math.floor(Number(opts.replicates) || 2)));
    const baseSeed = Math.floor(Number(opts.seed) || 0);
    // NB: Number(undefined) is NaN, and NaN ?? fallback stays NaN — use finite fallbacks so row counts are never NaN.
    const finiteOr = (v, fallback) => {
      const n = Number(v);
      return Number.isFinite(n) ? n : fallback;
    };
    const nAmbient = Math.max(8, Math.min(120, Math.floor(finiteOr(opts.nAmbient, 100))));
    const nFeno = Math.max(8, Math.min(120, Math.floor(finiteOr(opts.nFeno, 100))));
    const nWindow = Math.max(0, Math.min(80, Math.floor(finiteOr(opts.nWindow, 15))));

    // ── Derive calibration from real workspace files ───────────────────────
    // Collect all labelled (…Nppb…) non-synthetic tabular files in the workspace.
    // Parse those that have not yet been hydrated, then compute per-sensor
    // calibration statistics.  Fall back to built-in reference values if there
    // is not enough real data (< 2 usable files).
    let parsedForCal = [];
    let pooledCalibration = null;
    try {
      const allFiles = await fileManager.getAllFiles();
      // Find synthetic folder id so we can exclude synthetic files from calibration
      const synthFolder = allFiles.find(
        (f) => f.isFolder && String(f.name).toLowerCase() === FENOSE_SYNTHETIC_FOLDER_NAME.toLowerCase()
      );
      const synthFolderId = synthFolder ? String(synthFolder.id) : null;

      const looksLabelled = (name) => /(\d+(?:\.\d+)?)\s*ppb\b/i.test(String(name || ''));
      const isTabular     = (name) => /\.(csv|xlsx?)/i.test(String(name || ''));

      const realCandidates = allFiles.filter((f) => {
        if (f.isFolder) return false;
        if (synthFolderId && String(f.folderId) === synthFolderId) return false;
        return looksLabelled(f.name) && isTabular(f.name);
      });

      parsedForCal = await Promise.all(
        realCandidates.map(async (f) => {
          try {
            if (Array.isArray(f.data) && f.data.length > 0) {
              return { fileName: f.name, data: f.data };
            }
            const r = await parseFile(f);
            if (r?.data?.length) return { fileName: f.name, data: r.data };
          } catch (_) { /* skip unparseable files */ }
          return null;
        })
      ).then((results) => results.filter(Boolean));

      pooledCalibration = computeCalibrationFromFiles(parsedForCal);
      console.info(
        `[FeNOse synthetic] pooled calibration: ${pooledCalibration ? `yes (${parsedForCal.length} labelled file(s))` : 'no — built-in table only'}.`
      );
    } catch (calErr) {
      console.warn('[FeNOse synthetic] calibration error, using fallback:', calErr);
    }

    const byDevice = groupFenoseCalibrationFilesByDevice(parsedForCal);
    // When the user picks AUs in ML Studio, options come from filenames. Parsed calibration
    // may omit some of those files (parse errors or strict phase checks). Still emit synthetic
    // files per selected key using pooled or fallback calibration instead of failing.
    let deviceJobs;
    const dk = opts.deviceKeys;
    if (Array.isArray(dk) && dk.length > 0) {
      const want = dk.map((x) => String(x));
      deviceJobs = want.map((key) => ({
        key,
        files: byDevice.get(key) || [],
      }));
    } else if (byDevice.size === 0) {
      deviceJobs = [{ key: FENOSE_SYNTH_UNKNOWN_KEY, files: [] }];
    } else {
      deviceJobs = [...byDevice.entries()]
        .map(([key, files]) => ({ key, files }))
        .sort((a, b) => a.key.localeCompare(b.key));
    }

    console.info(
      `[FeNOse synthetic] device buckets (after selection): ${deviceJobs.length} (filenames use each unit’s id when present: ##########-####-asu-nz). ` +
        `Per-unit stats when that unit has ≥2 labelled files; otherwise pooled workspace data; otherwise built-in fallback.`
    );

    let folderId;
    let syntheticFolderCreatedAt = null;
    const existing = await fileManager.getAllFiles();
    const folderMatch = existing.find(
      (f) => f.isFolder && String(f.name).toLowerCase() === FENOSE_SYNTHETIC_FOLDER_NAME.toLowerCase()
    );
    if (folderMatch) {
      folderId = folderMatch.id;
    } else {
      folderId = `folder_${Math.random().toString(36).substr(2, 9)}`;
      syntheticFolderCreatedAt = Date.now();
      await fileManager.saveFile({
        id: folderId,
        name: FENOSE_SYNTHETIC_FOLDER_NAME,
        isFolder: true,
        createdAt: syntheticFolderCreatedAt,
      });
    }

    const totalPlanned = deviceJobs.length * conc.length * reps;
    const MAX_SYNTHETIC_BATCH = 10000;
    if (totalPlanned > MAX_SYNTHETIC_BATCH) {
      throw new Error(
        `Too many synthetic files at once (${totalPlanned}). Maximum is ${MAX_SYNTHETIC_BATCH} per run — lower replicates, devices, or concentrations, or run multiple times.`
      );
    }

    /** Yield so the tab stays responsive and memory can be reclaimed between writes. */
    const YIELD_EVERY = 20;
    const leanForState = [];

    let written = 0;
    let k = 0;
    for (const { key: deviceKey, files: devFiles } of deviceJobs) {
      const calibration = resolveSyntheticCalibration(devFiles, pooledCalibration);
      const deviceSuffix = deviceSuffixForSyntheticFile(deviceKey);
      for (const ppb of conc) {
        for (let r = 0; r < reps; r++) {
          const data = generateSyntheticFenoseRows({
            ppb,
            seed: (baseSeed + k * 9973) >>> 0,
            nAmbient,
            nFeno,
            nWindow,
            calibration,
          });
          const name = buildSyntheticFenoseFileName({ ppb, replicateIndex: r, deviceSuffix });
          const sampleN = Math.min(data.length, 32);
          const approxSize = Math.max(
            1024,
            Math.round((JSON.stringify(data.slice(0, sampleN)).length / sampleN) * data.length)
          );
          const fileId = Math.random().toString(36).substr(2, 9);
          const createdAt = Date.now();
          await fileManager.saveFile({
            id: fileId,
            name,
            folderId: String(folderId),
            data,
            size: approxSize,
            createdAt,
          });
          leanForState.push({
            id: fileId,
            name,
            folderId: String(folderId),
            size: approxSize,
            createdAt,
          });
          written++;
          k++;
          if (written % YIELD_EVERY === 0) {
            await new Promise((resolve) => setTimeout(resolve, 0));
          }
        }
      }
    }

    setFiles((prev) => {
      const ids = new Set(prev.map((f) => f.id));
      const out = [...prev];
      if (syntheticFolderCreatedAt != null && !ids.has(folderId)) {
        out.push({
          id: folderId,
          name: FENOSE_SYNTHETIC_FOLDER_NAME,
          isFolder: true,
          createdAt: syntheticFolderCreatedAt,
        });
        ids.add(folderId);
      }
      for (const row of leanForState) {
        if (!ids.has(row.id)) {
          out.push(row);
          ids.add(row.id);
        }
      }
      return out;
    });

    return { count: written, folderName: FENOSE_SYNTHETIC_FOLDER_NAME };
  }, []);

  const handleSaveSerialLogToWorkspace = useCallback(async ({ content, fileName }) => {
    if (typeof content !== 'string' || !fileName) {
      throw new Error('Missing serial log content or file name.');
    }
    const existing = await fileManager.getAllFiles();
    let folderId;
    let folderCreatedAt = null;
    const match = existing.find(
      (f) => f.isFolder && String(f.name).toLowerCase() === SERIAL_DATA_FOLDER_NAME.toLowerCase()
    );
    if (match) {
      folderId = match.id;
    } else {
      folderId = `folder_${Math.random().toString(36).substr(2, 9)}`;
      folderCreatedAt = Date.now();
      await fileManager.saveFile({
        id: folderId,
        name: SERIAL_DATA_FOLDER_NAME,
        isFolder: true,
        createdAt: folderCreatedAt,
      });
    }
    const fileId = Math.random().toString(36).substr(2, 9);
    const mime = String(fileName).toLowerCase().endsWith('.csv') ? 'text/csv' : 'text/plain';
    const blob = new Blob([content], { type: `${mime};charset=utf-8` });
    const nativeFile = new File([blob], fileName, { type: blob.type });
    const createdAt = Date.now();
    await fileManager.saveFile({
      id: fileId,
      name: fileName,
      folderId: String(folderId),
      file: nativeFile,
      csvText: content,
      size: blob.size,
      createdAt,
    });
    const refreshed = await fileManager.getAllFiles();
    setFiles(workspaceFilesForReactState(refreshed));
    return { fileId, folderId };
  }, []);

  const handleSaveJsonToWorkspace = useCallback(async ({ folderName, fileName, json }) => {
    if (!folderName || !fileName) throw new Error('Missing folderName or fileName');
    let folderId;
    try {
      const existing = await fileManager.getAllFiles();
      const match = existing.find((f) => f.isFolder && String(f.name).toLowerCase() === String(folderName).toLowerCase());
      if (match) {
        folderId = match.id;
      } else {
        folderId = `folder_${Math.random().toString(36).substr(2, 9)}`;
        await fileManager.saveFile({
          id: folderId,
          name: folderName,
          isFolder: true,
          createdAt: Date.now(),
        });
      }
      const fileId = Math.random().toString(36).substr(2, 9);
      const approxSize = Math.max(1, new Blob([JSON.stringify(json)]).size);
      await fileManager.saveFile({
        id: fileId,
        name: fileName,
        folderId: String(folderId),
        data: json,
        size: approxSize,
        createdAt: Date.now(),
      });
      const refreshed = await fileManager.getAllFiles();
      setFiles(refreshed);
      return { fileId, folderId };
    } catch (e) {
      console.error('Save JSON to workspace failed:', e);
      throw e;
    }
  }, []);

  const FENOSE_MODEL_JSON_RE = /^(.*)_(v1|v2)_(weights|preprocessing|metrics)\.json$/i;

  function fenoseKindFromJson(json) {
    if (!json || typeof json !== 'object') return null;
    const hasW = 'W1' in json || 'W2' in json || 'W3' in json || 'b1' in json || 'b2' in json || 'b3' in json;
    if (hasW) return 'weights';
    const hasPreV2 = 'good_mask' in json || 'feat_mean' in json || 'feat_std' in json || 'V_pca' in json || 'y_max' in json;
    const hasPreV1 = 'top_idx' in json || 'scaler_mean' in json || 'scaler_std' in json;
    if (hasPreV2 || hasPreV1 || 'feat_cols' in json) return 'preprocessing';
    if ('MAE_ppb' in json || 'RMSE_ppb' in json || 'trainCount' in json || 'testCount' in json) return 'metrics';
    return null;
  }

  function fenoseVersionFromPreprocessing(json) {
    if (!json || typeof json !== 'object') return null;
    if ('V_pca' in json || 'good_mask' in json || 'y_max' in json) return 'v2';
    if ('top_idx' in json || 'scaler_mean' in json || 'scaler_std' in json) return 'v1';
    return null;
  }

  /** FeNOse model import: writes JSON only into `FENOSE_MODEL_FOLDER_NAME` (never workspace root or other folders). */
  const handleUploadModelJsonToWorkspace = useCallback(async (fileList, opts = {}) => {
    const arr = Array.from(fileList || []).filter((f) => f?.name && String(f.name).toLowerCase().endsWith('.json'));
    if (arr.length === 0) return { ok: false, error: 'No .json files selected.' };

    const requestedName = String(opts.modelName || 'fenose').trim().replace(/[\\/:*?"<>|]/g, '-').slice(0, 80) || 'fenose';
    const requestedVersion = String(opts.version || 'auto').toLowerCase();

    let folderId;
    let createdFolder = false;
    try {
      const existing = await fileManager.getAllFiles();
      const modelFolders = existing.filter(
        (f) => f.isFolder && String(f.name).toLowerCase() === FENOSE_MODEL_FOLDER_NAME.toLowerCase()
      );
      if (modelFolders.length > 0) {
        const ranked = modelFolders
          .map((folder) => ({
            folder,
            n: existing.filter(
              (f) =>
                  !f.isFolder &&
                  String(f.folderId) === String(folder.id) &&
                  FENOSE_MODEL_JSON_RE.test(String(f.name || ''))
            ).length,
          }))
          .sort((a, b) => b.n - a.n);
        folderId = ranked[0].folder.id;
      } else {
        createdFolder = true;
        folderId = `folder_${Math.random().toString(36).substr(2, 9)}`;
        await fileManager.saveFile({
          id: folderId,
          name: FENOSE_MODEL_FOLDER_NAME,
          isFolder: true,
          createdAt: Date.now(),
        });
      }

      const baseNames = new Set(arr.map((f) => (f.name.split(/[/\\]/).pop() || f.name).trim()));
      const toRemove = existing.filter(
        (f) => !f.isFolder && String(f.folderId) === String(folderId) && baseNames.has(String(f.name))
      );
      await Promise.all(toRemove.map((f) => fileManager.deleteFile(f.id)));

      // Parse JSON first so we can classify & normalize names.
      const parsedFiles = [];
      for (const file of arr) {
        const originalBase = (file.name.split(/[/\\]/).pop() || file.name).trim();
        let text;
        try {
          text = await file.text();
        } catch (err) {
          return { ok: false, error: `Could not read ${originalBase}: ${err?.message || err}` };
        }
        let json;
        try {
          json = JSON.parse(text);
        } catch {
          return { ok: false, error: `${originalBase} is not valid JSON.` };
        }
        parsedFiles.push({ file, originalBase, text, json });
      }

      // If user provided correct FeNOse names for a single model, keep them.
      const matches = parsedFiles
        .map((pf) => ({ pf, m: pf.originalBase.match(FENOSE_MODEL_JSON_RE) }))
        .filter((x) => x.m);
      const uniqueKey = new Set(matches.map((x) => `${x.m[1]}::${String(x.m[2]).toLowerCase()}`));
      const canKeepNames = matches.length === parsedFiles.length && uniqueKey.size === 1;

      // Otherwise, classify by content and standardize names into one model.
      let inferredVersion = null;
      const byKind = new Map(); // kind -> parsedFile
      for (const pf of parsedFiles) {
        const kindFromName = pf.originalBase.match(FENOSE_MODEL_JSON_RE)?.[3]?.toLowerCase() || null;
        const kind = kindFromName || fenoseKindFromJson(pf.json);
        if (!kind) continue;
        if (!byKind.has(kind)) byKind.set(kind, pf);
        if (kind === 'preprocessing') inferredVersion = fenoseVersionFromPreprocessing(pf.json) || inferredVersion;
      }

      const wantedVersion =
        requestedVersion === 'v1' || requestedVersion === 'v2'
          ? requestedVersion
          : inferredVersion || 'v2';

      if (!canKeepNames) {
        if (!byKind.get('weights') || !byKind.get('preprocessing')) {
          const got = [...byKind.keys()].sort().join(', ') || 'none';
          return {
            ok: false,
            error:
              `Could not detect a complete model pair. Need BOTH weights + preprocessing JSON. Detected: ${got}. ` +
              `Tip: upload files named like ${requestedName}_${wantedVersion}_weights.json and ${requestedName}_${wantedVersion}_preprocessing.json.`,
          };
        }
      }

      const toSave = [];
      if (canKeepNames) {
        for (const pf of parsedFiles) {
          toSave.push({ name: pf.originalBase, pf });
        }
      } else {
        toSave.push({ name: `${requestedName}_${wantedVersion}_weights.json`, pf: byKind.get('weights') });
        toSave.push({ name: `${requestedName}_${wantedVersion}_preprocessing.json`, pf: byKind.get('preprocessing') });
        if (byKind.get('metrics')) toSave.push({ name: `${requestedName}_${wantedVersion}_metrics.json`, pf: byKind.get('metrics') });
      }

      // Remove any existing files with the same normalized names in Model/
      const normalizedNames = new Set(toSave.map((x) => x.name));
      const toRemoveNormalized = existing.filter(
        (f) => !f.isFolder && String(f.folderId) === String(folderId) && normalizedNames.has(String(f.name))
      );
      await Promise.all(toRemoveNormalized.map((f) => fileManager.deleteFile(f.id)));

      for (const item of toSave) {
        const pf = item.pf;
        if (!pf) continue;
        const fileId = Math.random().toString(36).substr(2, 9);
        await fileManager.saveFile({
          id: fileId,
          name: item.name,
          folderId: String(folderId),
          data: pf.json,
          size: Math.max(1, pf.text.length),
          createdAt: Date.now(),
        });
      }

      const refreshed = await fileManager.getAllFiles();
      setFiles(refreshed);

      const modelIds = new Set(
        refreshed
          .filter((f) => f.isFolder && String(f.name).toLowerCase() === FENOSE_MODEL_FOLDER_NAME.toLowerCase())
          .map((f) => String(f.id))
      );
      const inModel = refreshed.filter((f) => !f.isFolder && modelIds.has(String(f.folderId)));
      const byKey = new Map();
      for (const f of inModel) {
        const mm = String(f.name || '').match(FENOSE_MODEL_JSON_RE);
        if (!mm) continue;
        const key = `${mm[1]}::${mm[2].toLowerCase()}`;
        if (!byKey.has(key)) byKey.set(key, {});
        byKey.get(key)[mm[3].toLowerCase()] = true;
      }
      const pairHints = [];
      for (const file of arr) {
        const baseName = (file.name.split(/[/\\]/).pop() || file.name).trim();
        const mm = baseName.match(FENOSE_MODEL_JSON_RE);
        if (!mm) continue;
        const key = `${mm[1]}::${mm[2].toLowerCase()}`;
        const parts = byKey.get(key) || {};
        if (!parts.weights) pairHints.push(`Add ${mm[1]}_${mm[2].toLowerCase()}_weights.json`);
        if (!parts.preprocessing) pairHints.push(`Add ${mm[1]}_${mm[2].toLowerCase()}_preprocessing.json`);
      }
      const uniqueHints = [...new Set(pairHints)];

      return {
        ok: true,
        count: toSave.length,
        createdFolder,
        pairHints: uniqueHints,
        savedNames: toSave.map((x) => x.name),
      };
    } catch (e) {
      console.error('Upload model JSON failed:', e);
      return { ok: false, error: e?.message || 'Upload failed.' };
    }
  }, []);

  const handleRenameFolder = async (e, folderId) => {
    e.stopPropagation();
    const folder = files.find((f) => f.id === folderId && f.isFolder);
    if (!folder) return;
    if (RESERVED_WORKSPACE_FOLDER_NAMES.has(String(folder.name).toLowerCase())) {
      window.alert(
        `The folder "${folder.name}" is used by ML Studio (models or synthetic data) and cannot be renamed.`
      );
      return;
    }
    const next = window.prompt('New folder name', folder.name);
    if (next == null) return;
    const trimmed = String(next).trim();
    if (!trimmed) {
      window.alert('Folder name cannot be empty.');
      return;
    }
    if (/[\\/:*?"<>|]/.test(trimmed)) {
      window.alert('Name cannot contain these characters: \\ / : * ? " < > |');
      return;
    }
    if (RESERVED_WORKSPACE_FOLDER_NAMES.has(trimmed.toLowerCase())) {
      window.alert(`The name "${trimmed}" is reserved for ML Studio. Choose a different name.`);
      return;
    }
    if (trimmed === folder.name) return;
    const duplicate = files.some(
      (f) => f.isFolder && f.id !== folderId && String(f.name).toLowerCase() === trimmed.toLowerCase()
    );
    if (duplicate) {
      window.alert('Another folder already uses that name. Choose a different name.');
      return;
    }
    const updated = { ...folder, name: trimmed };
    try {
      await fileManager.saveFile(updated);
      setFiles((prev) => prev.map((f) => (f.id === folderId ? { ...f, name: trimmed } : f)));
    } catch (err) {
      console.error('Failed to rename folder:', err);
      window.alert('Could not rename folder. Please try again.');
    }
  };

  const handleDeleteFolder = async (e, folderId) => {
    e.stopPropagation();
    const filesInFolder = files.filter(f => f.folderId === folderId);
    const idsToDelete = [folderId, ...filesInFolder.map(f => f.id)];
    try {
      await Promise.all(idsToDelete.map(id => fileManager.deleteFile(id)));
      setFiles(prev => prev.filter(f => !idsToDelete.includes(f.id)));
      if (idsToDelete.includes(selectedFileId)) {
        setSelectedFileId(null);
        setParsedData(null);
      }
      setCompareFileIds(prev => (prev || []).filter(id => !idsToDelete.includes(id)));
      setCompareDataList(prev => (prev || []).filter(data => !idsToDelete.includes(data.id)));
    } catch (error) {
      console.error("Failed to delete folder:", error);
    }
  };

  const [compareFileIds, setCompareFileIds] = useState([]);
  const [compareDataList, setCompareDataList] = useState([]);

  const handleFileSelect = async (fileId, isMultiSelect = false) => {
    // If selecting a new main file, handle comparison reset or promotion
    if (!isMultiSelect) {
      if (selectedFileId === fileId) return; // Already main

      const fileObj = files.find(f => f.id === fileId);
      if (!fileObj) return;

      setSelectedFileId(fileId);
      setCompareFileIds([]);
      setCompareDataList([]);
      setLoading(true);

      try {
        const result = await parseFile(fileObj);
        setParsedData(result);
      } catch (error) {
        console.error("Error parsing file:", error);
      } finally {
        setLoading(false);
      }
      return;
    }

    // MULTI SELECT LOGIC
    // 1. If clicking current MAIN FILE
    if (fileId === selectedFileId) {
      // If we have comparison files, promote the first one to main
      if (compareFileIds.length > 0) {
        const newMainId = compareFileIds[0];
        const newCompareIds = compareFileIds.slice(1);

        // Set new state
        setSelectedFileId(newMainId);
        setCompareFileIds(newCompareIds);

        // Re-fetch MAIN data
        setLoading(true);
        try {
          const newMainObj = files.find(f => f.id === newMainId);
          const result = await parseFile(newMainObj);
          setParsedData(result);

          // Re-fetch COMPARISON data (because the list changed)
          handleCompareSelect(newCompareIds);
        } catch (e) {
          console.error(e);
        } finally {
          setLoading(false);
        }
      } else {
        // No comparison files -> Deselect all
        setSelectedFileId(null);
        setParsedData(null);
        setCompareFileIds([]);
        setCompareDataList([]);
      }
      return;
    }

    // 2. If clicking a COMPARISON FILE -> Remove it
    if (compareFileIds.includes(fileId)) {
      const newCompareIds = compareFileIds.filter(id => id !== fileId);
      handleCompareSelect(newCompareIds);
      return;
    }

    // 3. If clicking a NEW FILE -> Add to comparison
    if (!selectedFileId) {
      // If nothing selected, make it main (fallback to single select logic)
      handleFileSelect(fileId, false);
    } else {
      const newCompareIds = [...compareFileIds, fileId];
      handleCompareSelect(newCompareIds);
    }
  };

  const handleCompareSelect = async (fileIds) => {
    setCompareFileIds(fileIds);

    if (!fileIds || fileIds.length === 0) {
      setCompareDataList([]);
      return;
    }

    const validFiles = files.filter(f => fileIds.includes(f.id));

    try {
      const results = await Promise.allSettled(validFiles.map(f => parseFile(f)));
      const successful = results
        .filter(r => r.status === 'fulfilled')
        .map(r => r.value);

      if (results.length !== successful.length) {
        console.warn("Some comparison files failed to parse");
      }
      setCompareDataList(successful);
    } catch (error) {
      console.error("Unexpected error in comparison processing:", error);
    }
  };

  const handleSelectAll = async () => {
    if (files.length === 0) return;

    if (!selectedFileId) {
      // If no file is selected, select the first one as main, rest as compare
      const firstFileId = files[0].id;
      await handleFileSelect(firstFileId, false);
      const otherFileIds = files.slice(1).map(f => f.id);
      if (otherFileIds.length > 0) {
        handleCompareSelect(otherFileIds);
      }
      return;
    }

    // Get all other files
    const otherFileIds = files
      .filter(f => f.id !== selectedFileId)
      .map(f => f.id);

    if (otherFileIds.length === 0) return;

    // Toggle: If all are selected, deselect. Else, select all.
    if (compareFileIds.length === otherFileIds.length) {
      handleCompareSelect([]);
    } else {
      handleCompareSelect(otherFileIds);
    }
  };

  const handleSelectFiles = async (fileIdsToSelect) => {
    if (!fileIdsToSelect || fileIdsToSelect.length === 0) {
      handleCompareSelect([]);
      setSelectedFileId(null);
      setParsedData(null);
      return;
    }

    const mainId = fileIdsToSelect[0];
    const compareIds = fileIdsToSelect.slice(1);

    if (mainId !== selectedFileId) {
      await handleFileSelect(mainId, false);
    }
    handleCompareSelect(compareIds);
  };

  /** Sidebar: AU row / folder — chronological order for Drift Map, then open Recovery. */
  const handleOpenRecoveryForFileIds = async (rawIds) => {
    const ids = Array.isArray(rawIds) ? rawIds.filter(Boolean) : [];
    if (ids.length === 0) return;
    const byId = new Map(files.filter((f) => !f.isFolder).map((f) => [f.id, f]));
    const sorted = [...ids].filter((id) => byId.has(id)).sort((a, b) => {
      const na = byId.get(a)?.name || '';
      const nb = byId.get(b)?.name || '';
      return extractChronoSortKey(na).localeCompare(extractChronoSortKey(nb));
    });
    if (sorted.length === 0) return;
    await handleSelectFiles(sorted);
    setActivePage('recoveryAnalysis');
  };

  const deleteFile = async (e, fileId) => {
    e.stopPropagation();

    // Remove from DB
    try {
      await fileManager.deleteFile(fileId);
    } catch (error) {
      console.error("Failed to delete file from storage:", error);
    }

    setFiles(prev => prev.filter(f => f.id !== fileId));

    // If deleted file was selected, clear selection
    if (selectedFileId === fileId) {
      setSelectedFileId(null);
      setParsedData(null);
    }
    if (compareFileIds.includes(fileId)) {
      setCompareFileIds(prev => prev.filter(id => id !== fileId));
      setCompareDataList(prev => prev.filter(data => data.id !== fileId));
    }
  };

  const deleteFiles = async (e, fileIds) => {
    e.stopPropagation();

    // Remove from DB via loop (or if fileManager supports bulk)
    try {
      await Promise.all(fileIds.map(id => fileManager.deleteFile(id)));
    } catch (error) {
      console.error("Failed to delete files from storage:", error);
    }

    setFiles(prev => prev.filter(f => !fileIds.includes(f.id)));

    // Clear selections if they overlap
    if (fileIds.includes(selectedFileId)) {
      setSelectedFileId(null);
      setParsedData(null);
    }
    const safeCompareIds = compareFileIds || [];
    const overlappingCompare = safeCompareIds.filter(id => fileIds.includes(id));
    if (overlappingCompare.length > 0) {
      setCompareFileIds(prev => (prev || []).filter(id => !fileIds.includes(id)));
      setCompareDataList(prev => (prev || []).filter(data => !fileIds.includes(data.id)));
    }
  };

  const deleteAllFiles = async (e) => {
    if (e && typeof e.stopPropagation === 'function') {
      e.stopPropagation();
    }

    try {
      await fileManager.clearAllFiles();
      // Clear state only after successful DB clear to ensure consistency
      setFiles([]);
      setSelectedFileId(null);
      setParsedData(null);
      setCompareFileIds([]);
      setCompareDataList([]);
    } catch (error) {
      console.error("Failed to clear storage:", error);
      alert("Failed to delete files from storage. Please try again.");
    }
  };

  return (
    <div className="app-container" {...getRootProps()}>
      <input {...getInputProps()} />

      {/* Sidebar */}
      {activePage !== 'folderCompareAroma' && (
        <Sidebar
          files={files}
          onFileSelect={handleFileSelect}
          selectedFileId={selectedFileId}
          compareFileIds={compareFileIds}
          onUpload={handleManualUpload}
          onDeleteFile={deleteFile}
          onDeleteFiles={deleteFiles}
          onDeleteAllFiles={deleteAllFiles}
          onSelectAll={handleSelectAll}
          onSelectFiles={handleSelectFiles}
          onOpenRecoveryForFileIds={handleOpenRecoveryForFileIds}
          userName={userName}
          activePage={activePage}
          onPageChange={setActivePage}
          onCreateFolder={handleCreateFolder}
          onDeleteFolder={handleDeleteFolder}
          onRenameFolder={handleRenameFolder}
        />
      )}

      {/* Main Content */}
      {activePage === 'folderCompareAroma' ? (
        <FolderCompareAromaPage
          files={files}
          selectedFileId={selectedFileId}
          compareFileIds={compareFileIds}
          onClose={() => setActivePage('aromaAnalysis')}
        />
      ) : (
        <main className="main-content" style={{ position: 'relative' }}>
          <div className="content-area">
            {/*
              Only AU capture stays mounted when hidden so Web Serial + timers keep running.
              Other routes mount one at a time: mounting every page duplicated DOM ids (e.g. filter-unknown-chk)
              so labels and focus targeted the wrong hidden controls.
            */}
            <div
              className="au-capture-persistent-session"
              style={{ display: activePage === 'aromaUnitCapture' ? 'block' : 'none' }}
              aria-hidden={activePage !== 'aromaUnitCapture'}
            >
              <AromaUnitCapturePage
                onSaveToWorkspace={handleAromaUnitCaptureSave}
                onOpenSerialTab={() => setActivePage('serialMonitor')}
              />
            </div>

            {activePage !== 'aromaUnitCapture' && (
              <AnimatePresence mode="wait">
                {activePage === 'help' ? (
                  <HelpPage key="help" />
                ) : activePage === 'gasDesign' ? (
                  <GasSystemDesignPage key="gasDesign" />
                ) : activePage === 'gasMath' ? (
                  <GasDilutionMathPage key="gasMath" />
                ) : activePage === 'polymerCbMix' ? (
                  <PolymerCBMixPage key="polymerCbMix" />
                ) : activePage === 'normalize' ? (
                  <NormalizePage
                    key="normalize"
                    data={parsedData?.data}
                    fileName={parsedData?.fileName}
                    compareDataList={compareDataList}
                  />
                ) : activePage === 'aromaAnalysis' ? (
                  <AromaAnalysisPage
                    key="aromaAnalysis"
                    data={parsedData?.data}
                    fileName={parsedData?.fileName}
                    compareDataList={compareDataList}
                    availableFiles={files}
                    onPageChange={setActivePage}
                  />
                ) : activePage === 'separability' ? (
                  <SeparabilityAnalysisPage
                    key="separability"
                    data={parsedData?.data}
                    fileName={parsedData?.fileName}
                    compareDataList={compareDataList}
                    availableFiles={files}
                    onPageChange={setActivePage}
                  />
                ) : activePage === 'sensitivity' ? (
                  <SensitivityAnalysisPage
                    key="sensitivity"
                    data={parsedData?.data}
                    fileName={parsedData?.fileName}
                  />
                ) : activePage === 'recoveryAnalysis' ? (
                  <RecoveryAnalysisPage
                    key="recoveryAnalysis"
                    data={parsedData?.data}
                    fileName={parsedData?.fileName}
                    compareDataList={compareDataList}
                    availableFiles={files}
                    primaryFileId={selectedFileId}
                  />
                ) : activePage === 'manufacturing' ? (
                  <ManufacturingVariationPage
                    key="manufacturing"
                    data={parsedData?.data}
                    fileName={parsedData?.fileName}
                    compareDataList={compareDataList}
                    availableFiles={files}
                  />
                ) : activePage === 'csvPlotter' ? (
                  <CSVPlotterPage key="csvPlotter" workspaceFiles={files} />
                ) : activePage === 'serialMonitor' ? (
                  <SerialMonitorPage
                    key="serialMonitor"
                    onSaveSerialLogToWorkspace={handleSaveSerialLogToWorkspace}
                  />
                ) : activePage === 'mlStudio' ? (
                  <MLStudioPage
                    key="mlStudio"
                    data={parsedData?.data}
                    fileName={parsedData?.fileName}
                    compareDataList={compareDataList}
                    workspaceFiles={files}
                    workspaceSelectedFileId={selectedFileId}
                    workspaceCompareFileIds={compareFileIds}
                    onSaveJsonToWorkspace={handleSaveJsonToWorkspace}
                    onUploadModelJsonToWorkspace={handleUploadModelJsonToWorkspace}
                    onAddSyntheticFenoseToWorkspace={handleAddSyntheticFenoseToWorkspace}
                  />
                ) : activePage === 'tsnePage' ? (
                  <TSNEPage
                    key="tsnePage"
                    workspaceFiles={files}
                    onAddSyntheticFenoseToWorkspace={handleAddSyntheticFenoseToWorkspace}
                  />
                ) : !selectedFileId ? (
                  <EmptyState
                    key="empty"
                    isDragActive={isDragActive}
                    hasFiles={files.length > 0}
                    onBrowse={open}
                  />
                ) : (
                  <ChartArea
                    key="chart"
                    data={parsedData?.data}
                    fileName={parsedData?.fileName}
                    loading={loading}
                    compareDataList={compareDataList}
                    availableFiles={files.filter(f => f.id !== selectedFileId)}
                    onCompareSelect={handleCompareSelect}
                    compareFileIds={compareFileIds}
                  />
                )}
              </AnimatePresence>
            )}
          </div>
        </main>
      )}

      {/* Name Input Modal */}
      {isNameModalOpen && (
        <div className="modal-overlay">
          <div className="modal-content">
            <h2 className="modal-title-text">Welcome to NozePlot</h2>
            <p style={{ textAlign: 'center', color: 'var(--text-secondary)' }}>
              Please enter your name to continue.
            </p>
            <form onSubmit={handleNameSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '1rem', width: '100%' }}>
              <input
                type="text"
                className="modal-input"
                placeholder="Your Name"
                value={nameInput}
                onChange={(e) => setNameInput(e.target.value)}
                autoFocus
              />
              <button type="submit" className="modal-btn">
                Start Analyzing
              </button>
            </form>
          </div>
        </div>
      )}

      {/* Global Drag Overlay */}
      {isDragActive && (
        <div className="drag-overlay glass-panel">
          <UploadCloud size={64} color="var(--accent-primary)" />
          <h2>Drop more files to add</h2>
        </div>
      )}
    </div>
  );
}

export default App;
