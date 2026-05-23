/**
 * Zip export for MEMS mask JSON files stored under the workspace `mems_masks/` folder.
 */

import JSZip from 'jszip';
import { saveAs } from 'file-saver';
import { MEMS_MASKS_WORKSPACE_FOLDER_NAME } from './workspaceFilename.js';

/**
 * @param {string} stem — filename stem without extension
 * @param {string} [subfolderPath] — optional `Imports` or `Projects/Run1` (no leading slash)
 * @returns {string} e.g. `Imports/my_mask.json`
 */
export function buildMemsWorkspaceFileName(stem, subfolderPath) {
    const base = `${stem || 'mems_mask'}.json`;
    const sub = String(subfolderPath || '')
        .trim()
        .replace(/\\/g, '/')
        .replace(/^\/+|\/+$/g, '');
    if (!sub) return base;
    const segs = sub.split('/').filter((s) => s && s !== '.' && s !== '..');
    const safe = segs
        .map((s) => s.replace(/[^\w.\-()+ ]+/g, '_').replace(/\.+/g, '_').slice(0, 80))
        .filter(Boolean);
    if (!safe.length) return base;
    return `${safe.join('/')}/${base}`;
}

function uniqueZipPath(basePath, used) {
    let p = basePath;
    let i = 1;
    while (used.has(p)) {
        const dot = basePath.lastIndexOf('.');
        const stem = dot > 0 ? basePath.slice(0, dot) : basePath;
        const ext = dot > 0 ? basePath.slice(dot) : '';
        p = `${stem}_${i++}${ext}`;
    }
    used.add(p);
    return p;
}

function sanitizeZipRelativePath(name) {
    const raw = String(name || 'layout.json').replace(/\\/g, '/').replace(/^\/+/, '');
    const parts = raw.split('/').filter(Boolean);
    const safe = [];
    for (const part of parts) {
        if (part === '.' || part === '..') continue;
        const seg = part.replace(/[^\w.\-()+ ]+/g, '_').slice(0, 120);
        if (seg) safe.push(seg);
    }
    return safe.length ? safe.join('/') : 'layout.json';
}

/**
 * Download all workspace items in `mems_masks/` as a ZIP whose internal paths mirror
 * saved names (including optional `Subfolder/name.json` paths).
 *
 * @param {object[]} allFiles — `fileManager.getAllFiles()` shape
 */
export async function downloadMemsMasksFolderJsonZip(allFiles) {
    const folders = (allFiles || []).filter(
        (f) => f?.isFolder && String(f.name).toLowerCase() === MEMS_MASKS_WORKSPACE_FOLDER_NAME.toLowerCase()
    );
    if (!folders.length) {
        throw new Error(`Workspace folder “${MEMS_MASKS_WORKSPACE_FOLDER_NAME}” was not found. Save a layout once to create it.`);
    }
    const folder = folders[0];
    const children = (allFiles || []).filter((f) => !f.isFolder && String(f.folderId) === String(folder.id));
    if (!children.length) {
        throw new Error('No saved layouts in mems_masks — use “Workspace” to save first.');
    }

    const zip = new JSZip();
    const root = zip.folder(MEMS_MASKS_WORKSPACE_FOLDER_NAME);
    const used = new Set();

    for (const f of children) {
        const rel = sanitizeZipRelativePath(f.name);
        const pathInZip = uniqueZipPath(rel, used);
        let text;
        if (f.data != null) {
            text = typeof f.data === 'string' ? f.data : JSON.stringify(f.data, null, 2);
        } else {
            continue;
        }
        root.file(pathInZip, text);
    }

    if (used.size === 0) {
        throw new Error('No JSON payload found on mems_masks files (empty rows).');
    }

    const blob = await zip.generateAsync({ type: 'blob' });
    saveAs(blob, `${MEMS_MASKS_WORKSPACE_FOLDER_NAME}_export_${new Date().toISOString().slice(0, 10)}.zip`);
}
