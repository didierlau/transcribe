// Polyphonic note transcription with Spotify's Basic Pitch (TensorFlow.js),
// plus tempo detection. Keeps model outputs so thresholds can be re-applied fast.
import * as tf from '@tensorflow/tfjs';
import { BasicPitch, outputToNotesPoly, noteFramesToTime } from '@spotify/basic-pitch';
import { detectTempo } from './notation.js';

let basicPitch = null;
let last = null; // {frames, onsets}

const post = (m) => self.postMessage(m);

async function ensureModel(modelUrl) {
  if (basicPitch) return basicPitch;
  // GPU (WebGL) when the browser offers it in workers, otherwise plain CPU.
  const ok = await tf.setBackend('webgl').catch(() => false);
  if (!ok) await tf.setBackend('cpu');
  await tf.ready();
  basicPitch = new BasicPitch(tf.loadGraphModel(modelUrl));
  await basicPitch.model;
  return basicPitch;
}

function extractNotes({ onsetThresh, frameThresh, minNoteMs, minPitch, maxPitch }) {
  const { frames, onsets } = last;
  const minNoteLen = Math.max(1, Math.round(minNoteMs / 11.6));
  const midiToHz = (m) => 440 * Math.pow(2, (m - 69) / 12);
  const raw = outputToNotesPoly(frames, onsets, onsetThresh, frameThresh, minNoteLen, true,
    midiToHz(maxPitch + 0.5), midiToHz(minPitch - 0.5), true);
  return noteFramesToTime(raw).map((n) => ({
    pitch: n.pitchMidi ?? n.pitch_midi,
    start: n.startTimeSeconds,
    duration: n.durationSeconds,
    velocity: Math.max(0.15, Math.min(1, n.amplitude)),
  })).sort((a, b) => a.start - b.start || a.pitch - b.pitch);
}

self.onmessage = async (e) => {
  const msg = e.data;
  try {
    if (msg.type === 'transcribe') {
      post({ type: 'status', text: 'Loading the transcription model…' });
      const bp = await ensureModel(msg.modelUrl);
      const frames = [], onsets = [];
      post({ type: 'status', text: 'Listening for notes…' });
      await bp.evaluateModel(msg.audio, (f, o) => {
        frames.push(...f);
        onsets.push(...o);
      }, (p) => post({ type: 'progress', value: p }));
      last = { frames, onsets };
      post({ type: 'status', text: 'Finding the beat…' });
      const tempo = detectTempo(msg.beatAudio || msg.audio, 22050);
      post({ type: 'done', notes: extractNotes(msg.settings), tempo });
    } else if (msg.type === 'renotate') {
      if (!last) return;
      post({ type: 'notes', notes: extractNotes(msg.settings) });
    }
  } catch (err) {
    post({ type: 'error', message: String(err?.message || err) });
  }
};
