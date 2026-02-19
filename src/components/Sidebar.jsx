import React, { useRef, useState } from 'react';
import { Folder, FileText, UploadCloud, ChevronRight, BarChart2, Search, Trash2 } from 'lucide-react';
import './Sidebar.css';
const logo = '/logo_noze_circle.png';

const Sidebar = ({ files, onFileSelect, selectedFileId, compareFileIds = [], onUpload, onDeleteFile, onDeleteAllFiles, userName = "User" }) => {
    const fileInputRef = useRef(null);
    const folderInputRef = useRef(null);
    const [searchTerm, setSearchTerm] = useState('');

    const handleUploadClick = () => {
        fileInputRef.current?.click();
    };

    const handleFolderUploadClick = () => {
        folderInputRef.current?.click();
    };

    const filteredFiles = files.filter(f =>
        f.name.toLowerCase().includes(searchTerm.toLowerCase())
    );

    const [hoveredFile, setHoveredFile] = useState(null);
    const [tooltipPos, setTooltipPos] = useState({ top: 0, left: 0 });

    const handleMouseEnter = (e, file) => {
        const rect = e.currentTarget.getBoundingClientRect();
        setTooltipPos({
            top: rect.top + (rect.height / 2),
            left: rect.right + 10
        });
        setHoveredFile(file);
    };

    return (
        <aside className="sidebar">
            {hoveredFile && (
                <div
                    className="fixed-tooltip"
                    style={{
                        position: 'fixed',
                        top: tooltipPos.top,
                        left: tooltipPos.left,
                        transform: 'translateY(-50%)',
                        zIndex: 9999,
                        background: '#0f172a',
                        color: '#f8fafc',
                        padding: '6px 10px',
                        borderRadius: '6px',
                        fontSize: '0.75rem',
                        whiteSpace: 'nowrap',
                        pointerEvents: 'none',
                        boxShadow: '0 4px 12px rgba(0, 0, 0, 0.5)',
                        border: '1px solid rgba(56, 189, 248, 0.2)'
                    }}
                >
                    {hoveredFile.name}
                </div>
            )}
            <div className="sidebar-header">
                <div className="logo">
                    <img src={logo} alt="NozePlots4 Logo" className="logo-icon" />
                    <span>NozePlot</span>
                </div>
            </div>

            <div className="upload-section">
                <button className="btn-primary upload-btn" onClick={handleUploadClick}>
                    <UploadCloud className="icon" size={18} />
                    <span>Upload</span>
                </button>
                <button
                    className="btn-secondary upload-btn-folder"
                    onClick={handleFolderUploadClick}
                    title="Upload Folder"
                >
                    <Folder className="icon" size={18} />
                </button>
                <input
                    type="file"
                    ref={fileInputRef}
                    style={{ display: 'none' }}
                    multiple
                    accept=".csv,.xlsx,.xls"
                    onChange={onUpload}
                />
                <input
                    type="file"
                    ref={folderInputRef}
                    style={{ display: 'none' }}
                    webkitdirectory=""
                    directory=""
                    multiple
                    onChange={onUpload}
                />
            </div>

            {files.length > 0 && (
                <div className="search-box">
                    <Search className="search-icon" size={14} />
                    <input
                        type="text"
                        placeholder="Search..."
                        value={searchTerm}
                        onChange={(e) => setSearchTerm(e.target.value)}
                        className="search-input"
                    />
                </div>
            )}

            <div className="file-list-container">
                <div className="workspace-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '10px' }}>
                    <h3 className="section-title" style={{ margin: 0 }}>Workspace ({files.length})</h3>
                    {files.length > 0 && onDeleteAllFiles && (
                        <button
                            className="delete-all-btn"
                            onClick={(e) => {
                                e.stopPropagation();
                                if (onDeleteAllFiles) onDeleteAllFiles(e);
                            }}
                            title="Delete All Files"
                            style={{
                                background: 'transparent',
                                border: 'none',
                                color: '#ef4444',
                                cursor: 'pointer',
                                padding: '4px',
                                display: 'flex',
                                alignItems: 'center',
                                justifyContent: 'center',
                                borderRadius: '4px',
                                transition: 'background 0.2s',
                            }}
                            onMouseOver={(e) => e.currentTarget.style.background = 'rgba(239, 68, 68, 0.1)'}
                            onMouseOut={(e) => e.currentTarget.style.background = 'transparent'}
                        >
                            <Trash2 size={16} />
                        </button>
                    )}
                </div>
                {files.length === 0 ? (
                    <div className="empty-files">
                        <p>No files uploaded</p>
                    </div>
                ) : (
                    <ul className="file-list">
                        {filteredFiles.map((file) => (
                            <li
                                key={file.id}
                                className={`file-item ${selectedFileId === file.id ? 'active' : ''} ${compareFileIds?.includes(file.id) ? 'compare-active' : ''}`}
                                onClick={(e) => onFileSelect(file.id, e.ctrlKey || e.metaKey)}
                                onMouseEnter={(e) => handleMouseEnter(e, file)}
                                onMouseLeave={() => setHoveredFile(null)}
                            >
                                <div className="file-icon">
                                    <FileText size={16} />
                                </div>
                                <div className="file-details">
                                    <span className="file-name">{file.name}</span>
                                    <span className="file-meta">
                                        {(file.file.size / 1024).toFixed(1)} KB
                                    </span>
                                </div>
                                <button
                                    className="delete-file-btn"
                                    onClick={(e) => {
                                        e.stopPropagation();
                                        if (onDeleteFile) onDeleteFile(e, file.id);
                                    }}
                                    title="Delete file"
                                >
                                    <Trash2 size={14} />
                                </button>
                            </li>
                        ))}
                    </ul>
                )}
            </div>

            <div className="sidebar-footer">
                <div className="user-profile glass-panel">
                    <div className="avatar">{userName.charAt(0).toUpperCase()}</div>
                    <div className="user-info">
                        <span className="name">{userName}</span>
                        <span className="role">Data Analyst</span>
                    </div>
                </div>
            </div>
        </aside>
    );
};

export default Sidebar;
