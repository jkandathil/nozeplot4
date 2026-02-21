const e = { activeLabel: undefined, activePayload: [{ payload: { index: 0 } }] };
const val = e.activeLabel !== undefined ? e.activeLabel : (e.activePayload?.[0]?.payload?.["index"] || '');
console.log("Val is:", val);
const val2 = e.activeLabel !== undefined ? e.activeLabel : (e.activePayload?.[0]?.payload?.["index"] ?? '');
console.log("Val2 is:", val2);
