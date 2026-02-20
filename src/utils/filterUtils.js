
/**
 * Applies noise filtering to a dataset.
 * @param {Array} data - Array of data objects.
 * @param {Array} keys - List of keys (column names) to filter.
 * @param {String} type - 'none', 'ma' (Moving Average), 'gaussian'.
 * @param {Number} windowSize - Window size (or sigma proxy).
 * @returns {Array} - New array with filtered data.
 */
export const applyNoiseFilter = (data, keys, type, windowSize) => {
    if (!data || !data.length || type === 'none' || windowSize <= 1) return data;

    const len = data.length;
    const result = new Array(len);

    // 1. Moving Average (Centered)
    if (type === 'ma') {
        const half = Math.floor(windowSize / 2);
        for (let i = 0; i < len; i++) {
            const row = { ...data[i] };
            const start = Math.max(0, i - half);
            const end = Math.min(len, i + half + 1);

            keys.forEach(key => {
                if (typeof row[key] !== 'number') return;
                let sum = 0;
                let valid = 0;
                for (let j = start; j < end; j++) {
                    const val = data[j][key];
                    if (typeof val === 'number') {
                        sum += val;
                        valid++;
                    }
                }
                if (valid > 0) row[key] = sum / valid;
            });
            result[i] = row;
        }
    }
    // 2. Gaussian Smoothing
    else if (type === 'gaussian') {
        // Sigma approx windowSize / 4 for visual equivalence
        const sigma = Math.max(0.5, windowSize / 4);
        const radius = Math.ceil(sigma * 3);
        const kernel = [];
        let kSum = 0;

        // Precompute kernel
        for (let x = -radius; x <= radius; x++) {
            const g = Math.exp(-(x * x) / (2 * sigma * sigma));
            kernel.push(g);
            kSum += g;
        }
        const normKernel = kernel.map(v => v / kSum);

        for (let i = 0; i < len; i++) {
            const row = { ...data[i] };
            keys.forEach(key => {
                if (typeof row[key] !== 'number') return;
                let sum = 0;
                let wSum = 0;
                for (let k = 0; k < normKernel.length; k++) {
                    const idx = i + (k - radius);
                    if (idx >= 0 && idx < len) {
                        const val = data[idx][key];
                        if (typeof val === 'number') {
                            sum += val * normKernel[k];
                            wSum += normKernel[k];
                        }
                    }
                }
                if (wSum > 0) row[key] = sum / wSum;
            });
            result[i] = row;
        }
    } else {
        return data;
    }

    return result;
};
