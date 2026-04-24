/**
 * Circuit Studio project storage.
 *
 * Projects live in the browser's `localStorage` under these keys:
 *
 *   circuitStudio:projects         → JSON array of light metadata
 *                                    { id, name, updatedAt, createdAt,
 *                                      componentCount }
 *   circuitStudio:project:<id>     → full project blob
 *                                    { id, name, doc, analysis,
 *                                      tranOverride, createdAt,
 *                                      updatedAt, selectedSignals? }
 *   circuitStudio:currentProjectId → pointer to the slot the top-bar
 *                                    Save button writes to.
 *
 * We deliberately avoid IndexedDB / Dexie here — projects are tiny
 * (a few KB of schematic JSON) and keeping the store synchronous
 * makes the UI glue (autosave, Save As…) straightforward. If
 * simulation-result archives ever push us past a few MB we can
 * migrate selectively.
 *
 * The first call to `loadInitialProject()` performs a one-shot
 * migration from the previous single-slot key (`circuitStudio:doc`)
 * so users don't lose their in-progress design when this lands.
 */

const INDEX_KEY = 'circuitStudio:projects';
const PROJECT_PREFIX = 'circuitStudio:project:';
const CURRENT_KEY = 'circuitStudio:currentProjectId';
const LEGACY_DOC_KEY = 'circuitStudio:doc';

/** Current project-file format version. Bump when the on-disk shape changes. */
export const PROJECT_FORMAT = 'noze-circuit';
export const PROJECT_VERSION = 1;

/* --------------------------- helpers --------------------------- */

function safeLS() {
    try {
        if (typeof localStorage === 'undefined') return null;
        return localStorage;
    } catch { return null; }
}

function readJSON(ls, key, fallback) {
    try {
        const raw = ls.getItem(key);
        if (raw == null) return fallback;
        return JSON.parse(raw);
    } catch { return fallback; }
}

function writeJSON(ls, key, value) {
    ls.setItem(key, JSON.stringify(value));
}

function newId() {
    return 'p_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
}

function metaOf(project) {
    return {
        id: project.id,
        name: project.name,
        createdAt: project.createdAt,
        updatedAt: project.updatedAt,
        componentCount: project.doc?.components?.length || 0,
    };
}

/* ----------------------------- index -------------------------- */

/**
 * Return light metadata for every stored project, newest first.
 * Each entry contains only { id, name, updatedAt, createdAt,
 * componentCount } — enough to render the project manager without
 * eagerly deserialising every doc.
 */
export function listProjects() {
    const ls = safeLS();
    if (!ls) return [];
    const idx = readJSON(ls, INDEX_KEY, []);
    // Sort by updatedAt desc so the picker's default scan order is
    // most-recent-first.
    return [...idx].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}

/** Fetch a full project by id, or null if missing. */
export function loadProject(id) {
    const ls = safeLS();
    if (!ls || !id) return null;
    return readJSON(ls, PROJECT_PREFIX + id, null);
}

/**
 * Persist a project. If `project.id` is missing a new id is minted.
 * Returns the saved project (with id + timestamps filled in).
 */
export function saveProject(project) {
    const ls = safeLS();
    if (!ls) throw new Error('localStorage unavailable');
    if (!project || !project.doc) throw new Error('saveProject: project.doc is required');

    const id = project.id || newId();
    const now = Date.now();
    const createdAt = project.createdAt || now;
    const saved = {
        ...project,
        id,
        name: project.name || 'Untitled',
        createdAt,
        updatedAt: now,
    };

    writeJSON(ls, PROJECT_PREFIX + id, saved);

    // Update the metadata index atomically.
    const idx = readJSON(ls, INDEX_KEY, []);
    const meta = metaOf(saved);
    const existing = idx.findIndex((p) => p.id === id);
    if (existing >= 0) idx[existing] = meta;
    else idx.push(meta);
    writeJSON(ls, INDEX_KEY, idx);

    return saved;
}

/** Remove a project and its index entry. Safe on unknown ids. */
export function deleteProject(id) {
    const ls = safeLS();
    if (!ls || !id) return;
    ls.removeItem(PROJECT_PREFIX + id);
    const idx = readJSON(ls, INDEX_KEY, []).filter((p) => p.id !== id);
    writeJSON(ls, INDEX_KEY, idx);
    if (getCurrentProjectId() === id) setCurrentProjectId(null);
}

/**
 * Rename a project. Returns the updated project, or null if missing.
 */
export function renameProject(id, newName) {
    const p = loadProject(id);
    if (!p) return null;
    return saveProject({ ...p, name: String(newName || 'Untitled').slice(0, 128) });
}

/**
 * Duplicate a project. The copy gets a new id and an auto-suffixed
 * name if `newName` is omitted. Returns the new project, or null.
 */
export function duplicateProject(id, newName) {
    const p = loadProject(id);
    if (!p) return null;
    const name = newName || uniqueName(p.name + ' copy');
    const clone = {
        ...p,
        id: null,
        name,
        createdAt: Date.now(),
    };
    return saveProject(clone);
}

