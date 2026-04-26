import React, { useState } from 'react';
import { createPortal } from 'react-dom';
import { X, FileJson, FileCode, Link2, Package } from 'lucide-react';
import {
    parseNozeFootprintJson,
    parseKiCadModFootprint,
    fetchFootprintText,
} from '../pcb/footprintImport.js';
import { addFootprint } from '../pcb/footprintLib.js';

const SAMPLE_JSON = `{
  "id": "USER_LED_0603",
  "name": "LED 0603 hand place",
  "family": "D",
  "pads": [
    { "id": "A", "num": "1", "x": -0.4, "y": 0, "w": 0.5, "h": 0.8 },
    { "id": "K", "num": "2", "x": 0.4, "y": 0, "w": 0.5, "h": 0.8 }
  ],
  "silk": []
}`;

export default function FootprintImportModal({ onClose, onLibraryChanged }) {
    const [tab, setTab] = useState('json');
    const [text, setText] = useState('');
    const [url, setUrl] = useState('');
    const [err, setErr] = useState('');
    const [busy, setBusy] = useState(false);

    const applyDef = (def) => {
        addFootprint(def);
        onLibraryChanged?.();
        onClose();
    };

    const handleParseJson = () => {
        setErr('');
        try {
            applyDef(parseNozeFootprintJson(text.trim()));
        } catch (e) {
            setErr(e?.message || String(e));
        }
    };

    const handleParseKicad = () => {
        setErr('');
        try {
            applyDef(parseKiCadModFootprint(text.trim()));
        } catch (e) {
            setErr(e?.message || String(e));
        }
    };

    const handleFetchUrl = async () => {
        setErr('');
        setBusy(true);
        try {
            const body = await fetchFootprintText(url.trim());
            const t = body.trim();
            if (t.startsWith('{')) applyDef(parseNozeFootprintJson(t));
            else applyDef(parseKiCadModFootprint(t));
        } catch (e) {
            setErr(
                (e?.message || String(e)) +
                    ' — Many hosts block browser CORS; try pasting file contents instead.',
            );
        } finally {
            setBusy(false);
        }
    };

    return createPortal(
        <div
            className="pcb-import-overlay"
            role="dialog"
            aria-modal="true"
            aria-labelledby="pcb-import-title"
            onClick={(e) => {
                if (e.target === e.currentTarget) onClose();
            }}
        >
            <div className="pcb-import-card">
                <div className="pcb-import-head">
                    <h2 id="pcb-import-title">Import footprint</h2>
                    <button type="button" className="pcb-import-close" onClick={onClose} aria-label="Close">
                        <X size={18} />
                    </button>
                </div>
                <p className="pcb-import-lead">
                    Grow your library, then place parts on the board. Use JSON (Noze shape), paste a footprint module{' '}
                    (<code>.kicad_mod</code>), or fetch a raw file when CORS allows.
                </p>
                <div className="pcb-import-tabs">
                    <button type="button" className={tab === 'json' ? 'is-on' : ''} onClick={() => setTab('json')}>
                        <FileJson size={14} /> JSON
                    </button>
                    <button type="button" className={tab === 'kicad' ? 'is-on' : ''} onClick={() => setTab('kicad')}>
                        <FileCode size={14} /> Footprint module
                    </button>
                    <button type="button" className={tab === 'url' ? 'is-on' : ''} onClick={() => setTab('url')}>
                        <Link2 size={14} /> URL
                    </button>
                    <button type="button" className={tab === 'sample' ? 'is-on' : ''} onClick={() => setTab('sample')}>
                        <Package size={14} /> Sample
                    </button>
                </div>
                {tab === 'json' && (
                    <>
                        <label className="pcb-import-label">Noze / custom JSON (id, name, pads[])</label>
                        <textarea className="pcb-import-ta" value={text} onChange={(e) => setText(e.target.value)} rows={12} spellCheck={false} />
                        <button type="button" className="pcb-import-primary" onClick={handleParseJson}>
                            Parse & add to library
                        </button>
                    </>
                )}
                {tab === 'kicad' && (
                    <>
                        <label className="pcb-import-label">Paste module text — pads with (at) and (size), e.g. .kicad_mod</label>
                        <textarea className="pcb-import-ta" value={text} onChange={(e) => setText(e.target.value)} rows={14} spellCheck={false} />
                        <button type="button" className="pcb-import-primary" onClick={handleParseKicad}>
                            Parse & add to library
                        </button>
                    </>
                )}
                {tab === 'url' && (
                    <>
                        <label className="pcb-import-label">Direct URL to .json or .kicad_mod (must allow CORS)</label>
                        <input className="pcb-import-input" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://…" />
                        <button type="button" className="pcb-import-primary" disabled={busy} onClick={() => void handleFetchUrl()}>
                            {busy ? 'Fetching…' : 'Download & import'}
                        </button>
                    </>
                )}
                {tab === 'sample' && (
                    <>
                        <p className="pcb-import-lead">Load a minimal LED footprint JSON into the editor, then import.</p>
                        <button
                            type="button"
                            className="pcb-import-secondary"
                            onClick={() => {
                                setText(SAMPLE_JSON);
                                setTab('json');
                            }}
                        >
                            Insert sample JSON
                        </button>
                    </>
                )}
                {err ? <p className="pcb-import-err">{err}</p> : null}
            </div>
        </div>,
        document.body,
    );
}
