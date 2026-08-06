import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    host: true,
    port: 5173,
    // allow the public tunnel hostname (cloudflared quick tunnel) to reach the dev server
    allowedHosts: true,
    // talk to the control plane same-origin (no CORS) during dev
    proxy: {
      '/api': 'http://localhost:8080',
      '/origin': 'http://localhost:8080', // test-stream HLS/DASH/WebVTT
    },
  },
})
