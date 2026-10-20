// Audio helpers: decoding, resampling, downmixing, WAV export, waveform peaks.

export const SEP_RATE = 44100;
export const PITCH_RATE = 22050;

export async function decodeFile(ctx, file) {
  const data = await file.arrayBuffer();
  return await ctx.decodeAudioData(data);
}

/** Return [left, right] Float32Arrays at 44.1 kHz (mono is duplicated). */
export async function toStereo44k(buffer) {
  let buf = buffer;
  if (buffer.sampleRate !== SEP_RATE || buffer.numberOfChannels !== 2) {
    const len = Math.ceil((buffer.length * SEP_RATE) / buffer.sampleRate);
    const off = new OfflineAudioContext(2, len, SEP_RATE);
    const src = off.createBufferSource();
    src.buffer = buffer;
    src.connect(off.destination);
    src.start();
    buf = await off.startRendering();
  }
  return [buf.getChannelData(0).slice(), buf.getChannelData(1).slice()];
}

/** Mono mixdown resampled to `rate`. */
export async function toMono(buffer, rate = PITCH_RATE) {
  const len = Math.ceil((buffer.length * rate) / buffer.sampleRate);
  const off = new OfflineAudioContext(1, len, rate);
  const src = off.createBufferSource();
  src.buffer = buffer;
  src.connect(off.destination);
  src.start();
  const out = await off.startRendering();
  return out.getChannelData(0).slice();
}

export function makeBuffer(ctx, channels, rate = SEP_RATE) {
  const buf = ctx.createBuffer(channels.length, channels[0].length, rate);
  channels.forEach((c, i) => buf.copyToChannel(c, i));
  return buf;
}

/** 16-bit PCM WAV blob from an AudioBuffer. */
export function bufferToWav(buffer) {
  const nCh = buffer.numberOfChannels, len = buffer.length, rate = buffer.sampleRate;
  const bytes = 44 + len * nCh * 2;
  const view = new DataView(new ArrayBuffer(bytes));
  const str = (o, s) => [...s].forEach((c, i) => view.setUint8(o + i, c.charCodeAt(0)));
  str(0, 'RIFF'); view.setUint32(4, bytes - 8, true); str(8, 'WAVE');
  str(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true);
  view.setUint16(22, nCh, true); view.setUint32(24, rate, true);
  view.setUint32(28, rate * nCh * 2, true); view.setUint16(32, nCh * 2, true);
  view.setUint16(34, 16, true); str(36, 'data'); view.setUint32(40, len * nCh * 2, true);
  const chans = Array.from({ length: nCh }, (_, i) => buffer.getChannelData(i));
  let o = 44;
  for (let i = 0; i < len; i++) {
    for (let c = 0; c < nCh; c++) {
      const s = Math.max(-1, Math.min(1, chans[c][i]));
      view.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true);
      o += 2;
    }
  }
  return new Blob([view], { type: 'audio/wav' });
}

/** Min/max peaks per pixel column for drawing a waveform. */
export function peaks(buffers, columns) {
  const len = buffers[0].length;
  const per = len / columns;
  const out = new Float32Array(columns * 2);
  for (let c = 0; c < columns; c++) {
    const a = Math.floor(c * per), b = Math.min(len, Math.floor((c + 1) * per));
    let mn = 0, mx = 0;
    for (const buf of buffers) {
      const d = buf.getChannelData(0);
      for (let i = a; i < b; i += 4) {
        const v = d[i];
        if (v < mn) mn = v;
        if (v > mx) mx = v;
      }
    }
    out[c * 2] = mn; out[c * 2 + 1] = mx;
  }
  return out;
}

export function download(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}

export function formatTime(t) {
  if (!isFinite(t)) t = 0;
  const m = Math.floor(t / 60), s = Math.floor(t % 60), cs = Math.floor((t % 1) * 10);
  return `${m}:${String(s).padStart(2, '0')}.${cs}`;
}
