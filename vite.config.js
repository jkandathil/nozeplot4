import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  base: '/nozeplot4/',
  plugins: [react()],
  server: {
    host: 'localhost',
    port: 5174,
  },
})
