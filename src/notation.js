// Turns transcribed notes into a grand-staff score (ABC notation) and
// estimates tempo/beat grid from audio. Pure functions, usable in workers.

// ---------- Tempo & beat detection ----------

function fftMag(re, im) {
  // In-place radix-2 FFT; returns nothing, re/im modified.
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k, b = a + len / 2;
        const tr = re[b] * cr - im[b] * ci;
        const ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr; im[b] = im[a] - ti;
        re[a] += tr; im[a] += ti;
        const ncr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr; cr = ncr;
      }
    }
  }
}

/** Spectral-flux onset envelope. Returns {env, fps}. */
export function onsetEnvelope(mono, sr, n = 1024, hop = 512) {
  const frames = Math.max(0, Math.floor((mono.length - n) / hop));
  const env = new Float32Array(frames);
  const win = new Float32Array(n);
  for (let i = 0; i < n; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n);
  const half = n / 2;
  let prev = new Float32Array(half);
  const re = new Float32Array(n), im = new Float32Array(n);
  for (let f = 0; f < frames; f++) {
    const off = f * hop;
    for (let i = 0; i < n; i++) { re[i] = mono[off + i] * win[i]; im[i] = 0; }
    fftMag(re, im);
    let flux = 0;
    const cur = new Float32Array(half);
    for (let k = 1; k < half; k++) {
      const m = Math.log1p(100 * Math.hypot(re[k], im[k]));
      cur[k] = m;
      const d = m - prev[k];
      if (d > 0) flux += d;
    }
    env[f] = flux;
    prev = cur;
  }
  // remove slow trend
  const out = new Float32Array(frames);
  const w = 16;
  let acc = 0;
  for (let i = 0; i < frames; i++) {
    acc += env[i];
    if (i >= w) acc -= env[i - w];
    const mean = acc / Math.min(i + 1, w);
    out[i] = Math.max(0, env[i] - mean);
  }
  return { env: out, fps: sr / hop };
}

/** Estimate BPM and the time of the first beat. */
export function detectTempo(mono, sr) {
  const { env, fps } = onsetEnvelope(mono, sr);
  if (env.length < fps * 4) return { bpm: 120, firstBeat: 0 };
  const minBpm = 60, maxBpm = 200;
  const minLag = Math.floor((60 / maxBpm) * fps);
  const maxLag = Math.ceil((60 / minBpm) * fps);
  let best = { score: -Infinity, lag: fps / 2 };
  for (let lag = minLag; lag <= maxLag; lag++) {
    let s = 0;
    for (let i = lag; i < env.length; i++) s += env[i] * env[i - lag];
    s /= env.length - lag;
    const bpm = (60 * fps) / lag;
    // prefer musically common tempi (log-gaussian around 110 BPM)
    const prior = Math.exp(-0.5 * Math.pow(Math.log2(bpm / 110) / 0.9, 2));
    const score = s * prior;
    if (score > best.score) best = { score, lag };
  }
  // refine lag with parabolic interpolation on raw autocorrelation
  const ac = (lag) => {
    let s = 0;
    for (let i = lag; i < env.length; i++) s += env[i] * env[i - lag];
    return s / (env.length - lag);
  };
  const l = best.lag;
  const y0 = ac(l - 1), y1 = ac(l), y2 = ac(l + 1);
  const denom = y0 - 2 * y1 + y2;
  const lag = denom !== 0 ? l + (0.5 * (y0 - y2)) / denom : l;
  let bpm = (60 * fps) / lag;
  bpm = Math.round(bpm * 10) / 10;

  // phase: offset maximizing summed onset strength on the beat grid
  const period = (60 / bpm) * fps;
  let bestOff = 0, bestSum = -Infinity;
  for (let o = 0; o < period; o += 0.5) {
    let s = 0;
    for (let t = o; t < env.length; t += period) s += env[Math.round(t)] || 0;
    if (s > bestSum) { bestSum = s; bestOff = o; }
  }
  return { bpm, firstBeat: bestOff / fps };
}

// ---------- Key detection ----------

const MAJOR_PROFILE = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const MINOR_PROFILE = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];
// tonic pitch class -> key signature (positive = sharps, negative = flats)
const MAJOR_SIG = { 0: 0, 7: 1, 2: 2, 9: 3, 4: 4, 11: 5, 6: 6, 1: -5, 8: -4, 3: -3, 10: -2, 5: -1 };
const MAJOR_NAME = { 0: 'C', 7: 'G', 2: 'D', 9: 'A', 4: 'E', 11: 'B', 6: 'F#', 1: 'Db', 8: 'Ab', 3: 'Eb', 10: 'Bb', 5: 'F' };

