// Runs HT-Demucs 6-stem (ONNX) in a worker and returns the separated stems.
import * as ort from 'onnxruntime-web/webgpu';

export const STEMS = ['drums', 'bass', 'other', 'vocals', 'guitar', 'piano'];
const N = 343980; // model segment: 7.8 s at 44.1 kHz
const OVERLAP = Math.floor(N / 4);
const CACHE = 'transcribe-models-v1';

const post = (msg, transfer) => self.postMessage(msg, transfer || []);

async function fetchModel(url) {
  let cache = null;
  try {
    cache = await caches.open(CACHE);
    const hit = await cache.match(url);
    if (hit) {
      post({ type: 'status', text: 'Loading the separation model from this browser’s cache…' });
      return new Uint8Array(await hit.arrayBuffer());
    }
  } catch { cache = null; }

  const res = await fetch(url, { mode: 'cors' });
  if (!res.ok || (res.headers.get('content-type') || '').includes('text/html')) {
    throw new Error(`Model download failed (HTTP ${res.status}).`);
  }
  const total = Number(res.headers.get('content-length')) || 0;
  const reader = res.body.getReader();
  const chunks = [];
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    got += value.length;
    post({ type: 'download', loaded: got, total });
  }
  const bytes = new Uint8Array(got);
  let o = 0;
  for (const c of chunks) { bytes.set(c, o); o += c.length; }
  if (cache) {
    try { await cache.put(url, new Response(bytes, { headers: { 'content-type': 'application/octet-stream' } })); } catch {}
  }
  return bytes;
}

function makeWindow() {
  const w = new Float32Array(N).fill(1);
  for (let i = 0; i < OVERLAP; i++) {
    const v = (i + 1) / (OVERLAP + 1);
    w[i] = v;
    w[N - 1 - i] = v;
  }
  return w;
}

async function separate({ left, right, modelUrl, engine, wasmPaths }) {
  if (wasmPaths) ort.env.wasm.wasmPaths = wasmPaths;
  ort.env.wasm.numThreads = self.crossOriginIsolated ? Math.min(8, navigator.hardwareConcurrency || 4) : 1;

  post({ type: 'status', text: 'Downloading the separation model…' });
  const model = await fetchModel(modelUrl);
  post({ type: 'status', text: 'Starting the separation engine…' });
  const session = await ort.InferenceSession.create(model, {
    executionProviders: engine === 'gpu' ? ['webgpu'] : ['wasm'],
    graphOptimizationLevel: 'all',
  });

  const total = left.length;
  const stride = N - OVERLAP;
  const chunks = Math.max(1, Math.ceil(total / stride));
  const out = STEMS.map(() => [new Float32Array(total), new Float32Array(total)]);
  const weight = new Float32Array(total);
  const win = makeWindow();
  const input = new Float32Array(2 * N);
  const t0 = performance.now();

  for (let c = 0; c < chunks; c++) {
    const start = c * stride;
    const valid = Math.min(N, total - start);
    input.fill(0);
    input.set(left.subarray(start, start + valid), 0);
    input.set(right.subarray(start, start + valid), N);
    const res = await session.run({ mix: new ort.Tensor('float32', input, [1, 2, N]) });
    const stems = (res.stems || Object.values(res)[0]).data;

    if (c === 0) {
      let bad = false, energy = 0;
      for (let i = 0; i < stems.length; i += 97) {
        const v = stems[i];
        if (!Number.isFinite(v)) { bad = true; break; }
        energy += v * v;
      }
      let inEnergy = 0;
      for (let i = 0; i < input.length; i += 97) inEnergy += input[i] * input[i];
      if (bad || (inEnergy > 1e-3 && energy === 0)) throw new Error('ENGINE_INVALID_OUTPUT');
    }

    for (let s = 0; s < STEMS.length; s++) {
      for (let ch = 0; ch < 2; ch++) {
        const base = (s * 2 + ch) * N;
        const dst = out[s][ch];
        for (let i = 0; i < valid; i++) dst[start + i] += stems[base + i] * win[i];
      }
    }
    for (let i = 0; i < valid; i++) weight[start + i] += win[i];
    Object.values(res).forEach((t) => t.dispose?.());

    const elapsed = (performance.now() - t0) / 1000;
    post({ type: 'progress', done: c + 1, total: chunks, eta: (elapsed / (c + 1)) * (chunks - c - 1) });
  }

  for (let i = 0; i < total; i++) {
    const w = 1 / Math.max(weight[i], 1e-8);
    for (let s = 0; s < STEMS.length; s++) { out[s][0][i] *= w; out[s][1][i] *= w; }
  }
  await session.release?.();
  const transfer = out.flatMap((p) => [p[0].buffer, p[1].buffer]);
  post({ type: 'done', stems: STEMS.map((name, i) => ({ name, channels: out[i] })) }, transfer);
}

self.onmessage = async (e) => {
  try {
    await separate(e.data);
  } catch (err) {
    post({ type: 'error', message: String(err?.message || err) });
  }
};
