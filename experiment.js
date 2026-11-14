/* All data stays in this browser. Open experiment.html directly or via localhost. */
(() => {
  'use strict';
  const C = window.PilotCore, $ = id => document.getElementById(id);
  const canvas = $('stage'), context = canvas.getContext('2d'), audio = new PilotAudio();
  const STORE_KEY = 'audio-redirection-pilot-v1';
  const busy = new Set(['acquiring', 'preview', 'dark', 'cue', 'reach', 'calibrating']);
  let database = { version: 1, sessions: [] }, storageUsable = true;
  let session = null, viewed = null, current = null, phase = 'setup', reference = null;
  let hand = { x: 0, z: 0 }, raw = { x: 0, z: 0 }, pointer = null, inputOrigin = null;
  let layout = null, mapping = null, calibrationConfig = null, rawRequested = false;
  let timers = [], checkpoint = null, lastSample = -Infinity, reachStarted = 0;

  function message(text = '', error = false) {
    $('message').textContent = text; $('message').hidden = !text;
    $('message').classList.toggle('error', error);
  }
  function storageWarning(text) { $('storageWarning').textContent = text; $('storageWarning').hidden = !text; }
  try {
    const saved = localStorage.getItem(STORE_KEY);
    if (saved) {
      const parsed = JSON.parse(saved);
      if (parsed.version !== 1 || !Array.isArray(parsed.sessions)) throw new Error('保存形式が違います');
      database = parsed;
      // A refresh or crash cannot silently turn an unfinished trial into a valid one.
      for (const s of database.sessions) if (s.pending) {
        s.trials.push({ ...s.pending, status: 'aborted', invalidReason: 'page_closed_or_reloaded' });
        s.pending = null;
      }
    }
  } catch (_) {
    storageUsable = false;
    storageWarning('ブラウザ保存を読み込めません。このページではメモリに記録します。終了前にCSVまたはJSONを保存してください。');
  }
  function persist() {
    if (session) session.updatedAt = new Date().toISOString();
    if (!storageUsable) return;
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(database));
      $('saveStatus').textContent = 'このブラウザに保存済み';
      storageWarning('');
    } catch (_) {
      $('saveStatus').textContent = 'ブラウザ保存に失敗';
      storageWarning('ブラウザ保存に失敗しました。記録はこのページ内に残っています。「ここまで保存して終了」のあと、CSVかJSONを保存してください。');
    }
  }
  function delay(fn, ms) { timers.push(setTimeout(fn, ms)); }
  function clearTimers() { timers.forEach(clearTimeout); timers = []; clearInterval(checkpoint); checkpoint = null; }
  function unlock() { if (document.pointerLockElement === canvas) document.exitPointerLock(); }
  function showRun() {
    $('setup').hidden = true; $('results').hidden = true; $('saved').hidden = true; $('run').hidden = false;
    document.body.classList.add('running');
    $('run').scrollIntoView({ block: 'start', behavior: 'instant' });
    canvas.focus({ preventScroll: true });
    resize();
  }
  function showSetup() {
    phase = 'setup'; $('setup').hidden = false; $('run').hidden = true;
    document.body.classList.remove('running'); $('configFields').disabled = false;
    listSaved(); syncSetup();
  }
  function readConfig(requireAudio = true) {
    const offsets = C.parseOffsets($('offsets').value), repeats = Number($('repeats').value);
    const input = $('inputMode').value, task = $('taskMode').value;
    const pixels = Number($('mouseScale').value);
    if (!Number.isInteger(repeats) || repeats < 1 || repeats > 10) throw new Error('繰り返しは1〜10回にしてください。');
    if (!Number.isFinite(pixels) || pixels < 40 || pixels > 10000) throw new Error('基準距離の移動量は40〜10000にしてください。');
    if (requireAudio && !$('checkedAudio').checked) throw new Error('左右テストと音量の確認をして、確認欄にチェックしてください。');
    if (task === 'contact' && (input !== 'lock' || !reference)) {
      throw new Error('実物に当てるときは「マウス：画面端を越えて動かす」を選び、机上のPを登録してください。');
    }
    if (input === 'lock' && !canvas.requestPointerLock) throw new Error('このブラウザでは「画面内でドラッグ」か「指でタッチ」を選んでください。');
    return { input, task, offsets, repeats, axis: $('axis').value, sound: $('sound').value,
      volume: Number($('volume').value), device: $('device').value, connection: $('connection').value,
      equipment: $('equipment').value.trim(), mouseScale: pixels,
      reference: input === 'lock' && reference ? JSON.parse(JSON.stringify(reference)) : null,
      previewMs: 2000, eyeCloseMs: 1200, cueGapMs: 140, timeoutMs: 15000,
      headFixed: true, coordinateUnit: 'S_to_P_fraction', height: 0 };
  }
  function syncSetup() {
    const input = $('inputMode').value;
    $('inputHint').textContent = input === 'lock'
      ? '机の上を広く使えます。入力を準備したあと、マウスをSに戻して押し続けます。Escで解除。'
      : input === 'touch' ? '画面を机に平らに置き、Sに触れ続け、合図のあと指を滑らせます。画面の大きさが移動範囲です。'
        : 'Sを押したまま画面内で移動します。画面端を越えると記録を中止します。';
    $('contactHelp').hidden = $('taskMode').value !== 'contact';
    $('referenceControls').hidden = input !== 'lock'; $('scaleField').hidden = input !== 'lock';
    $('clearP').hidden = !reference;
    $('referenceStatus').textContent = reference
      ? `登録済み：S→Pを100%として使用（移動量 ${reference.pixelsPerUnit.toFixed(1)}）。毎回Sへ戻してください。`
      : '未登録。実物なしでは初期の基準距離を使えます。';
    try {
      const offsets = C.parseOffsets($('offsets').value);
      const n = (offsets.length * 2 - 1) * 4 * Number($('repeats').value);
      $('trialCount').textContent = Number.isFinite(n) ? `本番 ${n}試行` : '試行数を確認してください';
    } catch (_) { $('trialCount').textContent = 'ずらし量を確認してください'; }
    $('volumeValue').textContent = `${Math.round(Number($('volume').value) * 100)}%`;
  }
  function newSeed() {
    if (window.crypto?.getRandomValues) return crypto.getRandomValues(new Uint32Array(1))[0];
    return (Date.now() ^ Math.floor(Math.random() * 0xffffffff)) >>> 0;
  }
  function begin(practice) {
    try {
      const config = readConfig(), seed = newSeed();
      const plan = C.makePlan(config, seed, practice);
      audio.stop();
      session = { id: `${Date.now().toString(36)}-${seed.toString(36)}`, version: C.VERSION,
        phase: practice ? 'practice' : 'main', status: 'in_progress', seed, config, plan,
        nextIndex: 0, trials: [], pending: null, createdAt: new Date().toISOString(),
        environment: { userAgent: navigator.userAgent, devicePixelRatio: window.devicePixelRatio,
          screenWidth: screen.width, screenHeight: screen.height, urlProtocol: location.protocol } };
      database.sessions.push(session); persist(); message('');
      $('configFields').disabled = true; showRun(); readyTrial();
    } catch (e) { message(e.message, true); }
  }
  function readyTrial() {
    clearTimers(); current = null; phase = 'ready'; hand = { x: 0, z: 0 };
    $('sessionLabel').textContent = session.phase === 'practice' ? 'PRACTICE · 練習' : 'MAIN · 本番';
    $('progressText').textContent = `${session.nextIndex + 1} / ${session.plan.length}`;
    $('progressBar').max = session.plan.length; $('progressBar').value = session.nextIndex;
    $('runTitle').textContent = '開始位置へ戻してください';
    $('runInstruction').textContent = session.config.input === 'lock'
      ? '図の中をクリックして入力を準備します。次にマウスを机のSへ戻し、左ボタンを押し続けてください。'
      : '図のSを押し続けます。Aを覚え、暗くなったら目を閉じて、合図のあとに動かしてください。';
    $('responses').hidden = true; $('feedback').hidden = true; $('next').hidden = true;
    $('trialOverlay').hidden = true; $('cancelCalibration').hidden = true; $('finish').hidden = false;
    message(''); draw(); canvas.focus({ preventScroll: true });
  }
  function lockOnce(wantRaw) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const timeout = setTimeout(() => done(new Error('入力の準備が完了しませんでした。')), 2500);
      function done(error) {
        if (settled) return; settled = true; clearTimeout(timeout);
        document.removeEventListener('pointerlockchange', changed);
        document.removeEventListener('pointerlockerror', failed);
        if (error) reject(error); else resolve();
      }
      function changed() { if (document.pointerLockElement === canvas) done(); }
      function failed() { done(new Error('この入力方式を開始できませんでした。')); }
      document.addEventListener('pointerlockchange', changed);
      document.addEventListener('pointerlockerror', failed);
      try {
        const result = canvas.requestPointerLock(wantRaw ? { unadjustedMovement: true } : undefined);
        if (result?.then) result.then(changed, done);
      } catch (e) { done(e); }
    });
  }
  async function acquire(calibration) {
    const config = calibration ? calibrationConfig : session.config;
    phase = 'acquiring'; draw();
    const preferRaw = config.reference?.rawRequested ?? true;
    try {
      // Request under the original pointer gesture, before awaiting audio initialization.
      try { await lockOnce(preferRaw); rawRequested = preferRaw; }
      catch (e) {
        if (!preferRaw) throw e;
        await lockOnce(false); rawRequested = false;
      }
      if (phase !== 'acquiring') { unlock(); return; }
      await audio.ready(config.volume);
      if (document.pointerLockElement !== canvas || phase !== 'acquiring') throw new Error('入力の準備が解除されました。');
      phase = calibration ? 'calibration-origin' : 'origin';
      $('runTitle').textContent = 'マウスを机のSへ戻してください';
      $('runInstruction').textContent = calibration
        ? 'Sへ戻したら左ボタンを押し続けてPまで動かし、実物に当たったところで離してください。PはSの前方に置きます。'
        : '開始位置に戻したら、左ボタンを押し続けます。Aが2秒出たあと、暗くなったら目を閉じてください。';
      draw();
    } catch (e) {
      phase = calibration ? 'calibration-ready' : 'ready'; unlock();
      message(`${e.message} 再試行するか、準備で「画面内でドラッグ」を選んでください。`, true); draw();
    }
  }
  function startPreview(e) {
    const config = session.config;
    if (config.input === 'lock' && document.pointerLockElement !== canvas) return;
    pointer = e.pointerId; inputOrigin = { x: e.clientX, y: e.clientY };
    if (config.input !== 'lock') canvas.setPointerCapture(e.pointerId);
    raw = { x: 0, z: 0 }; layout = getLayout();
    mapping = config.input === 'lock' ? config.reference?.pixelsPerUnit || config.mouseScale : layout.scale;
    const rect = canvas.getBoundingClientRect();
    hand = config.input === 'lock' ? { x: 0, z: 0 } : {
      x: (e.clientX - rect.left - layout.ox) / mapping,
      z: (layout.oy - (e.clientY - rect.top)) / mapping
    };
    const planned = session.plan[session.nextIndex];
    current = { ...planned, id: `${session.id}-${planned.index}-${session.trials.length + 1}`,
      status: 'pending', startedAt: new Date().toISOString(), rawRequested: config.input === 'lock' && rawRequested,
      pixelsPerUnit: mapping, canvasWidth: layout.width, canvasHeight: layout.height,
      startPosition: { ...hand }, startDrift: 0, path: [], noticed: null, contact: null };
    session.pending = current; session.audio = audio.info(); phase = 'preview';
    $('runTitle').textContent = 'Aの場所を覚えてください';
    $('runInstruction').textContent = '2秒間、手を止めて場所を覚えます。まだ動かさないでください。';
    $('trialOverlay').hidden = true; audio.stop(); persist(); draw();
    checkpoint = setInterval(() => {
      const last = current?.path.at(-1);
      if (phase === 'reach' && last && (last.x !== hand.x || last.z !== hand.z)) sample(true);
      persist();
    }, 1000);
    delay(() => {
      if (phase !== 'preview') return;
      phase = 'dark'; $('trialOverlay').textContent = '目を閉じてください'; $('trialOverlay').hidden = false;
      $('runTitle').textContent = '目を閉じて合図を待ちます';
      $('runInstruction').textContent = 'ボタンを持ち続けてください。「ピッ」のあとに手を動かします。';
      delay(() => {
        if (phase !== 'dark') return;
        phase = 'cue'; audio.cue();
        delay(startReach, config.cueGapMs);
      }, config.eyeCloseMs);
    }, config.previewMs);
  }
  function startReach() {
    if (phase !== 'cue' || !current) return;
    phase = 'reach'; reachStarted = performance.now(); lastSample = -Infinity;
    $('trialOverlay').textContent = '音を聞いて、手を伸ばす';
    $('runTitle').textContent = 'ここだと思った位置で離してください';
    $('runInstruction').textContent = session.config.task === 'contact'
      ? '目を閉じたまま、実物に当たったらボタンを離します。' : '目を閉じたまま、届いたと思ったらボタンを離します。';
    try { current.audioStart = audio.start(current, hand, session.config.sound); }
    catch (e) { abort('audio_error', `音声の再生に失敗しました：${e.message}`); return; }
    sample(true);
    delay(() => { if (phase === 'reach') abort('timeout', '15秒で中断しました。開始位置へ戻して同じ試行をやり直します。'); }, session.config.timeoutMs);
  }
  function sample(force = false) {
    if (phase !== 'reach' || !current) return;
    const t = performance.now() - reachStarted;
    if (!force && t - lastSample < 16) return;
    const s = C.stimulus(current, hand);
    current.path.push({ t, ...hand, sourceX: s.x, sourceZ: s.z, gain: s.gain, period: s.period, progress: s.progress });
    lastSample = t;
  }
  function movement(dx, dz) {
    if (phase === 'calibrating') {
      raw.x += dx; raw.z += dz;
      hand = { x: raw.x / calibrationConfig.mouseScale, z: raw.z / calibrationConfig.mouseScale }; draw(); return;
    }
    if (!['preview', 'dark', 'cue', 'reach'].includes(phase)) return;
    hand = { x: hand.x + dx / mapping, z: hand.z + dz / mapping };
    if (phase !== 'reach') {
      current.startDrift = Math.max(current.startDrift, C.distance(hand, current.startPosition));
      if (current.startDrift > 0.06) abort('moved_before_cue', '合図の前に手が動いたため中断しました。Aを見ている間は止めて、同じ試行をやり直してください。');
      return;
    }
    if (Math.hypot(hand.x, hand.z) > 4) { abort('out_of_range', '基準距離の4倍を越えたため中断しました。移動量の設定と開始位置を確認してください。'); return; }
    audio.update(hand); sample();
  }
  function finishReach() {
    sample(true); current.endpoint = { ...hand }; current.durationMs = performance.now() - reachStarted;
    current.metrics = C.metrics(current, current.endpoint, current.path);
    current.status = 'awaiting_response'; phase = 'response'; clearTimers(); audio.stop(); unlock(); releaseCapture();
    $('trialOverlay').textContent = '目を開けて回答してください';
    $('runTitle').textContent = '今の感覚を答えてください';
    $('runInstruction').textContent = '位置と音の設定は、回答後まで表示しません。';
    $('responses').hidden = false; $('contactQuestion').hidden = session.config.task !== 'contact';
    document.querySelectorAll('[data-noticed], [data-contact]').forEach(b => b.setAttribute('aria-pressed', 'false'));
    $('saveAnswer').disabled = true; persist();
  }
  function releaseCapture() {
    if (pointer !== null && canvas.hasPointerCapture(pointer)) canvas.releasePointerCapture(pointer);
    pointer = null;
  }
  function abort(reason, text) {
    const calibration = phase.startsWith('calibration') || (!session && !!calibrationConfig);
    clearTimers(); audio.stop();
    // Change phase before releasing capture/lock, whose events may arrive immediately.
    phase = calibration ? 'calibration-ready' : 'ready';
    unlock(); releaseCapture();
    if (current && session) {
      current.status = 'aborted'; current.invalidReason = reason;
      if (!current.endpoint && current.path.length) current.endpoint = { ...hand };
      session.trials.push(current); session.pending = null; current = null; persist();
    }
    if (calibration) { draw(); message(text, true); }
    else { readyTrial(); message(text, true); }
  }
  function setResponse(kind, value) {
    if (phase !== 'response') return;
    current[kind] = value;
    document.querySelectorAll(`[data-${kind}]`).forEach(b => b.setAttribute('aria-pressed', String(b.dataset[kind] === value)));
    $('saveAnswer').disabled = !current.noticed || (session.config.task === 'contact' && !current.contact);
    persist();
  }
  function saveAnswer() {
    if (phase !== 'response' || $('saveAnswer').disabled) return;
    current.status = 'complete'; session.trials.push(current); session.pending = null; session.nextIndex++;
    $('responses').hidden = true; $('progressBar').value = session.nextIndex;
    phase = 'feedback'; persist();
    const practice = session.phase === 'practice';
    if (!practice && session.nextIndex === session.plan.length) { finishSession(true); return; }
    $('runTitle').textContent = '保存しました';
    $('runInstruction').textContent = practice ? '練習だけ答え合わせを表示します。オレンジ=A、緑=P、紺=到達位置です。' : '正解と条件は、本番が終わってから確認できます。';
    $('trialOverlay').hidden = practice;
    if (!practice) $('trialOverlay').textContent = '保存しました';
    $('feedback').hidden = false;
    $('feedback').textContent = practice
      ? `${C.CONDITIONS[current.condition]} ／ ずらし ${current.offsetPct}%\nAとの誤差 ${(current.metrics.errorA * 100).toFixed(1)}% ／ Pとの誤差 ${(current.metrics.errorP * 100).toFixed(1)}%` : `${session.nextIndex} / ${session.plan.length} 試行を保存しました。マウスをSに戻して進めてください。`;
    $('next').textContent = session.nextIndex === session.plan.length ? '練習の結果を見る →' : '開始位置へ戻して次へ →';
    $('next').hidden = false; draw();
  }
  function finishSession(complete = false) {
    if (!session) return;
    if (session.pending) {
      current.status = 'aborted'; current.invalidReason = 'ended_before_response';
      session.trials.push(current); session.pending = null;
    }
    clearTimers(); audio.stop(); phase = 'results'; unlock(); releaseCapture();
    session.status = complete ? 'complete' : 'stopped'; session.endedAt = new Date().toISOString();
    current = null; persist(); $('run').hidden = true; document.body.classList.remove('running');
    $('configFields').disabled = false; $('setup').hidden = true;
    showResults(session); listSaved(); message('');
  }
  function registerP() {
    try {
      const priorTask = $('taskMode').value;
      // Registration is the preparation for contact, so it does not require an existing P.
      $('taskMode').value = 'memory';
      try { calibrationConfig = readConfig(false); } finally { $('taskMode').value = priorTask; }
      calibrationConfig.reference = null;
      if (calibrationConfig.input !== 'lock') throw new Error('Pの登録には、画面端を越えるマウス入力を使います。');
      session = null; current = null; phase = 'calibration-ready'; hand = { x: 0, z: 0 };
      showRun(); $('sessionLabel').textContent = 'REFERENCE · P登録';
      $('progressText').textContent = ''; $('progressBar').value = 0;
      $('runTitle').textContent = '机上の開始位置SとPを決めます';
      $('runInstruction').textContent = 'PをSの前方に置き、図の中をクリックして入力を準備します。次にマウスをSへ戻してください。';
      $('responses').hidden = true; $('feedback').hidden = true; $('next').hidden = true;
      $('trialOverlay').hidden = true; $('finish').hidden = true; $('cancelCalibration').hidden = false;
      message(''); draw();
    } catch (e) { message(e.message, true); }
  }
  function finishCalibration() {
    const length = Math.hypot(raw.x, raw.z);
    phase = 'calibration-ready'; unlock(); releaseCapture();
    if (length < 40 || length > 10000 || raw.z / length < 0.65) {
      message('移動が小さすぎるか、Pが前方から離れすぎています。Sの前方へ十分に動かして登録し直してください。', true); draw(); return;
    }
    reference = { P: { x: raw.x / length, z: raw.z / length }, pixelsPerUnit: length,
      rawVector: { ...raw }, rawRequested, registeredAt: new Date().toISOString() };
    $('mouseScale').value = length.toFixed(1);
    calibrationConfig = null; showSetup();
    message('Pを登録しました。実物と開始位置の印を動かさず、同じ持ち方・当て方で試してください。');
  }
  function getConfigForView() { return phase.startsWith('calibration') || (!session && calibrationConfig) ? calibrationConfig : session?.config; }
  function getLayout() {
    const r = canvas.getBoundingClientRect(), cfg = getConfigForView();
    const P = cfg?.reference?.P || { x: 0, z: 1 };
    const minX = Math.min(-0.65, P.x - 0.65), maxX = Math.max(0.65, P.x + 0.65);
    const minZ = -0.17, maxZ = Math.max(1.55, P.z + 0.55);
    const scale = Math.min((r.width - 56) / (maxX - minX), (r.height - 54) / (maxZ - minZ));
    return { width: r.width, height: r.height, scale,
      ox: r.width / 2 - (minX + maxX) * scale / 2, oy: r.height - 28 + minZ * scale };
  }
  function resize() {
    if ($('run').hidden) return;
    const r = canvas.getBoundingClientRect(), dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(r.width * dpr); canvas.height = Math.round(r.height * dpr);
    context.setTransform(dpr, 0, 0, dpr, 0, 0); layout = getLayout(); draw();
  }
  function draw() {
    if ($('run').hidden) return;
    layout = getLayout(); const g = context, l = layout;
    const point = p => ({ x: l.ox + p.x * l.scale, y: l.oy - p.z * l.scale });
    g.clearRect(0, 0, l.width, l.height); g.fillStyle = '#f7f9f6'; g.fillRect(0, 0, l.width, l.height);
    g.strokeStyle = '#e4ebe5'; g.lineWidth = 1;
    for (let x = -2; x <= 2; x += 0.25) { const p = point({ x, z: 0 }); g.beginPath(); g.moveTo(p.x, 0); g.lineTo(p.x, l.height); g.stroke(); }
    for (let z = 0; z <= 2; z += 0.25) { const p = point({ x: 0, z }); g.beginPath(); g.moveTo(0, p.y); g.lineTo(l.width, p.y); g.stroke(); }
    function mark(p, label, color, square = false) {
      const t = point(p); g.fillStyle = color;
      if (square) g.fillRect(t.x - 8, t.y - 8, 16, 16);
      else { g.beginPath(); g.arc(t.x, t.y, label === 'S' ? 18 : 9, 0, Math.PI * 2); g.fill(); }
      g.font = '600 13px system-ui'; g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillStyle = label === 'S' ? '#fff' : color;
      g.fillText(label, t.x, label === 'S' ? t.y : t.y - 22);
    }
    mark({ x: 0, z: 0 }, 'S', '#233e43');
    if (phase === 'preview' && current) mark(current.A, 'A', '#bf5c2e');
    if (phase === 'feedback' && session?.phase === 'practice' && current) {
      g.strokeStyle = '#8a9d9e'; g.lineWidth = 2; g.beginPath();
      current.path.forEach((p, i) => { const t = point(p); if (i) g.lineTo(t.x, t.y); else g.moveTo(t.x, t.y); }); g.stroke();
      mark(current.A, 'A', '#bf5c2e'); mark(current.P, 'P', '#167567', true); mark(current.endpoint, '到達', '#334b80');
    }
    if (phase === 'calibrating') mark(hand, 'マウス', '#bf5c2e');
    if (['ready', 'origin', 'calibration-ready', 'calibration-origin', 'acquiring'].includes(phase)) {
      const cfg = getConfigForView();
      g.fillStyle = '#536c6b'; g.font = '500 15px system-ui'; g.textAlign = 'center';
      const text = phase === 'acquiring' ? '入力を準備しています…' : phase.endsWith('origin')
        ? '机のSへ戻したら、左ボタンを押し続ける' : cfg?.input === 'lock' ? '図の中をクリックして、入力を準備' : 'Sを押し続けて開始';
      g.fillText(text, l.width / 2, l.height * 0.34);
      g.fillStyle = '#879895'; g.font = '12px system-ui'; g.fillText('上が前・右が右。図は机を上から見たものです。', l.width / 2, 24);
    }
  }
  canvas.addEventListener('pointerdown', e => {
    if (e.button !== 0 || !e.isPrimary) return;
    if (phase === 'calibration-ready') { e.preventDefault(); acquire(true); return; }
    if (phase === 'calibration-origin') {
      e.preventDefault(); phase = 'calibrating'; raw = { x: 0, z: 0 }; hand = { x: 0, z: 0 }; pointer = e.pointerId;
      $('runTitle').textContent = 'Pまで動かして、当たったら離します'; draw(); return;
    }
    if (!['ready', 'origin'].includes(phase) || !session) return;
    const input = session.config.input;
    if ((input === 'touch') !== (e.pointerType === 'touch')) { message(input === 'touch' ? '指でSに触れてください。' : 'マウスで操作してください。', true); return; }
    e.preventDefault();
    if (input === 'lock' && phase === 'ready') { acquire(false); return; }
    if (input !== 'lock') {
      layout = getLayout(); const r = canvas.getBoundingClientRect();
      if (Math.hypot(e.clientX - r.left - layout.ox, e.clientY - r.top - layout.oy) > 28) { message('開始点Sを押し続けてください。', true); return; }
      // The gesture resumes audio; start the memory interval only after it is ready.
      phase = 'acquiring'; pointer = e.pointerId; inputOrigin = { x: e.clientX, y: e.clientY };
      canvas.setPointerCapture(e.pointerId);
      audio.ready(session.config.volume).then(() => {
        if (phase === 'acquiring' && pointer === e.pointerId) { message(''); startPreview(e); }
      }).catch(error => abort('audio_error', error.message));
    } else { message(''); startPreview(e); }
  });
  document.addEventListener('mousemove', e => {
    if (document.pointerLockElement === canvas) movement(e.movementX, -e.movementY);
  });
  canvas.addEventListener('pointermove', e => {
    if (!session || session.config.input === 'lock' || e.pointerId !== pointer) return;
    if (phase === 'acquiring') {
      if (Math.hypot(e.clientX - inputOrigin.x, e.clientY - inputOrigin.y) > getLayout().scale * 0.06) {
        abort('moved_before_cue', '音声の準備中に手が動きました。開始点Sへ戻して押し続けてください。');
      }
      return;
    }
    if (!['preview', 'dark', 'cue', 'reach'].includes(phase)) return;
    const r = canvas.getBoundingClientRect();
    if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) {
      abort('canvas_boundary', '画面の範囲を越えたため中断しました。画面端を越えるマウス入力か、小さい配置で試してください。'); return;
    }
    const dx = e.clientX - inputOrigin.x, dz = inputOrigin.y - e.clientY;
    inputOrigin = { x: e.clientX, y: e.clientY }; movement(dx, dz);
  });
  document.addEventListener('pointerup', e => {
    if (e.button !== 0) return;
    if (phase === 'calibrating') { finishCalibration(); return; }
    if (pointer !== e.pointerId) return;
    if (phase === 'reach') {
      if (session.config.input !== 'lock') {
        const r = canvas.getBoundingClientRect();
        if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) {
          abort('canvas_boundary', '画面外で離したため中断しました。同じ試行をやり直します。'); return;
        }
        // Some devices deliver their final position only on pointerup.
        movement(e.clientX - inputOrigin.x, inputOrigin.y - e.clientY);
      }
      if (phase === 'reach') finishReach();
    }
    else if (['preview', 'dark', 'cue', 'acquiring'].includes(phase)) abort('released_before_cue', '合図より前に離したため中断しました。次は合図のあとまで押し続けてください。');
  });
  canvas.addEventListener('pointercancel', () => { if (busy.has(phase)) abort('pointer_cancelled', '入力が中断されました。同じ試行をやり直します。'); });
  canvas.addEventListener('lostpointercapture', () => {
    if (session?.config.input !== 'lock' && ['preview', 'dark', 'cue', 'reach'].includes(phase)) abort('capture_lost', '入力の追跡が外れました。同じ試行をやり直します。');
  });
  canvas.addEventListener('contextmenu', e => e.preventDefault());
  document.addEventListener('pointerlockchange', () => {
    if (document.pointerLockElement === canvas) return;
    if (['preview', 'dark', 'cue', 'reach', 'calibrating'].includes(phase)) abort('pointer_lock_lost', '入力が解除されました。同じ試行をやり直します。');
    else if (phase === 'origin') readyTrial();
    else if (phase === 'calibration-origin') { phase = 'calibration-ready'; draw(); }
  });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && busy.has(phase)) abort('escape', '中断しました。開始位置へ戻してやり直せます。');
  });
  function interrupt(reason, text) {
    if (busy.has(phase)) abort(reason, text);
    else audio.stop();
  }
  window.addEventListener('blur', () => interrupt('window_blur', '画面のフォーカスが外れたため中断しました。'));
  document.addEventListener('visibilitychange', () => { if (document.hidden) interrupt('page_hidden', '画面が隠れたため中断しました。'); });
  window.addEventListener('resize', () => { if (busy.has(phase)) abort('resized', '画面の大きさが変わったため中断しました。'); resize(); });
  window.addEventListener('pagehide', () => { audio.stop(); persist(); });

  function showResults(s) {
    viewed = s; $('results').hidden = false;
    $('resultBadge').textContent = s.phase === 'practice' ? '練習データ' : s.status === 'complete' ? '本番・完了' : '本番・途中まで';
    const complete = s.trials.filter(t => t.status === 'complete').length, aborted = s.trials.filter(t => t.status === 'aborted').length;
    $('resultSummary').textContent = `有効 ${complete}試行 ／ 中断 ${aborted}試行。${s.config.input === 'touch' ? '画面タッチ' : 'マウス'}・${s.config.task === 'contact' ? '実物接触' : '実物なし'}。${new Date(s.createdAt).toLocaleString('ja-JP')}`;
    const tbody = $('resultRows'); tbody.replaceChildren();
    const pct = n => n === null ? '—' : `${(n * 100).toFixed(1)}%`;
    for (const row of C.summarize(s.trials)) {
      const tr = document.createElement('tr');
      const cells = [C.CONDITIONS[row.condition], `${row.offset}%`, row.n, pct(row.towardP), pct(row.errorA),
        row.noticedRate === null ? '—' : `${Math.round(row.noticedRate * 100)}% (${row.yes}/${row.yes + row.no})`, row.unsure,
        row.durationMs === null ? '—' : `${(row.durationMs / 1000).toFixed(2)}秒`,
        row.contactRate === null ? '—' : `${Math.round(row.contactRate * 100)}% (${row.contactN}件)`];
      for (const text of cells) { const td = document.createElement('td'); td.textContent = String(text); tr.appendChild(td); }
      tbody.appendChild(tr);
    }
    $('results').scrollIntoView({ block: 'start', behavior: 'instant' });
  }
  function listSaved() {
    $('saved').hidden = !database.sessions.length || !$('run').hidden;
    const select = $('savedSessions'), before = select.value; select.replaceChildren();
    for (const s of database.sessions.slice().reverse()) {
      const option = document.createElement('option'); option.value = s.id;
      option.textContent = `${new Date(s.createdAt).toLocaleString('ja-JP')} · ${s.phase === 'practice' ? '練習' : '本番'} ${s.nextIndex}/${s.plan.length}`;
      select.appendChild(option);
    }
    if (database.sessions.some(s => s.id === before)) select.value = before;
    updateResume();
  }
  function selectedSaved() { return database.sessions.find(s => s.id === $('savedSessions').value); }
  function updateResume() { const s = selectedSaved(); $('resumeSaved').disabled = !s || s.nextIndex >= s.plan.length; }
  function resumeSaved() {
    const s = selectedSaved(); if (!s || s.nextIndex >= s.plan.length) return;
    if (s.config.input === 'lock' && !canvas.requestPointerLock) { message('このセッションの入力方式に対応したPCブラウザで再開してください。', true); return; }
    session = s; current = null; session.status = 'in_progress';
    $('configFields').disabled = true; showRun(); readyTrial();
    message('同じ機材・装着・音量と、机上のS・Pの位置で再開してください。'); persist();
  }
  function download(text, name, type) {
    const blob = new Blob([text], { type }), url = URL.createObjectURL(blob), a = document.createElement('a');
    a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 3000);
  }
  function exportCsv(paths = false) {
    if (!viewed) return;
    const rows = paths ? C.pathRows(viewed) : C.trialRows(viewed);
    if (!rows.length) { message('書き出す記録がありません。', true); return; }
    download(C.csv(rows, Object.keys(rows[0])), `audio-pilot-${viewed.id}-${paths ? 'paths' : 'trials'}.csv`, 'text/csv;charset=utf-8');
  }
  $('configForm').addEventListener('submit', e => e.preventDefault());
  $('practice').addEventListener('click', () => begin(true)); $('start').addEventListener('click', () => begin(false));
  $('next').addEventListener('click', () => { if (session.nextIndex === session.plan.length) finishSession(true); else readyTrial(); });
  $('finish').addEventListener('click', () => finishSession(false));
  $('saveAnswer').addEventListener('click', saveAnswer);
  document.querySelectorAll('[data-noticed]').forEach(b => b.addEventListener('click', () => setResponse('noticed', b.dataset.noticed)));
  document.querySelectorAll('[data-contact]').forEach(b => b.addEventListener('click', () => setResponse('contact', b.dataset.contact)));
  $('registerP').addEventListener('click', registerP);
  $('clearP').addEventListener('click', () => { reference = null; syncSetup(); });
  $('cancelCalibration').addEventListener('click', () => { phase = 'setup'; unlock(); releaseCapture(); calibrationConfig = null; showSetup(); });
  $('backSetup').addEventListener('click', () => { $('results').hidden = true; showSetup(); });
  $('testLeft').addEventListener('click', () => audio.channel(-1, Number($('volume').value)).catch(e => message(e.message, true)));
  $('testRight').addEventListener('click', () => audio.channel(1, Number($('volume').value)).catch(e => message(e.message, true)));
  $('configForm').addEventListener('input', syncSetup);
  $('inputMode').addEventListener('change', () => { $('checkedAudio').checked = false; syncSetup(); });
  $('mouseScale').addEventListener('change', () => { if (reference && Math.abs(Number($('mouseScale').value) - reference.pixelsPerUnit) > 0.1) { reference = null; syncSetup(); } });
  $('device').addEventListener('change', () => { $('checkedAudio').checked = false; });
  $('connection').addEventListener('change', () => { $('checkedAudio').checked = false; });
  $('savedSessions').addEventListener('change', updateResume);
  $('viewSaved').addEventListener('click', () => { const s = selectedSaved(); if (s) showResults(s); });
  $('resumeSaved').addEventListener('click', resumeSaved);
  $('exportTrials').addEventListener('click', () => exportCsv(false));
  $('exportPaths').addEventListener('click', () => exportCsv(true));
  $('exportJson').addEventListener('click', () => { if (viewed) download(JSON.stringify(viewed, null, 2), `audio-pilot-${viewed.id}.json`, 'application/json'); });
  syncSetup(); listSaved();
})();
