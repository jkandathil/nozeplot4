import React, { useMemo, useState, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { X, Download, ExternalLink, Search } from 'lucide-react';
import {
    BUNDLED_MODEL_PACKS,
    REMOTE_MODEL_PACKS,
    searchModelCatalog,
    resolvePublicAssetUrl,
    fetchTextFromUrl,
} from '../../circuit/modelCatalog.js';

function newLibId() {
    return (typeof crypto !== 'undefined' && crypto.randomUUID)
        ? crypto.randomUUID()
        : `lib_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}

/**
 * Search curated free packs + try arbitrary HTTPS URLs (CORS permitting).
 * Parent mounts this only when visible.
 *
 * Props:
 *   onClose — dismiss
 *   onAddLibrary — ({ id, name, content }) merged into project spiceLibs
 *   onQueueIncludeLine — (filename) append .include after drawer sync (optional)
 */
export default function ModelLibraryModal({
    onClose,
    onAddLibrary,
    onQueueIncludeLine,
    netlistTextForInclude = '',
}) {
    const [q, setQ] = useState('');
    const [urlDraft, setUrlDraft] = useState('');
    const [busy, setBusy] = useState(false);
    const [err, setErr] = useState('');
    const [addInclude, setAddInclude] = useState(true);

    const filtered = useMemo(() => searchModelCatalog(q), [q]);

    const appendIncludeAfterOpen = useCallback((filename) => {
        if (!onQueueIncludeLine || !filename) return;
        const needle = `.include "${filename}"`;
        const base = netlistTextForInclude || '';
        if (base.includes(needle)) return;
        onQueueIncludeLine(filename);
    }, [onQueueIncludeLine, netlistTextForInclude]);

    const loadBundled = useCallback(async (pack) => {
        setBusy(true);
        setErr('');
        try {
            const href = resolvePublicAssetUrl(pack.path);
            const text = await fetchTextFromUrl(href);
            onAddLibrary({ id: newLibId(), name: pack.suggestedFilename, content: text });
            if (addInclude) appendIncludeAfterOpen(pack.suggestedFilename);
            onClose();
        } catch (e) {
            setErr(e?.message || String(e));
        } finally {
            setBusy(false);
        }
    }, [onAddLibrary, addInclude, appendIncludeAfterOpen, onClose]);

    const loadRemoteRow = useCallback(async (pack) => {
        setBusy(true);
        setErr('');
        try {
            const text = await fetchTextFromUrl(pack.fetchUrl);
            onAddLibrary({ id: newLibId(), name: pack.suggestedFilename, content: text });
            if (addInclude) appendIncludeAfterOpen(pack.suggestedFilename);
            onClose();
        } catch (e) {
            setErr(e?.message || String(e));
        } finally {
            setBusy(false);
        }
    }, [onAddLibrary, addInclude, appendIncludeAfterOpen, onClose]);

    const loadFromPastedUrl = useCallback(async () => {
        setBusy(true);
        setErr('');
        try {
            const text = await fetchTextFromUrl(urlDraft);
            const nameGuess = (() => {
                try {
                    const u = new URL(urlDraft.trim());
                    const base = u.pathname.split('/').filter(Boolean).pop() || 'imported.inc';
                    return /\.(inc|cir|lib|txt|spi)$/i.test(base) ? base : `${base}.inc`;
                } catch {
                    return 'imported.inc';
                }
            })();
            onAddLibrary({ id: newLibId(), name: nameGuess, content: text });
            if (addInclude) appendIncludeAfterOpen(nameGuess);
            onClose();
        } catch (e) {
            setErr(
                `${e?.message || e} — Many vendor sites block browser downloads (no CORS). `
                + 'Try a raw GitHub / jsDelivr link, or paste the text into a manual library row.',
            );
        } finally {
            setBusy(false);
        }
    }, [urlDraft, onAddLibrary, addInclude, appendIncludeAfterOpen, onClose]);

    if (typeof document === 'undefined') return null;

    return createPortal(
        <div className="cs-model-lib-root" role="dialog" aria-modal="true" aria-labelledby="cs-model-lib-title">
            <button type="button" className="cs-model-lib-backdrop" onClick={onClose} aria-label="Close" />
            <div className="cs-model-lib-card">
                <div className="cs-model-lib-head">
                    <h2 id="cs-model-lib-title">Model library</h2>
                    <button type="button" className="cs-model-lib-x" onClick={onClose} aria-label="Close">
                        <X size={18} />
                    </button>
                </div>
                <p className="cs-model-lib-lead">
                    Search curated <strong>free</strong> packs shipped with this app (same-origin download), or paste a{' '}
                    <strong>raw HTTPS URL</strong> if the host allows CORS. Simulation still uses Circuit Studio’s built-in
                    D/Q/M equations — exotic BSIM decks need manual reduction.
                </p>
                <label className="cs-model-lib-search">
                    <Search size={14} />
                    <input
                        type="search"
                        value={q}
                        onChange={(e) => setQ(e.target.value)}
                        placeholder="Part number, .model name, tag, or keyword…"
                        spellCheck={false}
                    />
                </label>
                <p className="cs-model-lib-hint cs-model-lib-hint-tight">
                    Example: type <code>2N3904</code> or <code>1N914</code> to find packs. After download, reference the{' '}
                    <strong>SPICE .model name</strong> from the file (e.g. <code>Q2N3904</code>, <code>D1N914</code>) in your
                    netlist, <strong>Apply</strong> the netlist source if it changed, then <strong>Run</strong>.
                </p>
                <label className="cs-model-lib-check">
                    <input type="checkbox" checked={addInclude} onChange={(e) => setAddInclude(e.target.checked)} />
                    After download, append <code>.include &quot;filename&quot;</code> to the netlist source (opens drawer)
                </label>
                {err && <div className="cs-model-lib-err">{err}</div>}
                <div className="cs-model-lib-body">
                    <div className="cs-model-lib-col">
                        <h3>Curated packs</h3>
                        <ul className="cs-model-lib-list">
                            {filtered.bundled.map((p) => (
                                <li key={p.id}>
                                    <div className="cs-model-lib-item-title">{p.title}</div>
                                    <div className="cs-model-lib-item-meta">{p.tags.join(' · ')}</div>
                                    {p.partNumbers?.length > 0 && (
                                        <div className="cs-model-lib-item-parts">
                                            <span className="cs-model-lib-item-parts-label">Part # / names:</span>{' '}
                                            {p.partNumbers.join(', ')}
                                        </div>
                                    )}
                                    <div className="cs-model-lib-item-desc">{p.description}</div>
                                    <div className="cs-model-lib-item-license">{p.license}</div>
                                    <div className="cs-model-lib-item-actions">
                                        <button
                                            type="button"
                                            className="cs-topbtn cs-topbtn-primary"
                                            disabled={busy}
                                            onClick={() => loadBundled(p)}
                                        >
                                            <Download size={12} /> Download &amp; add
                                        </button>
                                        <a
                                            className="cs-topbtn"
                                            href={resolvePublicAssetUrl(p.path)}
                                            target="_blank"
                                            rel="noreferrer"
                                        >
                                            <ExternalLink size={12} /> Open raw
                                        </a>
                                    </div>
                                </li>
                            ))}
                        </ul>
                        {filtered.bundled.length === 0 && <p className="cs-model-lib-empty">No curated matches.</p>}

                        {REMOTE_MODEL_PACKS.length > 0 && (
                            <>
                                <h3 className="cs-model-lib-h3">Mirrors</h3>
                                <ul className="cs-model-lib-list">
                                    {filtered.remote.map((p) => (
                                        <li key={p.id}>
                                            <div className="cs-model-lib-item-title">{p.title}</div>
                                            <div className="cs-model-lib-item-desc">{p.description}</div>
                                            <div className="cs-model-lib-item-actions">
                                                <button
                                                    type="button"
                                                    className="cs-topbtn cs-topbtn-primary"
                                                    disabled={busy}
                                                    onClick={() => loadRemoteRow(p)}
                                                >
                                                    <Download size={12} /> Fetch
                                                </button>
                                            </div>
                                        </li>
                                    ))}
                                </ul>
                            </>
                        )}
                    </div>
                    <div className="cs-model-lib-col cs-model-lib-col-url">
                        <h3>From URL</h3>
                        <p className="cs-model-lib-hint">
                            Paste a link to a <strong>raw</strong> <code>.inc</code> / <code>.lib</code> / <code>.cir</code> file
                            (e.g. GitHub <code>raw.githubusercontent.com/…</code>).
                        </p>
                        <textarea
                            className="cs-model-lib-url"
                            value={urlDraft}
                            onChange={(e) => setUrlDraft(e.target.value)}
                            rows={3}
                            spellCheck={false}
                            placeholder="https://…"
                        />
                        <button
                            type="button"
                            className="cs-topbtn cs-topbtn-primary"
                            disabled={busy || !urlDraft.trim()}
                            onClick={() => loadFromPastedUrl()}
                        >
                            <Download size={12} /> Try download
                        </button>
                    </div>
                </div>
            </div>
        </div>,
        document.body,
    );
}
