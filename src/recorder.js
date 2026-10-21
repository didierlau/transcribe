// Records audio from a microphone or from another browser tab as raw PCM.
import workletUrl from './recorder.worklet.js?url';

export const canRecordMic = () => !!navigator.mediaDevices?.getUserMedia;
export const canRecordTab = () => !!navigator.mediaDevices?.getDisplayMedia;

// Music, not speech: turn off the voice-call processing browsers apply by default.
const RAW = { echoCancellation: false, noiseSuppression: false, autoGainControl: false };

export async function listMics() {
  if (!navigator.mediaDevices?.enumerateDevices) return [];
  const all = await navigator.mediaDevices.enumerateDevices();
  return all.filter((d) => d.kind === 'audioinput');
}

export class Recorder {
  constructor() {
    this.chunks = [];
    this.length = 0;
    this.peak = 0; // peak level since last read, for the meter
    this.maxPeak = 0; // loudest level in the whole recording
    this.onEnded = null; // called if the source stops by itself (tab sharing ended)
  }

  get seconds() {
    return this.ctx ? this.length / this.ctx.sampleRate : 0;
  }

  async start(source, deviceId) {
    if (source === 'tab') {
      this.stream = await navigator.mediaDevices.getDisplayMedia({
        video: true,
        audio: { ...RAW, suppressLocalAudioPlayback: false },
        preferCurrentTab: false,
        selfBrowserSurface: 'exclude',
        surfaceSwitching: 'include',
        systemAudio: 'include',
      });
      if (!this.stream.getAudioTracks().length) {
        this.stream.getTracks().forEach((t) => t.stop());
        throw new Error('NO_TAB_AUDIO');
      }
    } else {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: { ...RAW, channelCount: { ideal: 2 }, ...(deviceId ? { deviceId: { exact: deviceId } } : {}) },
      });
    }
    // Its own context at the device's native rate (Firefox can't mix rates).
    this.ctx = new AudioContext();
    await this.ctx.audioWorklet.addModule(workletUrl);
    const src = this.ctx.createMediaStreamSource(new MediaStream(this.stream.getAudioTracks()));
    this.node = new AudioWorkletNode(this.ctx, 'capture-processor', {
      numberOfInputs: 1, numberOfOutputs: 0, channelCount: 2, channelCountMode: 'explicit',
    });
    this.node.port.onmessage = (e) => {
      const m = e.data;
      if (m.type === 'data') {
        this.chunks.push([m.l, m.r]);
        this.length += m.l.length;
        let pk = 0;
        for (let i = 0; i < m.l.length; i += 2) pk = Math.max(pk, Math.abs(m.l[i]), Math.abs(m.r[i]));
        this.peak = Math.max(this.peak, pk);
        this.maxPeak = Math.max(this.maxPeak, pk);
      } else if (m.type === 'stopped') this._stopped?.();
    };
    src.connect(this.node);
    this.stream.getTracks().forEach((t) => t.addEventListener('ended', () => this.onEnded?.()));
    if (this.ctx.state === 'suspended') await this.ctx.resume();
  }

  readPeak() {
    const p = this.peak;
    this.peak = 0;
    return p;
  }

  /** Stops recording; returns {channels: [L, R], sampleRate}. */
  async stop() {
    if (!this.node) return null;
    await Promise.race([
      new Promise((r) => { this._stopped = r; this.node.port.postMessage('stop'); }),
      new Promise((r) => setTimeout(r, 500)),
    ]);
    this.stream.getTracks().forEach((t) => t.stop());
    const sampleRate = this.ctx.sampleRate;
    await this.ctx.close();
    this.node = null;
    const L = new Float32Array(this.length), R = new Float32Array(this.length);
    let o = 0;
    for (const [l, r] of this.chunks) { L.set(l, o); R.set(r, o); o += l.length; }
    this.chunks = [];
    return { channels: trimSilence([L, R], sampleRate), sampleRate };
  }

  cancel() {
    this.stream?.getTracks().forEach((t) => t.stop());
    this.ctx?.close().catch(() => {});
    this.node = null;
    this.chunks = [];
  }
}

/** Cuts silence (below -50 dB) from the start and end, keeping a short margin. */
function trimSilence([L, R], rate) {
  const th = 0.00316;
  const loud = (i) => Math.abs(L[i]) > th || Math.abs(R[i]) > th;
  let a = 0, b = L.length - 1;
  while (a < L.length && !loud(a)) a++;
  while (b > a && !loud(b)) b--;
  if (a >= b) return [L, R];
  const pad = Math.round(rate * 0.25);
  a = Math.max(0, a - pad);
  b = Math.min(L.length, b + pad);
  return [L.slice(a, b), R.slice(a, b)];
}
