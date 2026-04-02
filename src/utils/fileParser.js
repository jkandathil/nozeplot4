import Papa from 'papaparse';
import * as XLSX from 'xlsx';

export const parseFile = (fileObj) => {
    return new Promise((resolve, reject) => {
        if (!fileObj) return reject(new Error("No file provided"));

        const hasRows =
            fileObj.data &&
            Array.isArray(fileObj.data) &&
            fileObj.data.length > 0 &&
            typeof fileObj.data[0] === 'object' &&
            fileObj.data[0] !== null;
        if (hasRows) {
            resolve({
                id: fileObj.id,
                fileName: fileObj.name || fileObj.fileName,
                data: fileObj.data,
                meta: { fields: Object.keys(fileObj.data[0]) }
            });
            return;
        }

        const blob = fileObj.file;
        const blobOk = blob && typeof blob.size === 'number' && blob.size > 0;
        const csvFallback =
            (typeof fileObj.csvText === 'string' && fileObj.csvText.trim().length > 0 && fileObj.csvText) ||
            (typeof fileObj.csvSnapshot === 'string' && fileObj.csvSnapshot.trim().length > 0 && fileObj.csvSnapshot) ||
            null;

        const baseName = fileObj.name || fileObj.fileName || '';
        const isExcel = baseName.endsWith('.xlsx') || baseName.endsWith('.xls');

        if (isExcel) {
            if (!blobOk) {
                return reject(new Error("File Blob is missing or 0 bytes! Please re-upload raw CSV."));
            }
            const reader = new FileReader();
            reader.onload = (e) => {
                try {
                    const data = e.target.result;
                    const workbook = XLSX.read(data, { type: 'binary', cellDates: true });
                    const firstSheetName = workbook.SheetNames[0];
                    const worksheet = workbook.Sheets[firstSheetName];
                    const rawData = XLSX.utils.sheet_to_json(worksheet, { defval: null, raw: true });

                    const jsonData = rawData.map(row => {
                        const clean = {};
                        Object.entries(row).forEach(([k, v]) => {
                            if (v instanceof Date) {
                                clean[k] = v.toISOString().replace('T', ' ').slice(0, 19);
                            } else if (typeof v === 'string') {
                                const n = parseFloat(v);
                                clean[k] = isNaN(n) ? v : n;
                            } else {
                                clean[k] = v;
                            }
                        });
                        return clean;
                    });

                    resolve({
                        id: fileObj.id,
                        fileName: fileObj.name,
                        data: jsonData,
                        meta: { fields: jsonData.length > 0 ? Object.keys(jsonData[0]) : [] }
                    });
                } catch (error) {
                    reject(error);
                }
            };
            reader.onerror = (error) => reject(error);
            reader.readAsBinaryString(blob);
        } else {
            const papaSource = blobOk ? blob : csvFallback;
            if (!papaSource) {
                return reject(new Error("File Blob is missing or 0 bytes! Please re-upload raw CSV."));
            }
            Papa.parse(papaSource, {
                header: true,
                dynamicTyping: true,
                skipEmptyLines: true,
                complete: (results) => {
                    resolve({
                        id: fileObj.id,
                        fileName: fileObj.name || fileObj.fileName,
                        data: results.data,
                        meta: results.meta
                    });
                },
                error: (error) => reject(error)
            });
        }
    });
};
