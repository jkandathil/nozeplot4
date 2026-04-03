import Papa from 'papaparse';
import * as XLSX from 'xlsx';
import { fileManager } from './db';

function hasHydratedRows(fileObj) {
    return (
        fileObj?.data &&
        Array.isArray(fileObj.data) &&
        fileObj.data.length > 0 &&
        typeof fileObj.data[0] === 'object' &&
        fileObj.data[0] !== null
    );
}

/**
 * Parse a workspace file into chart rows. If `fileObj` has no `data` but has an `id`,
 * loads the full record from IndexedDB (lean sidebar entries after bulk synthetic save).
 */
export async function parseFile(fileObj) {
    if (!fileObj) throw new Error('No file provided');

    let obj = fileObj;
    if (!hasHydratedRows(obj) && obj.id) {
        try {
            const full = await fileManager.getFile(obj.id);
            if (full && hasHydratedRows(full)) {
                obj = {
                    ...full,
                    ...obj,
                    data: full.data,
                    name: obj.name || full.name,
                    fileName: obj.fileName || full.fileName || obj.name || full.name,
                };
            }
        } catch {
            /* ignore */
        }
    }

    if (hasHydratedRows(obj)) {
        return {
            id: obj.id,
            fileName: obj.name || obj.fileName,
            data: obj.data,
            meta: { fields: Object.keys(obj.data[0]) },
        };
    }

    const blob = obj.file;
    const blobOk = blob && typeof blob.size === 'number' && blob.size > 0;
    const csvFallback =
        (typeof obj.csvText === 'string' && obj.csvText.trim().length > 0 && obj.csvText) ||
        (typeof obj.csvSnapshot === 'string' && obj.csvSnapshot.trim().length > 0 && obj.csvSnapshot) ||
        null;

    const baseName = obj.name || obj.fileName || '';
    const isExcel = baseName.endsWith('.xlsx') || baseName.endsWith('.xls');

    if (isExcel) {
        if (!blobOk) {
            throw new Error('File Blob is missing or 0 bytes! Please re-upload raw CSV.');
        }
        const data = await new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = (e) => resolve(e.target.result);
            reader.onerror = (error) => reject(error);
            reader.readAsBinaryString(blob);
        });
        const workbook = XLSX.read(data, { type: 'binary', cellDates: true });
        const firstSheetName = workbook.SheetNames[0];
        const worksheet = workbook.Sheets[firstSheetName];
        const rawData = XLSX.utils.sheet_to_json(worksheet, { defval: null, raw: true });

        const jsonData = rawData.map((row) => {
            const clean = {};
            Object.entries(row).forEach(([k, v]) => {
                if (v instanceof Date) {
                    clean[k] = v.toISOString().replace('T', ' ').slice(0, 19);
                } else if (typeof v === 'string') {
                    const n = parseFloat(v);
                    clean[k] = Number.isNaN(n) ? v : n;
                } else {
                    clean[k] = v;
                }
            });
            return clean;
        });

        return {
            id: obj.id,
            fileName: obj.name,
            data: jsonData,
            meta: { fields: jsonData.length > 0 ? Object.keys(jsonData[0]) : [] },
        };
    }

    const papaSource = blobOk ? blob : csvFallback;
    if (!papaSource) {
        throw new Error('File Blob is missing or 0 bytes! Please re-upload raw CSV.');
    }

    return new Promise((resolve, reject) => {
        Papa.parse(papaSource, {
            header: true,
            dynamicTyping: true,
            skipEmptyLines: true,
            complete: (results) => {
                resolve({
                    id: obj.id,
                    fileName: obj.name || obj.fileName,
                    data: results.data,
                    meta: results.meta,
                });
            },
            error: (error) => reject(error),
        });
    });
}
