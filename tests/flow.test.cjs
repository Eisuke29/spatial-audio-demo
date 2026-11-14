/* Exercise the production event handlers without a browser host or dependencies. */
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const C = require('../experiment-core.js');
const html = fs.readFileSync(path.join(__dirname, '../experiment.html'), 'utf8');
const appSource = fs.readFileSync(path.join(__dirname, '../experiment.js'), 'utf8');

function harness(previousStore = new Map(), failStorage = false) {
  let time = 0, timerId = 0;
  const timers = new Map(), events = new Map(), elements = new Map();
  const context2d = new Proxy({}, { get: () => () => {}, set: () => true });
  class Element {
    constructor(id = '') {
      this.id = id; this.listeners = new Map(); this.hidden = false; this.disabled = false; this.value = '';
      this.textContent = ''; this.dataset = {}; this.children = []; this.attributes = {};
      this.classList = { add() {}, remove() {}, toggle() {} }; this.captured = null;
    }
    addEventListener(type, fn) { const list = this.listeners.get(type) || []; list.push(fn); this.listeners.set(type, list); }
    removeEventListener(type, fn) { this.listeners.set(type, (this.listeners.get(type) || []).filter(f => f !== fn)); }
    dispatch(type, options = {}) {
      const event = { button: 0, isPrimary: true, pointerId: 1, pointerType: 'mouse', clientX: 500, clientY: 500, preventDefault() {}, ...options };
      for (const fn of this.listeners.get(type) || []) fn(event);
    }
    setAttribute(name, value) { this.attributes[name] = value; }
    appendChild(child) { this.children.push(child); if (!this.value && child.value) this.value = child.value; }
    replaceChildren() { this.children = []; this.value = ''; }
    remove() {} click() { this.dispatch('click'); } scrollIntoView() {} focus() {}
    getContext() { return context2d; }
    getBoundingClientRect() { return { left: 0, top: 0, right: 1000, bottom: 650, width: 1000, height: 650 }; }
    setPointerCapture(id) { this.captured = id; }
    hasPointerCapture(id) { return this.captured === id; }
    releasePointerCapture() { this.captured = null; this.dispatch('lostpointercapture'); }
    requestPointerLock() { document.pointerLockElement = this; document.dispatch('pointerlockchange'); return Promise.resolve(); }
  }
  for (const match of html.matchAll(/\bid="([^"]+)"/g)) elements.set(match[1], new Element(match[1]));
  const $ = id => elements.get(id);
  for (const [id, value] of Object.entries({ inputMode: 'drag', taskMode: 'memory', device: 'headphones', connection: 'wired', sound: 'pulse', volume: '.2', offsets: '0, 15, 30', repeats: '2', axis: 'lateral', mouseScale: '260' })) $(id).value = value;
  for (const id of ['run', 'results', 'responses', 'saved', 'message', 'storageWarning', 'trialOverlay']) $(id).hidden = true;
  const notices = ['yes', 'no', 'unsure'].map(value => { const e = new Element(); e.dataset.noticed = value; return e; });
  const contacts = ['yes', 'no', 'unsure'].map(value => { const e = new Element(); e.dataset.contact = value; return e; });
  const document = new Element('document'); document.body = new Element('body');
  document.getElementById = $;
  document.createElement = () => new Element();
  document.querySelectorAll = selector => selector.includes(',') ? [...notices, ...contacts] : selector.includes('noticed') ? notices : contacts;
  document.exitPointerLock = () => { document.pointerLockElement = null; document.dispatch('pointerlockchange'); };
  let audioStarts = 0, audioStops = 0;
  class Audio {
    async ready() {} info() { return { sampleRate: 48000 }; } cue() {}
    start() { audioStarts++; return time / 1000; } stop() { audioStops++; } update() {} async channel() {}
  }
  const window = { PilotCore: C, devicePixelRatio: 1,
    crypto: { getRandomValues: value => { value[0] = 23456; return value; } },
    addEventListener: (type, fn) => { const list = events.get(type) || []; list.push(fn); events.set(type, list); } };
  const addTimer = (fn, ms, repeat = false) => { const id = ++timerId; timers.set(id, { fn, at: time + ms, ms, repeat }); return id; };
  const box = { window, document, PilotAudio: Audio, navigator: { userAgent: 'Node test' },
    screen: { width: 1000, height: 650 }, location: { protocol: 'http:' }, crypto: window.crypto,
    performance: { now: () => time }, Date, console, Blob, URL,
    setTimeout: (fn, ms) => addTimer(fn, ms), setInterval: (fn, ms) => addTimer(fn, ms, true),
    clearTimeout: id => timers.delete(id), clearInterval: id => timers.delete(id),
    localStorage: { getItem: key => previousStore.get(key) || null, setItem: (key, value) => {
      if (failStorage) throw new Error('QuotaExceededError'); previousStore.set(key, value);
    } } };
  vm.createContext(box); vm.runInContext(appSource, box, { filename: 'experiment.js' });
  async function flush() { for (let i = 0; i < 10; i++) await Promise.resolve(); }
  async function tick(ms) {
    const target = time + ms;
    for (;;) {
      const next = [...timers.entries()].filter(([, t]) => t.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      const [id, timer] = next; time = timer.at;
      if (timer.repeat) timer.at += timer.ms; else timers.delete(id);
      timer.fn(); await flush();
    }
    time = target; await flush();
  }
  const database = () => JSON.parse(previousStore.get('audio-redirection-pilot-v1'));
  async function begin(practice = false) { $('checkedAudio').checked = true; $(practice ? 'practice' : 'start').click(); await flush(); }
  async function hold() {
    // S in the 1000x650 model: the production layout puts it at x=500.
    lastPointer = { clientX: 500, clientY: 563.093023255814 };
    $('stage').dispatch('pointerdown', { clientX: 500, clientY: 563.093023255814 }); await flush();
  }
  async function go() { await tick(3340); }
  let lastPointer = { clientX: 500, clientY: 563.093023255814 };
  function move(x = 0, z = 250) { lastPointer = { clientX: 500 + x, clientY: 563.093023255814 - z }; $('stage').dispatch('pointermove', lastPointer); }
  function release() { document.dispatch('pointerup', lastPointer); }
  function answer(noticed = 'no', contact) {
    notices.find(e => e.dataset.noticed === noticed).click();
    if (contact) contacts.find(e => e.dataset.contact === contact).click();
    $('saveAnswer').click();
  }
  return { $, notices, contacts, document, store: previousStore, database, begin, hold, go, move, release, answer, flush, tick,
    windowEvent: type => { for (const fn of events.get(type) || []) fn(); }, audioCounts: () => ({ audioStarts, audioStops }) };
}

test('audio confirmation is required before starting; contact requires a registered P', async () => {
  const h = harness(); h.$('start').click();
  assert.match(h.$('message').textContent, /確認/);
  assert.equal(h.store.size, 0);
  h.$('taskMode').value = 'contact'; await h.begin();
  assert.match(h.$('message').textContent, /Pを登録/);
  assert.equal(h.store.size, 0);
});
test('held drag reaches the response screen; answers are required; saving advances once', async () => {
  const h = harness(); await h.begin(); await h.hold();
  assert.match(h.$('runTitle').textContent, /Aの場所/);
  await h.go(); h.move(50, 250); await h.tick(25); h.release();
  assert.equal(h.$('responses').hidden, false);
  assert.equal(h.$('saveAnswer').disabled, true);
  assert.equal(h.database().sessions[0].nextIndex, 0);
  h.answer('unsure'); h.$('saveAnswer').click();
  const s = h.database().sessions[0];
  assert.equal(s.nextIndex, 1); assert.equal(s.trials.length, 1);
  assert.equal(s.trials[0].status, 'complete'); assert.equal(s.trials[0].noticed, 'unsure');
  assert.ok(s.trials[0].endpoint.z > 0); assert.ok(s.trials[0].path.length >= 2);
  assert.equal(h.$('trialOverlay').hidden, false); // main reveals no coordinates
  assert.doesNotMatch(h.$('feedback').textContent, /A固定|A→P|ずらし/);
});
test('early movement is recorded as invalid and retries the same planned trial', async () => {
  const h = harness(); await h.begin(); await h.hold(); h.move(30, 0);
  const s = h.database().sessions[0];
  assert.equal(s.nextIndex, 0); assert.equal(s.trials[0].invalidReason, 'moved_before_cue');
  await h.tick(5000);
  assert.equal(h.audioCounts().audioStarts, 0);
  await h.hold(); await h.go(); h.release(); h.answer();
  const after = h.database().sessions[0];
  assert.equal(after.trials.length, 2); assert.equal(after.trials[0].index, after.trials[1].index);
  assert.notEqual(after.trials[0].id, after.trials[1].id);
});
test('early release, focus loss and timeout cancel playback and cannot become valid responses', async () => {
  for (const reason of ['released_before_cue', 'window_blur', 'timeout']) {
    const h = harness(); await h.begin(); await h.hold();
    if (reason === 'released_before_cue') h.release();
    else if (reason === 'window_blur') { await h.go(); h.windowEvent('blur'); }
    else { await h.go(); await h.tick(15001); }
    const s = h.database().sessions[0];
    assert.equal(s.trials[0].invalidReason, reason); assert.equal(s.nextIndex, 0);
    assert.equal(h.$('responses').hidden, true);
    assert.ok(h.audioCounts().audioStops > 0);
  }
});
test('screen boundary is an invalid trial, not a clipped endpoint', async () => {
  const h = harness(); await h.begin(); await h.hold(); await h.go(); h.move(1000, 0);
  assert.equal(h.database().sessions[0].trials[0].invalidReason, 'canvas_boundary');
});
test('refresh preserves completed trials and invalidates the pending trial without advancing it', async () => {
  const h = harness(); await h.begin(); await h.hold(); await h.go(); h.release(); h.answer();
  h.$('next').click(); await h.hold(); await h.go(); h.move(0, 100); await h.tick(1000);
  const restored = harness(h.store); restored.$('resumeSaved').click(); await restored.flush();
  const s = restored.database().sessions[0];
  assert.equal(s.nextIndex, 1); assert.equal(s.trials.length, 2);
  assert.equal(s.trials[0].status, 'complete'); assert.equal(s.trials[1].invalidReason, 'page_closed_or_reloaded');
  assert.ok(s.trials[1].path.length >= 2);
  assert.equal(s.pending, null);
});
test('P registration and locked input reset origin after returning to S; contact answers are required', async () => {
  const h = harness(); h.$('inputMode').value = 'lock'; h.$('registerP').click();
  h.$('stage').dispatch('pointerdown'); await h.flush();
  assert.match(h.$('runTitle').textContent, /Sへ戻/);
  h.document.dispatch('mousemove', { movementX: 1000, movementY: 1000 }); // returning to S is not part of the reach
  h.$('stage').dispatch('pointerdown');
  h.document.dispatch('mousemove', { movementX: 0, movementY: -520 }); h.release();
  assert.match(h.$('referenceStatus').textContent, /登録済み/);
  h.$('taskMode').value = 'contact'; await h.begin();
  h.$('stage').dispatch('pointerdown'); await h.flush();
  h.document.dispatch('mousemove', { movementX: 700, movementY: 700 });
  h.$('stage').dispatch('pointerdown'); await h.flush(); await h.go();
  h.document.dispatch('mousemove', { movementX: 0, movementY: -520 }); h.release();
  h.notices[1].click(); assert.equal(h.$('saveAnswer').disabled, true);
  h.contacts[0].click(); assert.equal(h.$('saveAnswer').disabled, false); h.$('saveAnswer').click();
  const s = h.database().sessions[0], t = s.trials[0];
  assert.equal(t.contact, 'yes'); assert.equal(t.endpoint.x, 0); assert.equal(t.endpoint.z, 1);
  assert.equal(t.pixelsPerUnit, 520); assert.equal(s.config.reference.P.z, 1);
});
test('all practice trials show feedback and finish with separate, exportable practice data', async () => {
  const h = harness(); await h.begin(true);
  for (let i = 0; i < 4; i++) {
    await h.hold(); await h.go(); h.move(0, 250); h.release(); h.answer();
    assert.equal(h.$('trialOverlay').hidden, true);
    assert.match(h.$('feedback').textContent, /ずらし/);
    h.$('next').click();
  }
  const s = h.database().sessions[0];
  assert.equal(s.status, 'complete'); assert.equal(s.phase, 'practice'); assert.equal(s.trials.length, 4);
  assert.equal(h.$('results').hidden, false); assert.ok(h.$('resultRows').children.length > 0);
  assert.equal(C.trialRows(s).length, 4); assert.ok(C.pathRows(s).length >= 8);
});
test('storage failure is visible while in-memory results remain available', async () => {
  const h = harness(new Map(), true); await h.begin();
  assert.equal(h.$('storageWarning').hidden, false);
  await h.hold(); await h.go(); h.release(); h.answer(); h.$('finish').click();
  assert.equal(h.$('results').hidden, false); assert.ok(h.$('resultRows').children.length > 0);
});
test('touch keeps absolute canvas positions and rejects mouse input for a touch session', async () => {
  const h = harness(); h.$('inputMode').value = 'touch'; await h.begin();
  await h.hold();
  assert.match(h.$('message').textContent, /指でS/);
  h.$('stage').dispatch('pointerdown', { pointerType: 'touch', clientX: 510, clientY: 563.093023255814 }); await h.flush();
  await h.go();
  h.document.dispatch('pointerup', { pointerType: 'touch', clientX: 530, clientY: 313.093023255814 });
  h.answer();
  const t = h.database().sessions[0].trials[0];
  assert.ok(t.startPosition.x > 0);
  // Ending 30 CSS pixels to the right of S is absolute, not 20 pixels from the finger's start.
  assert.ok(Math.abs(t.endpoint.x * t.pixelsPerUnit - 30) < 1e-9);
  assert.ok(Math.abs(t.endpoint.z * t.pixelsPerUnit - 250) < 1e-9);
});
test('Pointer Lock exiting mid-reach records one invalid attempt and stops audio', async () => {
  const h = harness(); h.$('inputMode').value = 'lock'; await h.begin();
  h.$('stage').dispatch('pointerdown'); await h.flush();
  h.$('stage').dispatch('pointerdown'); await h.go();
  h.document.exitPointerLock();
  const s = h.database().sessions[0];
  assert.equal(s.trials.length, 1); assert.equal(s.trials[0].invalidReason, 'pointer_lock_lost');
  assert.equal(s.nextIndex, 0); assert.equal(h.$('responses').hidden, true);
});
test('main completes its balanced plan and never includes practice records', async () => {
  const h = harness(); h.$('offsets').value = '0, 25'; h.$('repeats').value = '1'; await h.begin();
  for (let i = 0; i < 12; i++) {
    await h.hold(); await h.go(); h.move(0, 250); h.release(); h.answer();
    if (i < 11) h.$('next').click();
  }
  const s = h.database().sessions[0];
  assert.equal(s.status, 'complete'); assert.equal(s.phase, 'main'); assert.equal(s.trials.length, 12);
  assert.equal(h.$('results').hidden, false); assert.match(h.$('resultBadge').textContent, /完了/);
});
