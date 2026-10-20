// Multi-track player: every stem plays in sync through its own gain node.

export class Player {
  constructor(ctx) {
    this.ctx = ctx;
    this.master = ctx.createGain();
    this.master.connect(ctx.destination);
    this.tracks = [];
    this.sources = [];
    this.playing = false;
    this.offset = 0; // position (s) when playback last started
    this.startedAt = 0; // ctx time when playback last started
    this.loop = { enabled: false, a: 0, b: 0 };
    this.onEnded = null;
  }

  get duration() {
    return this.tracks.reduce((m, t) => Math.max(m, t.buffer.duration), 0);
  }

  setTracks(tracks) {
    const pos = this.currentTime;
    const wasPlaying = this.playing;
    this.stopSources();
    this.tracks.forEach((t) => t.node.disconnect());
    this.tracks = tracks.map((t) => {
      const node = this.ctx.createGain();
      node.connect(this.master);
      return { gain: 1, muted: false, solo: false, ...t, node };
    });
    this.applyGains(true);
    this.offset = Math.min(pos, this.duration);
    if (wasPlaying) this.play();
  }

  effectiveGain(t) {
    const anySolo = this.tracks.some((x) => x.solo);
    if (anySolo) return t.solo ? t.gain : 0;
    return t.muted ? 0 : t.gain;
  }

  applyGains(instant = false) {
    const now = this.ctx.currentTime;
    for (const t of this.tracks) {
      const g = this.effectiveGain(t);
      if (instant) t.node.gain.value = g;
      else t.node.gain.setTargetAtTime(g, now, 0.015);
    }
  }

  get currentTime() {
    if (!this.playing) return this.offset;
    let t = this.offset + (this.ctx.currentTime - this.startedAt);
    const { enabled, a, b } = this.loop;
    if (enabled && b > a && this.offset < b && t >= b) t = a + ((t - a) % (b - a));
    return Math.min(t, this.duration);
  }

  async play() {
    if (!this.tracks.length) return;
    if (this.ctx.state === 'suspended') await this.ctx.resume();
    this.stopSources();
    const { enabled, a, b } = this.loop;
    if (enabled && b > a && (this.offset < a || this.offset >= b)) this.offset = a;
    if (this.offset >= this.duration - 0.01) this.offset = 0;
    const when = this.ctx.currentTime + 0.03;
    this.sources = this.tracks.map((t) => {
      const s = this.ctx.createBufferSource();
      s.buffer = t.buffer;
      if (enabled && b > a) {
        s.loop = true;
        s.loopStart = a;
        s.loopEnd = b;
      }
      s.connect(t.node);
      s.start(when, this.offset);
      return s;
    });
    const first = this.sources[0];
    first.onended = () => {
      if (this.sources[0] === first && this.playing) {
        this.playing = false;
        this.offset = 0;
        this.onEnded?.();
      }
    };
    this.startedAt = when;
    this.playing = true;
  }

  pause() {
    if (!this.playing) return;
    this.offset = this.currentTime;
    this.stopSources();
    this.playing = false;
  }

  seek(t) {
    const wasPlaying = this.playing;
    if (wasPlaying) this.stopSources();
    this.playing = false;
    this.offset = Math.max(0, Math.min(t, this.duration));
    if (wasPlaying) this.play();
  }

  setLoop(loop) {
    const pos = this.currentTime;
    this.loop = { ...this.loop, ...loop };
    if (this.playing) {
      this.offset = pos;
      this.play();
    }
  }

  stopSources() {
    for (const s of this.sources) {
      s.onended = null;
      try { s.stop(); } catch {}
      s.disconnect();
    }
    this.sources = [];
  }
}
