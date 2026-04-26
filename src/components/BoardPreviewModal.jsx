import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { X, FolderOpen, Loader2 } from 'lucide-react';
import './BoardPreviewModal.css';

/** Third-party layout preview bundle (loaded on demand). */
const PREVIEW_ENGINE_MODULE_URL = 'https://kicanvas.org/kicanvas/kicanvas.js';

let previewEngineScriptPromise;

function ensurePreviewEngineLoaded() {
    if (typeof window === 'undefined' || typeof document === 'undefined') {
        return Promise.reject(new Error('Browser only'));
    }
    if (typeof customElements !== 'undefined' && customElements.get('kicanvas-embed')) {
        return Promise.resolve();
    }
    if (!previewEngineScriptPromise) {
        previewEngineScriptPromise = new Promise((resolve, reject) => {
            let s = document.querySelector('script[data-noze-board-preview="1"]');
            if (!s) {
                s = document.createElement('script');
                s.type = 'module';
                s.async = true;
                s.src = PREVIEW_ENGINE_MODULE_URL;
                s.dataset.nozeBoardPreview = '1';
                document.head.appendChild(s);
            }
            const waitForElement = () => {
                let n = 0;
                const tick = () => {
                    if (customElements.get('kicanvas-embed')) {
                        s.setAttribute('data-complete', '1');
                        resolve();
                    } else if (n++ > 120) {
                        reject(
                            new Error(
                                'Preview engine did not start. Try Chrome or Firefox, or check that this site can load external scripts.',
                            ),
                        );
                    } else {
                        setTimeout(tick, 40);
                    }
                };
                tick();
            };
            if (s.getAttribute('data-complete') === '1') {
                waitForElement();
            } else {
                s.addEventListener('load', waitForElement, { once: true });
                s.addEventListener('error', () => reject(new Error('Could not load the board preview engine.')), {
                    once: true,
                });
            }
        });
    }
    return previewEngineScriptPromise;
}

/**
 * Full-screen read-only board/schematic preview (embedded industry-standard viewer).
 */
export default function BoardPreviewModal({ open, onClose }) {
    const [busy, setBusy] = useState(false);
    const [err, setErr] = useState('');
    const [blobUrl, setBlobUrl] = useState('');
    const [fileName, setFileName] = useState('');
    const revokeRef = useRef(null);

    const revokeBlob = useCallback(() => {
        if (revokeRef.current) {
            try {
                URL.revokeObjectURL(revokeRef.current);
            } catch {
                /* */
            }
            revokeRef.current = null;
        }
        setBlobUrl('');
        setFileName('');
    }, []);

    useEffect(() => {
        if (!open) {
            revokeBlob();
            setErr('');
            setBusy(false);
        }
    }, [open, revokeBlob]);

    const onPickFile = useCallback(
        (ev) => {
            const f = ev.target.files?.[0];
            ev.target.value = '';
            if (!f) return;
            const lower = f.name.toLowerCase();
            if (!lower.endsWith('.kicad_pcb') && !lower.endsWith('.kicad_sch')) {
                setErr('Use a board layout (.kicad_pcb) or schematic (.kicad_sch) file.');
                return;
            }
            setErr('');
            setBusy(true);
            revokeBlob();
            ensurePreviewEngineLoaded()
                .then(() => {
                    const url = URL.createObjectURL(f);
                    revokeRef.current = url;
                    setBlobUrl(url);
                    setFileName(f.name);
                })
                .catch((e) => {
                    setErr(e?.message || String(e));
                })
                .finally(() => setBusy(false));
        },
        [revokeBlob],
    );

    if (!open || typeof document === 'undefined') return null;

    return createPortal(
        <div className="kcv-root" role="dialog" aria-modal="true" aria-labelledby="kcv-title">
            <button type="button" className="kcv-backdrop" onClick={onClose} aria-label="Close" />
            <div className="kcv-card">
                <div className="kcv-head">
                    <h2 id="kcv-title">Board & schematic preview</h2>
                    <button type="button" className="kcv-close" onClick={onClose} aria-label="Close">
                        <X size={18} />
                    </button>
                </div>
                <p className="kcv-lead">
                    Open a layout you exported from this studio, or a compatible board/schematic from elsewhere. Pan, zoom, and
                    inspect layers here — read-only; editing stays in PCB Studio.
                </p>
                <div className="kcv-actions">
                    <label className="kcv-file-btn">
                        <FolderOpen size={14} /> Choose file…
                        <input type="file" accept=".kicad_pcb,.kicad_sch" onChange={onPickFile} disabled={busy} />
                    </label>
                </div>
                {busy ? (
                    <p className="kcv-status">
                        <Loader2 size={16} className="kcv-spin" /> Loading preview…
                    </p>
                ) : null}
                {err ? <p className="kcv-err">{err}</p> : null}
                {blobUrl ? (
                    <div className="kcv-viewport">
                        <kicanvas-embed key={blobUrl} src={blobUrl} controls="basic" className="kcv-embed" />
                        <p className="kcv-filetag">{fileName}</p>
                    </div>
                ) : (
                    <p className="kcv-placeholder">No file loaded yet.</p>
                )}
            </div>
        </div>,
        document.body,
    );
}
