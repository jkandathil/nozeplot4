import { createRequire } from 'node:module'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const require = createRequire(import.meta.url)
const monacoEditorPlugin = require('vite-plugin-monaco-editor').default

// https://vite.dev/config/
export default defineConfig({
  base: '/nozeplot4/',
  plugins: [
    react(),
    monacoEditorPlugin({
      languageWorkers: ['editorWorkerService', 'typescript', 'json', 'html', 'css'],
    }),
  ],
  server: {
    host: 'localhost',
    port: 5174,
    // Helps Google/Firebase OAuth popups in dev (avoids "The requested action is invalid" in some browsers)
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin-allow-popups',
    },
    // Dev: proxy to local compile bridge (npm run mcu:bridge) so Build works without CORS/URL config.
    proxy: {
      '/mcu-compile': {
        target: 'http://localhost:8787',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/mcu-compile/, ''),
      },
    },
  },
})
