import Papa from 'papaparse';
import { saveAs } from 'file-saver';
import JSZip from 'jszip';
import { parseFile } from './fileParser.js';

function basename(path) {
    if (!path) return '';
    return String(path).split(/[/\\]/).pop() || '';
}

function stemFromWorkspaceName(name) {
    const b = basename(name);
    return b.replace(/\.(csv|xlsx|xls)$/i, '') || 'data';
}

async function workspaceFileToRows(fileMeta) {
    if (fileMeta?.data && Array.isArray(fileMeta.data) && fileMeta.data.length > 0) {
        return fileMeta.data;
    }
    const parsed = await parseFile(fileMeta);
    return parsed?.data || [];
}

function rowsToCsvString(rows) {
    if (!rows?.length) return '';
    return Papa.unparse(rows, { quotes: true, header: true });
}

/**
 * Download one workspace item as a UTF-8 CSV (from in-memory `data` or by parsing `file`).
 */
export async function downloadWorkspaceFileAsCsv(fileMeta) {
    const rows = await workspaceFileToRows(fileMeta);
    if (!rows.length) {
        throw new Error('No rows to export.');
    }
    const csv = rowsToCsvString(rows);
    const outName = `${stemFromWorkspaceName(fileMeta.name)}.csv`;
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    saveAs(blob, outName);
}

function uniqueZipName(base, used) {
    let name = `${base}.csv`;
    let i = 1;
    while (used.has(name)) {
        name = `${base}_${i++}.csv`;
    }
    used.add(name);
    return name;
}

/**
 * ZIP containing one CSV per file in the folder (Excel converted to CSV).
 */
export async function downloadFolderContentsAsCsvZip(folder, allFiles) {
    const children = allFiles.filter((f) => !f.isFolder && f.folderId === folder.id);
    if (!children.length) {
        throw new Error('No files in this folder.');
    }
    const zip = new JSZip();
    const used = new Set();
    let added = 0;
    for (const f of children) {
        try {
            const rows = await workspaceFileToRows(f);
            if (!rows.length) continue;
            const csv = rowsToCsvString(rows);
            const base = stemFromWorkspaceName(f.name).replace(/[\\/:*?"<>|]/g, '_') || 'sheet';
            zip.file(uniqueZipName(base, used), csv);
            added++;
        } catch {
            /* skip broken entries */
        }
    }
    if (added === 0) {
        throw new Error('No exportable data in folder.');
    }
    const blob = await zip.generateAsync({ type: 'blob' });
    const safe = String(folder.name || 'folder').replace(/[\\/:*?"<>|]/g, '_');
    saveAs(blob, `${safe}_csv.zip`);
}

/**
 * ZIP for files at workspace root (no folderId).
 */
export async function downloadRootDataFilesAsCsvZip(allFiles) {
    const children = allFiles.filter((f) => !f.isFolder && !f.folderId);
    if (!children.length) {
        throw new Error('No files in DataFiles.');
    }
    const zip = new JSZip();
    const used = new Set();
    let added = 0;
    for (const f of children) {
        try {
            const rows = await workspaceFileToRows(f);
            if (!rows.length) continue;
            const csv = rowsToCsvString(rows);
            const base = stemFromWorkspaceName(f.name).replace(/[\\/:*?"<>|]/g, '_') || 'sheet';
            zip.file(uniqueZipName(base, used), csv);
            added++;
        } catch {
            /* skip */
        }
    }
    if (added === 0) {
        throw new Error('No exportable data.');
    }
    const blob = await zip.generateAsync({ type: 'blob' });
    saveAs(blob, `DataFiles_csv.zip`);
}
