import { drainJsonObjectsFromBuffer } from './src/utils/siacDeviceProfiles.js';

const echoBuffer = `> rpc send "{\\"method\\":\\"TELEMETRY\\",\\"params\\":{\\"period\\":1000,\\"outputFormat\\":0}}"
{
	"code": 0,
	"message": "OK",
	"sn": "0000000027-0926-asu-nz",
	"method": "TELEMETRY"
}
`;

const res = drainJsonObjectsFromBuffer(echoBuffer);
console.log("Chunks:", res.chunks);
console.log("Rest:", res.rest);
