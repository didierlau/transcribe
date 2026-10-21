import './styles.css';
import abcjs from 'abcjs';
import { Midi } from '@tonejs/midi';
import { Player } from './player.js';
import { buildAbc } from './notation.js';
import {
  decodeFile, toStereo44k, toMono, makeBuffer, bufferToWav, peaks, download, formatTime, SEP_RATE,
} from './audio.js';
import { Recorder, listMics, canRecordMic, canRecordTab } from './recorder.js';

const $ = (id) => document.getElementById(id);
const BASE = import.meta.env.BASE_URL;
const params = new URLSearchParams(location.search);

const MODELS = {
  gpu: { url: 'https://huggingface.co/kramp/htdemucs-6s-webgpu-onnx/resolve/main/htdemucs_6s.onnx', size: '285 MB' },
  cpu: { url: 'https://huggingface.co/adowu/htdemucs-6s-onnx/resolve/main/htdemucs_6s_fp16weights.onnx', size: '136 MB' },
};

const STEM_INFO = {
  mix: { label: 'Full mix', color: '#C9D6DE' },
  drums: { label: 'Drums', color: '#E36B5D' },
  bass: { label: 'Bass', color: '#4FA3E0' },
  piano: { label: 'Piano', color: '#5FC9A8' },
  guitar: { label: 'Guitar', color: '#F29A4A' },
  vocals: { label: 'Vocals', color: '#EC8FC0' },
  other: { label: 'Other', color: '#A99BEF' },
};
const STEM_ORDER = ['drums', 'bass', 'piano', 'guitar', 'vocals', 'other'];
const PITCH_RANGE = {
  piano: [21, 108], mix: [21, 108], other: [21, 108],
  bass: [28, 67], guitar: [40, 88], vocals: [40, 84], drums: [21, 108],
};

const ctx = new AudioContext({ sampleRate: SEP_RATE, latencyHint: 'playback' });
const player = new Player(ctx);

const state = {
  fileName: '',
  original: null, // AudioBuffer
  stems: null, // {name: AudioBuffer}
  waveform: null,
  sepWorker: null,
  trWorker: null,
  notes: null,
  tempo: { bpm: 120, firstBeat: 0 },
  barShift: 0,
  abc: null,
  abcEvents: [],
  taps: [],
};

// ---------- toast ----------
let toastTimer;
function toast(text, ms = 5000) {
  const el = $('toast');
  el.textContent = text;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), ms);
}

// ---------- loading a file ----------
function loadBuffer(buf, name) {
  stopSeparation();
  closeRecorder();
  player.pause();
  updatePlayUi();
  state.original = buf;
  state.stems = null;
  state.notes = null;
  state.abc = null;
  state.barShift = 0;
  $('songName').textContent = name;
  $('dropZone').hidden = true;
  $('deck').hidden = false;
  $('scorePanel').hidden = false;
  $('splitPanel').hidden = false;
  $('splitBtn').disabled = false;
  $('scoreTools').hidden = true;
  $('trProgress').hidden = true;
  $('scoreMeta').textContent = '';
  $('sheet').innerHTML = '';
  player.loop = { enabled: false, a: 0, b: 0 };
  updateLoopUi();
  player.seek(0);
  setTracks([{ id: 'mix', buffer: buf }]);
  fillSources();
  $('timeTotal').textContent = '/ ' + formatTime(buf.duration);
}

async function loadFile(file) {
  if (!file) return;
  const prev = $('songName').textContent;
  try {
    $('songName').textContent = 'Opening ' + file.name + '…';
    const buf = await decodeFile(ctx, file);
    state.fileName = file.name.replace(/\.[^.]+$/, '');
    loadBuffer(buf, state.fileName);
  } catch (err) {
    console.error(err);
    $('songName').textContent = prev.startsWith('Opening') ? '' : prev;
    toast(`Couldn’t open ${file.name}. Try an MP3 or WAV file.`);
  }
}

// ---------- recording ----------
const recorder = { active: null, source: 'mic', timer: 0 };

function setRecSource(source) {
  recorder.source = source;
  document.querySelectorAll('.rec-source').forEach((b) =>
    b.setAttribute('aria-checked', String(b.dataset.source === source)));
  $('micField').hidden = source !== 'mic';
  $('recHint').textContent = source === 'mic'
    ? 'Place the microphone near the instruments or the speaker. Keep the level out of the red.'
    : 'When the browser asks, choose the tab that’s playing and make sure “Also share tab audio” is on. Then press play in that tab.';
}

