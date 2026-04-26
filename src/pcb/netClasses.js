/**
 * Net Class System for PCB Studio.
 * Allows different design rules per net class (track width, clearance, via sizes).
 * Similar to KiCad's net class system.
 */

/** Default net class (matches global design rules). */
export const DEFAULT_NET_CLASS = {
  name: 'Default',
  trackWidthMm: 0.25,
  clearanceMm: 0.2,
  viaDrillMm: 0.4,
  viaDiamMm: 0.8,
  diffPairWidthMm: null,  // null = not a diff pair class
  diffPairGapMm: null,
};

/** Power net class. */
export const POWER_NET_CLASS = {
  name: 'Power',
  trackWidthMm: 0.5,
  clearanceMm: 0.3,
  viaDrillMm: 0.5,
  viaDiamMm: 1.0,
  diffPairWidthMm: null,
  diffPairGapMm: null,
};

/** High-speed differential pair class. */
export const DIFF_PAIR_NET_CLASS = {
  name: 'DiffPair',
  trackWidthMm: 0.15,
  clearanceMm: 0.15,
  viaDrillMm: 0.3,
  viaDiamMm: 0.6,
  diffPairWidthMm: 0.15,
  diffPairGapMm: 0.15,
};

/**
 * Initialize net classes in a PCB document.
 * @param {object} doc
 * @returns {object} Updated doc with netClasses
 */
export function initNetClasses(doc) {
  if (doc.meta?.netClasses) return doc;
  return {
    ...doc,
    meta: {
      ...doc.meta,
      netClasses: {
        classes: [
          { ...DEFAULT_NET_CLASS },
          { ...POWER_NET_CLASS },
          { ...DIFF_PAIR_NET_CLASS },
        ],
        /** Map of net name → class name */
        assignments: {},
      },
    },
  };
}

/**
 * Get the net class for a given net name.
 */
export function getNetClass(doc, netName) {
  const nc = doc.meta?.netClasses;
  if (!nc) return DEFAULT_NET_CLASS;
  const className = nc.assignments?.[netName];
  if (!className) return nc.classes?.[0] || DEFAULT_NET_CLASS;
  return nc.classes?.find(c => c.name === className) || nc.classes?.[0] || DEFAULT_NET_CLASS;
}

/**
 * Assign a net to a net class.
 */
export function assignNetToClass(doc, netName, className) {
  const nc = doc.meta?.netClasses || { classes: [{ ...DEFAULT_NET_CLASS }], assignments: {} };
  return {
    ...doc,
    meta: {
      ...doc.meta,
      netClasses: {
        ...nc,
        assignments: { ...nc.assignments, [netName]: className },
      },
    },
  };
}

/**
 * Add a custom net class.
 */
export function addNetClass(doc, netClass) {
  const nc = doc.meta?.netClasses || { classes: [{ ...DEFAULT_NET_CLASS }], assignments: {} };
  return {
    ...doc,
    meta: {
      ...doc.meta,
      netClasses: {
        ...nc,
        classes: [...nc.classes, { ...DEFAULT_NET_CLASS, ...netClass }],
      },
    },
  };
}
