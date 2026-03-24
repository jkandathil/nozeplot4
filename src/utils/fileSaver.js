import { fileManager } from './db';

const convertFileToBase64 = (fileObj) => {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = error => reject(error);
        if (fileObj && typeof fileObj.slice === 'function') {
            reader.readAsDataURL(fileObj);
        } else {
            console.error("Invalid File/Blob structure passed to encoder:", fileObj);
            resolve(null);
        }
    });
};

export const base64ToFile = (base64String, filename, mimeType) => {
    if (!base64String || typeof base64String !== 'string') return null;
    const arr = base64String.split(',');
    const base64Data = arr.length > 1 ? arr[1] : arr[0];
    const bstr = atob(base64Data);
    let n = bstr.length;
    const u8arr = new Uint8Array(n);
    while (n--) {
        u8arr[n] = bstr.charCodeAt(n);
    }
    return new File([u8arr], filename, { type: mimeType });
};

/**
 * Serializes the current workspace state (files, selections, parameters)
 * into a single JSON object and triggers a download.
 */
export const exportWorkspaceSession = async (currentAppState) => {
    try {
        // Fetch raw file metadata/content from IndexedDB
        const allSavedFiles = await fileManager.getAllFiles();

        const serializedFiles = await Promise.all(allSavedFiles.map(async f => {
            let base64Data = null;
            try {
                if (f.file) base64Data = await convertFileToBase64(f.file);
            } catch (e) { console.warn("Could not encode file:", f.name); }

            const serialized = { ...f, base64: base64Data };
            delete serialized.file; // Remove native File object mapping so JSON.stringify succeeds natively
            return serialized;
        }));

        // Construct the Workspace snapshot
        const sessionPayload = {
            version: "1.0",
            exportDate: new Date().toISOString(),
            appState: {
                selectedFileId: currentAppState.selectedFileId,
                compareFileIds: currentAppState.compareFileIds,
                activePage: currentAppState.activePage,
            },
            files: serializedFiles
        };

        const blob = new Blob([JSON.stringify(sessionPayload)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.style.display = 'none';
        a.href = url;
        a.download = `workspace_session_${new Date().toISOString().split('T')[0]}.noze`;
        document.body.appendChild(a);
        a.click();
        
        setTimeout(() => {
            document.body.removeChild(a);
            window.URL.revokeObjectURL(url);
        }, 100);

    } catch (e) {
        console.error("Failed to export workspace session:", e);
        throw e;
    }
};

/**
 * De-serialize a loaded .noze JSON block back into IndexedDB
 */
export const importWorkspaceSession = async (jsonDataAsString) => {
    try {
        const payload = JSON.parse(jsonDataAsString);
        if (payload.version !== "1.0" || !payload.files) {
            throw new Error("Invalid .noze session format.");
        }

        // Wipe existing DB slate
        await fileManager.clearAllFiles();

        // Restore files natively
        for (const meta of payload.files) {
            let restoredFileObject = null;
            
            try {
                if (meta.base64) {
                    restoredFileObject = base64ToFile(meta.base64, meta.name, meta.type || 'text/csv');
                }
            } catch (e) { console.warn("Could not decode base64 native:", e); }

            const restoredEntry = { ...meta, file: restoredFileObject };
            delete restoredEntry.base64; // Don't bloat local IndexedDB identically
            
            if (restoredFileObject && !restoredEntry.size) {
                restoredEntry.size = restoredFileObject.size;
            }

            await fileManager.saveFile(restoredEntry);
        }

        return payload.appState;
    } catch (err) {
        console.error("Failed to import session:", err);
        throw err;
    }
};
