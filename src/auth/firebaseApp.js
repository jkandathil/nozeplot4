import { initializeApp, getApps } from 'firebase/app';
import { getAuth } from 'firebase/auth';

/** Baked into CI builds when Firebase secrets are unset; must match `scripts/checkFirebaseBuildEnv.mjs`. */
export const FIREBASE_BUILD_PLACEHOLDER = '__FIREBASE_NOT_CONFIGURED__';

function buildFirebaseConfig() {
    const apiKey = import.meta.env.VITE_FIREBASE_API_KEY;
    const authDomain = import.meta.env.VITE_FIREBASE_AUTH_DOMAIN;
    const projectId = import.meta.env.VITE_FIREBASE_PROJECT_ID;
    const appId = import.meta.env.VITE_FIREBASE_APP_ID;
    const missingCore = [apiKey, authDomain, projectId, appId].some(
        (v) => !v || String(v).trim() === '' || String(v).trim() === FIREBASE_BUILD_PLACEHOLDER
    );
    if (missingCore) return null;
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