function corr(a, b) {
  const ma = a.reduce((x, y) => x + y, 0) / 12, mb = b.reduce((x, y) => x + y, 0) / 12;
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < 12; i++) {
    num += (a[i] - ma) * (b[i] - mb);
    da += (a[i] - ma) ** 2; db += (b[i] - mb) ** 2;
  }
  return da && db ? num / Math.sqrt(da * db) : 0;
}

/** Krumhansl-Schmuckler key finding. Returns {sig, name}. */
export function detectKey(notes) {
  const hist = new Array(12).fill(0);
  for (const n of notes) hist[n.pitch % 12] += n.duration;
  let best = { r: -Infinity, sig: 0, name: 'C' };
  for (let t = 0; t < 12; t++) {
    const rot = (p) => p.map((_, i) => p[(i - t + 12) % 12]);
    const rMaj = corr(hist, rot(MAJOR_PROFILE));
    if (rMaj > best.r) best = { r: rMaj, sig: MAJOR_SIG[t], name: MAJOR_NAME[t] };
    const rMin = corr(hist, rot(MINOR_PROFILE));
    const rel = (t + 3) % 12;
    if (rMin > best.r) {
      const minorNames = { 9: 'A', 4: 'E', 11: 'B', 6: 'F#', 1: 'C#', 8: 'G#', 3: 'D#', 10: 'Bb', 5: 'F', 0: 'C', 7: 'G', 2: 'D' };
      best = { r: rMin, sig: MAJOR_SIG[rel], name: minorNames[t] + 'm' };
    }
  }
  return { sig: best.sig, name: best.name };
}

// ---------- Pitch spelling ----------

const LETTERS = ['C', 'D', 'E', 'F', 'G', 'A', 'B'];
const NATURAL_PC = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
const SHARP_ORDER = ['F', 'C', 'G', 'D', 'A', 'E', 'B'];
const FLAT_ORDER = ['B', 'E', 'A', 'D', 'G', 'C', 'F'];

export function keyAccidentals(sig) {
  const acc = { C: 0, D: 0, E: 0, F: 0, G: 0, A: 0, B: 0 };
  if (sig > 0) SHARP_ORDER.slice(0, sig).forEach((l) => (acc[l] = 1));
  if (sig < 0) FLAT_ORDER.slice(0, -sig).forEach((l) => (acc[l] = -1));
  return acc;
}

/** Spell a MIDI pitch in a key: returns {letter, acc, octave}. */
export function spell(midi, sig, keyAcc) {
  const pc = ((midi % 12) + 12) % 12;
  let letter = null, acc = 0;
  for (const l of LETTERS) {
    if ((NATURAL_PC[l] + keyAcc[l] + 12) % 12 === pc) { letter = l; acc = keyAcc[l]; break; }
  }
  if (!letter) {
    for (const l of LETTERS) if (NATURAL_PC[l] === pc) { letter = l; acc = 0; }
  }
  if (!letter) {
    const useFlats = sig < 0;
    for (const l of LETTERS) {
      if (!useFlats && (NATURAL_PC[l] + 1) % 12 === pc) { letter = l; acc = 1; break; }
      if (useFlats && (NATURAL_PC[l] + 11) % 12 === pc) { letter = l; acc = -1; break; }
    }
  }
  const naturalMidi = midi - acc;
  const octave = Math.floor(naturalMidi / 12) - 1;
  return { letter, acc, octave };
}

function abcPitch({ letter, octave }) {
  if (octave >= 5) return letter.toLowerCase() + "'".repeat(octave - 5);
  return letter + ','.repeat(Math.max(0, 4 - octave));
}

const ACC_TXT = { '-2': '__', '-1': '_', '0': '=', '1': '^', '2': '^^' };

// ---------- ABC building ----------

const REPRESENTABLE = [16, 12, 8, 6, 4, 3, 2, 1]; // in 16ths

function splitDuration(len) {
  const parts = [];
  while (len > 0) {
    const p = REPRESENTABLE.find((r) => r <= len);
    parts.push(p);
    len -= p;
  }
  return parts;
}

/**
 * Build ABC for a two-staff piano score.
 * notes: [{pitch, start, duration}] (seconds)
 * opts: {bpm, offset (time of first downbeat, s), beatsPerBar, grid (2 = 8ths, 4 = 16ths),
 *        split (MIDI pitch, notes >= go to treble), title, barsPerLine}
 * Returns {abc, events: [{char, time}], key}
 */
