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
      } catch (error) {
        console.error("Failed to load files from storage:", error);
      }
    };
    loadFiles();
  }, []);

  // Common handler for adding files to processing queue
  const addFiles = useCallback(async (newFiles) => {
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
      type: file.type
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

  const handleManualUpload = (e) => {
    if (e.target.files && e.target.files.length > 0) {
      addFiles(e.target.files);
    }
  };

  const [compareFileIds, setCompareFileIds] = useState([]);
  const [compareDataList, setCompareDataList] = useState([]);

  // Reusable file parser
  const parseFile = (fileObj) => {
    return new Promise((resolve, reject) => {
      if (!fileObj) return reject(new Error("No file provided"));

      const isExcel = fileObj.name.endsWith('.xlsx') || fileObj.name.endsWith('.xls');

      if (isExcel) {
        const reader = new FileReader();
        reader.onload = (e) => {
          try {
            const data = e.target.result;
            const workbook = XLSX.read(data, { type: 'binary', cellDates: true });
            const firstSheetName = workbook.SheetNames[0];
            const worksheet = workbook.Sheets[firstSheetName];
            // Use raw:true so numbers stay as JS numbers (not formatted strings).
            // cellDates:true makes date cells come back as Date objects.
            const rawData = XLSX.utils.sheet_to_json(worksheet, { defval: null, raw: true });

            // Post-process each row: Date → ISO string, numeric strings → float
            const jsonData = rawData.map(row => {
              const clean = {};
              Object.entries(row).forEach(([k, v]) => {
                if (v instanceof Date) {
                  clean[k] = v.toISOString().replace('T', ' ').slice(0, 19);
                } else if (typeof v === 'string') {
                  const n = parseFloat(v);
                  clean[k] = isNaN(n) ? v : n;
                } else {
                  clean[k] = v;
                }
              });
              return clean;
            });

            resolve({
              id: fileObj.id,
              fileName: fileObj.name, // This is now the relative path if uploaded from a folder
              data: jsonData,
              meta: { fields: jsonData.length > 0 ? Object.keys(jsonData[0]) : [] }
            });
          } catch (error) {
            reject(error);
          }
        };
        reader.onerror = (error) => reject(error);
        reader.readAsBinaryString(fileObj.file);
      } else {
        Papa.parse(fileObj.file, {
          header: true,
          dynamicTyping: true,
          skipEmptyLines: true,
          complete: (results) => {
            resolve({
              id: fileObj.id,
              fileName: fileObj.name,  // This is now the relative path if uploaded from a folder
              data: results.data,
              meta: results.meta
            });
          },
          error: (error) => reject(error)
        });
      }
    });
  };

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
    const overlappingCompare = compareFileIds.filter(id => fileIds.includes(id));
    if (overlappingCompare.length > 0) {
      setCompareFileIds(prev => prev.filter(id => !fileIds.includes(id)));
      setCompareDataList(prev => prev.filter(data => !fileIds.includes(data.id)));
    }
  };

  const deleteAllFiles = async (e) => {
    if (e && typeof e.stopPropagation === 'function') {
      e.stopPropagation();
    }

    if (!window.confirm("Are you sure you want to delete ALL files? This cannot be undone.")) {
      return;
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
      />

      {/* Main Content */}
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
