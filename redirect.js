/* Local-only camera demo. The pure trial engine lives in redirect-core.js. */
(() => {
  'use strict';
  const C = window.RedirectCore, $ = id => document.getElementById(id), audio = new window.RedirectAudio();
  const TEST = ['localhost', '127.0.0.1'].includes(location.hostname) && new URLSearchParams(location.search).get('test') === '1';
  const KEY = TEST ? 'redirect.v2.test' : 'redirect.v2';
  const now = () => performance.now();
  let storageFailed = false, rawRecovery = null;
  function storageWarning(text) { storageFailed = true; $('storageWarning').hidden = false; $('storageWarning').textContent = text; }
  function read(key, fallback) { let value; try { value = localStorage.getItem(key); return value === null ? fallback : JSON.parse(value); } catch { if (key === KEY && typeof value === 'string') rawRecovery = { key, raw: value }; storageWarning('保存記録を読み取れません。新しい記録はメモリに保持します。JSONで書き出してください。'); return fallback; } }
  const freshSetup = () => ({ corners: [], color: null, body: null, S: null, P: null, headBehind: 15, earAbove: 35, tol: 16, cameraId: null });
  let setup = freshSetup(), db = { version: C.VERSION, sessions: [], activeId: null };
  const stored = read(KEY, null);
  if (stored) {
    try {
      if (stored.version !== C.VERSION || !Array.isArray(stored.sessions)) throw Error('version');
      db = stored;
      for (const session of db.sessions) C.Engine.restore(session, now());
      if (stored.setup && Array.isArray(stored.setup.corners) && stored.setup.corners.length <= 4 && stored.setup.corners.every(C.point)) setup = Object.assign(freshSetup(), stored.setup);
      if (!['body', 'S', 'P'].every(k => setup[k] === null || C.point(setup[k])) || (setup.color && !['h', 's', 'v'].every(k => Number.isFinite(setup.color[k])))) setup = freshSetup();
      setup.tol = C.clamp(Number(setup.tol) || 16, 6, 35);
    } catch { rawRecovery = stored; db = { version: C.VERSION, sessions: [], activeId: null }; storageWarning('保存記録の形式が合いません。元の内容は全記録JSONに含めて保護します。'); }
  }
  let engine = null, running = false, paused = false, stream = null, cameraPending = false, cameraGeneration = 0;
  let H = null, inverseH = null, marker = null, rawHand = null, hand = null, sampleAt = -Infinity, videoTime = -1;
  let calibrationSamples = [], trackingReason = 'カメラ未接続', lastRenderState = '', lastSavedAt = 0, lastUiAt = 0, lastProcessedAt = 0;
  let scheduled = new Set(), cueToken = 0, viewport = { w: 0, h: 0 };
  const video = $('video'), cam = $('cam'), camCtx = cam.getContext('2d', { willReadFrequently: true });
  const proc = document.createElement('canvas'), procCtx = proc.getContext('2d', { willReadFrequently: true });
  const map = $('map'), mapCtx = map.getContext('2d');
  const previous = db.sessions.find(s => s.id === db.activeId);
  if (previous) { try { engine = C.Engine.restore(previous, now()); } catch {} }
  function save() {
    if (engine) { const i = db.sessions.findIndex(s => s.id === engine.session.id); if (i < 0) db.sessions.push(engine.session); else db.sessions[i] = engine.session; db.activeId = engine.session.id; }
    db.setup = setup; if (rawRecovery) db.recoveredUnparsedRecord = rawRecovery;
    try { localStorage.setItem(KEY, JSON.stringify(db)); } catch { storageWarning('端末への保存に失敗しました。このページ内の記録は残っています。閉じる前にCSVまたはJSONを書き出してください。'); }
    lastSavedAt = now();
  }
  function notice(text, warning = false) { $('notice').textContent = text; $('notice').classList.toggle('warning', warning); }
  function later(fn, delay) { const timer = setTimeout(() => { scheduled.delete(timer); fn(); }, delay); scheduled.add(timer); return timer; }
  function cancelOutput() { cueToken++; scheduled.forEach(clearTimeout); scheduled.clear(); audio.stop(); try { window.speechSynthesis?.cancel(); } catch {} }
  function invalidate(reason) { cancelOutput(); if (engine?.abort(reason, now())) { save(); render(true); } }
  function buildH() {
    H = inverseH = null;
    if (setup.corners.length !== 4) return;
    try { H = C.solveH(setup.corners, C.PAPER); inverseH = C.solveH(C.PAPER, setup.corners); }
    catch (e) { setup.corners = []; setup.body = setup.S = setup.P = null; notice(e.message, true); }
  }
  function setupStep() {
    if (!stream && !TEST) return 'camera';
    if (!H) return 'corners'; if (!setup.color) return 'color'; if (!setup.body) return 'body'; if (!setup.S) return 'S'; if (!setup.P) return 'P';
    try { C.validateCalibration(setup); } catch { return 'P'; } return null;
  }
  const setupMessages = {
    camera: 'カメラを開始してください。紙とS・Pまで机全体を映します。',
    corners: 'A4の4隅：手前左 → 手前右 → 奥右 → 奥左。現在 ',
    color: '鮮やかな色のシールを、映像の中でクリックしてください。',
    body: '体の中央が接する机の手前の縁をクリックしてください。',
    S: '開始位置Sにシールを置き、0.5秒止めて「Sを登録」。',
    P: '実物Pの位置にシールを置き、0.5秒止めて「Pを登録」。Sから15cm以上・体の右側です。'
  };
  function isStable() { return C.point(hand) && now() - sampleAt < 150 && calibrationSamples.length >= 5 && calibrationSamples.at(-1).t - calibrationSamples[0].t >= 450 && calibrationSamples.every(p => C.dist(p, hand) <= 1); }
  function button(text, fn, { disabled = false, primary = false, id } = {}) { const b = document.createElement('button'); b.type = 'button'; b.textContent = text; b.disabled = disabled; b.className = primary ? 'primary' : ''; if (id) b.id = id; b.onclick = fn; return b; }
  function canStart() { return !setupStep() && $('calibrationCheck').checked && $('audioCheck').checked && audio.context?.state === 'running'; }
  function renderSetup() {
    const step = setupStep(), actions = $('setupActions');
    $('setupBadge').textContent = step ? '準備中' : '登録済み';
    $('setupPrompt').textContent = step ? setupMessages[step] + (step === 'corners' ? `${setup.corners.length} / 4` : '') : `S→P ${C.dist(setup.S, setup.P).toFixed(1)} cm。紙の四隅・手の重なり・実物の位置を確認してください。`;
    if (actions.dataset.step !== String(step)) {
      actions.dataset.step = String(step); actions.replaceChildren();
      if (step === 'corners') actions.append(button('1つ戻す', () => { setup.corners.pop(); buildH(); save(); renderSetup(); }));
      if (step === 'S' || step === 'P') actions.append(button(`${step}を登録`, () => {
        if (!isStable() || running) return;
        setup[step] = { ...hand };
        if (step === 'P') { try { C.validateCalibration(setup); } catch (e) { setup.P = null; notice(e.message, true); return; } }
        calibrationSamples = []; $('calibrationCheck').checked = false; save(); renderSetup(); drawMap();
      }, { id: 'capturePosition', primary: true }));
      if (!step) { actions.append(button('Sだけ登録し直す', () => { setup.S = null; $('calibrationCheck').checked = false; save(); renderSetup(); })); actions.append(button('Pだけ登録し直す', () => { setup.P = null; $('calibrationCheck').checked = false; save(); renderSetup(); })); }
    }
    if ($('capturePosition')) $('capturePosition').disabled = running || !isStable();
    $('camStart').disabled = cameraPending; $('camStart').hidden = !!stream; $('camStop').hidden = !stream;
    const ready = canStart(); $('startSession').disabled = !ready || running;
    $('startSession').textContent = ready ? 'この設定で開始' : step ? '位置の登録を完了してください' : !$('calibrationCheck').checked ? '配置の確認にチェック' : '左右の音を確認してください';
    $('resumeSession').hidden = !engine || engine.state === 'finished' || running;
    $('closeSavedSession').hidden = $('resumeSession').hidden;
    $('resumeSession').disabled = !ready;
  }
  function resetTracking() { marker = rawHand = hand = null; sampleAt = -Infinity; calibrationSamples = []; videoTime = -1; }
  function resetGeometry() { setup.corners = []; setup.body = setup.S = setup.P = null; H = inverseH = null; resetTracking(); $('calibrationCheck').checked = false; save(); renderSetup(); drawMap(); }
  function stopCamera() {
    cameraGeneration++; invalidate('camera_stopped'); stream?.getTracks().forEach(t => t.stop()); stream = null; video.srcObject = null; resetTracking(); trackingReason = 'カメラ停止中'; $('calibrationCheck').checked = false; renderSetup();
  }
  async function startCamera(id = null, change = false) {
    if (running || cameraPending) return;
    cameraPending = true; renderSetup(); const generation = ++cameraGeneration;
    try {
      if (!navigator.mediaDevices?.getUserMedia) throw new Error('カメラにはlocalhostまたはHTTPSで開いてください');
      const next = await navigator.mediaDevices.getUserMedia({ video: { ...(id ? { deviceId: { exact: id } } : {}), width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false });
      if (generation !== cameraGeneration) { next.getTracks().forEach(t => t.stop()); return; }
      stream?.getTracks().forEach(t => t.stop()); stream = next; video.srcObject = next; await video.play();
      const track = next.getVideoTracks()[0], settings = track.getSettings(), actualId = settings.deviceId || null;
      const resolutionChanged = setup.cameraWidth && (setup.cameraWidth !== video.videoWidth || setup.cameraHeight !== video.videoHeight);
      if (change || resolutionChanged || setup.cameraId && actualId && setup.cameraId !== actualId) resetGeometry();
      setup.cameraId = actualId; setup.cameraWidth = video.videoWidth; setup.cameraHeight = video.videoHeight;
      const devices = (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === 'videoinput');
      $('camSel').replaceChildren(...devices.map((d, i) => { const o = new Option(d.label || `カメラ ${i + 1}`, d.deviceId); o.selected = d.deviceId === actualId; return o; })); $('camSel').hidden = devices.length < 2;
      const ratio = video.videoHeight / video.videoWidth || 0.75; cam.width = 640; cam.height = Math.round(640 * ratio); proc.width = 320; proc.height = Math.round(320 * ratio);
      track.onended = () => { if (stream === next) { stream = null; resetTracking(); invalidate('camera_ended'); notice('カメラとの接続が切れました。開始し直して配置を確認してください。', true); renderSetup(); } };
      resetTracking(); $('calibrationCheck').checked = false; notice('カメラ映像は端末内だけで処理します。紙・カメラ・頭の位置を固定してください。'); save();
    } catch (e) { trackingReason = 'カメラを開けません'; notice(e.name === 'NotAllowedError' ? 'カメラの使用が許可されていません。ブラウザのカメラ設定を確認し、もう一度開始してください。' : e.name === 'NotFoundError' ? 'カメラが見つかりません。接続してからもう一度開始してください。' : `カメラを開けません：${e.message}`, true); }
    finally { cameraPending = false; renderSetup(); }
  }
  $('camStart').onclick = () => startCamera(); $('camStop').onclick = stopCamera; $('camSel').onchange = () => startCamera($('camSel').value, true);
  $('resetSetup').onclick = () => { if (!running) { setup.color = null; resetGeometry(); notice('紙の4隅から登録し直してください。'); } };
  cam.onclick = e => {
    if (running || !stream) return;
    const rect = cam.getBoundingClientRect(), p = { x: C.clamp((e.clientX - rect.left) / rect.width, 0, 1), y: C.clamp((e.clientY - rect.top) / rect.height, 0, 1) }, step = setupStep();
    if (step === 'corners') { setup.corners.push(p); buildH(); }
    if (step === 'color') {
      // Read the raw video, not the overlays painted onto the preview.
      const sample = document.createElement('canvas'); sample.width = video.videoWidth; sample.height = video.videoHeight; const ctx = sample.getContext('2d', { willReadFrequently: true }); ctx.drawImage(video, 0, 0);
      const x = C.clamp(Math.round(p.x * sample.width) - 2, 0, sample.width - 5), y = C.clamp(Math.round(p.y * sample.height) - 2, 0, sample.height - 5), pixels = ctx.getImageData(x, y, 5, 5).data;
      let r = 0, g = 0, b = 0; for (let i = 0; i < pixels.length; i += 4) { r += pixels[i]; g += pixels[i + 1]; b += pixels[i + 2]; }
      const color = C.rgb2hsv(r / 25, g / 25, b / 25);
      if (color.s < 0.3 || color.v < 0.2) { notice('白・灰・暗い色は追跡できません。鮮やかな色のシールを選んでください。', true); return; }
      setup.color = color;
    }
    if (step === 'body') setup.body = C.applyH(H, p);
    $('calibrationCheck').checked = false; save(); renderSetup(); drawMap();
  };
  $('tol').value = setup.tol; $('headBehind').value = setup.headBehind; $('earAbove').value = setup.earAbove;
  $('tol').oninput = () => { setup.tol = Number($('tol').value); $('tolValue').textContent = `${setup.tol}°`; resetTracking(); $('calibrationCheck').checked = false; save(); };
  for (const id of ['headBehind', 'earAbove']) $(id).onchange = () => { if (!running) { setup[id] = Number($(id).value); $('calibrationCheck').checked = false; save(); renderSetup(); } };
  for (const id of ['calibrationCheck', 'audioCheck']) $(id).onchange = renderSetup;
  $('volume').oninput = () => { audio.setVolume(Number($('volume').value)); $('volumeValue').textContent = `${Math.round(audio.volume * 100)}%`; $('audioCheck').checked = false; renderSetup(); };
  for (const [id, side] of [['testLeft', -1], ['testRight', 1]]) $(id).onclick = async () => { try { await audio.ensure(Number($('volume').value)); audio.test(side); renderSetup(); } catch (e) { notice(e.message, true); } };

  const conditionHelp = {
    none: '到達中の音なし。位置の記憶と手の感覚だけで伸ばします。',
    'T-c': '覚えた道具Aに音源を固定。一定のパルスで鳴ります。',
    'W-c': '手の進みに合わせ、一定のパルス音源がAからPへ移動。手を戻すと音源も戻ります。',
    'P-s': '手→Pの方向を音で伝え、近づくほど音量と頻度が増えます。Takahara方式そのものの再現ではありません。',
    'P-c': 'Pから一定のパルス。頭から見た実物位置を知らせる発展条件です。',
    'W-s': '手を導く先がAからPへ移る発展条件。音量と頻度も変化します。',
    'T-s': '手をAへ導く対照。AとPが異なる場合、実物へは導きません。'
  };
  $('condition').replaceChildren(...C.CONDITIONS.map(c => new Option(c.name, c.id))); $('condition').value = 'W-c';
  for (const c of C.CONDITIONS.filter(c => c.main)) { const label = document.createElement('label'), input = document.createElement('input'); input.type = 'checkbox'; input.value = c.id; input.name = 'conditions'; input.checked = true; input.disabled = c.id === 'none'; label.append(input, document.createTextNode(c.name + (c.id === 'none' ? '（比較の基準）' : ''))); $('conditionChoices').append(label); }
  function config() { return { kind: $('kind').value, condition: $('condition').value, angle: Number($('angle').value), tool: $('tool').value, conditions: [...document.querySelectorAll('[name=conditions]:checked')].map(e => e.value), angles: [...document.querySelectorAll('[name=angles]:checked')].map(e => Number(e.value)), repeats: Number($('repeats').value), priorKnowledge: $('knowledge').value, equipment: $('equipment').value.trim(), simulated: TEST, volume: audio.volume, headFixed: true, endpoint: 'key_self_report', memoryMs: 5000, timeoutMs: 12000, units: 'cm_planar_estimate' }; }
  function renderConfig() {
    const kind = $('kind').value; $('manualConfig').hidden = kind !== 'demo'; $('pilotConfig').hidden = kind === 'demo'; $('conditionChoices').hidden = kind === 'baseline';
    $('kindHelp').textContent = kind === 'demo' ? '1回ごとに軌跡・A・Pを表示します。まず動作の確認に。' : kind === 'baseline' ? '実物を取り除き、記憶した位置へ伸ばします。各配置の誤差を先に確認します。' : '音なしを含む4条件が基本。配置を角度ごとに覚え、各組の順序をランダム化します。閾値推定用の本実験ではありません。';
    $('conditionHelp').textContent = conditionHelp[$('condition').value];
    try { const plan = C.makePlan(config(), 1); $('trialCount').textContent = `${plan.length}回。赤・青・黄を同数含みます。青はずれ0の対照。12回ごとを目安に休憩してください。`; }
    catch (e) { $('trialCount').textContent = e.message; }
    drawMap();
  }
  $('configFields').onchange = renderConfig;
  function lockSetup(value) { document.querySelectorAll('.setup-panel button,.setup-panel input,.setup-panel select').forEach(el => { el.disabled = value; }); $('configFields').disabled = value; }
  function showParticipant(value) { running = value; document.body.classList.toggle('session-running', value); $('operator').hidden = !value; $('pause').hidden = !value; $('helpOpen').hidden = value; $('resultsOpen').hidden = value && engine?.state !== 'finished'; lockSetup(value); requestAnimationFrame(resize); renderSetup(); }
  $('startSession').onclick = async () => {
    if (!canStart() || running) return;
    try {
      await audio.ensure(Number($('volume').value));
      if (engine && engine.state !== 'finished' && !engine.session.closed) { notice('未完了の記録があります。「前の記録を再開」するか、再開後に「設定に戻る」で終了してください。', true); return; }
      const seed = crypto.getRandomValues(new Uint32Array(1))[0], id = `${TEST ? 'test-' : ''}${new Date().toISOString().replace(/[:.]/g, '-')}-${seed.toString(16)}`;
      engine = new C.Engine(config(), setup, seed, id); engine.session.createdAt = new Date().toISOString(); engine.session.environment = { userAgent: navigator.userAgent, width: innerWidth, height: innerHeight, audio: audio.metadata(), camera: stream?.getVideoTracks()[0]?.getSettings() ?? null, tracking: { width: proc.width, height: proc.height, smoothingMs: 30, freshnessMs: 150, tolerance: setup.tol } };
      engine.enteredAt = now(); paused = false; notice(TEST ? 'テスト入力モード：実際の参加者・手の記録ではありません。' : '目を閉じる前に指示を覚え、合図で伸ばしてください。'); save(); showParticipant(true); render(true);
    } catch (e) { notice(e.message, true); }
  };
  $('resumeSession').onclick = async () => {
    if (!canStart() || !engine || engine.state === 'finished') return;
    if (JSON.stringify(setup) !== JSON.stringify(engine.session.calibration)) { notice('保存時から位置の登録が変わっています。条件の違う記録を混ぜないため、この記録は再開できません。全記録JSONを書き出してください。', true); return; }
    try { await audio.ensure(engine.session.config.volume); $('volume').value = engine.session.config.volume; $('volumeValue').textContent = `${Math.round(audio.volume * 100)}%`; engine.learnedAngle = null; engine.state = 'learn'; engine.enteredAt = now(); paused = false; showParticipant(true); notice('配置を覚え直して再開します。未完了だった試行は中断として保存しています。'); render(true); } catch (e) { notice(e.message, true); }
  };
  $('closeSavedSession').onclick = () => { if (!engine || running) return; engine.close(now()); save(); renderSetup(); notice('未完了の記録を終了しました。結果は消していません。新しい設定で別のセッションを始められます。'); };
  $('operator').onclick = () => { if (!engine) return; engine.close(now()); cancelOutput(); save(); paused = false; showParticipant(false); notice('セッションを終了しました。途中までの記録も書き出せます。'); render(true); };
  $('pause').onclick = () => {
    paused = !paused; cancelOutput(); if (paused) engine?.abort('paused', now()); else if (engine && !engine.active && !['finished', 'learn'].includes(engine.state)) { engine.state = 'interrupted'; engine.message = 'paused'; }
    if (!paused && engine?.state === 'learn') engine.enteredAt = now();
    $('pause').textContent = paused ? '再開' : '一時停止'; save(); render(true);
  };
  function instruct() {
    const id = engine.begin(now()); if (!id) return;
    const token = ++cueToken; save(); render(true);
    let fired = false;
    const done = fallback => {
      if (fired || token !== cueToken || paused || !running || engine.current?.id !== id || engine.state !== 'instruction') return;
      fired = true; try { window.speechSynthesis?.cancel(); } catch {}
      engine.current.speechFallback = fallback;
      if (!engine.delay(id, now())) return;
      // The central cue is identical across all conditions. Movement begins 200ms later.
      audio.cue(); render(true);
      later(() => { if (token !== cueToken) return; if (engine.reach(id, now())) { audio.start(() => engine?.state === 'reach' && !paused && now() - sampleAt <= 150 ? C.sound(engine.current.condition, engine.hand, engine.current.T, engine.current.P, engine.current.S) : null, setup); } save(); render(true); }, 200);
    };
    const voices = window.speechSynthesis?.getVoices() || [], voice = voices.find(v => v.lang.startsWith('ja') && v.localService);
    if (voice && typeof SpeechSynthesisUtterance !== 'undefined') {
      try { const utterance = new SpeechSynthesisUtterance(`${C.TOOLS[engine.current.tool].short}を取って`); utterance.voice = voice; utterance.lang = 'ja-JP'; utterance.rate = 1; utterance.onend = () => done(false); utterance.onerror = () => done(true); window.speechSynthesis.cancel(); window.speechSynthesis.speak(utterance); }
      catch { later(() => done(true), 2200); }
    } else later(() => done(true), 2200);
    later(() => done(true), 4000);
  }
  const invalidText = { tracking_lost: 'シールの追跡が切れました', tracking_jump: '追跡位置が急に飛びました', early_movement: '開始合図より前に手が動きました', premature_stop: '到達前に終了しました', page_reload: 'ページが再読み込みされました', hidden: '画面が非表示になりました', focus_lost: '画面のフォーカスが外れました', viewport_changed: '画面の大きさが変わりました', paused: '一時停止しました', camera_stopped: 'カメラを停止しました', camera_ended: 'カメラが切断されました', audio_suspended: '音声が停止しました', escape: '操作を中断しました', start_not_ready: 'Sの位置を確認できませんでした', session_ended: 'セッションを終了しました' };
  function render(force = false) {
    if (!running || !engine) {
      $('phaseLabel').textContent = '準備'; $('stageOverlay').hidden = false; $('answerForm').hidden = true; $('feedback').hidden = true; $('stage').classList.remove('dark', 'has-map'); $('stageKicker').textContent = 'ONE PROXY / THREE TARGETS';
      $('stageTitle').textContent = '覚えた場所へ、音を頼りに。'; $('stageText').textContent = '赤・青・黄の道具を覚え、見ずに手を伸ばします。音の導き方で、手の行き先は変わるでしょうか。'; $('stageButtons').replaceChildren(); $('timerLabel').textContent = ''; $('sessionProgress').textContent = '準備 → 覚える → 伸ばす → 答える'; return;
    }
    const state = paused ? 'paused' : engine.state, changed = state !== lastRenderState || force; lastRenderState = state;
    const s = engine.session, complete = s.index >= s.plan.length;
    $('sessionProgress').textContent = `${s.index} / ${s.plan.length} 回 保存済み${s.config.simulated ? ' / テスト入力' : ''}`;
    $('stage').classList.toggle('dark', ['ready', 'instruction', 'delay', 'reach'].includes(state));
    $('stage').classList.toggle('has-map', state === 'learn' || state === 'finished' && s.config.kind === 'demo');
    const mapVisible = state === 'learn' || state === 'finished' && s.config.kind === 'demo';
    if (map.hidden === mapVisible) { map.hidden = !mapVisible; requestAnimationFrame(resize); }
    $('stageOverlay').hidden = state === 'answer'; $('answerForm').hidden = state !== 'answer'; $('feedback').hidden = true;
    const sec = engine.enteredAt === null ? 0 : (now() - engine.enteredAt) / 1000;
    const label = { learn: '1 / 覚える', ready: '2 / Sに戻す', instruction: '3 / 指示', delay: '3 / 合図', reach: '4 / 伸ばす', answer: '5 / 答える', saved: '保存済み', interrupted: '中断', finished: '終了', paused: '一時停止' }[state];
    $('phaseLabel').textContent = label; $('timerLabel').textContent = state === 'reach' ? `残り ${Math.max(0, Math.ceil(12 - sec))} 秒` : '';
    let title = '', text = '', kicker = 'LOOK / REMEMBER / REACH';
    if (state === 'learn') { title = '3つの場所を覚えてください'; text = '画面の上は机の奥、下は手前です。\n手を伸ばして触れず、配置だけを見て覚えます。'; }
    if (state === 'ready') { title = 'Sへ戻して、手を止める'; text = engine.atStart ? '準備できました。指示を見てから目を閉じ、合図で伸ばしてください。' : engine.hand ? 'Sの3cm以内で0.5秒止めてください。位置の確認は反対の手で操作します。' : 'シールが見つかりません。カメラの範囲へ手を戻してください。'; }
    if (state === 'instruction') { title = `${C.TOOLS[engine.current.tool].name}を取って`; text = '指示を覚えて、目を閉じてください。合図までSで待ちます。'; }
    if (state === 'delay') { title = '合図'; text = 'そのまま、手を伸ばしてください。'; }
    if (state === 'reach') { title = '音を頼りに、手を伸ばす'; text = s.config.kind === 'baseline' ? '覚えた場所に着いたらSpaceで止めます。' : '最初に実物に触れたらSpace。届かなければF。\n手探りせず、1回の到達で止めます。'; kicker = 'EYES CLOSED / FIRST REACH'; }
    if (state === 'saved') { title = '回答を保存しました'; text = s.index % 12 === 0 ? 'ここで休憩できます。次へ進むときにSへ手を戻してください。' : 'Sへ手を戻してから、次に進みます。'; }
    if (state === 'interrupted') { title = 'この試行をやり直します'; text = `${invalidText[engine.message] || '試行を中断しました'}。\n中断理由は記録し、同じ条件をもう一度行います。`; }
    if (state === 'paused') { title = '一時停止中'; text = '再開ボタンで戻ります。途中だった試行は、同じ条件でやり直します。'; }
    if (state === 'finished') { title = complete ? s.config.kind === 'demo' ? '1回の体験が終わりました' : 'すべての回答を保存しました' : '途中までの記録を保存しました'; text = s.config.kind === 'demo' ? '黒：手の軌跡　紫：導く音の目標位置\nAとPの間の移動は、音なし条件との比較で確かめます。' : complete && !s.final ? '最後に体験全体について回答してください。' : '記録はCSVとJSONで書き出せます。'; }
    $('stageTitle').textContent = title; $('stageText').textContent = text; $('stageKicker').textContent = kicker;
    if (changed) {
      const buttons = $('stageButtons'); buttons.replaceChildren();
      if (state === 'learn') buttons.append(button('配置を覚えた', () => { if (engine.learn(now())) render(true); }, { id: 'learnDone', primary: true }));
      if (state === 'ready') buttons.append(button('指示を聞いて開始', instruct, { id: 'beginTrial', primary: true }));
      if (['saved', 'interrupted'].includes(state)) buttons.append(button(state === 'saved' ? '次へ' : '同じ条件でもう一度', () => { if (engine.next(now())) { save(); render(true); } }, { id: 'nextTrial', primary: true }));
      if (state === 'finished') {
        if (complete && !s.final && s.config.kind !== 'demo') buttons.append(button('最後の質問に答える', openFinal, { primary: true }));
        else buttons.append(button('記録を見る', openResults, { primary: true }));
        buttons.append(button('設定に戻る', () => $('operator').click()));
      }
      if (state === 'answer') {
        cancelOutput(); $('answerForm').reset(); const baseline = s.config.kind === 'baseline', forcedNo = ['miss', 'timeout'].includes(engine.current.endReason);
        $('contactField').hidden = baseline; $('contactField').disabled = baseline || forcedNo;
        document.querySelectorAll('[name=contact]').forEach(input => { input.required = !baseline; input.checked = forcedNo && input.value === 'no'; });
        $('answerForm').querySelector('[name=noticed]').focus({ preventScroll: true });
      }
      if (['saved', 'interrupted', 'finished'].includes(state)) cancelOutput();
    }
    if ($('learnDone')) { $('learnDone').disabled = sec < 5; $('learnDone').textContent = sec < 5 ? `あと ${Math.ceil(5 - sec)} 秒、見て覚える` : '配置を覚えた'; }
    if ($('beginTrial')) $('beginTrial').disabled = !engine.atStart || !stream && !TEST;
    $('resultsOpen').hidden = state !== 'finished';
    if (state === 'finished' && s.config.kind === 'demo' && engine.current?.status === 'complete') {
      const t = engine.current; $('feedback').hidden = false;
      $('feedback').textContent = `${C.CMAP[t.condition].name} / ${C.TOOLS[t.tool].name} / A–P ${t.gap.toFixed(1)} cm。到達点→P ${t.errP.toFixed(1)} cm。${t.pull === null ? 'ずれ0の対照' : `P寄り比 ${Math.round(t.pull * 100)}%（A=0、P=100）`}。接触とずれの回答は別に記録しています。`;
    }
  }
  $('answerForm').onsubmit = e => {
    e.preventDefault(); if (!engine || engine.state !== 'answer') return;
    const form = new FormData($('answerForm')), forcedNo = ['miss', 'timeout'].includes(engine.current.endReason);
    const response = { noticed: form.get('noticed'), confidence: Number(form.get('confidence')), contact: engine.session.config.kind === 'baseline' ? 'not_applicable' : forcedNo ? 'no' : form.get('contact') };
    if (!engine.answer(response, now())) { notice('ずれ・接触・自信度の回答を選んでください。', true); return; }
    cancelOutput(); save(); render(true); if (engine.state === 'finished' && engine.session.config.kind !== 'demo') openFinal();
  };
  document.addEventListener('keydown', e => {
    if (!running || !engine || e.repeat || document.querySelector('dialog[open]')) return;
    if (e.code === 'Escape') { e.preventDefault(); invalidate('escape'); }
    if (/^(INPUT|SELECT|TEXTAREA)$/.test(e.target.tagName)) return;
    if (!paused && engine.state === 'reach' && ['Space', 'KeyF'].includes(e.code)) { e.preventDefault(); engine.end(now(), e.code === 'KeyF' ? 'miss' : 'self_stop'); cancelOutput(); save(); render(true); }
  });
  function openFinal() { $('realCount').value = engine.session.config.priorKnowledge === 'known' ? 'known' : ''; $('finalComment').value = ''; $('finalDialog').showModal(); }
  $('finalForm').onsubmit = e => { e.preventDefault(); if (!engine || !['1', '2', '3', 'unsure', 'known'].includes($('realCount').value)) return; engine.session.final = { realCount: $('realCount').value, comment: $('finalComment').value.trim(), time: new Date().toISOString(), priorKnowledge: engine.session.config.priorKnowledge }; save(); $('finalDialog').close(); render(true); };
  $('finalDialog').addEventListener('cancel', e => { e.preventDefault(); notice('最後の回答を保存すると、記録を表示できます。'); });
  $('helpOpen').onclick = () => $('helpDialog').showModal();
  document.querySelectorAll('[data-close]').forEach(b => b.onclick = () => $(b.dataset.close).close());
  function selectedSession() { return db.sessions.find(s => s.id === $('sessionSelect').value) || null; }
  const percent = (n, d) => d ? `${Math.round(n / d * 100)}% (${n}/${d})` : '—';
  function resultTable() {
    const s = selectedSession(), target = $('resultTable'); target.replaceChildren();
    $('exportTrials').disabled = $('exportPaths').disabled = !s;
    if (!s) { $('resultMeta').textContent = 'まだ記録がありません。'; $('resultNote').textContent = ''; return; }
    const completed = s.attempts.filter(t => t.status === 'complete').length, invalid = s.attempts.filter(t => t.status === 'invalid').length;
    $('resultMeta').textContent = `${s.id} / ${s.config.kind} / 完了 ${completed} / 中断 ${invalid} / 単位：平面校正による推定cm${s.config.simulated ? ' / テスト入力' : ''}`;
    const sealed = s.config.kind !== 'demo' && s.index < s.plan.length && !s.closed;
    $('resultNote').textContent = sealed ? '比較記録の途中は答え合わせを表示しません。書き出したデータの確認は終了後に行ってください。' : '記述集計です。P寄り比は因果効果や検出閾値ではありません。接触と「ずれなし」の同時成立は全完了試行を分母にします。';
    if (sealed) return;
    const table = document.createElement('table'), header = table.createTHead().insertRow();
    for (const name of ['条件', '間隔 / 道具', 'n', 'P誤差 / A誤差', 'P寄り比', '接触申告 / 不明', 'ずれ感あり / 不明', '接触+ずれ感なし', '時間']) { const th = document.createElement('th'); th.textContent = name; header.append(th); }
    const body = table.createTBody();
    for (const g of C.summarize(s)) { const row = body.insertRow(); const values = [C.CMAP[g.condition].name, `${g.angle}° / ${C.TOOLS[g.tool].name}${g.tool === 'M' ? '・ずれ0' : ''}`, g.n, `${g.errP.toFixed(1)} / ${g.errA.toFixed(1)} cm`, g.pull === null ? '—' : `${Math.round(g.pull * 100)}%`, s.config.kind === 'baseline' ? '対象外' : `${percent(g.contactYes, g.contactYes + g.contactNo)} / ${g.contactUnknown}`, `${percent(g.noticedYes, g.noticedYes + g.noticedNo)} / ${g.noticedUnknown}`, s.config.kind === 'baseline' ? '対象外' : percent(g.joint, g.n), `${(g.ms / 1000).toFixed(2)} s`]; for (const value of values) row.insertCell().textContent = value; }
    target.append(table);
  }
  function openResults() { save(); $('sessionSelect').replaceChildren(...[...db.sessions].reverse().map(s => new Option(`${s.createdAt || s.id} / ${s.config.kind}${s.config.simulated ? ' / TEST' : ''}`, s.id))); if (engine) $('sessionSelect').value = engine.session.id; $('exportLegacy').hidden = !read('cam1.history', null); resultTable(); $('resultsDialog').showModal(); }
  $('resultsOpen').onclick = openResults; $('sessionSelect').onchange = resultTable;
  function download(name, data, type) { const blob = new Blob([data], { type }), url = URL.createObjectURL(blob), a = document.createElement('a'); a.href = url; a.download = name; document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000); }
  $('exportJson').onclick = () => { save(); download('auditory-retargeting-all.json', JSON.stringify({ ...db, storageFailed, exportedAt: new Date().toISOString() }, null, 2), 'application/json'); };
  $('exportLegacy').onclick = () => download('auditory-retargeting-legacy.json', JSON.stringify({ history: read('cam1.history', []), setup: read('cam1.setup', null), plan: read('cam1.plan', null), settings: read('cam1.set', null) }, null, 2), 'application/json');
  $('exportTrials').onclick = () => {
    const s = selectedSession(); if (!s) return;
    const rows = s.attempts.map(t => ({ version: s.version, session: s.id, kind: s.config.kind, simulated: s.config.simulated, prior_knowledge: s.config.priorKnowledge, seed: s.seed, trial: t.index, attempt: t.id, status: t.status, invalid_reason: t.invalidReason, condition: t.condition, angle_deg: t.angle, tool: t.tool, signed_angle_deg: C.TOOLS[t.tool].side * t.angle, gap_cm: C.dist(t.T, t.P), A_x: t.T.x, A_y: t.T.y, P_x: t.P.x, P_y: t.P.y, S_x: t.S.x, S_y: t.S.y, E_x: t.E?.x, E_y: t.E?.y, err_A_cm: t.errA, err_P_cm: t.errP, pull_ratio: t.pull, toward_P_cm: t.towardP, perpendicular_cm: t.perpendicular, endpoint_near_P_3cm: t.nearP, contact_self_report: t.contact, noticed: t.noticed, confidence: t.confidence, duration_ms: t.ms, end_reason: t.endReason, speech_fallback: t.speechFallback, volume: s.config.volume, equipment: s.config.equipment, created_at: s.createdAt }));
    const cols = rows.length ? Object.keys(rows[0]) : ['session', 'trial', 'status']; download(`${s.id}-trials.csv`, C.csv(rows, cols), 'text/csv;charset=utf-8');
  };
  $('exportPaths').onclick = () => {
    const s = selectedSession(); if (!s) return; const rows = s.attempts.flatMap(t => t.path.map(p => ({ session: s.id, attempt: t.id, status: t.status, t_ms: p.t, x_cm: p.x, y_cm: p.y, raw_x_cm: p.rawX, raw_y_cm: p.rawY, sample_age_ms: p.sampleAgeMs, source_x_cm: p.audio?.source.x, source_y_cm: p.audio?.source.y, source_frame: p.audio?.frame, target_x_cm: p.audio?.target?.x ?? (p.audio?.frame === 'head' ? p.audio.source.x : null), target_y_cm: p.audio?.target?.y ?? (p.audio?.frame === 'head' ? p.audio.source.y : null), q: p.audio?.q, gain: p.audio?.gain, interval_s: p.audio?.interval }))); download(`${s.id}-paths.csv`, C.csv(rows, ['session', 'attempt', 'status', 't_ms', 'x_cm', 'y_cm', 'raw_x_cm', 'raw_y_cm', 'sample_age_ms', 'source_x_cm', 'source_y_cm', 'source_frame', 'target_x_cm', 'target_y_cm', 'q', 'gain', 'interval_s']), 'text/csv;charset=utf-8');
  };

  function resize() { const rect = map.getBoundingClientRect(), dpr = Math.min(devicePixelRatio || 1, 2); map.width = Math.round(rect.width * dpr); map.height = Math.round(rect.height * dpr); mapCtx.setTransform(dpr, 0, 0, dpr, 0, 0); viewport = { w: innerWidth, h: innerHeight }; drawMap(); }
  new ResizeObserver(resize).observe($('stage'));
  window.addEventListener('resize', () => { if (running && (Math.abs(innerWidth - viewport.w) > 2 || Math.abs(innerHeight - viewport.h) > 2)) invalidate('viewport_changed'); resize(); });
  window.addEventListener('blur', () => { if (running) invalidate('focus_lost'); });
  document.addEventListener('visibilitychange', () => { if (document.hidden) { if (running) invalidate('hidden'); else cancelOutput(); save(); } });
  window.addEventListener('pagehide', () => { cancelOutput(); save(); stream?.getTracks().forEach(t => t.stop()); });
  function drawMap() {
    const g = mapCtx, W = map.clientWidth, height = map.clientHeight;
    g.clearRect(0, 0, W, height);
    const state = engine?.state, display = running ? state === 'learn' || state === 'finished' && engine.session.config.kind === 'demo' : false;
    map.hidden = !display; if (!display || !setup.P || !setup.S || !setup.body || paused) return;
    let geom; try { geom = C.geometry(setup, engine.spec?.angle ?? engine.current?.angle ?? 20); } catch { return; }
    const pts = [geom.S, geom.P, geom.A, geom.B, geom.head], t = state === 'finished' ? engine.current : null;
    if (t) pts.push(...t.path); const minX = Math.min(...pts.map(p => p.x)) - 8, maxX = Math.max(...pts.map(p => p.x)) + 8, minY = Math.min(...pts.map(p => p.y)) - 8, maxY = Math.max(...pts.map(p => p.y)) + 8;
    const top = 180, bottom = t ? 185 : 95, available = Math.max(100, height - top - bottom), scale = Math.min((W - 70) / (maxX - minX), available / (maxY - minY)), ox = (W - (maxX - minX) * scale) / 2;
    const pt = p => ({ x: ox + (p.x - minX) * scale, y: top + available - (p.y - minY) * scale });
    g.strokeStyle = '#e7ece5'; g.lineWidth = 1; g.font = '11px system-ui';
    for (let x = Math.ceil(minX / 10) * 10; x <= maxX; x += 10) { const a = pt({ x, y: minY }), b = pt({ x, y: maxY }); g.beginPath(); g.moveTo(a.x, a.y); g.lineTo(b.x, b.y); g.stroke(); }
    for (let y = Math.ceil(minY / 10) * 10; y <= maxY; y += 10) { const a = pt({ x: minX, y }), b = pt({ x: maxX, y }); g.beginPath(); g.moveTo(a.x, a.y); g.lineTo(b.x, b.y); g.stroke(); }
    const dot = (p, color, radius, label, offset = 20, dx = 0) => { const a = pt(p); g.fillStyle = color; g.beginPath(); g.arc(a.x, a.y, radius, 0, Math.PI * 2); g.fill(); g.textAlign = 'center'; g.font = '600 12px system-ui'; g.fillText(label, a.x + dx, a.y + offset); };
    dot(geom.head, '#839588', 8, '頭・正面は上'); dot(geom.S, '#293d33', 5, 'S');
    for (const [id, tool] of Object.entries(C.TOOLS)) dot(geom[id], tool.color, 9, tool.name, id === 'M' ? -16 : 24);
    if (t) {
      const line = (ps, color, dash) => { if (!ps.length) return; g.strokeStyle = color; g.lineWidth = 2.5; g.setLineDash(dash); g.beginPath(); ps.forEach((p, i) => { const a = pt(p); if (i) g.lineTo(a.x, a.y); else g.moveTo(a.x, a.y); }); g.stroke(); g.setLineDash([]); };
      line(t.path.map(p => p.audio?.target || (p.audio?.frame === 'head' ? p.audio.source : null)).filter(C.point), '#8b58ac', [5, 4]); line(t.path, '#21372c', []);
      dot(t.P, '#1b806b', 5, '実物P', 38); dot(t.E, '#151f1a', 4, '到達', 4, 38);
    }
    g.fillStyle = '#6c8172'; g.font = '10px system-ui'; g.textAlign = 'left'; g.fillText('10cm方眼・平面校正による模式図', 18, height - 60);
  }
  function drawCamera() {
    if (running) return;
    const W = cam.width, h = cam.height, g = camCtx;
    g.fillStyle = '#192724'; g.fillRect(0, 0, W, h);
    if (!stream || video.readyState < 2) { g.fillStyle = '#bdcfc3'; g.font = '20px system-ui'; g.textAlign = 'center'; g.fillText('机を真上から映します', W / 2, h / 2); return; }
    g.drawImage(video, 0, 0, W, h);
    g.strokeStyle = '#ffe16f'; g.lineWidth = 3; g.beginPath(); setup.corners.forEach((p, i) => { if (i) g.lineTo(p.x * W, p.y * h); else g.moveTo(p.x * W, p.y * h); }); if (setup.corners.length === 4) g.closePath(); g.stroke();
    setup.corners.forEach((p, i) => { g.fillStyle = '#ffe16f'; g.font = 'bold 20px system-ui'; g.textAlign = 'left'; g.fillText(String(i + 1), p.x * W + 8, p.y * h - 8); });
    if (inverseH) for (const [key, label] of [['body', '体'], ['S', 'S'], ['P', 'P']]) if (setup[key]) { const p = C.applyH(inverseH, setup[key]); if (!p) continue; g.strokeStyle = key === 'P' ? '#30e3aa' : '#fff'; g.beginPath(); g.arc(p.x * W, p.y * h, 12, 0, 7); g.stroke(); g.fillStyle = g.strokeStyle; g.font = 'bold 20px system-ui'; g.fillText(label, p.x * W + 15, p.y * h); }
    if (marker) { g.strokeStyle = '#33e8ec'; g.lineWidth = 3; g.beginPath(); g.arc(marker.x * W, marker.y * h, 14, 0, 7); g.stroke(); }
  }
  function acceptSample(raw, timestamp) {
    if (!C.point(raw)) { hand = rawHand = marker = null; sampleAt = -Infinity; calibrationSamples = []; return; }
    const dt = timestamp - sampleAt, alpha = Number.isFinite(dt) ? 1 - Math.exp(-Math.max(dt, 1) / 30) : 1;
    hand = hand ? C.mix(hand, raw, alpha) : { ...raw }; rawHand = raw; sampleAt = timestamp;
    calibrationSamples.push({ ...hand, t: timestamp }); while (calibrationSamples.length && timestamp - calibrationSamples[0].t > 550) calibrationSamples.shift();
  }
  function loop(timestamp) {
    if (stream && video.readyState >= 2 && video.currentTime !== videoTime && timestamp - lastProcessedAt >= 25) {
      videoTime = video.currentTime; lastProcessedAt = timestamp;
      if (setup.color && H) {
        procCtx.drawImage(video, 0, 0, proc.width, proc.height);
        const result = C.findMarker(procCtx.getImageData(0, 0, proc.width, proc.height).data, proc.width, proc.height, setup.color, setup.tol);
        marker = result.point; trackingReason = result.reason; acceptSample(marker ? C.applyH(H, marker) : null, timestamp);
      }
    }
    if (timestamp - sampleAt > 150) { hand = null; calibrationSamples = []; if (Number.isFinite(sampleAt) && stream) trackingReason = '映像の更新が止まっています'; }
    if (running && engine && !paused) {
      const previousState = engine.state; engine.update(hand, timestamp, sampleAt, rawHand);
      if (previousState !== engine.state) { if (engine.state !== 'reach') cancelOutput(); save(); render(true); }
      if (engine.active && audio.context?.state !== 'running') invalidate('audio_suspended');
      if (timestamp - lastSavedAt > 1000 && engine.state === 'reach') save();
    }
    if (timestamp - lastUiAt > 100) {
      lastUiAt = timestamp; $('trackSt').textContent = hand ? '● 追跡中' : trackingReason;
      $('trackingHint').textContent = running && ['instruction', 'delay', 'reach', 'answer'].includes(engine?.state) ? '試行中の位置情報は非表示' : hand ? `追跡中${TEST ? '・テスト入力' : ''}` : 'シールが見えないときは、位置を確認してください。';
      renderSetup(); render(); drawCamera(); drawMap();
    }
    requestAnimationFrame(loop);
  }
  if (TEST) {
    notice('テスト入力モード：実際の参加者・手の記録ではありません。', true);
    window.__redirectTest = {
      get engine() { return engine; }, get db() { return db; }, get setup() { return setup; }, get hand() { return hand; },
      setSetup(su) { setup = Object.assign(freshSetup(), su); buildH(); save(); renderSetup(); },
      feed(p, timestamp = now()) { acceptSample(p, timestamp); if (running && engine) engine.update(hand, timestamp, timestamp, rawHand); renderSetup(); render(); },
      render: () => render(true), save, sound: audio, isStable,
      startReach() { if (!engine) return; const id = engine.current?.id; cancelOutput(); engine.delay(id, now()); engine.reach(id, now()); render(true); }
    };
  }
  buildH(); renderConfig(); renderSetup(); resize(); render(); requestAnimationFrame(loop);
  if (engine) save();
})();