async function fillMics() {
  const mics = await listMics().catch(() => []);
  const sel = $('micSel');
  const cur = sel.value;
  sel.innerHTML = '<option value="">Default microphone</option>' + mics
    .filter((m) => m.deviceId && m.deviceId !== 'default')
    .map((m, i) => `<option value="${m.deviceId}">${(m.label || `Microphone ${i + 1}`).replace(/</g, '&lt;')}</option>`).join('');
  sel.value = [...sel.options].some((o) => o.value === cur) ? cur : '';
}

function openRecorder() {
  if (!canRecordMic() && !canRecordTab()) {
    toast('This browser can’t record audio. Try Chrome, Edge or Firefox.');
    return;
  }
  player.pause();
  updatePlayUi();
  $('tabSource').disabled = !canRecordTab();
  if (!canRecordTab()) $('tabDesc').textContent = 'Not available in this browser. Use Chrome or Edge on a computer.';
  $('dropZone').hidden = true;
  $('recPanel').hidden = false;
  setRecSource(canRecordMic() ? 'mic' : 'tab');
  fillMics();
  $('recBtn').focus();
}

function closeRecorder() {
  if (recorder.active) recorder.active.cancel();
  recorder.active = null;
  cancelAnimationFrame(recorder.timer);
  setRecUi(false);
  $('recPanel').hidden = true;
  if (!state.original) $('dropZone').hidden = false;
}

function setRecUi(on) {
  $('recBtn').classList.toggle('is-recording', on);
  $('recBtn').setAttribute('aria-label', on ? 'Stop recording' : 'Start recording');
  $('recPanel').classList.toggle('is-recording', on);
  document.querySelectorAll('.rec-source, #micSel').forEach((el) => (el.disabled = on || (el.id === 'tabSource' && !canRecordTab())));
  if (!on) { $('recTime').textContent = '0:00.0'; $('recMeter').style.clipPath = ''; recorder.level = 0; }
}

function meterLoop() {
  const r = recorder.active;
  if (!r) return;
  const pk = r.readPeak();
  const db = pk > 0 ? 20 * Math.log10(pk) : -60;
  const fill = $('recMeter');
  // jump up instantly, fall back slowly, like a hardware meter
  recorder.level = Math.max(Math.max(0, Math.min(100, ((db + 60) / 60) * 100)), (recorder.level || 0) - 1.2);
  const level = recorder.level;
  fill.style.clipPath = `inset(0 ${100 - level}% 0 0)`;
  $('recTime').textContent = formatTime(r.seconds);
  if (recorder.source === 'tab' && r.seconds > 6 && r.maxPeak < 0.001) {
    $('recHint').textContent = 'No sound is coming through. Check that the tab is playing and that tab audio is shared. Some services, like Spotify, block recording and only send silence.';
  }
  recorder.timer = requestAnimationFrame(meterLoop);
}

async function startRecording() {
  const r = new Recorder();
  recorder.active = r;
  try {
    await r.start(recorder.source, $('micSel').value);
  } catch (err) {
    recorder.active = null;
    const name = err?.name || '';
    if (err?.message === 'NO_TAB_AUDIO') toast('No sound was shared. Try again and turn on “Also share tab audio” in the sharing dialog.', 9000);
    else if (name === 'NotAllowedError') toast(recorder.source === 'mic' ? 'Microphone access was blocked. Allow it in the address bar, then try again.' : 'Sharing was cancelled.');
    else if (name === 'NotFoundError') toast('No microphone was found. Plug one in and try again.');
    else toast('Couldn’t start recording: ' + (err?.message || err));
    return;
  }
  r.onEnded = () => { if (recorder.active === r) stopRecording(); };
  setRecUi(true);
  if (recorder.source === 'mic') fillMics();
  meterLoop();
}

async function stopRecording() {
  const r = recorder.active;
  if (!r) return;
  recorder.active = null;
  cancelAnimationFrame(recorder.timer);
  const result = await r.stop();
  setRecUi(false);
  if (!result || result.channels[0].length < result.sampleRate * 0.5) {
    toast('The recording was empty. Check the input and try again.');
    return;
  }
  const buf = makeBuffer(ctx, result.channels, result.sampleRate);
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  state.fileName = `Recording ${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}.${pad(d.getMinutes())}`;
  loadBuffer(buf, state.fileName);
  toast(r.maxPeak > 0.99 ? 'Recorded, but parts were too loud and distorted. Move the microphone back for the next take.' : 'Recorded. Split it or transcribe it like any song.', 7000);
}

