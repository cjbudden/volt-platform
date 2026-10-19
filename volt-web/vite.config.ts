import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { fileURLToPath } from 'node:url'

// THE PLAYER SDK is imported as source from ../volt-player (the same code the
// embed bundle is built from), so the console's players and a customer's are
// one player. Its own node_modules supply Shaka.
const PLAYER_SDK = fileURLToPath(new URL('../volt-player/src/sdk', import.meta.url))

// STYLING: Tailwind utilities + our design tokens as ONE system.
// src/index.css imports Tailwind's theme and utilities layers and feeds it our
// tokens via @theme, so `text-body`, `bg-panel`, `text-muted` resolve to the
// same values as the semantic component classes. See DESIGN_SYSTEM.md.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: [{ find: /^@volt\/player$/, replacement: PLAYER_SDK + '/index.ts' }, { find: /^@volt\/player\/(.*)$/, replacement: PLAYER_SDK + '/$1' }] },
  server: {
    fs: { allow: ['..'] },
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
      '/filler': 'http://localhost:8080',  // uploaded slates & loops
      '/clips': 'http://localhost:8080',   // rendered clip outputs
      '^/player/': 'http://localhost:8080',  // the embed bundle (Player setup snippet, share pages)
    },
  },
})
