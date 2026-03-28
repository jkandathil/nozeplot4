import { initializeApp, getApps } from 'firebase/app';
import { getAuth } from 'firebase/auth';

function buildFirebaseConfig() {
    const apiKey = import.meta.env.VITE_FIREBASE_API_KEY;
    const authDomain = import.meta.env.VITE_FIREBASE_AUTH_DOMAIN;
    const projectId = import.meta.env.VITE_FIREBASE_PROJECT_ID;
    const appId = import.meta.env.VITE_FIREBASE_APP_ID;
    if (!apiKey || !authDomain || !projectId || !appId) return null;
    const cfg = {
        apiKey,
        authDomain,
        projectId,
        appId,
    };
    const bucket = import.meta.env.VITE_FIREBASE_STORAGE_BUCKET;
    const sender = import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID;
    if (bucket) cfg.storageBucket = bucket;
    if (sender) cfg.messagingSenderId = sender;
    return cfg;
}

/** @returns {import('firebase/auth').Auth | null} */
export function getFirebaseAuth() {
    const config = buildFirebaseConfig();
    if (!config) return null;
    const app = getApps().length ? getApps()[0] : initializeApp(config);
    return getAuth(app);
}
