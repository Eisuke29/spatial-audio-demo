/* Pure geometry, tracking and trial lifecycle. No DOM, clock, audio or storage dependency. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.RedirectCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const VERSION = '2.0.0';
  const CONDITIONS = [
    { id: 'none', name: '音なし', loc: null, type: 'constant', main: true },
    { id: 'T-c', name: 'A固定・一定音', loc: 'T', type: 'constant', main: true },
    { id: 'W-c', name: 'A→P・一定音', loc: 'W', type: 'constant', main: true },
    { id: 'P-s', name: 'Pへ・手相対の誘導音', loc: 'P', type: 'sensor', main: true },
    { id: 'P-c', name: 'P固定・一定音（発展）', loc: 'P', type: 'constant', main: false },
    { id: 'W-s', name: 'A→P・手相対の誘導音（発展）', loc: 'W', type: 'sensor', main: false },
    { id: 'T-s', name: 'Aへ・手相対の誘導音（空振り対照）', loc: 'T', type: 'sensor', main: false }
  ];
  const CMAP = Object.fromEntries(CONDITIONS.map(c => [c.id, c]));
  const TOOLS = { A: { name: '赤・前', short: '赤', side: -1, color: '#c93445' }, M: { name: '青・中央', short: '青', side: 0, color: '#2563eb' }, B: { name: '黄・後ろ', short: '黄', side: 1, color: '#a66600' } };
  const PAPER = [{ x: 0, y: 0 }, { x: 29.7, y: 0 }, { x: 29.7, y: 21 }, { x: 0, y: 21 }];
  const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
  const point = p => !!p && Number.isFinite(p.x) && Number.isFinite(p.y);
  const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  const copy = value => JSON.parse(JSON.stringify(value));
  const mix = (a, b, q) => ({ x: a.x + (b.x - a.x) * q, y: a.y + (b.y - a.y) * q });
  function seeded(seed) { let a = seed >>> 0; return () => { a += 0x6D2B79F5; let t = Math.imul(a ^ a >>> 15, 1 | a); t ^= t + Math.imul(t ^ t >>> 7, 61 | t); return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
  function shuffle(items, rng) { const a = [...items]; for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }
  function validateCalibration(su) {
    if (!su || !['body', 'S', 'P'].every(k => point(su[k]))) throw new Error('体・S・Pの登録が必要です');
    if (dist(su.S, su.P) < 15 || dist(su.S, su.P) > 90) throw new Error('S→Pは15〜90cmの届く範囲にしてください');
    if (!(su.headBehind >= 0 && su.headBehind <= 50 && su.earAbove >= 5 && su.earAbove <= 100)) throw new Error('頭の位置の設定を確認してください');
    const h = head(su);
    if (dist(su.P, h) < 15 || su.P.x - h.x < 10) throw new Error('Pは体の右側に登録してください');
    return true;
  }
  const head = su => ({ x: su.body.x, y: su.body.y - su.headBehind });
  function geometry(su, angle) {
    validateCalibration(su);
    const h = head(su), radius = dist(su.P, h), azimuth = Math.atan2(su.P.x - h.x, su.P.y - h.y), g = { P: { ...su.P }, S: { ...su.S }, head: h };
    for (const [id, tool] of Object.entries(TOOLS)) { const a = azimuth + tool.side * angle * Math.PI / 180; g[id] = { x: h.x + radius * Math.sin(a), y: h.y + radius * Math.cos(a) }; }
    return g;
  }
  function progress(hand, S, P) { const dx = P.x - S.x, dy = P.y - S.y, d = dx * dx + dy * dy; if (d < 1e-8) throw new Error('SとPが重なっています'); return clamp(((hand.x - S.x) * dx + (hand.y - S.y) * dy) / d, 0, 1); }
  function sound(condition, hand, T, P, S) {
    const c = CMAP[condition];
    if (!c || !point(hand) || !c.loc) return null;
    const q = progress(hand, S, P), w = q * q * (3 - 2 * q);
    const source = c.loc === 'T' ? T : c.loc === 'P' ? P : mix(T, P, w);
    if (c.type === 'constant') return { source: { ...source }, q, gain: 0.65, interval: 0.45, frame: 'head' };
    const closeness = clamp(1 - dist(hand, source) / 35, 0, 1);
    // Explicit hand-relative direction code, distinct from a head-fixed physical sound source.
    return { source: { x: source.x - hand.x, y: source.y - hand.y }, target: { ...source }, q, gain: 0.25 + closeness * 0.4, interval: 0.65 - closeness * 0.43, frame: 'hand-direction' };
  }
  function metrics(T, P, E) {
    if (![T, P, E].every(point)) return { errA: null, errP: null, gap: dist(T, P), pull: null, towardP: null, perpendicular: null };
    const dx = P.x - T.x, dy = P.y - T.y, gap = Math.hypot(dx, dy), dot = (E.x - T.x) * dx + (E.y - T.y) * dy;
    return { errA: dist(E, T), errP: dist(E, P), gap, pull: gap > 1e-6 ? dot / (gap * gap) : null, towardP: gap > 1e-6 ? dot / gap : null, perpendicular: gap > 1e-6 ? ((E.x - T.x) * -dy + (E.y - T.y) * dx) / gap : null };
  }
  function makePlan(config, seed) {
    if (!config || !['demo', 'baseline', 'pilot'].includes(config.kind)) throw new Error('試し方が不正です');
    const rng = seeded(seed), result = [];
    if (config.kind === 'demo') {
      if (!CMAP[config.condition] || !TOOLS[config.tool] || ![5, 10, 15, 20, 30, 40].includes(config.angle)) throw new Error('体験条件が不正です');
      return [{ condition: config.condition, angle: config.angle, tool: config.tool, block: 0, repeat: 0 }];
    }
    const conditions = config.kind === 'baseline' ? ['none'] : config.conditions;
    if (!Array.isArray(conditions) || !conditions.length || new Set(conditions).size !== conditions.length || conditions.some(c => !CMAP[c] || !CMAP[c].main)) throw new Error('主要条件を選んでください');
    if (!conditions.includes('none')) throw new Error('比較の基準として音なしを含めてください');
    if (!Array.isArray(config.angles) || !config.angles.length || new Set(config.angles).size !== config.angles.length || config.angles.some(a => ![5, 10, 15, 20, 30, 40].includes(a))) throw new Error('間隔を選んでください');
    if (!Number.isInteger(config.repeats) || config.repeats < 1 || config.repeats > 10) throw new Error('反復数は1〜10です');
    shuffle(config.angles, rng).forEach((angle, block) => {
      for (let repeat = 0; repeat < config.repeats; repeat++) result.push(...shuffle(conditions.flatMap(condition => Object.keys(TOOLS).map(tool => ({ condition, angle, tool, block, repeat }))), rng));
    });
    return result;
  }
  function solveH(src, dst) {
    if (!Array.isArray(src) || src.length !== 4 || !src.every(point) || !Array.isArray(dst) || dst.length !== 4 || !dst.every(point)) throw new Error('4隅を指定してください');
    function convex(ps) {
      const cross = ps.map((p, i) => { const b = ps[(i + 1) % 4], c = ps[(i + 2) % 4]; return (b.x - p.x) * (c.y - b.y) - (b.y - p.y) * (c.x - b.x); });
      return cross.every(x => x > 1e-7) || cross.every(x => x < -1e-7);
    }
    if (!convex(src) || !convex(dst)) throw new Error('4隅は重ねず、紙の周囲に沿って順番に選んでください');
    const A = [], b = [];
    for (let i = 0; i < 4; i++) { const { x, y } = src[i], { x: u, y: v } = dst[i]; A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]); b.push(u); A.push([0, 0, 0, x, y, 1, -v * x, -v * y]); b.push(v); }
    for (let c = 0; c < 8; c++) {
      let pivot = c;
      for (let r = c + 1; r < 8; r++) if (Math.abs(A[r][c]) > Math.abs(A[pivot][c])) pivot = r;
      [A[c], A[pivot]] = [A[pivot], A[c]]; [b[c], b[pivot]] = [b[pivot], b[c]];
      if (Math.abs(A[c][c]) < 1e-10) throw new Error('紙が小さすぎるか、4隅の形が不正です');
      const f = A[c][c]; for (let k = c; k < 8; k++) A[c][k] /= f; b[c] /= f;
      for (let r = 0; r < 8; r++) if (r !== c) { const m = A[r][c]; for (let k = c; k < 8; k++) A[r][k] -= m * A[c][k]; b[r] -= m * b[c]; }
    }
    return [...b, 1];
  }
  function applyH(H, p) { const w = H[6] * p.x + H[7] * p.y + H[8]; if (!point(p) || Math.abs(w) < 1e-9) return null; const q = { x: (H[0] * p.x + H[1] * p.y + H[2]) / w, y: (H[3] * p.x + H[4] * p.y + H[5]) / w }; return point(q) && Math.abs(q.x) < 300 && Math.abs(q.y) < 300 ? q : null; }
  function rgb2hsv(r, g, b) { r /= 255; g /= 255; b /= 255; const hi = Math.max(r, g, b), lo = Math.min(r, g, b), d = hi - lo; let h = d ? hi === r ? ((g - b) / d) % 6 : hi === g ? (b - r) / d + 2 : (r - g) / d + 4 : 0; h *= 60; if (h < 0) h += 360; return { h, s: hi ? d / hi : 0, v: hi }; }
  function findMarker(data, W, H, color, tolerance) {
    if (!color || color.s < 0.25 || color.v < 0.2 || data.length !== W * H * 4) return { point: null, reason: '色未登録' };
    const mask = new Uint8Array(W * H), minS = Math.max(0.3, color.s * 0.55), minV = Math.max(0.2, color.v * 0.4);
    for (let i = 0; i < mask.length; i++) { const c = rgb2hsv(data[i * 4], data[i * 4 + 1], data[i * 4 + 2]); const dh = Math.abs(c.h - color.h); mask[i] = c.s >= minS && c.v >= minV && Math.min(dh, 360 - dh) <= tolerance ? 1 : 0; }
    const queue = new Int32Array(mask.length), blobs = [];
    for (let i = 0; i < mask.length; i++) if (mask[i]) {
      let read = 0, write = 1, sx = 0, sy = 0, minX = W, maxX = 0, minY = H, maxY = 0; queue[0] = i; mask[i] = 0;
      while (read < write) {
        const p = queue[read++], x = p % W, y = Math.floor(p / W); sx += x; sy += y; minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y);
        for (const n of [x > 0 ? p - 1 : -1, x < W - 1 ? p + 1 : -1, y > 0 ? p - W : -1, y < H - 1 ? p + W : -1]) if (n >= 0 && mask[n]) { mask[n] = 0; queue[write++] = n; }
      }
      if (write >= 8 && write <= W * H * 0.08 && write / ((maxX - minX + 1) * (maxY - minY + 1)) >= 0.25) blobs.push({ x: sx / write / W, y: sy / write / H, size: write });
    }
    blobs.sort((a, b) => b.size - a.size);
    if (!blobs.length) return { point: null, reason: 'シールが見えません' };
    if (blobs[1] && blobs[1].size > blobs[0].size * 0.55) return { point: null, reason: '同じ色が複数あります' };
    return { point: blobs[0], reason: '追跡中' };
  }
  class Engine {
    constructor(config, calibration, seed, id) {
      validateCalibration(calibration);
      this.session = { version: VERSION, id, config: copy(config), calibration: copy(calibration), seed: seed >>> 0, plan: makePlan(config, seed), index: 0, attempts: [], final: null, closed: false };
      this.state = 'learn'; this.learnedAngle = null; this.enteredAt = null; this.current = null; this.hand = null; this.samples = []; this.message = ''; this.sequence = 0; this.lastSampleAt = null;
    }
    get spec() { return this.session.plan[this.session.index] || null; }
    get active() { return ['instruction', 'delay', 'reach', 'answer'].includes(this.state); }
    get stable() { return this.samples.length >= 5 && this.lastSampleAt - this.samples[0].t >= 450 && this.samples.every(p => dist(p, this.hand) <= 1); }
    get atStart() { return point(this.hand) && dist(this.hand, this.session.calibration.S) <= 3 && this.stable; }
    update(hand, now, sampleAt = now, raw = hand) {
      if (this.enteredAt === null) this.enteredAt = now;
      if (!point(hand) || !Number.isFinite(sampleAt) || now - sampleAt > 150) {
        this.hand = null; this.samples = [];
        if (['instruction', 'delay', 'reach'].includes(this.state)) this.abort('tracking_lost', now);
        return;
      }
      if (this.lastSampleAt !== null && sampleAt < this.lastSampleAt) return;
      if (sampleAt !== this.lastSampleAt) {
        if (this.hand && this.lastSampleAt !== null && sampleAt - this.lastSampleAt < 250 && dist(hand, this.hand) > 2 + 250 * (sampleAt - this.lastSampleAt) / 1000) { this.hand = null; this.samples = []; if (this.active) this.abort('tracking_jump', now); return; }
        this.hand = { ...hand }; this.rawHand = point(raw) ? { ...raw } : { ...hand }; this.lastSampleAt = sampleAt;
        this.samples.push({ ...hand, t: sampleAt }); while (this.samples.length && sampleAt - this.samples[0].t > 550) this.samples.shift();
        if (this.state === 'reach') this.record(now, raw);
      }
      if (['instruction', 'delay'].includes(this.state) && dist(hand, this.session.calibration.S) > 4) this.abort('early_movement', now);
      if (this.state === 'reach' && now - this.current.startAt >= 12000) this.end(now, 'timeout');
    }
    learn(now) { if (this.state !== 'learn' || this.enteredAt === null || now - this.enteredAt < 5000) return false; this.learnedAngle = this.spec.angle; this.state = 'ready'; this.enteredAt = now; return true; }
    begin(now) {
      if (this.state !== 'ready' || !this.atStart || this.session.closed || !this.spec) return null;
      const g = geometry(this.session.calibration, this.spec.angle);
      this.current = { id: this.session.id + '-' + (++this.sequence), index: this.session.index, ...copy(this.spec), T: g[this.spec.tool], P: g.P, S: g.S, head: g.head, path: [], status: 'pending', instructionAt: now, startAt: null, E: null, endReason: null };
      this.session.attempts.push(this.current); this.state = 'instruction'; this.enteredAt = now; this.message = ''; return this.current.id;
    }
    delay(id, now) { if (this.state !== 'instruction' || this.current.id !== id) return false; this.state = 'delay'; this.enteredAt = now; return true; }
    reach(id, now) {
      if (this.state !== 'delay' || this.current.id !== id) return false;
      if (!this.hand || dist(this.hand, this.current.S) > 4 || now - this.lastSampleAt > 150) { this.abort('start_not_ready', now); return false; }
      this.state = 'reach'; this.current.startAt = now; this.enteredAt = now; this.record(now); return true;
    }
    record(now, raw = this.hand) {
      const t = this.current, prev = t.path[t.path.length - 1];
      if (prev && now - t.startAt - prev.t < 30) return;
      const audio = sound(t.condition, this.hand, t.T, t.P, t.S);
      t.path.push({ t: now - t.startAt, x: this.hand.x, y: this.hand.y, rawX: raw?.x ?? this.hand.x, rawY: raw?.y ?? this.hand.y, sampleAgeMs: now - this.lastSampleAt, audio });
    }
    end(now, reason = 'self_stop') {
      if (this.state !== 'reach' || !this.hand || now - this.lastSampleAt > 150) return false;
      if (reason !== 'timeout' && (now - this.current.startAt < 250 || dist(this.hand, this.current.S) < 8)) { this.abort('premature_stop', now); return false; }
      const t = this.current; t.E = { ...this.hand }; t.ms = now - t.startAt; t.endReason = reason; t.endAt = now;
      t.path.push({ t: t.ms, ...this.hand, rawX: this.rawHand?.x ?? this.hand.x, rawY: this.rawHand?.y ?? this.hand.y, sampleAgeMs: now - this.lastSampleAt, audio: sound(t.condition, this.hand, t.T, t.P, t.S) });
      Object.assign(t, metrics(t.T, t.P, t.E));
      t.nearP = t.errP <= 3; t.contact = reason === 'timeout' || reason === 'miss' ? 'no' : this.session.config.kind === 'baseline' ? 'not_applicable' : null;
      this.state = 'answer'; this.enteredAt = now; return true;
    }
    answer(response, now) {
      if (this.state !== 'answer') return false;
      if (!['yes', 'no', 'unsure'].includes(response.noticed) || !['yes', 'no', 'unsure', 'not_applicable'].includes(response.contact) || !Number.isInteger(response.confidence) || response.confidence < 1 || response.confidence > 5) return false;
      if (this.session.config.kind !== 'baseline' && response.contact === 'not_applicable') return false;
      if (['miss', 'timeout'].includes(this.current.endReason) && response.contact !== 'no') return false;
      Object.assign(this.current, response, { status: 'complete', answeredAt: now });
      this.session.index++; this.state = this.spec ? 'saved' : 'finished'; this.enteredAt = now; return true;
    }
    next(now) { if (!['saved', 'interrupted'].includes(this.state) || !this.spec) return false; this.current = null; this.samples = []; this.state = this.learnedAngle === this.spec.angle ? 'ready' : 'learn'; this.enteredAt = now; return true; }
    abort(reason, now) {
      if (!this.active) return false;
      if (this.current && this.current.status === 'pending') Object.assign(this.current, { status: 'invalid', invalidReason: reason, invalidAt: now });
      this.state = 'interrupted'; this.message = reason; this.enteredAt = now; this.samples = []; return true;
    }
    close(now) { this.abort('session_ended', now); this.session.closed = true; this.state = 'finished'; this.enteredAt = now; }
    static restore(session, now) {
      if (!session || session.version !== VERSION || typeof session.id !== 'string' || !Array.isArray(session.attempts)) throw new Error('保存記録の形式が不正です');
      const e = new Engine(session.config, session.calibration, session.seed, session.id);
      if (JSON.stringify(e.session.plan) !== JSON.stringify(session.plan) || !Number.isInteger(session.index) || session.index < 0 || session.index > session.plan.length || session.attempts.some(t => !t || !['pending', 'complete', 'invalid'].includes(t.status) || !Array.isArray(t.path) || !t.path.every(p => point(p) && Number.isFinite(p.t)) || ![t.T, t.P, t.S].every(point) || !session.plan[t.index] || t.condition !== session.plan[t.index].condition || t.tool !== session.plan[t.index].tool || t.angle !== session.plan[t.index].angle || t.status === 'complete' && (!point(t.E) || ![t.errA, t.errP, t.ms].every(Number.isFinite) || !['yes', 'no', 'unsure'].includes(t.noticed)))) throw new Error('保存記録の割付または軌跡が不正です');
      const completed = session.attempts.filter(t => t.status === 'complete').map(t => t.index).sort((a, b) => a - b);
      if (completed.length !== session.index || completed.some((x, i) => x !== i)) throw new Error('保存記録の完了数が合いません');
      e.session = copy(session); e.sequence = session.attempts.length;
      for (const t of e.session.attempts) if (t.status === 'pending') Object.assign(t, { status: 'invalid', invalidReason: 'page_reload', invalidAt: now });
      e.state = session.index >= session.plan.length || session.closed ? 'finished' : 'learn'; e.enteredAt = now; e.message = 'page_reload'; return e;
    }
  }
  function summarize(session) {
    const groups = new Map();
    for (const t of session.attempts) if (t.status === 'complete') {
      const key = `${t.condition}|${t.angle}|${t.tool}`;
      if (!groups.has(key)) groups.set(key, { condition: t.condition, angle: t.angle, tool: t.tool, n: 0, contactYes: 0, contactNo: 0, contactUnknown: 0, noticedYes: 0, noticedNo: 0, noticedUnknown: 0, joint: 0, errP: 0, errA: 0, pullSum: 0, pullN: 0, ms: 0 });
      const g = groups.get(key); g.n++; g.errP += t.errP; g.errA += t.errA; g.ms += t.ms;
      g[t.contact === 'yes' ? 'contactYes' : t.contact === 'no' ? 'contactNo' : 'contactUnknown']++;
      g[t.noticed === 'yes' ? 'noticedYes' : t.noticed === 'no' ? 'noticedNo' : 'noticedUnknown']++;
      if (t.contact === 'yes' && t.noticed === 'no') g.joint++;
      if (t.pull !== null) { g.pullSum += t.pull; g.pullN++; }
    }
    return [...groups.values()].map(g => ({ ...g, errP: g.errP / g.n, errA: g.errA / g.n, ms: g.ms / g.n, pull: g.pullN ? g.pullSum / g.pullN : null }));
  }
  function csv(rows, columns) {
    const cell = x => { if (x === null || x === undefined) return ''; let s = typeof x === 'object' ? JSON.stringify(x) : String(x); if (/^[=+@\t\r]/.test(s) || /^-[^\d.]/.test(s)) s = "'" + s; return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
    return '\ufeff' + [columns.map(cell).join(','), ...rows.map(r => columns.map(k => cell(r[k])).join(','))].join('\r\n');
  }
  return { VERSION, CONDITIONS, CMAP, TOOLS, PAPER, clamp, point, dist, copy, mix, seeded, shuffle, head, geometry, progress, sound, metrics, makePlan, validateCalibration, solveH, applyH, rgb2hsv, findMarker, Engine, summarize, csv };
});
