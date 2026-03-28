import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  base: '/nozeplot4/',
  plugins: [react()],
  server: {
    host: 'localhost',
    port: 5174,
    // Helps Google/Firebase OAuth popups in dev (avoids "The requested action is invalid" in some browsers)
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin-allow-popups',
    },
  },
})