['recordOpen', 'recordOpen2'].forEach((id) => $(id).addEventListener('click', openRecorder));
$('recClose').addEventListener('click', closeRecorder);
document.querySelectorAll('.rec-source').forEach((b) => b.addEventListener('click', () => setRecSource(b.dataset.source)));
$('recBtn').addEventListener('click', () => (recorder.active ? stopRecording() : startRecording()));

['fileInput', 'fileInput2'].forEach((id) =>
  $(id).addEventListener('change', (e) => { loadFile(e.target.files[0]); e.target.value = ''; }));

const dz = document.body;
dz.addEventListener('dragover', (e) => { e.preventDefault(); document.body.classList.add('dragging'); });
dz.addEventListener('dragleave', (e) => { if (e.target === document.body || !e.relatedTarget) document.body.classList.remove('dragging'); });
dz.addEventListener('drop', (e) => {
  e.preventDefault();
  document.body.classList.remove('dragging');
  const f = [...e.dataTransfer.files].find((x) => x.type.startsWith('audio') || /\.(mp3|wav|flac|m4a|ogg|aac)$/i.test(x.name));
  if (f) loadFile(f); else toast('That isn’t an audio file. Drop an MP3, WAV, FLAC, M4A or OGG.');
});

// ---------- mixer ----------
function setTracks(list) {
  player.setTracks(list.map((t) => ({ ...t, name: t.id })));
  state.waveform = null;
  renderConsole();
  drawWave();
}

function gainToDb(g) {
  if (g <= 0.0001) return '−∞';
  const db = 20 * Math.log10(g);
  return (db > 0.05 ? '+' : db < -0.05 ? '−' : '') + Math.abs(db).toFixed(1);
}

function renderConsole() {
  const el = $('console');
  el.innerHTML = '';
  for (const t of player.tracks) {
    const info = STEM_INFO[t.id];
    const strip = document.createElement('div');
    strip.className = 'strip';
    strip.style.setProperty('--cap', info.color);
    strip.innerHTML = `
      <div class="scribble">${info.label}</div>
      <div class="fader-wrap">
        <input type="range" class="fader" min="0" max="150" value="${Math.round(t.gain * 100)}" aria-label="${info.label} volume" />
      </div>
      <output class="db">${gainToDb(t.gain)} dB</output>
      <div class="ms">
        <button class="btn-ms mute" aria-pressed="${t.muted}" title="Mute ${info.label}">M</button>
        <button class="btn-ms solo" aria-pressed="${t.solo}" title="Solo ${info.label}">S</button>
      </div>
      <button class="btn-dl" title="Download ${info.label} as WAV" aria-label="Download ${info.label} as WAV">
        <svg viewBox="0 0 24 24"><path d="M12 4v11m0 0-4.5-4.5M12 15l4.5-4.5M5 19h14"/></svg>
      </button>`;
    const fader = strip.querySelector('.fader');
    const out = strip.querySelector('.db');
    fader.addEventListener('input', () => {
      t.gain = fader.value / 100;
      out.textContent = gainToDb(t.gain) + ' dB';
      player.applyGains();
    });
    fader.addEventListener('dblclick', () => { fader.value = 100; fader.dispatchEvent(new Event('input')); });
    const mute = strip.querySelector('.mute');
    const solo = strip.querySelector('.solo');
    mute.addEventListener('click', () => {
      t.muted = !t.muted;
      mute.setAttribute('aria-pressed', t.muted);
      player.applyGains(); refreshStrips();
    });
    solo.addEventListener('click', () => {
      t.solo = !t.solo;
      solo.setAttribute('aria-pressed', t.solo);
      player.applyGains(); refreshStrips();
    });
    strip.querySelector('.btn-dl').addEventListener('click', () => {
      const base = state.fileName || 'song';
      download(bufferToWav(t.buffer), `${base} - ${info.label}.wav`);
    });
    t.el = strip;
    el.appendChild(strip);
  }
  refreshStrips();
}

function refreshStrips() {
  for (const t of player.tracks) t.el?.classList.toggle('silent', player.effectiveGain(t) === 0);
}

