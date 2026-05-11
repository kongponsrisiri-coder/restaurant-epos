import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  // Relative asset paths so the same dist/ works both via http (Netlify)
  // and via file:// (Electron renderer).
  base: './',
  server: {
    host: '0.0.0.0',
    port: 5173
  }
})