import { auDeviceFolderNameFromSn } from './siacDeviceProfiles.js';

/** Wall-clock time when the save runs: YYYY-MM-DD_HHMMSS (filesystem-safe). */
export function formatSavingTimestamp(d = new Date()) {
    const pad = (n) => String(n).padStart(2, '0');
    const x = d instanceof Date ? d : new Date(d);
    return `${x.getFullYear()}-${pad(x.getMonth() + 1)}-${pad(x.getDate())}_${pad(x.getHours())}${pad(x.getMinutes())}${pad(x.getSeconds())}`;
}

/** e.g. AU_ID_2026-03-28_084135.csv — AU_ID from device sn, timestamp from save moment. */
export function buildAuCaptureFileName(data, savingDate = new Date()) {
    const auId = auDeviceFolderNameFromSn(data?.[0]?.sn);
    return `${auId}_${formatSavingTimestamp(savingDate)}.csv`;
}
