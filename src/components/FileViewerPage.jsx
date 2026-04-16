import { useState, useEffect, useRef, useCallback } from 'react';
import { ArrowLeft, FileCode } from 'lucide-react';
import './FileViewerPage.css';
import { fileManager } from '../utils/db';
import { fileBasename, isSpreadsheetEditableWorkspaceFile } from '../utils/workspaceFilename';
import { classifyWorkspaceFileViewer } from '../utils/fileViewerKind';
import FileViewerCodeBlock from './FileViewerCodeBlock';

const MAX_TEXT_CHARS = 1_200_000;

function readBlobAsText(blob) {
    return new Promise((resolve, reject) => {
        const r = new FileReader();
        r.onload = () => resolve(String(r.result ?? ''));
        r.onerror = () => reject(r.error);
        r.readAsText(blob, 'UTF-8');
    });
}

function readBlobAsArrayBuffer(blob) {
    return new Promise((resolve, reject) => {
        const r = new FileReader();
        r.onload = () => resolve(r.result);
        r.onerror = () => reject(r.error);
        r.readAsArrayBuffer(blob);
    });
}

function truncateText(s, max = MAX_TEXT_CHARS) {
    if (s.length <= max) return { text: s, truncated: false };
    return { text: s.slice(0, max) + '\n\n… [truncated — file is larger than viewer limit]', truncated: true };
}

async function loadTextualContent(full, mode) {
    const base = fileBasename(full.name || '').toLowerCase();
    const isJsonName = /\.json$/i.test(base);

    if (isJsonName && full.data != null && typeof full.data === 'object') {
        const hasBlob = full.file && typeof full.file.size === 'number' && full.file.size > 0;
        if (!hasBlob) {
            return JSON.stringify(full.data, null, 2);
        }
    }

    if (mode === 'csv-text') {
        if (typeof full.csvText === 'string' && full.csvText.length) return full.csvText;
        if (typeof full.csvSnapshot === 'string' && full.csvSnapshot.length) return full.csvSnapshot;
    }

    const blob = full.file;
    if (blob && typeof blob.size === 'number' && blob.size > 0) {
        return readBlobAsText(blob);
    }

    if (isJsonName && full.data != null && typeof full.data === 'object') {
        return JSON.stringify(full.data, null, 2);
    }

    throw new Error('No readable text in storage. Re-upload the file if this is an old entry.');
}