/* ------------------------- current project ------------------- */

export function getCurrentProjectId() {
    const ls = safeLS();
    if (!ls) return null;
    try { return ls.getItem(CURRENT_KEY) || null; } catch { return null; }
}

export function setCurrentProjectId(id) {
    const ls = safeLS();
    if (!ls) return;
    if (id) ls.setItem(CURRENT_KEY, id);
    else ls.removeItem(CURRENT_KEY);
}

/* --------------------- naming + utilities -------------------- */

/**
 * Produce a name that doesn't collide with any existing project's
 * name — appends " (2)", " (3)", … as needed.
 */
export function uniqueName(base) {
    const existing = new Set(listProjects().map((p) => p.name));
    if (!existing.has(base)) return base;
    for (let i = 2; i < 1000; i++) {
        const candidate = `${base} (${i})`;
        if (!existing.has(candidate)) return candidate;
    }
    return `${base} (${Date.now()})`;
}

/**
 * Format an epoch millis timestamp for display in the project list.
 * Uses short relative form for recent items and a locale date for
 * older ones so the list glances well.
 */
export function formatUpdatedAt(ts, now = Date.now()) {
    if (!ts) return '';
    const d = now - ts;
    if (d < 30_000) return 'just now';
    if (d < 60 * 60_000) return `${Math.round(d / 60_000)} min ago`;
    if (d < 24 * 60 * 60_000) return `${Math.round(d / (60 * 60_000))} hr ago`;
    if (d < 7 * 24 * 60 * 60_000) return `${Math.round(d / (24 * 60 * 60_000))} days ago`;
    try { return new Date(ts).toLocaleDateString(); } catch { return ''; }
}

/* ------------------------ legacy migration ------------------ */

/**
 * First-run migration: if the user has a schematic saved under the
 * old single-slot key and no modern projects yet, import it as
 * "Recovered design" so nothing is lost. Returns the imported
 * project, or null if nothing to migrate.
 */
export function migrateLegacySingleSlot() {
    const ls = safeLS();
    if (!ls) return null;
    try {
        if (listProjects().length > 0) return null;
        const raw = ls.getItem(LEGACY_DOC_KEY);
        if (!raw) return null;
        const doc = JSON.parse(raw);
        if (!doc || !Array.isArray(doc.components)) return null;
        const project = saveProject({
            name: 'Recovered design',
            doc,
            analysis: 'tran',
        });
        setCurrentProjectId(project.id);
        // Keep the legacy key for one more session as a safety net.
        // If the user is happy we can drop it on the next release.
        return project;
    } catch { return null; }
}

/**
 * Boot-time entry point for CircuitStudioPage. Returns whichever
 * project the user should see first:
 *   1. The slot pointed to by `currentProjectId` (if still valid).
 *   2. The most-recently-updated project.
 *   3. A freshly-migrated legacy doc.
 *   4. null (→ caller should show the blank/home state).
 */
export function loadInitialProject() {
    migrateLegacySingleSlot();
    const cur = getCurrentProjectId();
    if (cur) {
        const p = loadProject(cur);
        if (p) return p;
    }
    const idx = listProjects();
    if (idx.length > 0) {
        const p = loadProject(idx[0].id);
        if (p) {
            setCurrentProjectId(p.id);
            return p;
        }
    }
    return null;
}

/* ------------------ import from file ------------------------ */

/**
 * Accept an in-memory JSON object (typically from a dropped
 * `.noze.json` file) and persist it as a new project. Validates the
 * envelope so stray JSON doesn't create a corrupt slot.
 */
export function importProjectJson(json, { renameTo } = {}) {
    if (!json || typeof json !== 'object') throw new Error('Not a valid project file.');
    // Accept both the wrapped envelope { format, version, project }
    // and the flat legacy form { name, doc, ... }.
    let payload = json;
    if (json.format && json.project) {
        if (json.format !== PROJECT_FORMAT) {
            throw new Error(`Unsupported project format: ${json.format}`);
        }
        payload = json.project;
    }
    if (!payload.doc || !Array.isArray(payload.doc.components)) {
        throw new Error('Project file has no schematic doc.');
    }
    const name = renameTo || uniqueName(payload.name || 'Imported project');
    return saveProject({
        ...payload,
        id: null,
        name,
        createdAt: Date.now(),
    });
}

/** Wrap a project in the on-disk envelope so the format is self-describing. */
export function toExportEnvelope(project) {
    return {
        format: PROJECT_FORMAT,
        version: PROJECT_VERSION,
        exportedAt: new Date().toISOString(),
        project: {
            name: project.name,
            doc: project.doc,
            analysis: project.analysis,
            tranOverride: project.tranOverride,
            sweep: project.sweep,
            selectedSignals: project.selectedSignals,
            createdAt: project.createdAt,
            updatedAt: project.updatedAt,
        },
    };
}
