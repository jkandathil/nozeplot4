import { runDrc } from './memsDrcEngine.js';

self.onmessage = function (e) {
    const { id, doc, ruleSet } = e.data;
    try {
        const { violations, stats } = runDrc(doc, ruleSet);
        self.postMessage({ id, type: 'success', violations, stats });
    } catch (err) {
        self.postMessage({ id, type: 'error', error: err.message });
    }
};
