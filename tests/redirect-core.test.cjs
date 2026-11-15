const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../redirect-core.js');
const su = { body: { x: 0, y: 0 }, S: { x: 0, y: 10 }, P: { x: 40, y: 0 }, headBehind: 15, earAbove: 35 };
const config = { kind: 'pilot', conditions: ['none', 'T-c', 'W-c', 'P-s'], angles: [10, 20], repeats: 2, priorKnowledge: 'known' };
const near = (a, b, epsilon = 1e-8) => assert.ok(Math.abs(a - b) < epsilon, `${a} != ${b}`);
function ready() { const e = new C.Engine(config, su, 1024, 'session'); e.update(su.S, 0); assert.equal(e.learn(4999), false); assert.equal(e.learn(5000), true); for (let t = 5000; t <= 5600; t += 50) e.update(su.S, t); assert.ok(e.atStart); return e; }
function reaching() { const e = ready(), id = e.begin(5600); assert.ok(id); assert.ok(e.delay(id, 5650)); assert.ok(e.reach(id, 5700)); return e; }
function move(e, target = su.P, start = 5750, duration = 1500) { for (let t = start; t <= start + duration; t += 50) e.update(C.mix(su.S, target, Math.min(1, (t - start) / duration)), t); return start + duration; }

test('camera pilot balances every condition, direction, zero-control, angle and repetition', () => {
  const plan = C.makePlan(config, 42); assert.equal(plan.length, 48);
  assert.deepEqual(plan, C.makePlan(config, 42)); assert.notDeepEqual(plan, C.makePlan(config, 43));
  for (const a of config.angles) for (let r = 0; r < 2; r++) for (const c of config.conditions) for (const tool of Object.keys(C.TOOLS)) assert.equal(plan.filter(t => t.angle === a && t.repeat === r && t.condition === c && t.tool === tool).length, 1);
  assert.equal(C.makePlan({ ...config, kind: 'baseline' }, 4).length, 12);
  assert.throws(() => C.makePlan({ ...config, conditions: [] }, 1)); assert.throws(() => C.makePlan({ ...config, conditions: ['T-s'] }, 1));
  assert.throws(() => C.makePlan({ ...config, repeats: Infinity }, 1)); assert.throws(() => C.makePlan({ ...config, angles: [0] }, 1));
});
test('layout preserves head-centred radius and computes actual gaps, rather than treating degrees as cm', () => {
  for (const a of [5, 10, 20, 40]) { const g = C.geometry(su, a), r = C.dist(g.P, g.head); for (const id of ['A', 'M', 'B']) near(C.dist(g[id], g.head), r); near(C.dist(g.M, g.P), 0); near(C.dist(g.A, g.P), 2 * r * Math.sin(a * Math.PI / 360)); assert.ok(g.A.y > g.B.y); }
  assert.throws(() => C.geometry({ ...su, P: su.S }, 10)); assert.throws(() => C.geometry({ ...su, P: { x: -30, y: 0 } }, 10));
});
test('auditory warp is reversible, stationary when the hand stops, and reaches exactly P', () => {
  const T = C.geometry(su, 20).A;
  assert.deepEqual(C.sound('W-c', su.S, T, su.P, su.S).source, T);
  assert.deepEqual(C.sound('W-c', su.P, T, su.P, su.S).source, su.P);
  const mid = C.mix(su.S, su.P, 0.5), st = C.sound('W-c', mid, T, su.P, su.S); near(st.source.x, (T.x + su.P.x) / 2); near(st.source.y, (T.y + su.P.y) / 2);
  assert.deepEqual(st, C.sound('W-c', mid, T, su.P, su.S));
  for (let q = 0; q <= 1; q += 0.01) { const p = C.mix(su.S, su.P, q), a = C.sound('W-c', p, T, su.P, su.S); assert.ok(C.point(a.source)); assert.ok(a.q >= 0 && a.q <= 1); near(a.gain, 0.65); near(a.interval, 0.45); }
  assert.equal(C.sound('none', mid, T, su.P, su.S), null);
  assert.deepEqual(C.sound('T-c', su.P, T, su.P, su.S).source, T);
});
test('sensor encodes hand-relative direction while constant sound remains head relative', () => {
  const T = C.geometry(su, 20).A, a = C.sound('P-s', su.S, T, su.P, su.S), b = C.sound('P-s', su.P, T, su.P, su.S);
  assert.equal(a.frame, 'hand-direction'); assert.deepEqual(a.source, { x: 40, y: -10 }); assert.deepEqual(a.target, su.P); assert.ok(b.gain > a.gain); assert.ok(b.interval < a.interval); assert.equal(C.sound('T-c', su.S, T, su.P, su.S).frame, 'head');
});
test('endpoint metrics retain overshoot, negative pull, perpendicular error and null zero-gap', () => {
  const T = { x: 0, y: 0 }, P = { x: 10, y: 0 };
  near(C.metrics(T, P, T).pull, 0); near(C.metrics(T, P, P).pull, 1); near(C.metrics(T, P, { x: 20, y: 5 }).pull, 2); near(C.metrics(T, P, { x: -10, y: 0 }).pull, -1); near(C.metrics(T, P, { x: 10, y: 5 }).perpendicular, 5);
  assert.equal(C.metrics(P, P, T).pull, null); assert.equal(C.metrics(P, P, T).towardP, null);
});
test('homography handles perspective, inverse round trips, and rejects crossed/collinear/repeated corners', () => {
  const corners = [{ x: .1, y: .9 }, { x: .9, y: .85 }, { x: .8, y: .1 }, { x: .2, y: .15 }], H = C.solveH(corners, C.PAPER), inv = C.solveH(C.PAPER, corners);
  for (let i = 0; i < 4; i++) { const p = C.applyH(H, corners[i]); near(p.x, C.PAPER[i].x); near(p.y, C.PAPER[i].y); }
  for (let i = 0; i < 200; i++) { const p = { x: 29.7 * i / 200, y: 21 * (i % 17) / 17 }, q = C.applyH(H, C.applyH(inv, p)); near(p.x, q.x); near(p.y, q.y); }
  assert.throws(() => C.solveH([corners[0], corners[2], corners[1], corners[3]], C.PAPER));
  assert.throws(() => C.solveH(Array(4).fill({ x: 0, y: 0 }), C.PAPER));
  assert.throws(() => C.solveH([0, 1, 2, 3].map(x => ({ x, y: x })), C.PAPER));
  assert.equal(C.applyH([1, 0, 0, 0, 1, 0, 0, 0, 0], { x: 1, y: 1 }), null);
});
function image(blobs) { const W = 100, H = 100, pixels = new Uint8ClampedArray(W * H * 4); for (const [x, y, w, h] of blobs) for (let j = y; j < y + h; j++) for (let i = x; i < x + w; i++) { pixels[(j * W + i) * 4] = 255; pixels[(j * W + i) * 4 + 3] = 255; } return C.findMarker(pixels, W, H, { h: 0, s: 1, v: 1 }, 16); }
test('connected color tracking avoids phantom midpoints between equally sized same-colour objects', () => {
  const a = image([[10, 10, 6, 6]]); assert.ok(a.point); near(a.point.x, .125); near(a.point.y, .125);
  assert.equal(image([[10, 10, 6, 6], [80, 80, 6, 6]]).point, null);
  assert.equal(image([[0, 0, 40, 40]]).point, null); assert.equal(image([[0, 0, 1, 1]]).point, null);
  assert.equal(image([]).point, null); assert.ok(image([[10, 10, 6, 6], [80, 80, 3, 3]]).point);
});
test('stopping or dwelling never constitutes contact; explicit stop and separate responses are required', () => {
  const e = reaching(); const end = move(e); for (let t = end + 50; t < end + 2000; t += 50) e.update(su.P, t);
  assert.equal(e.state, 'reach'); assert.equal(e.current.contact, undefined);
  assert.ok(e.end(end + 1950)); assert.equal(e.state, 'answer'); assert.equal(e.current.contact, null);
  assert.equal(e.answer({ noticed: 'no', confidence: 3, contact: null }, end + 2000), false);
  assert.ok(e.answer({ noticed: 'no', confidence: 3, contact: 'yes' }, end + 2000));
  assert.equal(e.current.status, 'complete'); assert.equal(e.session.index, 1);
  assert.equal(e.answer({ noticed: 'no', confidence: 3, contact: 'yes' }, end + 2001), false);
});
test('tracking loss, stale samples and jumps invalidate a pending trial and preserve its assignment', () => {
  for (const failure of ['null', 'stale', 'jump']) { const e = reaching(); const original = { ...e.spec }; if (failure === 'null') e.update(null, 5800); if (failure === 'stale') e.update(su.S, 5900, 5600); if (failure === 'jump') e.update({ x: 100, y: 100 }, 5750); assert.equal(e.state, 'interrupted', failure); assert.equal(e.current.status, 'invalid'); assert.equal(e.session.index, 0); assert.deepEqual(e.spec, original); assert.ok(e.next(6000)); assert.equal(e.state, 'ready'); }
});
test('early movement and premature stop cannot enter the valid result set', () => {
  const e = ready(), id = e.begin(5600); e.update({ x: 7, y: 10 }, 5650); assert.equal(e.state, 'interrupted'); assert.equal(e.current.invalidReason, 'early_movement'); assert.equal(e.delay(id, 5700), false); assert.equal(e.reach(id, 5800), false);
  const r = reaching(); assert.equal(r.end(5750), false); assert.equal(r.current.invalidReason, 'premature_stop'); assert.equal(C.summarize(r.session).length, 0);
});
test('timeout is a failed reach outcome, rather than disappearing or being converted into contact', () => {
  const e = reaching(); const end = move(e, { x: 20, y: 10 }); for (let t = end + 50; t <= 17700; t += 50) e.update({ x: 20, y: 10 }, t);
  assert.equal(e.state, 'answer'); assert.equal(e.current.endReason, 'timeout'); assert.equal(e.current.contact, 'no');
  assert.equal(e.answer({ noticed: 'no', confidence: 3, contact: 'yes' }, 18000), false);
  assert.ok(e.answer({ noticed: 'unsure', confidence: 1, contact: 'no' }, 18000));
});
test('reload invalidates pending attempts without advancement and relearns layout', () => {
  const e = reaching(); move(e); const saved = C.copy(e.session), r = C.Engine.restore(saved, 1);
  assert.equal(r.session.index, 0); assert.equal(r.session.attempts[0].invalidReason, 'page_reload'); assert.equal(r.state, 'learn'); assert.equal(saved.attempts[0].status, 'pending');
  assert.throws(() => C.Engine.restore({ ...saved, index: -1 }, 1)); assert.throws(() => C.Engine.restore({ ...saved, plan: [] }, 1));
});
test('unknown answers are counted separately, zero-gap pull is null, and joint outcome keeps all trials in denominator', () => {
  const attempts = [
    { status: 'complete', condition: 'none', angle: 10, tool: 'A', errP: 5, errA: 4, ms: 1000, pull: 1, contact: 'yes', noticed: 'no' },
    { status: 'complete', condition: 'none', angle: 10, tool: 'A', errP: 7, errA: 6, ms: 3000, pull: 0, contact: 'unsure', noticed: 'unsure' },
    { status: 'invalid', condition: 'none', angle: 10, tool: 'A', errP: 999 },
    { status: 'complete', condition: 'none', angle: 10, tool: 'M', errP: 1, errA: 1, ms: 1000, pull: null, contact: 'no', noticed: 'yes' }
  ]; const groups = C.summarize({ attempts }); const g = groups[0]; assert.equal(g.n, 2); assert.equal(g.joint, 1); assert.equal(g.contactUnknown, 1); assert.equal(g.noticedUnknown, 1); near(g.errP, 6); near(g.pull, .5); assert.equal(groups[1].pull, null);
});
test('CSV preserves UTF-8, newlines, zero values, negative numeric data and spreadsheet formula safety', () => {
  const out = C.csv([{ a: '=HYPERLINK("bad")', b: '赤,青\n黄', c: -1.25, d: 0, e: null }], ['a', 'b', 'c', 'd', 'e']);
  assert.ok(out.startsWith('\ufeff')); assert.ok(out.includes("'=HYPERLINK")); assert.ok(out.includes('"赤,青\n黄"')); assert.ok(out.endsWith(',-1.25,0,'));
});
test('the explicit endpoint preserves the last raw camera sample independently of its smoothed position', () => {
  const e = reaching(), time = move(e); e.update(su.P, time + 50, time + 50, { x: 40.4, y: .3 }); assert.ok(e.end(time + 50));
  const endpoint = e.current.path.at(-1); near(endpoint.x, 40); near(endpoint.rawX, 40.4); near(endpoint.rawY, .3);
});