// ---------- waveform & transport ----------
const wave = $('wave');
function drawWave() {
  if (!player.tracks.length) return;
  const dpr = window.devicePixelRatio || 1;
  const w = wave.clientWidth, h = wave.clientHeight;
  if (!w) return;
  if (wave.width !== Math.round(w * dpr) || wave.height !== Math.round(h * dpr)) {
    wave.width = Math.round(w * dpr); wave.height = Math.round(h * dpr);
    state.waveform = null;
  }
  if (!state.waveform) state.waveform = peaks(player.tracks.map((t) => t.buffer), Math.round(w));
  const g = wave.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, w, h);
  const dur = player.duration || 1;
  const pos = player.currentTime / dur;
  const { enabled, a, b } = player.loop;
  if (b > a) {
    g.fillStyle = enabled ? 'rgba(242,179,61,0.16)' : 'rgba(242,179,61,0.07)';
    g.fillRect((a / dur) * w, 0, ((b - a) / dur) * w, h);
  }
  const p = state.waveform;
  const mid = h / 2;
  const scale = mid * 0.92 / Math.max(0.05, ...Array.from({ length: Math.min(p.length, 4000) }, (_, i) => Math.abs(p[i])));
  for (let x = 0; x < w; x++) {
    const mn = p[x * 2] * scale, mx = p[x * 2 + 1] * scale;
    g.fillStyle = x / w < pos ? '#8FD3BE' : '#4C6170';
    g.fillRect(x, mid - mx, 1, Math.max(1, mx - mn));
  }
  if (b > a) {
    g.fillStyle = '#F2B33D';
    g.fillRect((a / dur) * w - 1, 0, 2, h);
    g.fillRect((b / dur) * w - 1, 0, 2, h);
  }
  g.fillStyle = '#F4F7F9';
  g.fillRect(pos * w - 1, 0, 2, h);
}

let dragging = false;
function seekFromEvent(e) {
  const r = wave.getBoundingClientRect();
  const x = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
  player.seek(x * player.duration);
  drawWave();
}
wave.addEventListener('pointerdown', (e) => { dragging = true; wave.setPointerCapture(e.pointerId); seekFromEvent(e); });
wave.addEventListener('pointermove', (e) => { if (dragging) seekFromEvent(e); });
wave.addEventListener('pointerup', () => (dragging = false));
new ResizeObserver(() => drawWave()).observe(wave);

function updatePlayUi() {
  $('playBtn').classList.toggle('is-playing', player.playing);
  $('playBtn').setAttribute('aria-label', player.playing ? 'Pause' : 'Play');
}
async function togglePlay() {
  if (player.playing) player.pause(); else await player.play();
  updatePlayUi();
}
$('playBtn').addEventListener('click', togglePlay);
player.onEnded = updatePlayUi;

function tick() {
  if (player.tracks.length) {
    $('timeNow').textContent = formatTime(player.currentTime);
    if (player.playing) drawWave();
  }
  requestAnimationFrame(tick);
}
requestAnimationFrame(tick);

function updateLoopUi() {
  const { enabled, a, b } = player.loop;
  $('loopBtn').setAttribute('aria-pressed', String(enabled));
  $('loopRead').textContent = b > a ? `${formatTime(a)} – ${formatTime(b)}` : a > 0 ? `From ${formatTime(a)}` : 'No loop set';
  drawWave();
}
$('setA').addEventListener('click', () => {
  const a = player.currentTime;
  const b = player.loop.b > a ? player.loop.b : 0;
  player.setLoop({ a, b, enabled: player.loop.enabled && b > a });
  updateLoopUi();
});
$('setB').addEventListener('click', () => {
  const b = player.currentTime;
  if (b <= player.loop.a) { toast('Set the loop end after the loop start (A).'); return; }
  player.setLoop({ b, enabled: true });
  updateLoopUi();
});
$('loopBtn').addEventListener('click', () => {
  if (!(player.loop.b > player.loop.a)) { toast('Set A and B first: play to a spot and press Set A, then Set B.'); return; }
  player.setLoop({ enabled: !player.loop.enabled });
  updateLoopUi();
});