export function buildAbc(notes, opts) {
  const { bpm = 120, beatsPerBar = 4, grid = 4, split = 60, title = 'Transcription', barsPerLine = 4 } = opts;
  let offset = opts.offset || 0;
  const step = 60 / bpm / 4; // one 16th in seconds
  const unit = 4 / grid; // grid size in 16ths
  const barLen = beatsPerBar * 4;
  const key = opts.key || detectKey(notes);
  const keyAcc = keyAccidentals(key.sig);

  const snap = (x) => Math.round(x / unit) * unit;
  let q = notes.map((n) => ({
    pitch: n.pitch,
    s: snap((n.start - offset) / step),
    d: Math.max(unit, snap(n.duration / step)),
  }));
  if (q.length) {
    const minS = Math.min(...q.map((n) => n.s));
    if (minS < 0) {
      const shiftBars = Math.ceil(-minS / barLen);
      q.forEach((n) => (n.s += shiftBars * barLen));
      offset -= shiftBars * barLen * step;
    }
  }
  const lastEnd = q.reduce((m, n) => Math.max(m, n.s + n.d), 0);
  const nBars = Math.max(1, Math.ceil(lastEnd / barLen));

  const stepToTime = (s) => offset + s * step;

  function voiceBars(vNotes) {
    // group by onset
    const groups = new Map();
    for (const n of vNotes) {
      if (!groups.has(n.s)) groups.set(n.s, { pitches: new Set(), end: 0 });
      const g = groups.get(n.s);
      g.pitches.add(n.pitch);
      g.end = Math.max(g.end, n.s + n.d);
    }
    const onsets = [...groups.keys()].sort((a, b) => a - b);
    const events = []; // {type:'n'|'r', pitches, s, len}
    let cursor = 0;
    onsets.forEach((s, i) => {
      const g = groups.get(s);
      if (s > cursor) events.push({ type: 'r', s: cursor, len: s - cursor });
      const next = i + 1 < onsets.length ? onsets[i + 1] : Infinity;
      let end = Math.min(g.end, next);
      if (end <= s) end = s + unit;
      events.push({ type: 'n', pitches: [...g.pitches].sort((a, b) => a - b), s, len: end - s });
      cursor = end;
    });
    if (cursor < nBars * barLen) events.push({ type: 'r', s: cursor, len: nBars * barLen - cursor });

    // emit tokens per bar
    const bars = Array.from({ length: nBars }, () => []);
    let accState = {};
    let curBar = -1;
    for (const ev of events) {
      let s = ev.s, len = ev.len;
      let first = true;
      while (len > 0) {
        const bar = Math.floor(s / barLen);
        if (bar >= nBars) break;
        if (bar !== curBar) { accState = {}; curBar = bar; }
        const barEnd = (bar + 1) * barLen;
        const seg = Math.min(len, barEnd - s);
        const pieces = splitDuration(seg);
        pieces.forEach((p, pi) => {
          const lenTxt = p === 1 ? '' : String(p);
          let text;
          if (ev.type === 'r') {
            text = 'z' + lenTxt;
          } else {
            const parts = ev.pitches.map((m) => {
              const sp = spell(m, key.sig, keyAcc);
              const k = sp.letter + sp.octave;
              const current = k in accState ? accState[k] : keyAcc[sp.letter];
              let pre = '';
              if (sp.acc !== current) { pre = ACC_TXT[String(sp.acc)]; accState[k] = sp.acc; }
              return pre + abcPitch(sp);
            });
            text = (parts.length > 1 ? '[' + parts.join('') + ']' : parts[0]) + lenTxt;
            const moreComing = pi < pieces.length - 1 || len - seg > 0;
            if (moreComing) text += '-';
          }
          bars[bar].push({ text, beat: s % 4 === 0 || ev.type === 'r', time: first && ev.type === 'n' ? stepToTime(s) : null });
          first = false;
          s += p;
        });
        len -= seg;
      }
    }
    return bars;
  }

  const rh = voiceBars(q.filter((n) => n.pitch >= split));
  const lh = voiceBars(q.filter((n) => n.pitch < split));

  const header = [
    'X:1',
    `T:${title.replace(/[\r\n]/g, ' ')}`,
    `M:${beatsPerBar}/4`,
    'L:1/16',
    `Q:1/4=${Math.round(bpm)}`,
    '%%score {RH | LH}',
    'V:RH clef=treble',
    'V:LH clef=bass',
    `K:${key.name}`,
  ].join('\n') + '\n';

  let abc = header;
  const events = [];
  const pushBars = (voice, bars, from, to) => {
    abc += `[V:${voice}] `;
    for (let b = from; b < to; b++) {
      for (const tok of bars[b]) {
        // a space starts a new beam group: break beams on every beat
        if (tok.beat && !abc.endsWith(' ')) abc += ' ';
        if (tok.time != null) events.push({ char: abc.length, time: tok.time });
        abc += tok.text;
      }
      abc += b === nBars - 1 ? ' |]' : ' | ';
    }
    abc += '\n';
  };
  for (let b = 0; b < nBars; b += barsPerLine) {
    const to = Math.min(nBars, b + barsPerLine);
    pushBars('RH', rh, b, to);
    pushBars('LH', lh, b, to);
  }
  return { abc, events, key, offset };
}
