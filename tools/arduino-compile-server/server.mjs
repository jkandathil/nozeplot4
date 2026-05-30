#!/usr/bin/env node
/**
 * Minimal local compile server for the NozePlot "MCU Flash" page.
 *
 * Wraps `arduino-cli` and implements the contract the app expects:
 *
 *   POST /compile   { fqbn, sketch, files?, libraries? }
 *   →  { ok, stdout, stderr, hex? | parts? }   (base64 payloads)
 *
 * Run locally, then set the app's "Remote compile server URL" to
 * http://localhost:8787 (Chrome allows https→http requests to localhost).
 *
 * Requirements: Node 18+, arduino-cli on PATH, and the relevant cores
 * installed (see README.md).
 */
import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const PORT = Number(process.env.PORT || 8787);
const CLI = process.env.ARDUINO_CLI || 'arduino-cli';

function setCors(res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

async function readBody(req) {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    return Buffer.concat(chunks).toString('utf8');
}

async function compile({ fqbn, sketch, files, libraries }) {
    if (!fqbn) return { ok: false, stderr: 'Missing fqbn.' };
    const root = await mkdtemp(join(tmpdir(), 'noze-sketch-'));
    const sketchDir = join(root, 'sketch');
    await mkdir(sketchDir, { recursive: true });
    await writeFile(join(sketchDir, 'sketch.ino'), sketch || '');
    for (const [name, content] of Object.entries(files || {})) {
        await writeFile(join(sketchDir, basename(String(name)).replace(/[^\w.\-]/g, '_')), String(content));
    }

    let stdout = '';
    let stderr = '';
    try {
        for (const lib of libraries || []) {
            try {
                const r = await run(CLI, ['lib', 'install', String(lib)], { maxBuffer: 1 << 26 });
                stdout += r.stdout || '';
                stderr += r.stderr || '';
            } catch (e) {
                stderr += `lib install "${lib}": ${e.stderr || e.message}\n`;
            }
        }

        const out = join(root, 'out');
        try {
            const r = await run(CLI, ['compile', '--fqbn', fqbn, '--output-dir', out, sketchDir], { maxBuffer: 1 << 27 });
            stdout += r.stdout || '';
            stderr += r.stderr || '';
        } catch (e) {
            return { ok: false, stdout: stdout + (e.stdout || ''), stderr: stderr + (e.stderr || e.message) };
        }

        const outFiles = await readdir(out);
        const b64 = async (f) => (await readFile(join(out, f))).toString('base64');

        if (/esp32|esp8266/i.test(fqbn)) {
            const merged = outFiles.find((f) => /\.merged\.bin$/i.test(f));
            if (merged) {
                return { ok: true, stdout, stderr, parts: [{ address: 0, data: await b64(merged) }] };
            }
            // Fallback: assemble bootloader + partitions + app at standard offsets.
            const app = outFiles.find((f) => /\.ino\.bin$/i.test(f) && !/bootloader|partitions|merged/i.test(f));
            const boot = outFiles.find((f) => /bootloader\.bin$/i.test(f));
            const part = outFiles.find((f) => /partitions\.bin$/i.test(f));
            const isClassicEsp32 = /esp32:esp32:esp32(\b|:|$)/.test(fqbn);
            const bootOffset = /esp8266/i.test(fqbn) ? 0x0 : isClassicEsp32 ? 0x1000 : 0x0;
            const parts = [];
            if (boot) parts.push({ address: bootOffset, data: await b64(boot) });
            if (part) parts.push({ address: 0x8000, data: await b64(part) });
            if (app) parts.push({ address: 0x10000, data: await b64(app) });
            if (!parts.length) return { ok: false, stdout, stderr: stderr + '\nNo ESP binaries produced.' };
            return { ok: true, stdout, stderr, parts };
        }

        // AVR → Intel HEX
        const hex =
            outFiles.find((f) => /\.hex$/i.test(f) && !/with_bootloader/i.test(f)) || outFiles.find((f) => /\.hex$/i.test(f));
        if (!hex) return { ok: false, stdout, stderr: stderr + '\nNo .hex produced.' };
        const text = await readFile(join(out, hex), 'utf8');
        return { ok: true, stdout, stderr, hex: Buffer.from(text, 'utf8').toString('base64') };
    } finally {
        rm(root, { recursive: true, force: true }).catch(() => {});
    }
}

createServer(async (req, res) => {
    setCors(res);
    if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
    }
    const path = (req.url || '').replace(/[?#].*$/, '').replace(/\/+$/, '');
    if (req.method === 'POST' && path.endsWith('/compile')) {
        try {
            const body = JSON.parse((await readBody(req)) || '{}');
            const result = await compile(body);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(result));
        } catch (e) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, stderr: String(e?.message || e) }));
        }
        return;
    }
    if (req.method === 'GET' && (path === '' || path.endsWith('/health'))) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, service: 'noze arduino compile server' }));
        return;
    }
    res.writeHead(404);
    res.end('Not found');
}).listen(PORT, () => {
    console.log(`NozePlot Arduino compile server → http://localhost:${PORT}`);
    console.log(`Using CLI: ${CLI}`);
});
