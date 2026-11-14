const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../experiment-core.js');
const config = { offsets: [0, 15, 30], repeats: 2, axis: 'lateral', reference: null };
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} ≠ ${b}`);

test('balanced blocks include zero once and both offset signs for all four conditions', () => {
  const plan = C.makePlan(config, 1234);
  assert.equal(plan.length, 40);
  for (const block of [1, 2]) {
    const counts = new Map();
    for (const t of plan.filter(t => t.block === block)) {
      const key = `${t.condition}/${t.offsetPct}`;
      counts.set(key, (counts.get(key) || 0) + 1);
      assert.deepEqual(t.P, { x: 0, z: 1 });
      near(t.P.x - t.A.x, t.offsetPct / 100);
    }
    assert.equal(counts.size, 20);
    assert.deepEqual([...counts.values()], Array(20).fill(1));
  }
  assert.deepEqual(C.makePlan(config, 1234), plan);
  assert.notDeepEqual(C.makePlan(config, 1235), plan);
});
test('zero is added, duplicate offset levels do not bias counts, malformed input is rejected', () => {
  assert.deepEqual(C.parseOffsets('30、15, 15'), [0, 15, 30]);
  for (const value of ['', '-1,10', '0,NaN', '0,51', '0']) assert.throws(() => C.parseOffsets(value));
  assert.throws(() => C.makePlan({ ...config, repeats: 0 }, 1));
});
test('practice is four distinct conditions; physical P stays fixed for both placement axes', () => {
  const reference = { P: { x: 0.6, z: 0.8 } };
  const cfg = { ...config, reference, axis: 'depth' };
  const plan = C.makePlan(cfg, 1, true);
  assert.equal(plan.length, 4);
  assert.equal(new Set(plan.map(t => t.condition)).size, 4);
  for (const t of plan) {
    assert.deepEqual(t.P, reference.P);
    near(t.A.x / t.A.z, t.P.x / t.P.z);
  }
});
test('warping reaches P, reverses with the hand and clamps outside the reach', () => {
  const trial = { condition: 'warp', ...C.geometry(config, 30) };
  assert.equal(C.progress({ x: 0, z: 0.5 }, trial), 0.5);
  const middle = C.stimulus(trial, { x: 0, z: 0.5 });
  near(middle.x, -0.15);
  near(C.stimulus(trial, trial.S).x, trial.A.x);
  near(C.stimulus(trial, trial.P).x, trial.P.x);
  near(C.stimulus(trial, { x: 0, z: -1 }).x, trial.A.x);
  near(C.stimulus(trial, { x: 0, z: 2 }).x, trial.P.x);
  assert.equal(C.stimulus({ ...trial, condition: 'fixed' }, trial.P).x, trial.A.x);
  assert.equal(C.stimulus({ ...trial, condition: 'none' }, trial.P).gain, 0);
});
test('hand-relative guidance gets louder and faster and reverses direction after passing P', () => {
  const trial = { condition: 'sensor', ...C.geometry(config, 30) };
  const far = C.stimulus(trial, { x: 0, z: 0 });
  const close = C.stimulus(trial, { x: 0, z: 0.9 });
  assert.ok(close.gain > far.gain);
  assert.ok(close.period < far.period);
  assert.ok(C.stimulus(trial, { x: 0, z: 1.1 }).z < 0);
  const atTarget = C.stimulus(trial, trial.P);
  for (const n of Object.values(atTarget)) assert.ok(Number.isFinite(n));
});
test('attraction is signed, defined on both offset signs, unclipped, and absent for zero offset', () => {
  for (const sign of [-1, 1]) {
    const t = { ...C.geometry(config, sign * 30) };
    near(C.metrics(t, t.A, []).attractionRatio, 0);
    near(C.metrics(t, t.P, []).attractionRatio, 1);
    near(C.metrics(t, { x: t.A.x + 2 * (t.P.x - t.A.x), z: 1 }, []).attractionRatio, 2);
    assert.ok(C.metrics(t, { x: t.A.x - (t.P.x - t.A.x), z: 1 }, []).towardP < 0);
  }
  const zero = C.geometry(config, 0), measured = C.metrics(zero, { x: 0.1, z: 1 }, []);
  assert.equal(measured.towardP, null); assert.equal(measured.attractionRatio, null);
  near(measured.errorA, 0.1);
});
test('summary excludes aborts, keeps unsure separate, and preserves zero-condition false alarms', () => {
  const trial = (offsetPct, noticed, status = 'complete') => ({ condition: 'none', offsetPct, noticed, status,
    contact: 'unsure', durationMs: 1000, metrics: { towardP: offsetPct ? 0.1 : null, errorA: 0.1, errorP: 0.2 } });
  const s = C.summarize([trial(15, 'yes'), trial(-15, 'no'), trial(15, 'unsure'), trial(15, 'yes', 'aborted'), trial(0, 'yes')]);
  assert.equal(s.length, 2);
  assert.equal(s[0].noticedRate, 1); assert.equal(s[0].towardP, null);
  assert.equal(s[1].n, 3); assert.equal(s[1].noticedRate, 0.5); assert.equal(s[1].unsure, 1);
  assert.equal(s[1].contactRate, null);
});
test('CSV preserves Japanese/newlines, escapes quotes and spreadsheet formulas, and keeps numeric signs', () => {
  const csv = C.csv([{ note: '機材,"試験"\n次', injection: '=HYPERLINK("x")', x: -0.5, missing: null }], ['note', 'injection', 'x', 'missing']);
  assert.ok(csv.startsWith('\uFEFF'));
  assert.ok(csv.includes('機材,""試験""\n次'));
  assert.ok(csv.includes('"\'=HYPERLINK(""x"")"'));
  assert.ok(csv.includes('"-0.5",'));
});
