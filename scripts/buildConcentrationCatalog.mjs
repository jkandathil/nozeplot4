/**
 * Scans normalized_* CSV basenames under Raw_data/files and writes src/data/concentration-catalog.json.
 * Keys match folder uploads from Raw_data/63: <10-digit time>_<8-hex>/<AU-id>.csv
 *
 * Usage: node scripts/buildConcentrationCatalog.mjs
 * Optional: CONCENTRATION_CATALOG_SOURCE=/path/to/files
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const FILES_DIR = process.env.CONCENTRATION_CATALOG_SOURCE || path.join(ROOT, 'Raw_data/files');
const OUT = path.join(ROOT, 'src/data/concentration-catalog.json');

const NORMALIZED_RE = /^normalized_(\d{10})_([a-f0-9]{8})_(\d+(?:\.\d+)?)ppb_(.+)\.csv$/i;

function main() {
    if (!fs.existsSync(FILES_DIR)) {
        console.error('Source directory missing:', FILES_DIR);
        process.exit(1);
    }
    const entries = [];
    for (const name of fs.readdirSync(FILES_DIR)) {
        if (!name.endsWith('.csv')) continue;
        const m = name.match(NORMALIZED_RE);
        if (!m) continue;
        entries.push({
            time10: m[1],
            hash: m[2].toLowerCase(),
            auId: m[4],
            valuePpb: parseFloat(m[3]),
            sourceFile: name,
        });
    }
    const payload = {
        version: 1,
        generatedAt: new Date().toISOString(),
        entries,
    };
    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    fs.writeFileSync(OUT, `${JSON.stringify(payload, null, 2)}\n`);
    console.log(`Wrote ${entries.length} catalog entries → ${path.relative(ROOT, OUT)}`);
}

main();
