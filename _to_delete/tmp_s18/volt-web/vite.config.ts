import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// STYLING: Tailwind utilities + our design tokens as ONE system.
// src/index.css imports Tailwind's theme and utilities layers and feeds it our
// tokens via @theme, so `text-body`, `bg-panel`, `text-muted` resolve to the
// same values as the semantic component classes. See DESIGN_SYSTEM.md.
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
      '/origin': 'http://localhost:8080',  // test-stream HLS/DASH/WebVTT
      '/library': 'http://localhost:8080', // image-library original bytes
      '/img': 'http://localhost:8080',     // resized preview derivatives
      '/radio': 'http://localhost:8080',   // live MP3 fan-out (radio stations)
    },
  },
})
