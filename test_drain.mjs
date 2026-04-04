import { drainJsonObjectsFromBuffer } from './src/utils/siacDeviceProfiles.js';

const testBuffer = `rpc send "{\\\"method\\\":\\\"TELEMETRY\\\"}"\r\n` + 
  `{\r\n` +
  `  "sn": "001",\r\n` +
  `  "method": "TELEMETRY",\r\n` +
  `  "result": {\r\n` +
  `    "A1": 123.456,\r\n` +
  `    "PZEFR0": nan\r\n` +
  `  }\r\n` +
  `}\r\n`;

console.log("Buffer length:", testBuffer.length);

function debugDrain(buffer) {
    const chunks = [];
    let i = 0;
    while (i < buffer.length) {
        const start = buffer.indexOf('{', i);
        if (start < 0) return { chunks, rest: buffer.slice(i) };
        let depth = 0, inString = false, escape = false, j = start, closed = false;
        for (; j < buffer.length; j++) {
            const c = buffer[j];
            if (escape) { escape = false; continue; }
            if (inString) {
                if (c === '\\') { escape = true; continue; }
                if (c === '"') inString = false;
                continue;
            }
            if (c === '"') { inString = true; continue; }
            if (c === '{') depth++;
            else if (c === '}') {
                depth--;
                if (depth === 0) {
                    chunks.push(buffer.slice(start, j + 1));
                    i = j + 1;
                    closed = true;
                    break;
                }
            }
        }
        if (!closed) return { chunks, rest: buffer.slice(start) };
    }
    return { chunks, rest: buffer.slice(i) };
}

const { chunks, rest } = debugDrain(testBuffer);
console.log("Chunks found:", chunks.length);
chunks.forEach((c, i) => {
  console.log(`Chunk ${i}:`, JSON.stringify(c));
});
console.log("Rest:", JSON.stringify(rest));