document.addEventListener('keydown', (e) => {
  if (e.target.closest('input, select, textarea') || !player.tracks.length || !$('recPanel').hidden) return;
  if (e.code === 'Space') { e.preventDefault(); togglePlay(); }
  else if (e.key === 'a' || e.key === 'A') $('setA').click();
  else if (e.key === 'b' || e.key === 'B') $('setB').click();
  else if (e.key === 'l' || e.key === 'L') $('loopBtn').click();
  else if (e.key === 'ArrowLeft') { player.seek(player.currentTime - 5); drawWave(); }
  else if (e.key === 'ArrowRight') { player.seek(player.currentTime + 5); drawWave(); }
});

// ---------- separation ----------
const engineSel = $('engineSel');
try { engineSel.value = localStorage.getItem('engine') || 'auto'; } catch {}
function updateModelSize() {
  const v = engineSel.value;
  $('modelSize').textContent = v === 'gpu' ? MODELS.gpu.size : v === 'cpu' ? MODELS.cpu.size : `${MODELS.cpu.size}, or ${MODELS.gpu.size} on a graphics card`;
}
engineSel.addEventListener('change', () => {
  try { localStorage.setItem('engine', engineSel.value); } catch {}
  updateModelSize();
});
updateModelSize();

async function pickEngine() {
  const pref = engineSel.value;
  if (pref !== 'auto') return pref;
  let gpuFailed = false;
  try { gpuFailed = localStorage.getItem('gpuFailed') === '1'; } catch {}
  if (!gpuFailed && navigator.gpu) {
    try { if (await navigator.gpu.requestAdapter()) return 'gpu'; } catch {}
  }
  return 'cpu';
}

function stopSeparation() {
  state.sepWorker?.terminate();
  state.sepWorker = null;
  $('splitProgress').hidden = true;
  $('splitBtn').disabled = false;
}

function setSplitProgress(frac, text) {
  $('splitProgress').hidden = false;
  $('splitFill').style.width = `${Math.round(frac * 100)}%`;
  $('splitText').textContent = text;
}

async function runSeparation(engine) {
  const [left, right] = await toStereo44k(state.original);
  const modelUrl = new URL(params.get('model') || MODELS[engine].url, location.href).href;
  const wasmPaths = new URL(`${BASE}ort/`, location.href).href;
  const worker = new Worker(new URL('./separator.worker.js', import.meta.url), { type: 'module' });
  state.sepWorker = worker;
  return new Promise((resolve, reject) => {
    worker.onmessage = (e) => {
      const m = e.data;
      if (m.type === 'status') setSplitProgress(0, m.text);
      else if (m.type === 'download') {
        const mb = (x) => (x / 1048576).toFixed(0);
        setSplitProgress(m.total ? m.loaded / m.total : 0,
          `Downloading the separation model: ${mb(m.loaded)}${m.total ? ' of ' + mb(m.total) : ''} MB. This happens once.`);
      } else if (m.type === 'progress') {
        const left = m.eta > 90 ? `about ${Math.round(m.eta / 60)} min left` : `about ${Math.max(1, Math.round(m.eta))} s left`;
        setSplitProgress(m.done / m.total, `Separating: part ${m.done} of ${m.total}, ${m.done < m.total ? left : 'finishing up'}`);
      } else if (m.type === 'done') { worker.terminate(); resolve(m.stems); }
      else if (m.type === 'error') { worker.terminate(); reject(new Error(m.message)); }
    };
    worker.onerror = (e) => { worker.terminate(); reject(new Error(e.message || 'The separation engine crashed.')); };
    worker.postMessage({ left, right, modelUrl, engine, wasmPaths }, [left.buffer, right.buffer]);
  });
}

$('splitBtn').addEventListener('click', async () => {
  if (!state.original) return;
  $('splitBtn').disabled = true;
  let engine = await pickEngine();
  const file = state.original;
  setSplitProgress(0, 'Preparing the audio…');
  let stems;
  try {
    try {
      stems = await runSeparation(engine);
    } catch (err) {
      if (engine !== 'gpu' || !state.sepWorker) throw err;
      console.warn('GPU separation failed, falling back to CPU:', err);
      try { localStorage.setItem('gpuFailed', '1'); } catch {}
      engine = 'cpu';
      toast('The graphics card engine didn’t work here. Switching to the processor engine.');
      stems = await runSeparation(engine);
    }
  } catch (err) {
    if (!state.sepWorker) return; // cancelled
    console.error(err);
    stopSeparation();
    const msg = String(err.message);
    toast(/memory|alloc/i.test(msg)
      ? 'Ran out of memory while separating. Close other tabs or try a shorter song.'
      : /download/i.test(msg) ? 'Couldn’t download the separation model. Check your connection and try again.'
      : 'Separation failed: ' + msg, 9000);
    return;
  }
  if (file !== state.original) return;
  state.sepWorker = null;
  state.stems = {};
  for (const s of stems) state.stems[s.name] = makeBuffer(ctx, s.channels);
  $('splitProgress').hidden = true;
  $('splitPanel').hidden = true;
  setTracks(STEM_ORDER.map((id) => ({ id, buffer: state.stems[id] })));
  fillSources();
  toast('Instruments separated. Use the faders to build your mix.');
});
$('splitCancel').addEventListener('click', stopSeparation);

