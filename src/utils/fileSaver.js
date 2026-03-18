import { saveAs } from 'file-saver';
import { fileManager } from './db'; // assuming the db logic exists

/**
 * Serializes the current workspace state (files, selections, parameters)
 * into a single JSON object and triggers a download.
 */
export const exportWorkspaceSession = async (currentAppState) => {
    try {
        // Fetch raw file metadata/content from IndexedDB
        const allSavedFiles = await fileManager.getAllFiles();

        // Construct the Workspace snapshot
        const sessionPayload = {
            version: "1.0",
            exportDate: new Date().toISOString(),
            appState: {
                selectedFileId: currentAppState.selectedFileId,
                compareFileIds: currentAppState.compareFileIds,
                activePage: currentAppState.activePage,
                // you can push normalization offsets or ML parameters here implicitly if held in App.jsx
            },
            files: allSavedFiles.map(f => ({
                id: f.id,
                name: f.name,
                type: f.type,
                // we'll need to somehow serialize the raw File object to base64 or construct if needed,
                // but for massive CSVs, just passing the text/binary array buffer might be optimal.
                // For simplicity, we assume we extract file mapping.
            }))
        };

        const blob = new Blob([JSON.stringify(sessionPayload, null, 2)], { type: 'application/json' });
        saveAs(blob, `workspace_session_${new Date().toISOString().split('T')[0]}.noze`);

    } catch (e) {
        console.error("Failed to export workspace session:", e);
        throw e;
    }
};
