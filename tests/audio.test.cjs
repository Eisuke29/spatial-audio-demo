const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const C = require('../experiment-core.js');
const source = fs.readFileSync(path.join(__dirname, '../pilot-audio.js'), 'utf8');

function harness() {
  class Param {
    constructor() { this.value = 0; this.events = []; }
    cancelScheduledValues(t) { this.events = this.events.filter(e => e.t < t); }
    setValueAtTime(value, t) { this.value = value; this.events.push({ value, t, type: 'value' }); }
    setTargetAtTime(value, t) { this.value = value; this.events.push({ value, t, type: 'target' }); }
    linearRampToValueAtTime(value, t) { this.value = value; this.events.push({ value, t, type: 'ramp' }); }
  }
  class Node {
    constructor() {
      for (const name of ['gain', 'pan', 'frequency', 'positionX', 'positionY', 'positionZ']) this[name] = new Param();
      this.stops = []; this.connections = [];
    }
    connect(node) { this.connections.push(node); return node; } disconnect() { this.connections = []; }
    start(t) { this.started = t; } stop(t) { this.stops.push(t); }
  }
  class AudioContext {
    constructor() {
      this.currentTime = 0; this.sampleRate = 48000; this.state = 'suspended';
      this.destination = new Node(); this.listener = {};
      for (const prefix of ['forward', 'up']) for (const axis of ['X', 'Y', 'Z']) this.listener[prefix + axis] = new Param();
    }
    createGain() { return new Node(); } createPanner() { return new Node(); }
    createBufferSource() { return new Node(); } createStereoPanner() { return new Node(); } createOscillator() { return new Node(); }
    createBuffer(channels, length) { const data = new Float32Array(length); return { getChannelData: () => data }; }
    async resume() { this.state = 'running'; }
  }
  let timer = null;
  const box = { window: { AudioContext }, PilotCore: C,
    setInterval: fn => { timer = fn; return 1; }, clearInterval: () => { timer = null; } };
  vm.createContext(box); vm.runInContext(source, box);
  const audio = new box.window.PilotAudio();
  return { audio, hasTimer: () => !!timer };
}
test('audio engine uses finite, tapered broadband samples and explicit uncalibrated output metadata', async () => {
  const { audio } = harness(); await audio.ready(0.2);
  const data = audio.noise.getChannelData(0);
  assert.equal(data.length, 48000 * 4); assert.equal(data[0], 0); assert.equal(data.at(-1), 0);
  let sum = 0;
  for (const n of data) { assert.ok(Number.isFinite(n) && Math.abs(n) <= 0.351); sum += n * n; }
  assert.ok(Math.sqrt(sum / data.length) > 0.19);
  assert.equal(audio.info().levelCalibratedSPL, false);
  assert.equal(audio.panner.rolloffFactor, 0); assert.equal(audio.panner.panningModel, 'HRTF');
});
test('silent trials create no source; pulsed noise schedules envelopes without changing playback speed', async () => {
  const h = harness(), { audio } = h; await audio.ready(0.2);
  const geometry = C.geometry({ axis: 'lateral' }, 30);
  audio.start({ ...geometry, condition: 'none' }, geometry.S, 'pulse');
  assert.equal(audio.source, null); assert.equal(h.hasTimer(), false);
  audio.start({ ...geometry, condition: 'warp' }, geometry.S, 'pulse');
  assert.ok(audio.source); assert.equal(h.hasTimer(), true);
  assert.ok(audio.envelope.gain.events.some(e => e.type === 'ramp' && e.value === 1));
  const node = audio.source; audio.stop();
  assert.equal(node.stops.length, 1); assert.equal(audio.envelope.gain.value, 0); assert.equal(h.hasTimer(), false);
});
test('stopping during the common start cue also stops the cue oscillator', async () => {
  const { audio } = harness(); await audio.ready(0.2); audio.cue();
  const cue = audio.tests[0]; assert.ok(cue);
  audio.stop(); assert.equal(cue.stops.length, 2); assert.equal(audio.tests.length, 0);
});