// ---------- transcription ----------
function fillSources() {
  const sel = $('sourceSel');
  const opts = state.stems ? STEM_ORDER.filter((s) => s !== 'drums') : ['mix'];
  sel.innerHTML = opts.map((id) => `<option value="${id}">${STEM_INFO[id].label}</option>`).join('');
  sel.value = state.stems ? 'piano' : 'mix';
  $('scoreHint').hidden = !!state.stems;
}

const NOTE_NAMES = ['C', 'C♯', 'D', 'E♭', 'E', 'F', 'F♯', 'G', 'A♭', 'A', 'B♭', 'B'];
const noteName = (m) => NOTE_NAMES[m % 12] + (Math.floor(m / 12) - 1);
$('splitSel').innerHTML = Array.from({ length: 25 }, (_, i) => 48 + i)
  .map((m) => `<option value="${m}"${m === 60 ? ' selected' : ''}>${noteName(m)}${m === 60 ? ' (middle C)' : ''}</option>`).join('');

function noteSettings() {
  const s = $('sensIn').value / 100; // 0..1, higher = more notes
  const [minPitch, maxPitch] = PITCH_RANGE[state.trSource || 'piano'];
  return {
    onsetThresh: 0.7 - 0.45 * s,
    frameThresh: 0.45 - 0.25 * s,
    minNoteMs: 120 - 70 * s,
    minPitch, maxPitch,
  };
}

function trWorker() {
  if (!state.trWorker) {
    state.trWorker = new Worker(new URL('./transcriber.worker.js', import.meta.url), { type: 'module' });
    state.trWorker.onmessage = onTrMessage;
  }
  return state.trWorker;
}

function setTrProgress(frac, text) {
  $('trProgress').hidden = false;
  $('trFill').style.width = `${Math.round(frac * 100)}%`;
  $('trText').textContent = text;
}

function onTrMessage(e) {
  const m = e.data;
  if (m.type === 'status') setTrProgress(m.text.startsWith('Listening') ? 0 : 1, m.text);
  else if (m.type === 'progress') setTrProgress(m.value, `Listening for notes: ${Math.round(m.value * 100)}%`);
  else if (m.type === 'done') {
    $('trProgress').hidden = true;
    $('transcribeBtn').disabled = false;
    state.tempo = m.tempo;
    state.barShift = 0;
    $('bpmIn').value = m.tempo.bpm;
    state.notes = m.notes;
    $('scoreTools').hidden = false;
    renderScore();
  } else if (m.type === 'notes') {
    state.notes = m.notes;
    renderScore();
  } else if (m.type === 'error') {
    $('trProgress').hidden = true;
    $('transcribeBtn').disabled = false;
    toast('Transcription failed: ' + m.message, 9000);
  }
}

$('transcribeBtn').addEventListener('click', async () => {
  if (!state.original) return;
  const src = $('sourceSel').value;
  state.trSource = src;
  const buf = src === 'mix' ? state.original : state.stems[src];
  $('transcribeBtn').disabled = true;
  setTrProgress(0, 'Preparing the audio…');
  const audio = await toMono(buf);
  const beatAudio = state.stems ? await toMono(state.stems.drums) : null;
  const msg = { type: 'transcribe', audio, beatAudio, settings: noteSettings(), modelUrl: new URL(`${BASE}basic-pitch/model.json`, location.href).href };
  trWorker().postMessage(msg, [audio.buffer, ...(beatAudio ? [beatAudio.buffer] : [])]);
});

let renotateTimer;
$('sensIn').addEventListener('input', () => {
  clearTimeout(renotateTimer);
  renotateTimer = setTimeout(() => trWorker().postMessage({ type: 'renotate', settings: noteSettings() }), 150);
});

