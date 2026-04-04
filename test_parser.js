const jsonStr = `{\r\r\n\t"code": 0,\r\r\n\t"message": "OK",\r\r\n\t"sn": "0000000027-0926-asu-nz",\r\r\n\t"method": "TELEMETRY"}`;
try {
    const obj = JSON.parse(jsonStr);
    console.log("Parsed:", obj.sn);
} catch (e) {
    console.error("Parse failed:", e);
}
