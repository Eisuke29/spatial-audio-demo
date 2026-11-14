/* Browser and Node share the experiment definitions and analysis. No dependencies. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.PilotCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const VERSION = '1.0.0';
  const CONDITIONS = {
    none: '① 音なし',
    fixed: '② A固定',
    warp: '③ A→P移動',
    sensor: '④ Pへの誘導'
  };
  const clamp = (n, lo = 0, hi = 1) => Math.max(lo, Math.min(hi, n));
  const distance = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
  const mean = values => values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;

  function random(seed) {
    let a = seed >>> 0;
    return function () {
      a += 0x6D2B79F5;
      let t = a;
      t = Math.imul(t ^ t >>> 15, t | 1);
      t ^= t + Math.imul(t ^ t >>> 7, t | 61);
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }
  function shuffle(array, rng) {
    const copy = array.slice();
    for (let i = copy.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [copy[i], copy[j]] = [copy[j], copy[i]];
    }
    return copy;
  }
  function parseOffsets(text) {
    const parts = String(text).trim().split(/[,、\s]+/).filter(Boolean);
    if (!parts.length) throw new Error('ずらす量を入力してください。例：0, 15, 30');
    const values = parts.map(Number);
    if (values.some(n => !Number.isFinite(n) || n < 0 || n > 50)) {
      throw new Error('ずらす量は0〜50の数値をカンマで区切ってください。');
    }
    const unique = [...new Set(values)].sort((a, b) => a - b);
    if (!unique.includes(0)) unique.unshift(0);
    if (!unique.some(n => n > 0)) throw new Error('0より大きいずらし量も1つ以上入れてください。');
    return unique;
  }
  function geometry(config, offsetPct) {
    const P = config.reference ? { ...config.reference.P } : { x: 0, z: 1 };
    const unit = config.axis === 'depth' ? P : { x: 1, z: 0 };
    const shift = offsetPct / 100;
    return { S: { x: 0, z: 0 }, P, A: { x: P.x - unit.x * shift, z: P.z - unit.z * shift } };
  }
  function makePlan(config, seed, practice = false) {
    const rng = random(seed);
    if (practice) return shuffle(Object.keys(CONDITIONS).map((condition, i) => ({
      condition, offsetPct: i % 2 ? -config.offsets.at(-1) : config.offsets.at(-1), block: 1
    })), rng).map((t, i) => ({ ...t, index: i + 1, ...geometry(config, t.offsetPct) }));
    if (!Number.isInteger(config.repeats) || config.repeats < 1 || config.repeats > 10) {
      throw new Error('繰り返しは1〜10回にしてください。');
    }
    const offsets = config.offsets.flatMap(n => n === 0 ? [0] : [-n, n]);
    const plan = [];
    for (let block = 1; block <= config.repeats; block++) {
      const trials = Object.keys(CONDITIONS).flatMap(condition => offsets.map(offsetPct => ({ condition, offsetPct, block })));
      plan.push(...shuffle(trials, rng));
    }
    if (plan.length > 600) throw new Error('試行数が多すぎます。ずらし量か繰り返しを減らしてください。');
    return plan.map((t, i) => ({ ...t, index: i + 1, ...geometry(config, t.offsetPct) }));
  }
  function progress(hand, trial) {
    const a = trial.P;
    const norm = a.x * a.x + a.z * a.z;
    return norm ? clamp((hand.x * a.x + hand.z * a.z) / norm) : 0;
  }
  function stimulus(trial, hand) {
    const p = progress(hand, trial);
    if (trial.condition === 'none') return { x: trial.A.x, z: trial.A.z, gain: 0, period: 0.45, progress: p };
    if (trial.condition === 'sensor') {
      const d = distance(hand, trial.P);
      const proximity = 1 - clamp(d / Math.max(0.001, distance(trial.S, trial.P)));
      // Hand-relative direction is an explicit guidance code, not a world-fixed source.
      const dx = trial.P.x - hand.x, dz = trial.P.z - hand.z;
      const len = Math.hypot(dx, dz);
      return { x: len > 0.005 ? dx / len : 0, z: len > 0.005 ? dz / len : 1,
        gain: 0.35 + 0.65 * proximity, period: 0.65 - 0.43 * proximity, progress: p };
    }
    const f = trial.condition === 'warp' ? p * p * (3 - 2 * p) : 0;
    return { x: trial.A.x + (trial.P.x - trial.A.x) * f,
      z: trial.A.z + (trial.P.z - trial.A.z) * f, gain: 1, period: 0.45, progress: p };
  }
  function metrics(trial, endpoint, path) {
    const dx = trial.P.x - trial.A.x, dz = trial.P.z - trial.A.z;
    const offset = Math.hypot(dx, dz);
    const projection = offset > 1e-9 ? ((endpoint.x - trial.A.x) * dx + (endpoint.z - trial.A.z) * dz) / offset : null;
    let pathLength = 0;
    for (let i = 1; i < path.length; i++) pathLength += distance(path[i - 1], path[i]);
    return { errorA: distance(endpoint, trial.A), errorP: distance(endpoint, trial.P),
      towardP: projection, attractionRatio: offset > 1e-9 ? projection / offset : null, pathLength };
  }
  function summarize(trials) {
    const good = trials.filter(t => t.status === 'complete');
    const levels = [...new Set(good.map(t => Math.abs(t.offsetPct)))].sort((a, b) => a - b);
    return Object.keys(CONDITIONS).flatMap(condition => levels.map(offset => {
      const group = good.filter(t => t.condition === condition && Math.abs(t.offsetPct) === offset);
      const yes = group.filter(t => t.noticed === 'yes').length;
      const no = group.filter(t => t.noticed === 'no').length;
      const contacts = group.filter(t => t.contact === 'yes' || t.contact === 'no');
      return { condition, offset, n: group.length, towardP: mean(group.map(t => t.metrics.towardP).filter(n => n !== null)),
        errorA: mean(group.map(t => t.metrics.errorA)), errorP: mean(group.map(t => t.metrics.errorP)),
        durationMs: mean(group.map(t => t.durationMs)), yes, no, unsure: group.length - yes - no,
        noticedRate: yes + no ? yes / (yes + no) : null,
        contactN: contacts.length, contactRate: contacts.length ? contacts.filter(t => t.contact === 'yes').length / contacts.length : null };
    })).filter(g => g.n > 0);
  }
  function csv(rows, columns) {
    const cell = value => {
      if (value === null || value === undefined) return '';
      let s = String(value);
      if (typeof value === 'string' && /^[\s]*[=+\-@]/.test(s)) s = "'" + s;
      return '"' + s.replace(/"/g, '""') + '"';
    };
    return '\uFEFF' + [columns.map(cell).join(','), ...rows.map(row => columns.map(c => cell(row[c])).join(','))].join('\r\n');
  }
  function trialRows(session) {
    return session.trials.map(t => ({
      session_id: session.id, app_version: VERSION, phase: session.phase, seed: session.seed,
      trial: t.index, attempt_id: t.id, block: t.block, status: t.status, invalid_reason: t.invalidReason,
      condition: t.condition, signed_offset_pct: t.offsetPct, axis: session.config.axis,
      input: session.config.input, task: session.config.task, sound: session.config.sound,
      device: session.config.device, connection: session.config.connection, equipment: session.config.equipment,
      head_fixed_instruction: true, volume: session.config.volume, coordinate_unit: 'S_to_P_fraction',
      reference_registered: !!session.config.reference, pointer_raw_requested: t.rawRequested ?? false,
      relative_pixels_per_unit: t.pixelsPerUnit, canvas_width_css_px: t.canvasWidth, canvas_height_css_px: t.canvasHeight,
      start_x: t.startPosition?.x, start_z: t.startPosition?.z, start_drift: t.startDrift, started_at: t.startedAt,
      a_x: t.A.x, a_z: t.A.z, p_x: t.P.x, p_z: t.P.z,
      end_x: t.endpoint?.x, end_z: t.endpoint?.z, duration_ms: t.durationMs,
      error_a: t.metrics?.errorA, error_p: t.metrics?.errorP, toward_p: t.metrics?.towardP,
      attraction_ratio: t.metrics?.attractionRatio, path_length: t.metrics?.pathLength,
      noticed: t.noticed, contact_self_report: t.contact,
      audio_sample_rate: session.audio?.sampleRate, audio_base_latency_s: session.audio?.baseLatency,
      audio_output_latency_s: session.audio?.outputLatency, audio_start_requested_s: t.audioStart,
      user_agent: session.environment.userAgent
    }));
  }
  function pathRows(session) {
    return session.trials.flatMap(t => (t.path || []).map(p => ({
      session_id: session.id, phase: session.phase, trial: t.index, attempt_id: t.id, status: t.status,
      condition: t.condition, signed_offset_pct: t.offsetPct, t_ms: p.t, x: p.x, z: p.z,
      source_x: p.sourceX, source_z: p.sourceZ, stimulus_gain: p.gain, pulse_period_s: p.period,
      reach_progress: p.progress
    })));
  }
  return { VERSION, CONDITIONS, clamp, distance, random, shuffle, parseOffsets, geometry, makePlan,
    progress, stimulus, metrics, summarize, csv, trialRows, pathRows };
});
