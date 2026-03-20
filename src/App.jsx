import { useState, useCallback, useEffect } from 'react';
import { useDropzone } from 'react-dropzone';
import Papa from 'papaparse';
import * as XLSX from 'xlsx';
import {
  LayoutDashboard,
  FileText,
  Settings,
  UploadCloud,
  BarChart2,
  Folder
} from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
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
import GasSystemDesignPage from './components/gas-design/GasSystemDesignPage';
import Calculator from './components/Calculator';
import MLStudioPage from './components/MLStudioPage';
import { Calculator as CalcIcon, FlaskConical, Network } from 'lucide-react';

import FolderCompareAromaPage from './components/FolderCompareAromaPage';
import { parseFile } from './utils/fileParser';

function App() {
  const [files, setFiles] = useState([]);
  const [selectedFileId, setSelectedFileId] = useState(null);
  const [parsedData, setParsedData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [activePage, setActivePage] = useState('dashboard'); // 'dashboard' | 'normalize'
  const [isCalculatorOpen, setIsCalculatorOpen] = useState(false);

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
        const savedFiles = await fileManager.getAllFiles();
        if (savedFiles && savedFiles.length > 0) {
          setFiles(savedFiles);
        }

        // Restore Workspace Session mappings seamlessly
        const restoredStateStr = localStorage.getItem('noze_restored_state');
        if (restoredStateStr && savedFiles) {
          try {
            const restoredState = JSON.parse(restoredStateStr);
            if (restoredState.activePage) setActivePage(restoredState.activePage);

            if (restoredState.selectedFileId) {
              const mainFileObj = savedFiles.find(f => f.id === restoredState.selectedFileId);
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
                }
              }
            }

            if (restoredState.compareFileIds && Array.isArray(restoredState.compareFileIds)) {
              setCompareFileIds(restoredState.compareFileIds);
              const restoredComparables = [];
              for (const cId of restoredState.compareFileIds) {
                const cfile = savedFiles.find(f => f.id === cId);
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

    const formattedFiles = validFiles.map(file => ({
      id: Math.random().toString(36).substr(2, 9),
      name: file.webkitRelativePath || file.name,
      path: file.webkitRelativePath || file.name,
      file: file,
      type: file.type,
      folderId: targetFolderId
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
          userName={userName}
          activePage={activePage}
          onPageChange={setActivePage}
          isCalculatorOpen={isCalculatorOpen}
          setIsCalculatorOpen={setIsCalculatorOpen}
          onCreateFolder={handleCreateFolder}
          onDeleteFolder={handleDeleteFolder}
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
            <AnimatePresence mode="wait">
              {activePage === 'gasDesign' ? (
                <GasSystemDesignPage key="gasDesign" />
              ) : activePage === 'gasMath' ? (
                <GasDilutionMathPage key="gasMath" />
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
              ) : activePage === 'recoveryAnalysis' ? (
                <RecoveryAnalysisPage
                  key="recoveryAnalysis"
                  data={parsedData?.data}
                  fileName={parsedData?.fileName}
                  compareDataList={compareDataList}
                  availableFiles={files}
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
                <CSVPlotterPage
                  key="csvPlotter"
                />
              ) : activePage === 'mlStudio' ? (
                <MLStudioPage
                  key="mlStudio"
                  data={parsedData?.data}
                  fileName={parsedData?.fileName}
                  compareDataList={compareDataList}
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

      {/* Floating Calculator */}
      <Calculator isOpen={isCalculatorOpen} onClose={() => setIsCalculatorOpen(false)} />
    </div>
  );
}

export default App;
