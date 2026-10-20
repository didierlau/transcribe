import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';

// Lets the dev server use multi-threaded WebAssembly (on GitHub Pages the
// service worker in public/coi-serviceworker.min.js does this instead).
const isolation = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
};

export default defineConfig({
  // Relative base so the site works at https://<user>.github.io/<repo>/
  base: './',
  resolve: {
    alias: [
      // Use ONNX Runtime's unbundled build: it loads its WebAssembly from
      // public/ort (see scripts/copy-ort.mjs), which multi-threading needs.
      {
        find: /^onnxruntime-web\/webgpu$/,
        replacement: fileURLToPath(new URL('./node_modules/onnxruntime-web/dist/ort.webgpu.min.mjs', import.meta.url)),
      },
    ],
  },
  worker: { format: 'es' },
  optimizeDeps: { exclude: ['onnxruntime-web'] },
  build: { target: 'es2022', chunkSizeWarningLimit: 4000 },
  server: { headers: isolation },
  preview: { headers: isolation },
});
