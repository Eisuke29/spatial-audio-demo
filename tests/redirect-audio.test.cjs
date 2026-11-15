const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
function harness() {
  const nodes = [], timers = new Map(); let timerIndex = 0;
  class Param { constructor() { this.value = 0; } setTargetAtTime(x) { this.value = x; } setValueAtTime(x) { this.value = x; } linearRampToValueAtTime(x) { this.value = x; } }
  class Node { constructor() { for (const k of ['gain', 'pan', 'frequency', 'positionX', 'positionY', 'positionZ']) this[k] = new Param(); this.stops = 0; this.disconnected = false; nodes.push(this); } connect() {} disconnect() { this.disconnected = true; } start(when) { this.started = when; } stop() { this.stops++; } }
  class Context { constructor() { this.state = 'suspended'; this.currentTime = 0; this.sampleRate = 48000; this.listener = {}; for (const k of ['forwardX', 'forwardY', 'forwardZ', 'upX', 'upY', 'upZ']) this.listener[k] = new Param(); this.destination = new Node(); } async resume() { this.state = 'running'; } createGain() { return new Node(); } createPanner() { return new Node(); } createStereoPanner() { return new Node(); } createOscillator() { return new Node(); } createBufferSource() { return new Node(); } createBuffer(c, n) { const a = new Float32Array(n); return { getChannelData: () => a }; } }
  const box = { AudioContext: Context, setTimeout: fn => { timers.set(++timerIndex, fn); return timerIndex; }, clearTimeout: id => timers.delete(id) }; vm.createContext(box); vm.runInContext(fs.readFileSync(path.join(__dirname, '../redirect-audio.js'), 'utf8'), box);
  return { audio: new box.RedirectAudio(), nodes, timers };
}
const su = { body: { x: 0, y: 0 }, headBehind: 15, earAbove: 35 };
test('constant audio uses fixed seeded ramps and no automatic distance attenuation', async () => {
  const { audio } = harness(); await audio.ensure(.25); const data = audio.buffer.getChannelData(0);
  assert.equal(data.length, 7200); assert.ok(data[0] === 0 && data.at(-1) === 0); assert.ok(data.every(v => Number.isFinite(v) && Math.abs(v) <= .35)); assert.equal(audio.panner.rolloffFactor, 0); assert.equal(audio.panner.panningModel, 'HRTF');
  const other = harness().audio; await other.ensure(.25); assert.deepEqual(data, other.buffer.getChannelData(0));
});
test('stop cancels every scheduled source including channel checks and the central cue', async () => {
  const { audio, timers } = harness(); await audio.ensure(); audio.test(-1); const checks = [...audio.nodes]; assert.equal(checks.length, 3); audio.stop(); assert.equal(audio.nodes.size, 0); assert.ok(checks.every(n => n.stops === 1 && n.disconnected));
  audio.cue(); const cue = [...audio.nodes][0]; audio.stop(); assert.equal(cue.stops, 2); assert.ok(cue.disconnected);
  audio.start(() => ({ source: { x: 40, y: 0 }, frame: 'head', gain: .65, interval: .45 }), su); assert.ok(timers.size); const pending = [...audio.nodes]; audio.stop(); assert.equal(timers.size, 0); assert.ok(pending.every(n => n.stops === 1));
});
test('silent or stopped context never keeps a scheduler alive', async () => {
  const { audio, timers } = harness(); await audio.ensure(); audio.start(() => null, su); assert.equal(timers.size, 0); assert.equal(audio.nodes.size, 0);
  audio.context.state = 'suspended'; audio.start(() => ({ source: { x: 1, y: 1 }, frame: 'head', gain: .65, interval: .45 }), su); assert.equal(timers.size, 0); assert.equal(audio.nodes.size, 0);
});
test('coordinate conversion preserves head forward/up axes and distinguishes hand-relative cues', async () => {
  const { audio } = harness(); await audio.ensure(); audio.position({ frame: 'head', source: { x: 40, y: 5 } }, su);
  assert.equal(audio.panner.positionX.value, .4); assert.equal(audio.panner.positionY.value, -.35); assert.equal(audio.panner.positionZ.value, -.2);
  audio.position({ frame: 'hand-direction', source: { x: -10, y: 0 } }, su); assert.equal(audio.panner.positionX.value, -1); assert.equal(audio.panner.positionY.value, 0); assert.equal(audio.panner.positionZ.value, -0);
});
