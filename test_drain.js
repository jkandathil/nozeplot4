import { drainJsonObjectsFromBuffer } from './src/utils/siacDeviceProfiles.js';
import fs from 'fs';

const packet = `{
    "code": 0,
    "message": "OK",
    "sn": "0000000027-0926-asu-nz",
    "method": "TELEMETRY",
    "result": {
        "A1": 1.0,
        "name": "foo\\"bar"
    }
}
`;

// Simulate receiving 100 packets, chunked randomly
let buffer = '';
let chunksReceived = [];
for (let i = 0; i < 100; i++) {
    buffer += packet;
}

const res = drainJsonObjectsFromBuffer(buffer);
console.log("Found chunks:", res.chunks.length);
console.log("Rest length:", res.rest.length);
