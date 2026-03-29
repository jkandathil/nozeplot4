#!/usr/bin/env node
/**
 * Probe a USB serial device (e.g. SiAC-2) at 115200 with line-oriented framing.
 *
 * Usage:
 *   node scripts/serialProbe.mjs --list
 *   node scripts/serialProbe.mjs --port /dev/cu.usbserial-0001
 *   node scripts/serialProbe.mjs --port auto --lines 30 --seconds 10
 *
 * macOS: prefer /dev/cu.* (call-out) for your program; /dev/tty.* can block if another app holds it.
 */

import { SerialPort } from 'serialport';
import { ReadlineParser } from '@serialport/parser-readline';

function parseArgs(argv) {
    const out = {
        list: false,
        port: null,
        baudRate: 115200,
        lines: 50,
        seconds: null,
        delimiter: '\n',
    };
    for (let i = 2; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--list' || a === '-l') out.list = true;
        else if (a === '--port' || a === '-p') out.port = argv[++i];
        else if (a === '--baud' || a === '-b') out.baudRate = Number(argv[++i]);
        else if (a === '--lines' || a === '-n') out.lines = Number(argv[++i]);
        else if (a === '--seconds' || a === '-s') out.seconds = Number(argv[++i]);
        else if (a === '--crlf') out.delimiter = '\r\n';
        else if (a === '--help' || a === '-h') out.help = true;
    }
    return out;
}

function printHelp() {
    console.log(`serialProbe.mjs — list ports and read line-delimited serial data

  --list, -l              List serial ports
  --port, -p <path|auto>  Device path or "auto" for first /dev/cu.usb*
  --baud, -b <n>          Default 115200
  --lines, -n <n>         Stop after N lines (default 50)
  --seconds, -s <n>       Also stop after N seconds (whichever comes first)
  --crlf                  Use \\r\\n as line delimiter (default is \\n, CR stripped)
`);
}

function analyzeLine(line) {
    const trimmed = line.replace(/^\r+|\r+$/g, '').trim();
    const len = trimmed.length;
    const printable = /^[\x20-\x7E\t]*$/.test(trimmed);
    const nums = trimmed.match(/-?\d+\.?\d*(?:[eE][+-]?\d+)?/g);
    const commaParts = trimmed.split(',').map((s) => s.trim());
    const tabParts = trimmed.split('\t');
    let guess = 'unknown';
    if (/^\s*\{[\s\S]*\}\s*$/.test(trimmed)) guess = 'JSON object (one per line)';
    else if (/^\s*\[[\s\S]*\]\s*$/.test(trimmed)) guess = 'JSON array';
    else if (commaParts.length >= 4 && commaParts.every((p) => /^-?\d/.test(p) || p === '')) guess = 'maybe CSV numbers';
    else if (tabParts.length >= 4) guess = 'maybe TSV';
    else if (nums && nums.length >= 4) guess = 'numeric tokens';
    else if (/^[0-9a-fA-F\s,]+$/.test(trimmed) && trimmed.length > 8) guess = 'maybe hex-ish';
    return { trimmed, len, printable, guess, commaCount: commaParts.length, tabCount: tabParts.length, numTokens: nums?.length ?? 0 };
}

async function listPorts() {
    const ports = await SerialPort.list();
    if (!ports.length) {
        console.log('No serial ports reported by node-serialport.');
        return;
    }
    console.log('Path                          Manufacturer        Serial / pnpId');
    for (const p of ports) {
        const path = p.path || '';
        const man = (p.manufacturer || '').slice(0, 18);
        const extra = p.serialNumber || p.pnpId || p.productId || '';
        const hint = path.startsWith('/dev/tty.') ? ` → try ${toCalloutPath(path)}` : '';
        console.log(`${path.padEnd(30)}${man.padEnd(20)}${extra}${hint}`);
    }
}

/** node-serialport often lists /dev/tty.*; macOS apps should open /dev/cu.* */
function toCalloutPath(path) {
    if (!path) return path;
    return path.replace(/^\/dev\/tty\./, '/dev/cu.');
}

function pickAutoPort(ports) {
    const withCu = ports.map((p) => ({ ...p, path: toCalloutPath(p.path) }));
    const usb = withCu.filter((p) => /usb|serial|usbserial|SLAB|wchusb|FTDI|CP210/i.test(p.path + (p.manufacturer || '') + (p.pnpId || '')));
    const nonBt = usb.filter((p) => !/Bluetooth|debug-console/i.test(p.path));
    return (nonBt[0] || withCu[0])?.path;
}

async function readPort(opts) {
    let ports = await SerialPort.list();
    let path = opts.port;
    if (path === 'auto') {
        path = pickAutoPort(ports);
        if (!path) {
            console.error('No port found for --port auto');
            process.exit(1);
        }
        console.log('Auto-selected:', path);
    }
    if (!path) {
        console.error('Set --port /dev/cu.… or --port auto');
        process.exit(1);
    }

    const port = new SerialPort({
        path,
        baudRate: opts.baudRate,
        dataBits: 8,
        parity: 'none',
        stopBits: 1,
        autoOpen: false,
    });

    const parser = port.pipe(
        new ReadlineParser({
            delimiter: opts.delimiter === '\r\n' ? '\r\n' : '\n',
            includeDelimiter: false,
        })
    );

    const lines = [];
    const started = Date.now();

    await new Promise((resolve, reject) => {
        port.open((err) => (err ? reject(err) : resolve()));
    });

    console.log(`Opened ${path} @ ${opts.baudRate} 8N1, delimiter: ${JSON.stringify(opts.delimiter)}`);
    console.log('Reading… (Ctrl+C to stop)\n');

    parser.on('data', (buf) => {
        const raw = buf.toString('utf8');
        lines.push(raw);
        const a = analyzeLine(raw);
        const preview = a.printable
            ? a.trimmed.slice(0, 200) + (a.trimmed.length > 200 ? '…' : '')
            : `[non-ASCII len=${a.len}] ${Buffer.from(a.trimmed, 'utf8').toString('hex').slice(0, 80)}…`;
        console.log(`[${lines.length}] len=${a.len} guess=${a.guess} | ${preview}`);
        const doneLines = opts.lines > 0 && lines.length >= opts.lines;
        const doneTime = opts.seconds != null && (Date.now() - started) / 1000 >= opts.seconds;
        if (doneLines || doneTime) {
            port.close();
        }
    });

    port.on('error', (e) => console.error('Port error:', e.message));

    await new Promise((resolve) => {
        port.on('close', resolve);
        parser.on('error', () => port.close());
    });

    console.log('\n--- Summary ---');
    console.log(`Lines captured: ${lines.length}`);
    if (!lines.length) {
        console.log('No lines received. Device may need a command to stream, wrong port, or wrong baud.');
        return;
    }
    const lens = lines.map((l) => l.replace(/^\r+|\r+$/g, '').trim().length);
    const minL = Math.min(...lens);
    const maxL = Math.max(...lens);
    console.log(`Line length min/max: ${minL} / ${maxL}`);
    const guesses = {};
    for (const l of lines) {
        const g = analyzeLine(l).guess;
        guesses[g] = (guesses[g] || 0) + 1;
    }
    console.log('Format guesses:', guesses);
    console.log('\nFirst line (full, CR stripped):');
    console.log(lines[0].replace(/^\r+|\r+$/g, '').trim());
}

const opts = parseArgs(process.argv);
if (opts.help) {
    printHelp();
    process.exit(0);
}

if (opts.list) {
    await listPorts();
    process.exit(0);
}

try {
    await readPort(opts);
} catch (e) {
    console.error(e.message || e);
    process.exit(1);
}
