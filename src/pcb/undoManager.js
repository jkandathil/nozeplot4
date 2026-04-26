/**
 * Professional Undo/Redo Manager for PCB Studio.
 * Snapshot-based with configurable depth — simple, reliable, works with
 * any serializable document model.
 *
 * Usage:
 *   const um = createUndoManager(64);
 *   um.push(doc);            // save current state before mutation
 *   const prev = um.undo();  // returns previous snapshot or null
 *   const next = um.redo();  // returns next snapshot or null
 */

/**
 * @param {number} [maxDepth=64] Maximum undo history depth.
 * @returns {UndoManager}
 */
export function createUndoManager(maxDepth = 64) {
  /** @type {string[]} JSON-serialized snapshots */
  let undoStack = [];
  /** @type {string[]} */
  let redoStack = [];
  let lastPushTime = 0;
  const MIN_PUSH_INTERVAL_MS = 150; // debounce rapid changes

  return {
    /**
     * Push a snapshot onto the undo stack.
     * Call this BEFORE applying a mutation to the document.
     * Clears the redo stack (standard behavior).
     * @param {object} doc  The current document state (will be JSON-cloned).
     * @param {boolean} [force=false] Push even if within debounce window.
     */
    push(doc, force = false) {
      const now = Date.now();
      if (!force && now - lastPushTime < MIN_PUSH_INTERVAL_MS) return;
      lastPushTime = now;

      const snap = JSON.stringify(doc);
      // Don't push if identical to top of stack
      if (undoStack.length > 0 && undoStack[undoStack.length - 1] === snap) return;

      undoStack.push(snap);
      if (undoStack.length > maxDepth) {
        undoStack = undoStack.slice(undoStack.length - maxDepth);
      }
      redoStack = [];
    },

    /**
     * Undo: pop the last snapshot and return it.
     * @param {object} currentDoc  The CURRENT doc state (pushed onto redo stack).
     * @returns {object|null} The previous document state, or null if nothing to undo.
     */
    undo(currentDoc) {
      if (undoStack.length === 0) return null;
      redoStack.push(JSON.stringify(currentDoc));
      const snap = undoStack.pop();
      return JSON.parse(snap);
    },

    /**
     * Redo: pop the redo stack and return it.
     * @param {object} currentDoc  The CURRENT doc state (pushed onto undo stack).
     * @returns {object|null} The next document state, or null if nothing to redo.
     */
    redo(currentDoc) {
      if (redoStack.length === 0) return null;
      undoStack.push(JSON.stringify(currentDoc));
      const snap = redoStack.pop();
      return JSON.parse(snap);
    },

    /** @returns {boolean} */
    canUndo() { return undoStack.length > 0; },
    /** @returns {boolean} */
    canRedo() { return redoStack.length > 0; },

    /** Number of undo steps available. */
    undoDepth() { return undoStack.length; },
    /** Number of redo steps available. */
    redoDepth() { return redoStack.length; },

    /** Clear all history. */
    clear() {
      undoStack = [];
      redoStack = [];
    },
  };
}