function scoreOptions() {
  const bpm = Math.max(30, Math.min(300, Number($('bpmIn').value) || state.tempo.bpm));
  const beat = 60 / bpm;
  return {
    bpm,
    offset: state.tempo.firstBeat + state.barShift * beat,
    beatsPerBar: Number($('meterSel').value),
    grid: Number($('gridSel').value),
    split: Number($('splitSel').value),
    title: $('songName').textContent || 'Transcription',
  };
}

function renderScore() {
  if (!state.notes) return;
  const sheet = $('sheet');
  if (!state.notes.length) {
    sheet.innerHTML = '<p class="sheet-empty">No notes found. Raise the sensitivity, or pick a different instrument.</p>';
    $('scoreMeta').textContent = '';
    return;
  }
  const opts = scoreOptions();
  const { abc, events, key } = buildAbc(state.notes, opts);
  state.abc = abc;
  state.abcEvents = new Map(events.map((ev) => [ev.char, ev.time]));
  const label = STEM_INFO[state.trSource].label;
  const keyName = key.name.endsWith('m') ? key.name.slice(0, -1) + ' minor' : key.name + ' major';
  $('scoreMeta').textContent = `${label}: ${state.notes.length} notes in ${keyName.replace('#', '♯').replace(/([A-G])b/, '$1♭')}, ${Math.round(opts.bpm)} beats per minute. Click any note to jump there in the song.`;
  abcjs.renderAbc(sheet, abc, {
    responsive: 'resize',
    add_classes: true,
    staffwidth: Math.max(300, Math.min(980, sheet.clientWidth - 30)),
    paddingtop: 10,
    paddingbottom: 20,
    paddingleft: 10,
    paddingright: 10,
    wrap: { minSpacing: 1.6, maxSpacing: 2.8, preferredMeasuresPerLine: sheet.clientWidth < 640 ? 2 : 4 },
    clickListener: (el) => {
      const t = state.abcEvents.get(el.startChar);
      if (t != null) { player.seek(Math.max(0, t - 0.05)); drawWave(); }
    },
  });
}

let lastSheetWidth = 0, resizeTimer;
new ResizeObserver(() => {
  const w = $('sheet').clientWidth;
  if (!state.notes || Math.abs(w - lastSheetWidth) < 40) return;
  lastSheetWidth = w;
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(renderScore, 200);
}).observe($('sheet'));

['meterSel', 'gridSel', 'splitSel'].forEach((id) => $(id).addEventListener('change', renderScore));
$('bpmIn').addEventListener('change', renderScore);
$('halfBtn').addEventListener('click', () => { $('bpmIn').value = (Number($('bpmIn').value) / 2).toFixed(1); renderScore(); });
$('dblBtn').addEventListener('click', () => { $('bpmIn').value = (Number($('bpmIn').value) * 2).toFixed(1); renderScore(); });
$('shiftBack').addEventListener('click', () => { state.barShift -= 1; renderScore(); });
$('shiftFwd').addEventListener('click', () => { state.barShift += 1; renderScore(); });
$('tapBtn').addEventListener('click', () => {
  const now = performance.now();
  state.taps = state.taps.filter((t) => now - t < 3000);
  state.taps.push(now);
  if (state.taps.length >= 4) {
    const iv = (state.taps.at(-1) - state.taps[0]) / (state.taps.length - 1);
    $('bpmIn').value = (60000 / iv).toFixed(1);
    if (player.playing) {
      // align the beat grid to the last tap
      state.tempo.firstBeat = player.currentTime;
      state.barShift = 0;
    }
    renderScore();
  }
});

$('midiBtn').addEventListener('click', () => {
  if (!state.notes) return;
  const opts = scoreOptions();
  const midi = new Midi();
  midi.header.setTempo(opts.bpm);
  midi.header.name = opts.title;
  const track = midi.addTrack();
  track.name = STEM_INFO[state.trSource].label;
  track.instrument.number = 0;
  for (const n of state.notes) track.addNote({ midi: n.pitch, time: n.start, duration: n.duration, velocity: n.velocity });
  download(new Blob([midi.toArray()], { type: 'audio/midi' }), `${opts.title} - ${track.name}.mid`);
});
$('abcBtn').addEventListener('click', () => {
  if (state.abc) download(new Blob([state.abc], { type: 'text/plain' }), `${scoreOptions().title}.abc`);
});
$('printBtn').addEventListener('click', () => window.print());
