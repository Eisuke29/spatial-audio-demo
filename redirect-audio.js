(function (root, factory) {
  const Audio = factory();
  if (typeof module === 'object' && module.exports) module.exports = Audio;
  else root.RedirectAudio = Audio;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  class Audio {
    constructor() { this.context = null; this.nodes = new Set(); this.timer = null; this.token = 0; this.volume = 0.25; }
    async ensure(volume = this.volume) {
      if (!this.context) {
        const Context = globalThis.AudioContext || globalThis.webkitAudioContext;
        if (!Context) throw new Error('このブラウザはWeb Audioに対応していません');
        this.context = new Context();
        this.master = this.context.createGain(); this.master.connect(this.context.destination);
        this.panner = this.context.createPanner(); this.panner.panningModel = 'HRTF'; this.panner.distanceModel = 'inverse'; this.panner.rolloffFactor = 0; this.panner.refDistance = 1; this.panner.connect(this.master);
        const l = this.context.listener;
        if (l.forwardX) { l.forwardX.value = 0; l.forwardY.value = 0; l.forwardZ.value = -1; l.upX.value = 0; l.upY.value = 1; l.upZ.value = 0; } else l.setOrientation(0, 0, -1, 0, 1, 0);
        const sr = this.context.sampleRate, n = Math.round(sr * 0.15), fade = Math.round(sr * 0.005);
        this.buffer = this.context.createBuffer(1, n, sr); const data = this.buffer.getChannelData(0);
        let seed = 0x20261116;
        for (let i = 0; i < n; i++) { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; data[i] = (seed / 4294967296 * 2 - 1) * 0.35 * Math.min(1, i / fade, (n - i - 1) / fade); }
      }
      this.setVolume(volume);
      if (this.context.state === 'suspended') await this.context.resume();
      if (this.context.state !== 'running') throw new Error('音声を開始できません。画面をクリックしてもう一度試してください');
      return this.metadata();
    }
    setVolume(v) { this.volume = Math.max(0, Math.min(0.7, v)); if (this.master) this.master.gain.setTargetAtTime(this.volume, this.context.currentTime, 0.01); }
    metadata() { const c = this.context; return { sampleRate: c?.sampleRate ?? null, baseLatency: c?.baseLatency ?? null, outputLatency: c?.outputLatency ?? null, state: c?.state ?? 'uninitialized', volume: this.volume, spatialization: 'WebAudio HRTF; non-individualized', distanceRolloff: 0, stimulus: 'seeded white noise 150ms / 5ms ramps', constantInterval: 0.45, sensorInterval: [0.22, 0.65], sensorFrame: 'hand-direction', seed: '0x20261116' }; }
    position(st, calibration) {
      let x, y, z;
      if (st.frame === 'head') { x = (st.source.x - calibration.body.x) / 100; y = -calibration.earAbove / 100; z = -(st.source.y - calibration.body.y + calibration.headBehind) / 100; }
      else { const length = Math.hypot(st.source.x, st.source.y); const scale = length > 1 ? 1 / length : 1; x = st.source.x * scale; y = 0; z = -st.source.y * scale; if (length < 1) { x = 0; z = -1; } }
      const p = this.panner, t = this.context.currentTime;
      if (p.positionX) { p.positionX.setTargetAtTime(x, t, 0.01); p.positionY.setTargetAtTime(y, t, 0.01); p.positionZ.setTargetAtTime(z, t, 0.01); } else p.setPosition(x, y, z);
    }
    pulse(when, gain, destination = this.panner) {
      const s = this.context.createBufferSource(), g = this.context.createGain();
      s.buffer = this.buffer; g.gain.value = gain; s.connect(g); g.connect(destination); this.nodes.add(s);
      s.onended = () => { this.nodes.delete(s); s.disconnect(); g.disconnect(); }; s.start(when); return s;
    }
    cue() {
      this.stop(); const c = this.context, t = c.currentTime, o = c.createOscillator(), g = c.createGain();
      o.frequency.value = 700; g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(0.18, t + 0.005); g.gain.linearRampToValueAtTime(0, t + 0.075);
      o.connect(g); g.connect(this.master); this.nodes.add(o); o.onended = () => { this.nodes.delete(o); o.disconnect(); g.disconnect(); }; o.start(t); o.stop(t + 0.08);
    }
    test(side) { this.stop(); const p = this.context.createStereoPanner(); p.pan.value = side; p.connect(this.master); for (let i = 0; i < 3; i++) this.pulse(this.context.currentTime + 0.2 * i, 0.6, p); const last = [...this.nodes].at(-1); if (last) { const finish = last.onended; last.onended = () => { finish(); p.disconnect(); }; } }
    start(read, calibration) {
      this.stop(); const token = this.token; let next = this.context.currentTime + 0.025;
      const tick = () => {
        if (token !== this.token) return;
        const st = read();
        if (!st || this.context.state !== 'running') { this.stop(); return; }
        this.position(st, calibration);
        if (next < this.context.currentTime) next = this.context.currentTime + 0.01;
        while (next < this.context.currentTime + 0.075) { this.pulse(next, st.gain); next += st.interval; }
        this.timer = setTimeout(tick, 20);
      }; tick();
    }
    stop() { this.token++; clearTimeout(this.timer); this.timer = null; for (const s of [...this.nodes]) { try { s.stop(); } catch {} if (s.onended) s.onended(); } this.nodes.clear(); }
  }
  return Audio;
});
