import { defineConfig } from 'vite'
import { resolve } from 'node:path'

/**
 * ONE FILE, IIFE, NO MODULE LOADER.
 *
 * The player is embedded with a plain <script src> on somebody else's website,
 * which may be a WordPress theme, a CMS block, or a static page from 2014.
 * An ES module build would need type="module", would fail silently on anything
 * that does not support it, and would pull shaka as a second request from a
 * relative path the host page controls. A single self-contained IIFE that
 * defines one global is the format that works everywhere it will actually be
 * pasted.
 */
export default defineConfig({
  build: {
    lib: {
      entry: resolve(__dirname, 'src/index.ts'),
      name: 'VoltPlayer',
      formats: ['iife'],
      fileName: () => 'volt-player.js',
    },
    // Shaka is BUNDLED, not external. An embedder should not have to add a
    // second script tag in the right order, and a CDN copy is one more thing
    // that can be blocked by a corporate proxy or pinned to a version that
    // stops matching this code.
    rollupOptions: { output: { inlineDynamicImports: true } },
    cssCodeSplit: false,
    sourcemap: true,
    target: 'es2018',
  },
})
