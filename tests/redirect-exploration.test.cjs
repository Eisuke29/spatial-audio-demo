const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../redirect-core.js');
const su = { body: { x: 0, y: 0 }, S: { x: 0, y: 10 }, P: { x: 40, y: 0 }, headBehind: 15, earAbove: 35 };
const config = { kind: 'pilot', conditions: ['none', 'T-c', 'W-c', 'P-s'], angles: [10, 20], repeats: 2 };

test('100 seeded complete sessions / 4800 valid reaches retain assignments through randomized interruptions and reloads', () => {
  let completed = 0, interrupted = 0, reloaded = 0;
  for (let seed = 1; seed <= 100; seed++) {
    let e = new C.Engine(config, su, seed, `s-${seed}`), time = 0; const rng = C.seeded(seed + 77);
    while (e.state !== 'finished') {
      if (e.state === 'learn') { e.update(su.S, time); time += 5100; assert.ok(e.learn(time)); }
      for (let n = 0; n < 15; n++) e.update(su.S, time += 50);
      const index = e.session.index, spec = JSON.stringify(e.spec), id = e.begin(time);
      assert.ok(id, `begin seed ${seed} index ${index}`);
      if (rng() < .18) {
        const reason = ['focus_lost', 'hidden', 'paused', 'viewport_changed'][Math.floor(rng() * 4)];
        assert.ok(e.abort(reason, time)); interrupted++;
        assert.equal(e.session.index, index); assert.equal(JSON.stringify(e.spec), spec);
        assert.equal(e.reach(id, time + 300), false); assert.equal(e.answer({ contact: 'yes', noticed: 'no', confidence: 3 }, time + 400), false);
        e.next(time += 100); continue;
      }
      assert.ok(e.delay(id, time += 50)); assert.ok(e.reach(id, time += 50));
      const target = C.mix(e.current.T, e.current.P, rng() * 1.8 - .4);
      for (let n = 1; n <= 25; n++) e.update(C.mix(su.S, target, n / 25), time += 50);
      if (rng() < .05) {
        e = C.Engine.restore(C.copy(e.session), time += 200); reloaded++;
        assert.equal(e.session.index, index); assert.equal(JSON.stringify(e.spec), spec); continue;
      }
      assert.ok(e.end(time)); const was = e.current.id;
      assert.ok(e.answer({ contact: rng() < .6 ? 'yes' : 'no', noticed: rng() < .5 ? 'yes' : 'no', confidence: 1 + Math.floor(rng() * 5) }, time += 100)); completed++;
      assert.equal(e.session.index, index + 1); assert.equal(e.current.id, was);
      if (e.state !== 'finished') e.next(time += 50);
    }
    const final = C.Engine.restore(C.copy(e.session), time);
    assert.equal(final.state, 'finished'); assert.equal(final.session.index, 48);
    assert.equal(new Set(final.session.attempts.map(t => t.id)).size, final.session.attempts.length);
    assert.equal(C.summarize(final.session).reduce((s, g) => s + g.n, 0), 48);
    assert.ok(final.session.attempts.every(t => t.status !== 'pending'));
  }
  assert.equal(completed, 4800); assert.ok(interrupted > 500); assert.ok(reloaded > 100);
});

test('10000 random endpoint geometries preserve projection identities and zero/overshoot behavior', () => {
  const rng = C.seeded(233);
  for (let i = 0; i < 10000; i++) {
    const T = { x: rng() * 200 - 100, y: rng() * 200 - 100 }, P = { x: T.x + rng() * 30 + .01, y: T.y + rng() * 30 + .01 }, E = { x: rng() * 200 - 100, y: rng() * 200 - 100 }, m = C.metrics(T, P, E);
    assert.ok(Math.abs(m.errA ** 2 - (m.towardP ** 2 + m.perpendicular ** 2)) < 1e-7);
    assert.ok(Math.abs(m.towardP - m.pull * m.gap) < 1e-8);
    const a = C.metrics(T, P, C.mix(T, P, -2)), b = C.metrics(T, P, C.mix(T, P, 3));
    assert.ok(Math.abs(a.pull + 2) < 1e-8); assert.ok(Math.abs(b.pull - 3) < 1e-8);
  }
});

test('1000 perturbed perspective calibrations round-trip known plane points', () => {
  const rng = C.seeded(929);
  for (let i = 0; i < 1000; i++) {
    const ps = [{ x: .1 + rng() * .1, y: .8 + rng() * .1 }, { x: .8 + rng() * .1, y: .8 + rng() * .1 }, { x: .8 + rng() * .1, y: .1 + rng() * .1 }, { x: .1 + rng() * .1, y: .1 + rng() * .1 }];
    const h = C.solveH(ps, C.PAPER), inv = C.solveH(C.PAPER, ps), point = { x: rng() * 60 - 10, y: rng() * 40 - 10 }, back = C.applyH(h, C.applyH(inv, point));
    assert.ok(C.dist(point, back) < 1e-7);
  }
});

test('malformed storage, missing controls and forged completion counts fail explicitly', () => {
  assert.throws(() => C.makePlan({ ...config, kind: 'anything' }, 1));
  assert.throws(() => C.makePlan({ ...config, conditions: ['W-c'] }, 1));
  const e = new C.Engine(config, su, 11, 'malformed');
  for (const mutation of [s => { s.index = 1; }, s => { s.attempts = [{}]; }, s => { s.calibration.P.x = null; }, s => { s.plan[0].tool = 'invented'; }, s => { s.version = 'bad'; }]) { const s = C.copy(e.session); mutation(s); assert.throws(() => C.Engine.restore(s, 0)); }
});
test('all seven exploratory sound variants remain finite across 1000 hand poses including reversal and overshoot', () => {
  const rng = C.seeded(672), g = C.geometry(su, 30);
  for (let i = 0; i < 1000; i++) {
    const hand = { x: rng() * 100 - 20, y: rng() * 100 - 50 };
    for (const c of C.CONDITIONS) for (const tool of ['A', 'M', 'B']) {
      const s = C.sound(c.id, hand, g[tool], su.P, su.S);
      if (c.id === 'none') { assert.equal(s, null); continue; }
      assert.ok(C.point(s.source)); assert.ok(s.interval >= .219 && s.interval <= .651); assert.ok(s.gain >= .249 && s.gain <= .651); assert.ok(s.q >= 0 && s.q <= 1);
    }
  }
});
