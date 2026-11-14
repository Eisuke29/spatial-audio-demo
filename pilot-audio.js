(function () {
  'use strict';
  class PilotAudio {
    constructor() { this.context = null; this.source = null; this.timer = null; this.tests = []; }
    async ready(volume) {
      if (!this.context) {
        const Context = window.AudioContext || window.webkitAudioContext;
        if (!Context) throw new Error('このブラウザは音声再生に対応していません。');
        this.context = new Context({ latencyHint: 'interactive' });
        const a = this.context;
        this.master = a.createGain(); this.master.connect(a.destination);
        this.panner = a.createPanner(); this.panner.panningModel = 'HRTF';
        this.panner.distanceModel = 'inverse'; this.panner.refDistance = 1;
        this.panner.rolloffFactor = 0; // Fixed and warped sounds differ only in direction.
        this.level = a.createGain(); this.envelope = a.createGain();
        this.envelope.connect(this.panner).connect(this.level).connect(this.master);
        this.envelope.gain.value = 0;
        const listener = a.listener;
        if (listener.forwardX) {
          listener.forwardX.value = 0; listener.forwardY.value = 0; listener.forwardZ.value = -1;
          listener.upX.value = 0; listener.upY.value = 1; listener.upZ.value = 0;
        } else listener.setOrientation(0, 0, -1, 0, 1, 0);
        this.noise = a.createBuffer(1, a.sampleRate * 4, a.sampleRate);
        const data = this.noise.getChannelData(0), rng = PilotCore.random(0x20261114);
        for (let i = 0; i < data.length; i++) data[i] = (rng() * 2 - 1) * 0.35;
        // Short tapers suppress a discontinuity at the buffer loop.
        const fade = Math.floor(a.sampleRate * 0.005);
        for (let i = 0; i < fade; i++) { data[i] *= i / fade; data[data.length - i - 1] *= i / fade; }
      }
      this.master.gain.setValueAtTime(volume, this.context.currentTime);
      await this.context.resume();
      if (this.context.state !== 'running') throw new Error('音声を開始できません。もう一度押してください。');
    }
    info() {
      const a = this.context;
      return { sampleRate: a.sampleRate, baseLatency: a.baseLatency ?? null,
        outputLatency: a.outputLatency ?? null, noiseSeed: 0x20261114,
        levelCalibratedSPL: false, acousticUnitsPerReach: 0.5, listenerBehindStart: 0.3 };
    }
    cue() {
      const a = this.context, t = a.currentTime;
      const oscillator = a.createOscillator(), g = a.createGain();
      oscillator.frequency.value = 520;
      g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(0.2, t + 0.005);
      g.gain.setValueAtTime(0.2, t + 0.065); g.gain.linearRampToValueAtTime(0, t + 0.08);
      oscillator.connect(g).connect(this.master); oscillator.start(t); oscillator.stop(t + 0.09);
      this.tests.push(oscillator);
      oscillator.onended = () => { oscillator.disconnect(); g.disconnect(); this.tests = this.tests.filter(s => s !== oscillator); };
    }
    start(trial, hand, sound) {
      this.stop();
      const a = this.context;
      this.trial = trial; this.sound = sound;
      this.envelope.gain.cancelScheduledValues(a.currentTime); this.envelope.gain.value = 0;
      this.update(hand, true);
      if (trial.condition === 'none') return a.currentTime;
      this.source = a.createBufferSource(); this.source.buffer = this.noise; this.source.loop = true;
      this.source.connect(this.envelope);
      const onset = a.currentTime + 0.01;
      this.source.start(onset); this.nextPulse = onset;
      if (sound === 'continuous' && trial.condition !== 'sensor') {
        this.envelope.gain.setTargetAtTime(1, onset, 0.005);
      } else {
        this.schedule(); this.timer = setInterval(() => this.schedule(), 25);
      }
      return onset;
    }
    schedule() {
      const a = this.context;
      if (!this.source) return;
      if (this.nextPulse < a.currentTime) this.nextPulse = a.currentTime + 0.005;
      while (this.nextPulse < a.currentTime + 0.1) {
        const t = this.nextPulse, period = this.params.period;
        const duration = Math.min(0.18, period * 0.55), g = this.envelope.gain;
        g.setValueAtTime(0, t); g.linearRampToValueAtTime(1, t + 0.005);
        g.setValueAtTime(1, t + duration - 0.005); g.linearRampToValueAtTime(0, t + duration);
        this.nextPulse += period;
      }
    }
    update(hand, immediate = false) {
      const a = this.context;
      this.params = PilotCore.stimulus(this.trial, hand);
      const s = this.params;
      // World sources use an illustrative head position 0.3 units behind S.
      // Sensor sources encode the hand-to-P vector, with a constant acoustic radius.
      const x = s.x * 0.5, z = -(s.z + (this.trial.condition === 'sensor' ? 0 : 0.3)) * 0.5;
      const t = a.currentTime;
      if (this.panner.positionX) {
        for (const [name, value] of [['positionX', x], ['positionY', 0], ['positionZ', z]]) {
          const p = this.panner[name];
          if (immediate) { p.cancelScheduledValues(t); p.setValueAtTime(value, t); }
          else p.setTargetAtTime(value, t, 0.015);
        }
      } else this.panner.setPosition(x, 0, z);
      if (immediate) this.level.gain.setValueAtTime(s.gain, t);
      else this.level.gain.setTargetAtTime(s.gain, t, 0.015);
      return s;
    }
    async channel(side, volume) {
      await this.ready(volume); this.stop();
      const a = this.context, source = a.createBufferSource(), pan = a.createStereoPanner(), g = a.createGain();
      source.buffer = this.noise; pan.pan.value = side;
      const t = a.currentTime;
      g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(0.5, t + 0.01);
      g.gain.setValueAtTime(0.5, t + 0.35); g.gain.linearRampToValueAtTime(0, t + 0.4);
      source.connect(pan).connect(g).connect(this.master); source.start(); source.stop(t + 0.42);
      this.tests.push(source);
      source.onended = () => { source.disconnect(); pan.disconnect(); g.disconnect(); this.tests = this.tests.filter(s => s !== source); };
    }
    stop() {
      clearInterval(this.timer); this.timer = null;
      if (this.source) { try { this.source.stop(); } catch (_) {} this.source.disconnect(); this.source = null; }
      for (const source of this.tests) { try { source.stop(); } catch (_) {} }
      this.tests = [];
      if (this.context) { this.envelope.gain.cancelScheduledValues(this.context.currentTime); this.envelope.gain.value = 0; }
    }
  }
  window.PilotAudio = PilotAudio;
})();