export default function FileViewerPage({ fileId, workspaceFiles, onClose, onOpenSpreadsheet }) {
    const [title, setTitle] = useState('');
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(null);
    const [presentation, setPresentation] = useState(null);
    const [textContent, setTextContent] = useState('');
    const [truncated, setTruncated] = useState(false);
    const [blobUrl, setBlobUrl] = useState(null);
    const [docxHtml, setDocxHtml] = useState('');
    const blobUrlRef = useRef(null);

    const stub = workspaceFiles?.find((f) => f.id === fileId && !f.isFolder);
    const stubId = stub?.id;

    const clearMediaUrl = useCallback(() => {
        if (blobUrlRef.current) {
            URL.revokeObjectURL(blobUrlRef.current);
            blobUrlRef.current = null;
        }
        setBlobUrl(null);
    }, []);

    useEffect(
        () => () => {
            if (blobUrlRef.current) {
                URL.revokeObjectURL(blobUrlRef.current);
                blobUrlRef.current = null;
            }
        },
        []
    );

    useEffect(() => {
        let cancelled = false;
        async function run() {
            setError(null);
            setLoading(true);
            setPresentation(null);
            setTextContent('');
            setTruncated(false);
            setDocxHtml('');
            clearMediaUrl();

            if (!fileId) {
                setLoading(false);
                setError('No file selected.');
                return;
            }
            if (!stub) {
                setLoading(false);
                setError('File not found in the workspace.');
                return;
            }

            let full;
            try {
                full = await fileManager.getFile(fileId);
            } catch (e) {
                setLoading(false);
                setError(e?.message || 'Could not load file.');
                return;
            }
            if (!full || full.isFolder) {
                setLoading(false);
                setError('File not found.');
                return;
            }
            if (cancelled) return;

            const label = full.name || stub.name || '';
            setTitle(label);
            const cls = classifyWorkspaceFileViewer(label);
            setPresentation(cls);

            try {
                if (cls.mode === 'image' || cls.mode === 'pdf') {
                    const blob = full.file;
                    if (!blob || !blob.size) throw new Error('No image/PDF bytes in storage.');
                    const url = URL.createObjectURL(blob);
                    if (cancelled) {
                        URL.revokeObjectURL(url);
                        return;
                    }
                    blobUrlRef.current = url;
                    setBlobUrl(url);
                } else if (cls.mode === 'docx') {
                    const blob = full.file;
                    if (!blob || !blob.size) throw new Error('No document bytes in storage.');
                    const ab = await readBlobAsArrayBuffer(blob);
                    const mammoth = await import('mammoth');
                    const { value } = await mammoth.convertToHtml({ arrayBuffer: ab });
                    if (!cancelled) setDocxHtml(value || '<p>(Empty document)</p>');
                } else if (cls.mode === 'doc-legacy') {
                    setTextContent('');
                } else if (cls.mode === 'excel-binary') {
                    setTextContent('');
                } else if (cls.mode === 'unsupported') {
                    setTextContent('');
                } else if (cls.mode === 'plain-text') {
                    const raw = await loadTextualContent(full, 'plain-text');
                    const { text, truncated: t } = truncateText(raw);
                    setTextContent(text);
                    setTruncated(t);
                } else if (cls.mode === 'csv-text') {
                    const raw = await loadTextualContent(full, 'csv-text');
                    const { text, truncated: t } = truncateText(raw);
                    setTextContent(text);
                    setTruncated(t);
                } else if (cls.mode === 'code') {
                    const raw = await loadTextualContent(full, 'code');
                    const { text, truncated: t } = truncateText(raw);
                    setTextContent(text);
                    setTruncated(t);
                }
            } catch (e) {
                if (!cancelled) setError(e?.message || 'Could not read file.');
            } finally {
                if (!cancelled) setLoading(false);
            }
        }
        run();
        return () => {
            cancelled = true;
        };
    }, [fileId, stubId, clearMediaUrl]);

    const shortName = fileBasename(title);
    const canSpreadsheet = isSpreadsheetEditableWorkspaceFile(title) && onOpenSpreadsheet;

    return (
        <div className="file-viewer-page">
            <header className="file-viewer-toolbar">
                <button type="button" className="file-viewer-back" onClick={onClose}>
                    <ArrowLeft size={18} />
                    <span>Back</span>
                </button>
                <div className="file-viewer-title-block">
                    <h1 className="file-viewer-title">
                        <FileCode size={20} style={{ verticalAlign: 'middle', marginRight: 8, opacity: 0.9 }} />
                        File viewer
                    </h1>
                    {shortName ? (
                        <span className="file-viewer-sub" title={title}>
                            {shortName}
                            {presentation?.language ? ` · ${presentation.language}` : ''}
                        </span>
                    ) : null}
                </div>
                <div className="file-viewer-actions">
                    {canSpreadsheet ? (
                        <button
                            type="button"
                            className="file-viewer-secondary"
                            onClick={() => onOpenSpreadsheet(fileId)}
                        >
                            Open in spreadsheet
                        </button>
                    ) : null}
                </div>
            </header>

            {error ? <div className="file-viewer-banner file-viewer-banner--error">{error}</div> : null}
            {truncated ? (
                <div className="file-viewer-banner file-viewer-banner--warn">Preview truncated for size.</div>
            ) : null}
            {loading ? <div className="file-viewer-loading">Loading…</div> : null}

            {!loading && !error && presentation?.mode === 'image' && blobUrl ? (
                <div className="file-viewer-frame file-viewer-frame--media">
                    <img src={blobUrl} alt={shortName || 'Image'} className="file-viewer-img" />
                </div>
            ) : null}

            {!loading && !error && presentation?.mode === 'pdf' && blobUrl ? (
                <div className="file-viewer-frame file-viewer-frame--media">
                    <iframe title={shortName || 'PDF'} src={blobUrl} className="file-viewer-pdf" />
                </div>
            ) : null}

            {!loading && !error && presentation?.mode === 'docx' ? (
                <div className="file-viewer-frame file-viewer-docx" dangerouslySetInnerHTML={{ __html: docxHtml }} />
            ) : null}

            {!loading && !error && presentation?.mode === 'doc-legacy' ? (
                <div className="file-viewer-banner">
                    Legacy <code>.doc</code> (binary) is not previewed here. Export to <code>.docx</code> or PDF and
                    re-upload, or download the file from the sidebar.
                </div>
            ) : null}

            {!loading && !error && presentation?.mode === 'excel-binary' ? (
                <div className="file-viewer-banner">
                    Excel workbooks are not rendered in the viewer. Use charts from the dashboard, download as CSV
                    from the sidebar, or convert to CSV and upload.
                </div>
            ) : null}

            {!loading && !error && presentation?.mode === 'unsupported' ? (
                <div className="file-viewer-banner">
                    No preview for this file type. Download it from the sidebar or convert to a supported format
                    (text, code, JSON, PDF, image, .docx).
                </div>
            ) : null}

            {!loading && !error && presentation?.mode === 'plain-text' ? (
                <div className="file-viewer-code-wrap">
                    <pre className="file-viewer-plain">{textContent}</pre>
                </div>
            ) : null}

            {!loading && !error && (presentation?.mode === 'csv-text' || presentation?.mode === 'code') ? (
                <div className="file-viewer-code-wrap">
                    <FileViewerCodeBlock code={textContent} language={presentation.language} showLineNumbers />
                </div>
            ) : null}
        </div>
    );
}
