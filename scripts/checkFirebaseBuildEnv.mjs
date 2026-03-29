/**
 * Ensures Firebase VITE_* vars exist before gh-pages build.
 * Uses Vite's loadEnv so .env / .env.local match `vite build`.
 * CI: secrets must be set on the workflow step env (see deploy-pages.yml).
 */
import { loadEnv } from 'vite';
import path from 'path';
import { fileURLToPath } from 'url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fromFiles = loadEnv('production', root, 'VITE_');
const env = { ...fromFiles, ...process.env };

const required = [
  'VITE_FIREBASE_API_KEY',
  'VITE_FIREBASE_AUTH_DOMAIN',
  'VITE_FIREBASE_PROJECT_ID',
  'VITE_FIREBASE_APP_ID',
];

const missing = required.filter((k) => !env[k] || String(env[k]).trim() === '');
if (missing.length) {
  console.error('[checkFirebaseBuildEnv] Missing:', missing.join(', '));
  console.error(
    'Fix: copy .env.example → .env.local and fill Firebase web config, then npm run deploy.\n' +
      'Or: GitHub → Settings → Secrets and variables → Actions → add the same VITE_FIREBASE_* names, then re-run the Deploy workflow.'
  );
  process.exit(1);
}
