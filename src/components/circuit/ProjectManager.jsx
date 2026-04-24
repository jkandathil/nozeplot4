import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { X, Trash2, Copy, Pencil, Check, FilePlus, FolderOpen, Upload } from 'lucide-react';
import {
    listProjects, loadProject, deleteProject, renameProject,
    duplicateProject, importProjectJson, formatUpdatedAt,
} from '../../circuit/projects.js';

/**
 * Project manager modal.
 *
 * Renders the full list of locally-saved projects with per-row
 * actions (open, rename, duplicate, delete) and a top action bar
 * for "New" and "Import …". Portals to <body> so it escapes the
 * `.main-content` stacking context.
 *
 * Props:
 *   currentId — highlight the currently-loaded slot
 *   onOpen    — called with a full project (doc + metadata) when
 *               the user picks one to load
 *   onNew     — create a fresh project; parent decides the default
 *               name and persists via saveProject
 *   onClose   — dismiss the modal
 */
export default function ProjectManager({ currentId, onOpen, onNew, onClose }) {
    const [projects, setProjects] = useState(() => listProjects());
    const [editingId, setEditingId] = useState(null);
    const [editName, setEditName] = useState('');
    const [error, setError] = useState('');
    const [now, setNow] = useState(Date.now());
    const fileInputRef = useRef(null);

    // Refresh the relative-time labels every 30s so "just now"
    // decays to "1 min ago" without a full re-render cycle.
    useEffect(() => {
        const t = setInterval(() => setNow(Date.now()), 30_000);
        return () => clearInterval(t);
    }, []);

    const refresh = useCallback(() => setProjects(listProjects()), []);

    useEffect(() => {
        const onKey = (ev) => { if (ev.key === 'Escape') onClose?.(); };
        document.addEventListener('keydown', onKey);
        return () => document.removeEventListener('keydown', onKey);
    }, [onClose]);

    const handleOpen = useCallback((id) => {
        const full = loadProject(id);
        if (!full) { setError('Project could not be loaded — it may have been deleted.'); return; }
        onOpen?.(full);
    }, [onOpen]);

    const handleDelete = useCallback((p) => {
        const ok = window.confirm(`Delete "${p.name}"? This cannot be undone.`);
        if (!ok) return;
        deleteProject(p.id);
        refresh();
    }, [refresh]);

    const handleDuplicate = useCallback((p) => {
        const copy = duplicateProject(p.id);
        if (copy) refresh();
    }, [refresh]);

    const startRename = useCallback((p) => {
        setEditingId(p.id);
        setEditName(p.name);
        setError('');
    }, []);

    const commitRename = useCallback(() => {
        if (!editingId) return;
        const name = editName.trim();
        if (!name) { setError('Name cannot be empty.'); return; }
        renameProject(editingId, name);
        setEditingId(null);
        setEditName('');
        refresh();
    }, [editingId, editName, refresh]);

    const handleImport = useCallback(async (file) => {
        setError('');
        try {
            const text = await file.text();
            const json = JSON.parse(text);
            const imported = importProjectJson(json);
            refresh();
            onOpen?.(imported);
        } catch (e) {
            setError(`Import failed: ${e?.message || e}`);
        }
    }, [onOpen, refresh]);

    const onFilePicked = useCallback((ev) => {
        const file = ev.target.files?.[0];
        if (file) handleImport(file);
        ev.target.value = ''; // allow re-selecting the same file
    }, [handleImport]);

    const sorted = useMemo(() => projects, [projects]);

    if (typeof document === 'undefined') return null;

    return createPortal(
        <div className="cs-projects-modal" role="dialog" aria-modal="true">
            <div className="cs-projects-backdrop" onClick={onClose} aria-hidden="true" />
            <div className="cs-projects-card">
                <div className="cs-projects-head">
                    <FolderOpen size={16} />
                    <div className="cs-projects-title">My circuits</div>
                    <div className="cs-projects-spacer" />
                    <button
                        className="cs-projects-actionbtn"
                        onClick={() => { onNew?.(); }}
                        title="Create a new blank project"
                    >
                        <FilePlus size={14} /> New
                    </button>
                    <button
                        className="cs-projects-actionbtn"
                        onClick={() => fileInputRef.current?.click()}
                        title="Import a .noze.json project file"
                    >
                        <Upload size={14} /> Import…
                    </button>
                    <input
                        ref={fileInputRef}
                        type="file"
                        accept=".json,.noze,application/json"
                        style={{ display: 'none' }}
                        onChange={onFilePicked}
                    />
                    <button
                        className="cs-projects-closebtn"
                        onClick={onClose}
                        title="Close (Esc)"
                    >
                        <X size={16} />
                    </button>
                </div>

                {error && <div className="cs-projects-error">{error}</div>}

                <div className="cs-projects-body">
                    {sorted.length === 0 ? (
                        <div className="cs-projects-empty">
                            <div>No saved projects yet.</div>
                            <div className="cs-projects-empty-hint">
                                Hit <b>New</b> above to start a fresh sheet, or use
                                <b> Import</b> to load a <code>.noze.json</code> file.
                            </div>
                        </div>
                    ) : (
                        <ul className="cs-projects-list">
                            {sorted.map((p) => (
                                <li
                                    key={p.id}
                                    className={`cs-projects-row${p.id === currentId ? ' is-current' : ''}`}
                                >
                                    <div className="cs-projects-row-main"
                                         onDoubleClick={() => handleOpen(p.id)}>
                                        {editingId === p.id ? (
                                            <form
                                                className="cs-projects-rename"
                                                onSubmit={(e) => { e.preventDefault(); commitRename(); }}
                                            >
                                                <input
                                                    autoFocus
                                                    value={editName}
                                                    onChange={(e) => setEditName(e.target.value)}
                                                    onBlur={commitRename}
                                                    onKeyDown={(e) => {
                                                        if (e.key === 'Escape') { setEditingId(null); setEditName(''); }
                                                    }}
                                                    spellCheck={false}
                                                />
                                                <button type="submit" className="cs-projects-iconbtn" title="Save name">
                                                    <Check size={14} />
                                                </button>
                                            </form>
                                        ) : (
                                            <>
                                                <button
                                                    className="cs-projects-name"
                                                    onClick={() => handleOpen(p.id)}
                                                    title="Open this project"
                                                >
                                                    {p.name}
                                                </button>
                                                <div className="cs-projects-meta">
                                                    <span>{p.componentCount || 0} parts</span>
                                                    <span>·</span>
                                                    <span>updated {formatUpdatedAt(p.updatedAt, now)}</span>
                                                    {p.id === currentId && (
                                                        <>
                                                            <span>·</span>
                                                            <span className="cs-projects-tag">open</span>
                                                        </>
                                                    )}
                                                </div>
                                            </>
                                        )}
                                    </div>
                                    <div className="cs-projects-rowactions">
                                        <button
                                            className="cs-projects-iconbtn"
                                            onClick={() => startRename(p)}
                                            title="Rename"
                                        >
                                            <Pencil size={14} />
                                        </button>
                                        <button
                                            className="cs-projects-iconbtn"
                                            onClick={() => handleDuplicate(p)}
                                            title="Duplicate"
                                        >
                                            <Copy size={14} />
                                        </button>
                                        <button
                                            className="cs-projects-iconbtn cs-projects-iconbtn-danger"
                                            onClick={() => handleDelete(p)}
                                            title="Delete"
                                        >
                                            <Trash2 size={14} />
                                        </button>
                                    </div>
                                </li>
                            ))}
                        </ul>
                    )}
                </div>

                <div className="cs-projects-foot">
                    Projects are stored in your browser's local storage.
                    Use <b>Export</b> in the File menu to back them up.
                </div>
            </div>
        </div>,
        document.body,
    );
}
