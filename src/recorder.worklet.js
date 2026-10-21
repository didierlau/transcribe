// Collects raw PCM from the input and posts it to the main thread in blocks.
class CaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.block = 4096;
    this.buf = [new Float32Array(this.block), new Float32Array(this.block)];
    this.fill = 0;
    this.active = true;
    this.port.onmessage = (e) => {
      if (e.data === 'stop') {
        this.flush();
        this.active = false;
        this.port.postMessage({ type: 'stopped' });
      }
    };
  }

  flush() {
    if (!this.fill) return;
    const l = this.buf[0].slice(0, this.fill);
    const r = this.buf[1].slice(0, this.fill);
    this.port.postMessage({ type: 'data', l, r }, [l.buffer, r.buffer]);
    this.fill = 0;
  }

  process(inputs) {
    if (!this.active) return false;
    const input = inputs[0];
    if (input && input.length) {
      const l = input[0];
      const r = input[1] || input[0];
      for (let i = 0; i < l.length; i++) {
        this.buf[0][this.fill] = l[i];
        this.buf[1][this.fill] = r[i];
        if (++this.fill === this.block) this.flush();
      }
    }
    return true;
  }
}

registerProcessor('capture-processor', CaptureProcessor);
