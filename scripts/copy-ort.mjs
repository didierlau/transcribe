// Copies ONNX Runtime's WebAssembly files into public/ort so the separation
// worker can load them (and start its worker threads) from a stable URL.
import { cpSync, mkdirSync, readdirSync } from 'node:fs';

const src = 'node_modules/onnxruntime-web/dist';
const dst = 'public/ort';
mkdirSync(dst, { recursive: true });
for (const f of readdirSync(src)) {
  if (/^ort-wasm-simd-threaded(\.asyncify)?\.(mjs|wasm)$/.test(f)) cpSync(`${src}/${f}`, `${dst}/${f}`);
}
console.log('Copied ONNX Runtime files to', dst);
