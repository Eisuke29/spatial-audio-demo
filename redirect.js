/* Camera-first, one-viewport UI. Trial math and persistence format remain v2. */
(() => {
  'use strict';
  const C = window.RedirectCore, $ = id => document.getElementById(id), audio = new window.RedirectAudio();
  const UI_VERSION = '2.1.0';
  const TARGETS = { A: { letter: 'A', spoken: 'エー' }, M: { letter: 'B', spoken: 'ビー' }, B: { letter: 'C', spoken: 'シー' } };
  const CONDITION_NAMES = { none: '音なし', 'T-c': '道具に固定', 'W-c': '道具から実物へ', 'P-s': '実物へ誘導', 'P-c': '実物に固定（発展）', 'W-s': '移動＋誘導（発展）', 'T-s': '道具へ誘導（対照）' };
  const TEST = ['localhost', '127.0.0.1'].includes(location.hostname) && new URLSearchParams(location.search).get('test') === '1';
  const KEY = TEST ? 'redirect.v2.test' : 'redirect.v2', now = () => performance.now();
  let storageFailed = false, rawRecovery = null;
  function storageWarning(text) { storageFailed = true; $('storageWarning').hidden = false; $('storageWarning').textContent = text; }
  function read(key, fallback) { let value; try { value = localStorage.getItem(key); return value === null ? fallback : JSON.parse(value); } catch { if (key === KEY && typeof value === 'string') rawRecovery = { key, raw: value }; storageWarning('保存データを読めません。記録からJSONを書き出してください。'); return fallback; } }
  const freshSetup = () => ({ corners: [], color: null, body: null, S: null, P: null, headBehind: 15, earAbove: 35, tol: 16, cameraId: null });
  let setup = freshSetup(), db = { version: C.VERSION, sessions: [], activeId: null };
  const stored = read(KEY, null);
  if (stored) {
    try {
      if (stored.version !== C.VERSION || !Array.isArray(stored.sessions)) throw Error('version');
      for (const session of stored.sessions) C.Engine.restore(session, now());
      db = stored;
      if (stored.setup && Array.isArray(stored.setup.corners) && stored.setup.corners.length <= 4 && stored.setup.corners.every(C.point)) setup = Object.assign(freshSetup(), stored.setup);
      if (!['body', 'S', 'P'].every(k => setup[k] === null || C.point(setup[k])) || setup.color && !['h', 's', 'v'].every(k => Number.isFinite(setup.color[k]))) setup = freshSetup();
      setup.tol = C.clamp(Number(setup.tol) || 16, 6, 35);
    } catch { rawRecovery = stored; db = { version: C.VERSION, sessions: [], activeId: null }; storageWarning('保存形式を確認できません。元の内容はJSONに残します。'); }
  }
  let engine = null, running = false, paused = false, stream = null, cameraPending = false, cameraGeneration = 0, testInput = false;
  let H = null, inverseH = null, marker = null, hand = null, rawHand = null, sampleAt = -Infinity, videoTime = -1;
  let calibrationSamples = [], trackingReason = 'カメラ未接続', lastUiAt = 0, lastSavedAt = 0, lastProcessedAt = 0, lastRenderState = '';
  let scheduled = new Set(), cueToken = 0, testedSides = new Set(), viewport = { w: innerWidth, h: innerHeight }, keyboardPoint = null;
  const video = $('video'), cam = $('cam'), camCtx = cam.getContext('2d', { willReadFrequently: true });
  const proc = document.createElement('canvas'), procCtx = proc.getContext('2d', { willReadFrequently: true });
  const surface = $('visualSurface'), cameraView = $('cameraView'), svg = $('objectOverlay'), NS = 'http://www.w3.org/2000/svg';
  const conditionsPanel = $('conditionsPanel');
  const previous = db.sessions.find(s => s.id === db.activeId);
  if (previous) { try { engine = C.Engine.restore(previous, now()); } catch {} }

  function save() {
    if (engine) { const i = db.sessions.findIndex(s => s.id === engine.session.id); if (i < 0) db.sessions.push(engine.session); else db.sessions[i] = engine.session; db.activeId = engine.session.id; }
    db.setup = setup; if (rawRecovery) db.recoveredUnparsedRecord = rawRecovery;
    try { localStorage.setItem(KEY, JSON.stringify(db)); } catch { storageWarning('保存できません。ページを閉じる前に「記録」から書き出してください。'); }
    lastSavedAt = now();
  }
  function notice(text, warning = false) { $('notice').textContent = text; $('notice').classList.toggle('warning', warning); }
  function later(fn, delay) { const timer = setTimeout(() => { scheduled.delete(timer); fn(); }, delay); scheduled.add(timer); return timer; }
  function cancelOutput() { cueToken++; scheduled.forEach(clearTimeout); scheduled.clear(); audio.stop(); try { window.speechSynthesis?.cancel(); } catch {} }
  function invalidate(reason) { cancelOutput(); if (engine?.abort(reason, now())) { save(); render(true); } }
  function button(text, fn, { disabled = false, primary = false, id } = {}) { const b = document.createElement('button'); b.type = 'button'; b.textContent = text; b.disabled = disabled; b.className = primary ? 'primary' : 'subtle'; if (id) b.id = id; b.onclick = fn; return b; }
  function buildH() {
    H = inverseH = null;
    if (setup.corners.length !== 4) return;
    try { H = C.solveH(setup.corners, C.PAPER); inverseH = C.solveH(C.PAPER, setup.corners); }
    catch (e) { setup.corners = []; setup.body = setup.S = setup.P = null; notice(e.message, true); }
  }
  function setupStep() {
    if (!stream && !(TEST && testInput)) return 'camera';
    if (!H) return 'corners'; if (!setup.color) return 'color'; if (!setup.body) return 'body'; if (!setup.S) return 'S'; if (!setup.P) return 'P';
    try { C.validateCalibration(setup); } catch { return 'P'; } return null;
  }
  const SETUP_ORDER = ['camera', 'corners', 'color', 'body', 'S', 'P', 'verify', 'audio'];
  function setupPhase() { return setupStep() || (!$('calibrationCheck').checked ? 'verify' : !$('audioCheck').checked || audio.context?.state !== 'running' ? 'audio' : 'ready'); }
  function isStable() { return C.point(hand) && now() - sampleAt < 150 && calibrationSamples.length >= 5 && calibrationSamples.at(-1).t - calibrationSamples[0].t >= 450 && calibrationSamples.every(p => C.dist(p, hand) <= 1); }
  function canStart() { return setupPhase() === 'ready'; }
  function activeAngle() { if (running && engine) return engine.spec?.angle ?? engine.current?.angle ?? 20; return $('kind').value === 'demo' ? Number($('angle').value) : Math.max(0, ...[...document.querySelectorAll('[name=angles]:checked')].map(e => Number(e.value))) || 20; }
  function project(p) { if (!inverseH || !C.point(p)) return null; const image = C.applyH(inverseH, p); return image ? { x: image.x * cam.width, y: image.y * cam.height } : null; }
  function circlePoints(p, radius) { return Array.from({ length: 32 }, (_, i) => project({ x: p.x + radius * Math.cos(i / 32 * Math.PI * 2), y: p.y + radius * Math.sin(i / 32 * Math.PI * 2) })); }
  function objectRadius() {
    if (running && engine?.session.config.targetRadiusCm) return engine.session.config.targetRadiusCm;
    const cfg = running && engine ? engine.session.config : null;
    const angles = cfg ? cfg.kind === 'demo' ? [cfg.angle] : cfg.angles : $('kind').value === 'demo' ? [Number($('angle').value)] : [...document.querySelectorAll('[name=angles]:checked')].map(e => Number(e.value));
    const smallest = Math.min(...angles.filter(a => a > 0));
    // One size for every block in the session; never make object size an angle cue.
    return setup.P && setup.body && Number.isFinite(smallest) ? Math.min(3, .8 * C.dist(setup.P, C.head(setup)) * Math.sin(smallest * Math.PI / 360)) : 3;
  }
  function objectsInFrame() {
    if (!inverseH || setupStep()) return false;
    const angles = $('kind').value === 'demo' ? [Number($('angle').value)] : [...document.querySelectorAll('[name=angles]:checked')].map(e => Number(e.value));
    if (!angles.length) return false;
    try { return angles.every(a => { const g = C.geometry(setup, a); return ['A', 'M', 'B'].every(id => circlePoints(g[id], objectRadius()).every(p => p && p.x >= 4 && p.y >= 4 && p.x <= cam.width - 4 && p.y <= cam.height - 4)); }); } catch { return false; }
  }
  function backSetup() {
    if (running) return;
    const phase = setupPhase();
    if (phase === 'corners') setup.corners.pop();
    else if (phase === 'color') { setup.corners.pop(); setup.color = null; }
    else if (phase === 'body') setup.color = null;
    else if (phase === 'S') setup.body = null;
    else if (phase === 'P') setup.S = null;
    else if (phase === 'verify') setup.P = null;
    else if (phase === 'audio' || phase === 'ready') $('calibrationCheck').checked = false;
    if (!setup.body) setup.S = setup.P = null;
    if (!setup.S) setup.P = null;
    $('calibrationCheck').checked = false; $('audioCheck').checked = false; testedSides.clear();
    buildH(); calibrationSamples = []; save(); render(true);
  }
  function renderSetup() {
    $('setupControls').hidden = running; $('stageButtons').hidden = !running;
    if (running) return;
    const phase = setupPhase(), actions = $('setupActions'), index = SETUP_ORDER.indexOf(phase), ready = phase === 'ready';
    $('setupBadge').textContent = ready ? '完了' : `${Math.max(0, index)} / 8`;
    $('setupList').querySelectorAll('li').forEach((li, i) => { li.dataset.number = i + 1; li.className = ready || i < index ? 'done' : i === index ? 'now' : ''; if (i === index) li.setAttribute('aria-current', 'step'); else li.removeAttribute('aria-current'); });
    $('paperGuide').hidden = phase !== 'corners'; $('paperGuide').querySelectorAll('[data-corner]').forEach(n => { n.className = Number(n.dataset.corner) < setup.corners.length ? 'done' : Number(n.dataset.corner) === setup.corners.length ? 'now' : ''; });
    $('camStart').hidden = phase !== 'camera'; $('camStart').disabled = cameraPending; $('camStart').textContent = cameraPending ? '接続中…' : 'カメラを開始';
    $('camStop').hidden = !stream; $('audioControls').hidden = phase !== 'audio';
    $('testLeft').setAttribute('aria-pressed', String(testedSides.has(-1))); $('testRight').setAttribute('aria-pressed', String(testedSides.has(1)));
    if (actions.dataset.phase !== phase) {
      actions.dataset.phase = phase; actions.replaceChildren();
      if (phase !== 'camera' && !ready) actions.append(button('1つ戻る', backSetup, { id: 'setupBack', disabled: phase === 'corners' && !setup.corners.length }));
      if (phase === 'S' || phase === 'P') actions.append(button(`${phase}を登録`, () => {
        if (!isStable() || running) return;
        setup[phase] = { ...hand };
        if (phase === 'P') { try { C.validateCalibration(setup); } catch (e) { setup.P = null; notice(e.message, true); return; } }
        calibrationSamples = []; $('calibrationCheck').checked = false; notice(''); save(); render(true);
      }, { id: 'capturePosition', primary: true }));
      if (phase === 'verify') actions.append(button('配置を確認した', () => { if (!objectsInFrame()) return; $('calibrationCheck').checked = true; notice(''); render(true); }, { id: 'verifySetup', primary: true }));
      if (phase === 'audio') actions.append(button('左右とも聞こえた', () => { if (testedSides.size !== 2) return; $('audioCheck').checked = true; audio.stop(); render(true); }, { id: 'confirmAudio', primary: true }));
    }
    if ($('setupBack')) $('setupBack').disabled = phase === 'corners' && !setup.corners.length;
    if ($('capturePosition')) $('capturePosition').disabled = !isStable();
    if ($('verifySetup')) $('verifySetup').disabled = !objectsInFrame();
    if ($('confirmAudio')) $('confirmAudio').disabled = testedSides.size !== 2 || audio.context?.state !== 'running';
    const unfinished = engine && engine.state !== 'finished' && !engine.session.closed;
    $('startSession').hidden = !ready || !!unfinished; $('startSession').disabled = !canStart(); $('startSession').textContent = '配置を覚える';
    $('resumeSession').hidden = !ready || !unfinished; $('resumeSession').disabled = !canStart(); $('closeSavedSession').hidden = !unfinished;
    $('configFields').disabled = !!unfinished;
    cam.classList.toggle('picking', ['corners', 'color', 'body'].includes(phase));
    cam.tabIndex = ['corners', 'color', 'body'].includes(phase) ? 0 : -1;
  }
  function resetTracking() { marker = rawHand = hand = null; sampleAt = -Infinity; calibrationSamples = []; videoTime = -1; }
  function resetGeometry() { setup.corners = []; setup.body = setup.S = setup.P = null; H = inverseH = null; resetTracking(); $('calibrationCheck').checked = false; $('audioCheck').checked = false; testedSides.clear(); keyboardPoint = null; save(); render(true); }
  function stopCamera() { cameraGeneration++; invalidate('camera_stopped'); stream?.getTracks().forEach(t => t.stop()); stream = null; video.srcObject = null; resetTracking(); trackingReason = 'カメラ停止中'; $('calibrationCheck').checked = false; render(true); }
  async function startCamera(id = null, change = false) {
    if (running || cameraPending) return;
    cameraPending = true; renderSetup(); const generation = ++cameraGeneration;
    try {
      if (!navigator.mediaDevices?.getUserMedia) throw new Error('HTTPSまたはlocalhostで開いてください');
      const next = await navigator.mediaDevices.getUserMedia({ video: { ...(id ? { deviceId: { exact: id } } : {}), width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false });
      if (generation !== cameraGeneration) { next.getTracks().forEach(t => t.stop()); return; }
      stream?.getTracks().forEach(t => t.stop()); stream = next; video.srcObject = next; await video.play();
      const track = next.getVideoTracks()[0], settings = track.getSettings(), actualId = settings.deviceId || null;
      const resolutionChanged = setup.cameraWidth && (setup.cameraWidth !== video.videoWidth || setup.cameraHeight !== video.videoHeight);
      if (change || resolutionChanged || setup.cameraId && actualId && setup.cameraId !== actualId) resetGeometry();
      setup.cameraId = actualId; setup.cameraWidth = video.videoWidth; setup.cameraHeight = video.videoHeight;
      const devices = (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === 'videoinput');
      $('camSel').replaceChildren(...devices.map((d, i) => { const o = new Option(d.label || `カメラ ${i + 1}`, d.deviceId); o.selected = d.deviceId === actualId; return o; })); $('camSel').hidden = devices.length < 2;
      const ratio = video.videoHeight / video.videoWidth || .75; cam.width = 640; cam.height = Math.round(640 * ratio); proc.width = 320; proc.height = Math.round(320 * ratio);
      track.onended = () => { if (stream === next) { stream = null; resetTracking(); invalidate('camera_ended'); notice('カメラが切れました。接続して開始し直してください。', true); render(true); } };
      resetTracking(); $('calibrationCheck').checked = false; $('audioCheck').checked = false; testedSides.clear(); notice(''); save(); resize();
    } catch (e) { trackingReason = 'カメラを開けません'; notice(e.name === 'NotAllowedError' ? 'カメラの使用が許可されていません。ブラウザで許可して開始し直してください。' : e.name === 'NotFoundError' ? 'カメラを接続して、開始し直してください。' : `カメラを開けません：${e.message}`, true); }
    finally { cameraPending = false; render(true); }
  }
  function selectCameraPoint(p) {
    if (running || !stream) return;
    const phase = setupStep();
    if (phase === 'corners') { setup.corners.push(p); buildH(); }
    if (phase === 'color') {
      const sample = document.createElement('canvas'); sample.width = video.videoWidth; sample.height = video.videoHeight; const ctx = sample.getContext('2d', { willReadFrequently: true }); ctx.drawImage(video, 0, 0);
      const x = C.clamp(Math.round(p.x * sample.width) - 2, 0, sample.width - 5), y = C.clamp(Math.round(p.y * sample.height) - 2, 0, sample.height - 5), pixels = ctx.getImageData(x, y, 5, 5).data;
      let r = 0, g = 0, b = 0; for (let i = 0; i < pixels.length; i += 4) { r += pixels[i]; g += pixels[i + 1]; b += pixels[i + 2]; }
      const color = C.rgb2hsv(r / 25, g / 25, b / 25);
      if (color.s < .3 || color.v < .2) { notice('白・灰・暗い色は追跡できません。鮮やかなシールを選んでください。', true); return; }
      setup.color = color;
    }
    if (phase === 'body') setup.body = C.applyH(H, p);
    $('calibrationCheck').checked = false; notice(''); save(); render(true);
  }
  cam.onclick = e => { const r = cam.getBoundingClientRect(); keyboardPoint = null; selectCameraPoint({ x: C.clamp((e.clientX - r.left) / r.width, 0, 1), y: C.clamp((e.clientY - r.top) / r.height, 0, 1) }); };
  cam.onkeydown = e => {
    if (running || !['corners', 'color', 'body'].includes(setupPhase())) return;
    if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) { e.preventDefault(); keyboardPoint ||= { x: .5, y: .5 }; const d = e.shiftKey ? .05 : .01; if (e.key === 'ArrowLeft') keyboardPoint.x -= d; if (e.key === 'ArrowRight') keyboardPoint.x += d; if (e.key === 'ArrowUp') keyboardPoint.y -= d; if (e.key === 'ArrowDown') keyboardPoint.y += d; keyboardPoint.x = C.clamp(keyboardPoint.x, 0, 1); keyboardPoint.y = C.clamp(keyboardPoint.y, 0, 1); drawScene(); }
    if (e.key === 'Enter' && keyboardPoint) { e.preventDefault(); selectCameraPoint({ ...keyboardPoint }); }
  };
  cam.onblur = () => { keyboardPoint = null; };
  $('camStart').onclick = () => startCamera(); $('camStop').onclick = () => { $('settingsDialog').close(); stopCamera(); }; $('camSel').onchange = () => { const id = $('camSel').value; $('settingsDialog').close(); startCamera(id, true); };
  $('resetSetup').onclick = () => { if (!running) { setup.color = null; resetGeometry(); notice(''); } };
  $('tol').value = setup.tol; $('tolValue').textContent = `${setup.tol}°`; $('headBehind').value = setup.headBehind; $('earAbove').value = setup.earAbove;
  $('tol').oninput = () => { setup.tol = Number($('tol').value); $('tolValue').textContent = `${setup.tol}°`; resetTracking(); $('calibrationCheck').checked = false; save(); render(true); };
  for (const id of ['headBehind', 'earAbove']) $(id).onchange = () => { if (!running) { setup[id] = Number($(id).value); $('calibrationCheck').checked = false; save(); render(true); } };
  for (const id of ['calibrationCheck', 'audioCheck']) $(id).onchange = () => render(true);
  $('volume').oninput = () => { audio.setVolume(Number($('volume').value)); $('volumeValue').textContent = `${Math.round(audio.volume * 100)}%`; $('audioCheck').checked = false; testedSides.clear(); render(true); };
  for (const [id, side] of [['testLeft', -1], ['testRight', 1]]) $(id).onclick = async () => { try { await audio.ensure(Number($('volume').value)); audio.test(side); testedSides.add(side); notice(''); render(true); } catch (e) { notice(e.message, true); } };

  $('condition').replaceChildren(...C.CONDITIONS.map(c => new Option(CONDITION_NAMES[c.id], c.id))); $('condition').value = 'W-c';
  for (const c of C.CONDITIONS.filter(c => c.main)) { const label = document.createElement('label'), input = document.createElement('input'); input.type = 'checkbox'; input.value = c.id; input.name = 'conditions'; input.checked = true; input.disabled = c.id === 'none'; label.append(input, document.createTextNode(CONDITION_NAMES[c.id])); $('conditionChoices').append(label); }
  const conditionHelp = { none: '到達中の音なし', 'T-c': '音源は覚えた道具の位置', 'W-c': '手の進みに合わせて音源を移動', 'P-s': '手と実物のずれを音で案内', 'P-c': '音源は実物の位置', 'W-s': '導く先を道具から実物へ移動', 'T-s': '実物ではなく道具へ誘導' };
  function restorePendingConfig() {
    if (!engine || engine.state === 'finished' || engine.session.closed) return;
    const cfg = engine.session.config;
    for (const id of ['kind', 'condition', 'angle', 'tool', 'repeats']) if (cfg[id] !== undefined) $(id).value = cfg[id];
    document.querySelectorAll('[name=conditions]').forEach(n => { n.checked = n.value === 'none' || cfg.conditions?.includes(n.value); });
    document.querySelectorAll('[name=angles]').forEach(n => { n.checked = cfg.angles?.includes(Number(n.value)); });
    $('knowledge').value = cfg.priorKnowledge || 'known'; $('equipment').value = cfg.equipment || '';
    audio.setVolume(Number.isFinite(cfg.volume) ? cfg.volume : .25); $('volume').value = audio.volume; $('volumeValue').textContent = `${Math.round(audio.volume * 100)}%`;
  }
  function config() { return { kind: $('kind').value, condition: $('condition').value, angle: Number($('angle').value), tool: $('tool').value, conditions: [...document.querySelectorAll('[name=conditions]:checked')].map(e => e.value), angles: [...document.querySelectorAll('[name=angles]:checked')].map(e => Number(e.value)), repeats: Number($('repeats').value), priorKnowledge: $('knowledge').value, equipment: $('equipment').value.trim(), simulated: TEST, volume: audio.volume, headFixed: true, endpoint: 'key_self_report', memoryMs: 5000, timeoutMs: 12000, units: 'cm_planar_estimate', interfaceVersion: UI_VERSION, display: 'camera_homography_overlay', targetRadiusCm: objectRadius(), targetLabels: { A: 'A', M: 'B', B: 'C' } }; }
  function renderConfig() {
    const kind = $('kind').value; $('manualConfig').hidden = kind !== 'demo'; $('pilotConfig').hidden = kind === 'demo'; $('conditionChoices').hidden = kind === 'baseline';
    $('kindHelp').textContent = kind === 'demo' ? '回答後に結果を表示' : kind === 'baseline' ? '実物を取り除いて測る' : '途中の結果は表示しない';
    $('conditionHelp').textContent = conditionHelp[$('condition').value];
    try { const p = C.makePlan(config(), 1); $('trialCount').textContent = `合計 ${p.length} 回`; } catch (e) { $('trialCount').textContent = e.message; }
    if ($('calibrationCheck').checked && !objectsInFrame()) $('calibrationCheck').checked = false;
    render(true);
  }
  $('configFields').onchange = renderConfig;
  function lockSetup(value) { $('configFields').disabled = value; document.querySelectorAll('#settingsDialog input,#settingsDialog select,#settingsDialog textarea').forEach(n => { n.disabled = value; }); }
  function showParticipant(value) { running = value; document.body.classList.toggle('session-running', value); $('operator').hidden = !value; $('pause').hidden = !value; $('settingsOpen').hidden = value; $('helpOpen').hidden = value; $('conditionsOpen').hidden = value; $('resultsOpen').hidden = value && engine?.state !== 'finished'; lockSetup(value); $('conditionsDialog').close(); requestAnimationFrame(resize); renderSetup(); }
  $('startSession').onclick = async () => {
    if (!canStart() || running) return;
    try {
      await audio.ensure(Number($('volume').value));
      if (engine && engine.state !== 'finished' && !engine.session.closed) { notice('未完了の記録があります。「続きから」を選んでください。', true); return; }
      const seed = crypto.getRandomValues(new Uint32Array(1))[0], id = `${TEST ? 'test-' : ''}${new Date().toISOString().replace(/[:.]/g, '-')}-${seed.toString(16)}`;
      engine = new C.Engine(config(), setup, seed, id); engine.session.createdAt = new Date().toISOString(); engine.session.environment = { userAgent: navigator.userAgent, width: innerWidth, height: innerHeight, audio: audio.metadata(), camera: stream?.getVideoTracks()[0]?.getSettings() ?? null, tracking: { width: proc.width, height: proc.height, smoothingMs: 30, freshnessMs: 150, tolerance: setup.tol } };
      engine.enteredAt = now(); paused = false; $('pause').textContent = '一時停止'; notice(''); save(); showParticipant(true); render(true);
    } catch (e) { notice(e.message, true); }
  };
  $('resumeSession').onclick = async () => {
    if (!canStart() || !engine || engine.state === 'finished') return;
    if (JSON.stringify(setup) !== JSON.stringify(engine.session.calibration)) { notice('位置の登録が変わっています。「新しく始める」で前の記録を残して始め直してください。', true); return; }
    try { await audio.ensure(engine.session.config.volume); $('volume').value = engine.session.config.volume; $('volumeValue').textContent = `${Math.round(audio.volume * 100)}%`; engine.learnedAngle = null; engine.state = 'learn'; engine.enteredAt = now(); paused = false; showParticipant(true); notice(''); render(true); } catch (e) { notice(e.message, true); }
  };
  $('closeSavedSession').onclick = () => { if (!engine || running) return; engine.close(now()); save(); render(true); notice(''); };
  $('operator').onclick = () => { if (!engine) return; engine.close(now()); cancelOutput(); save(); paused = false; showParticipant(false); notice(''); render(true); };
  $('pause').onclick = () => { paused = !paused; cancelOutput(); if (paused) engine?.abort('paused', now()); else if (engine && !engine.active && !['finished', 'learn'].includes(engine.state)) { engine.state = 'interrupted'; engine.message = 'paused'; } if (!paused && engine?.state === 'learn') engine.enteredAt = now(); $('pause').textContent = paused ? '再開' : '一時停止'; save(); render(true); };
  function instruct() {
    const id = engine.begin(now()); if (!id) return;
    engine.current.interfaceVersion = UI_VERSION; engine.current.targetLabel = TARGETS[engine.current.tool].letter; engine.current.targetRadiusCm = objectRadius();
    const token = ++cueToken; save(); render(true); let fired = false;
    const done = fallback => {
      if (fired || token !== cueToken || paused || !running || engine.current?.id !== id || engine.state !== 'instruction') return;
      fired = true; try { window.speechSynthesis?.cancel(); } catch {} engine.current.speechFallback = fallback;
      if (!engine.delay(id, now())) return;
      audio.cue(); render(true);
      later(() => { if (token !== cueToken) return; if (engine.reach(id, now())) audio.start(() => engine?.state === 'reach' && !paused && now() - sampleAt <= 150 ? C.sound(engine.current.condition, engine.hand, engine.current.T, engine.current.P, engine.current.S) : null, setup); save(); render(true); }, 200);
    };
    const voices = window.speechSynthesis?.getVoices() || [], voice = voices.find(v => v.lang.startsWith('ja') && v.localService);
    if (voice && typeof SpeechSynthesisUtterance !== 'undefined') { try { const u = new SpeechSynthesisUtterance(`${TARGETS[engine.current.tool].spoken}を取って`); u.voice = voice; u.lang = 'ja-JP'; u.rate = 1; u.onend = () => done(false); u.onerror = () => done(true); window.speechSynthesis.cancel(); window.speechSynthesis.speak(u); } catch { later(() => done(true), 2200); } }
    else later(() => done(true), 2200);
    later(() => done(true), 4000);
  }
  const invalidText = { tracking_lost: 'シールが見えません。カメラの範囲へ戻してください。', tracking_jump: '位置が飛びました。シールの追跡を確認してください。', early_movement: '合図より前に動きました。Sで合図を待ってください。', premature_stop: '到達前に終了しました。合図のあと手を伸ばしてください。', page_reload: '配置を覚え直してください。', hidden: '画面が隠れました。Sへ戻して再開してください。', focus_lost: '画面から離れました。Sへ戻して再開してください。', viewport_changed: '画面サイズが変わりました。Sへ戻して再開してください。', paused: 'Sへ戻してから再開してください。', camera_stopped: 'カメラを開始し直してください。', camera_ended: 'カメラを接続し直してください。', audio_suspended: '音声が止まりました。音を確認して再開してください。', escape: 'Sへ戻してから再開してください。', start_not_ready: '開始位置Sに手を戻してください。', session_ended: '記録を終了しました。' };
  function setupInstructions() {
    const phase = setupPhase(), corners = ['手前左', '手前右', '奥右', '奥左'];
    const messages = {
      camera: ['カメラを開始してください', '机を真上から映します。A4と手が映る位置に固定します。'],
      corners: [`A4の${corners[setup.corners.length] || '手前左'}の角をクリック`, `${setup.corners.length + 1} / 4 点目。紙は横向きに置きます。`],
      color: ['手のシールをクリック', '鮮やかな色のシールを、映像の中で選びます。'],
      body: ['体の真ん中をクリック', '自分の正面にある、机の手前の縁を選びます。'],
      S: ['開始位置に手を置く', isStable() ? '「Sを登録」を押してください。' : 'シールが見える位置で、0.5秒止めてください。'],
      P: ['実物の位置に手を置く', isStable() ? '「Pを登録」を押してください。' : '体の右側。Sから15cm以上離し、0.5秒止めてください。'],
      verify: ['映像のA・B・Cを確認', objectsInFrame() ? 'Sと実物Pも、正しい位置に重なっているか確認します。' : '対象が映像の外です。カメラを引き、準備をやり直してください。'],
      audio: ['左右の音を聞く', testedSides.size === 2 ? '左右が正しければ「左右とも聞こえた」を押します。' : '左・右を1回ずつ聞き、音量を合わせます。'],
      ready: ['準備完了', engine && engine.state !== 'finished' && !engine.session.closed ? '「続きから」で前の条件を再開。「新しく始める」で条件を変更。' : '「配置を覚える」で始めます。']
    };
    return { phase, title: messages[phase][0], text: messages[phase][1] };
  }
  function render(force = false) {
    renderSetup();
    const state = running && engine ? paused ? 'paused' : engine.state : 'setup', changed = force || state !== lastRenderState; lastRenderState = state;
    const flow = state === 'setup' ? 'setup' : state === 'learn' ? 'learn' : ['answer', 'saved', 'finished'].includes(state) ? 'answer' : 'reach';
    document.querySelectorAll('#steps li').forEach((li, i) => { const n = ['setup', 'learn', 'reach', 'answer'].indexOf(flow); if (li.dataset.step === flow) li.setAttribute('aria-current', 'step'); else li.removeAttribute('aria-current'); li.classList.toggle('done', i < n); });
    const showVideo = state === 'setup' || !paused && ['learn', 'ready'].includes(state) || state === 'finished' && engine.session.config.kind === 'demo';
    cameraView.hidden = !showVideo; $('stageMask').hidden = showVideo || state === 'answer'; $('answerForm').hidden = state !== 'answer'; $('feedback').hidden = true; $('trackSt').hidden = !showVideo;
    $('stage').dataset.state = state;
    $('stage').classList.toggle('dark', ['instruction', 'delay', 'reach', 'paused', 'interrupted'].includes(state));
    let title = '', text = '', cue = '', label = '';
    const sec = engine?.enteredAt === null || !engine ? 0 : (now() - engine.enteredAt) / 1000;
    $('timerLabel').textContent = state === 'reach' ? `残り ${Math.max(0, Math.ceil(12 - sec))} 秒` : '';
    $('sessionProgress').textContent = running && engine ? `${engine.session.index} / ${engine.session.plan.length} 回` : '';
    if (state === 'setup') { const s = setupInstructions(); title = s.title; text = s.text; label = s.phase === 'ready' ? '準備完了' : `準備 ${SETUP_ORDER.indexOf(s.phase) + 1} / 8`; }
    if (state === 'learn') { label = '覚える'; title = 'A・B・Cの位置を覚える'; text = '手は伸ばさず、映像の位置を見て覚えます。'; }
    if (state === 'ready') { label = '開始位置'; title = 'Sへ手を戻す'; text = engine.atStart ? '「指示を聞く」を押してください。' : engine.hand ? 'Sの中で0.5秒止めてください。' : 'シールが見えません。映像の範囲へ戻してください。'; }
    if (state === 'instruction') { label = '指示'; title = `${TARGETS[engine.current.tool].letter}を取ってください`; text = '目を閉じて、合図を待ちます。'; cue = TARGETS[engine.current.tool].letter; }
    if (state === 'delay') { label = '合図'; title = '手を伸ばしてください'; text = ''; cue = '手を伸ばす'; }
    if (state === 'reach') { label = '伸ばす'; title = engine.session.config.kind === 'baseline' ? '覚えた場所で止める' : '最初に実物に触れたら止める'; text = '反対の手で Space。届かなければ F。'; cue = 'Space：到達で止める\nF：届かなかった'; }
    if (state === 'answer') { label = '答える'; title = '今の到達について答える'; text = ''; }
    if (state === 'saved') { label = '保存済み'; title = '次の試行へ'; text = engine.session.index % 12 === 0 ? 'ここで休憩できます。進むときにSへ戻します。' : 'Sへ手を戻して「次へ」を押します。'; cue = '回答を保存しました'; }
    if (state === 'interrupted') { label = '中断'; title = '同じ条件でもう一度'; text = invalidText[engine.message] || 'Sへ戻して再開してください。'; cue = 'やり直す'; }
    if (state === 'paused') { label = '一時停止'; title = '再開で続けます'; text = '途中の試行は同じ条件でやり直します。'; cue = '一時停止中'; }
    if (state === 'finished') { label = '終了'; title = engine.session.index >= engine.session.plan.length ? '終了しました' : '途中までの記録を保存しました'; text = engine.session.config.kind === 'demo' ? '映像上に手の軌跡を表示しています。' : '「記録」から書き出せます。'; cue = '記録を保存しました'; }
    $('phaseLabel').textContent = label; $('stageTitle').textContent = title; if ($('stageText').textContent !== text) $('stageText').textContent = text; $('stageText').hidden = !text; $('maskCue').textContent = cue;
    if (changed) {
      const actions = $('stageButtons'); actions.replaceChildren();
      if (state === 'learn') actions.append(button('覚えた', () => { if (engine.learn(now())) render(true); }, { id: 'learnDone', primary: true }));
      if (state === 'ready') actions.append(button('指示を聞く', instruct, { id: 'beginTrial', primary: true }));
      if (state === 'reach') {
        actions.append(button('到達で止める', () => endReach('self_stop'), { id: 'stopReach', primary: true }));
        actions.append(button('届かなかった', () => endReach('miss'), { id: 'missReach' }));
      }
      if (['saved', 'interrupted'].includes(state)) actions.append(button(state === 'saved' ? '次へ' : 'もう一度', () => { if (engine.next(now())) { save(); render(true); } }, { id: 'nextTrial', primary: true }));
      if (state === 'finished') {
        const s = engine.session;
        if (s.index >= s.plan.length && !s.final && s.config.kind !== 'demo') actions.append(button('最後の質問', openFinal, { primary: true }));
        else if (s.config.kind === 'demo') actions.append(button('もう1回', () => { showParticipant(false); $('startSession').click(); }, { primary: true, id: 'repeatTrial' }));
        actions.append(button('条件に戻る', () => $('operator').click()));
      }
      if (state === 'answer') {
        cancelOutput(); $('answerForm').reset(); $('answerError').hidden = true;
        const baseline = engine.session.config.kind === 'baseline', no = ['miss', 'timeout'].includes(engine.current.endReason);
        $('contactField').hidden = baseline; $('contactField').disabled = baseline || no;
        document.querySelectorAll('[name=contact]').forEach(n => { n.required = !baseline; n.checked = no && n.value === 'no'; });
        if (matchMedia('(pointer:fine)').matches) $('answerForm').querySelector('[name=noticed]').focus({ preventScroll: true });
      }
      if (['saved', 'interrupted', 'finished'].includes(state)) cancelOutput();
    }
    if ($('learnDone')) { $('learnDone').disabled = sec < 5; $('learnDone').textContent = sec < 5 ? `あと ${Math.ceil(5 - sec)} 秒` : '覚えた'; }
    if ($('beginTrial')) $('beginTrial').disabled = !engine.atStart || !stream && !TEST;
    $('resultsOpen').hidden = running && state !== 'finished';
    $('trackingHint').textContent = state === 'reach' ? 'Space：到達で止める　F：届かなかった　Esc：中断' : state === 'setup' && ['S', 'P'].includes(setupPhase()) ? hand ? isStable() ? '静止を確認しました' : '手を止めてください' : 'シールが見えません' : '';
    if (state === 'finished' && engine.session.config.kind === 'demo' && engine.current?.status === 'complete') {
      const t = engine.current; $('feedback').hidden = false;
      $('feedback').replaceChildren();
      for (const [caption, value] of [['実物まで', `${t.errP.toFixed(1)} cm`], ['P寄り比', t.pull === null ? 'ずれ0' : `${Math.round(t.pull * 100)}%`], ['接触申告', { yes: '触れた', no: '届かなかった', unsure: '不明' }[t.contact]]]) { const span = document.createElement('span'), strong = document.createElement('b'); strong.textContent = value; span.append(document.createTextNode(`${caption} `), strong); $('feedback').append(span); }
    }
    drawScene();
  }
  function endReach(reason) { if (!engine || paused) return; engine.end(now(), reason); cancelOutput(); save(); render(true); }
  $('answerForm').onsubmit = e => {
    e.preventDefault(); if (!engine || engine.state !== 'answer') return;
    const f = new FormData($('answerForm')), no = ['miss', 'timeout'].includes(engine.current.endReason);
    const response = { noticed: f.get('noticed'), confidence: Number(f.get('confidence')), contact: engine.session.config.kind === 'baseline' ? 'not_applicable' : no ? 'no' : f.get('contact') };
    if (!engine.answer(response, now())) { $('answerError').hidden = false; $('answerError').textContent = '各項目を1つずつ選んでください。'; const field = [...$('answerForm').querySelectorAll('fieldset')].find(g => !g.hidden && !g.disabled && !g.querySelector('input:checked')); field?.querySelector('input')?.focus({ preventScroll: true }); return; }
    cancelOutput(); save(); render(true); if (engine.state === 'finished' && engine.session.config.kind !== 'demo') openFinal();
  };
  document.addEventListener('keydown', e => { if (!running || !engine || e.repeat || document.querySelector('dialog[open]')) return; if (e.code === 'Escape') { e.preventDefault(); invalidate('escape'); } if (/^(INPUT|SELECT|TEXTAREA)$/.test(e.target.tagName)) return; if (!paused && engine.state === 'reach' && ['Space', 'KeyF'].includes(e.code)) { e.preventDefault(); endReach(e.code === 'KeyF' ? 'miss' : 'self_stop'); } });
  function openFinal() { $('realCount').value = engine.session.config.priorKnowledge === 'known' ? 'known' : ''; $('finalComment').value = ''; $('finalDialog').showModal(); }
  $('finalForm').onsubmit = e => { e.preventDefault(); if (!engine || !['1', '2', '3', 'unsure', 'known'].includes($('realCount').value)) return; engine.session.final = { realCount: $('realCount').value, comment: $('finalComment').value.trim(), time: new Date().toISOString(), priorKnowledge: engine.session.config.priorKnowledge }; save(); $('finalDialog').close(); render(true); };
  $('finalDialog').addEventListener('cancel', e => e.preventDefault());

  $('helpOpen').onclick = () => $('helpDialog').showModal(); $('settingsOpen').onclick = () => $('settingsDialog').showModal(); $('conditionsOpen').onclick = () => $('conditionsDialog').showModal();
  document.querySelectorAll('[data-close]').forEach(b => b.onclick = () => $(b.dataset.close).close());
  const tabs = [$('trackingTab'), $('recordingTab')];
  function selectTab(index) { tabs.forEach((tab, i) => { tab.setAttribute('aria-selected', String(i === index)); tab.tabIndex = i === index ? 0 : -1; $(tab.getAttribute('aria-controls')).hidden = i !== index; }); }
  tabs.forEach((tab, i) => { tab.onclick = () => selectTab(i); tab.onkeydown = e => { if (!['ArrowRight', 'ArrowLeft', 'Home', 'End'].includes(e.key)) return; e.preventDefault(); const n = e.key === 'Home' ? 0 : e.key === 'End' ? 1 : 1 - i; selectTab(n); tabs[n].focus(); }; }); selectTab(0);
  function syncConditionPanel() { const narrow = matchMedia('(max-width:850px), (max-height:500px)').matches; if (narrow && !conditionsPanel.closest('dialog')) $('conditionsDialogBody').append(conditionsPanel); else if (!narrow && conditionsPanel.closest('dialog')) { $('conditionsDialog').close(); $('mainLayout').prepend(conditionsPanel); } }
  const resetInDialog = button('準備をやり直す', () => { $('settingsDialog').close(); $('resetSetup').click(); }); $('trackingSettings').append(resetInDialog);
  $('trackingSettings').append(button('音を確認し直す', () => { $('settingsDialog').close(); $('audioCheck').checked = false; testedSides.clear(); render(true); }));

  function selectedSession() { return db.sessions.find(s => s.id === $('sessionSelect').value) || null; }
  const percent = (n, d) => d ? `${Math.round(n / d * 100)}% (${n}/${d})` : '—';
  function resultTable() {
    const s = selectedSession(), target = $('resultTable'); target.replaceChildren(); $('exportTrials').disabled = $('exportPaths').disabled = !s;
    if (!s) { $('resultMeta').textContent = 'まだ記録がありません。'; $('resultNote').textContent = ''; return; }
    const complete = s.attempts.filter(t => t.status === 'complete').length, invalid = s.attempts.filter(t => t.status === 'invalid').length;
    $('resultMeta').textContent = `${s.config.kind} / 完了 ${complete} / 中断 ${invalid}${s.config.simulated ? ' / テスト入力' : ''}`;
    const sealed = s.config.kind !== 'demo' && s.index < s.plan.length && !s.closed;
    $('resultNote').textContent = sealed ? '比較の途中は結果を表示しません。' : 'cmは平面校正による推定。接触は自己申告。不明は別計数。'; if (sealed) return;
    const table = document.createElement('table'), header = table.createTHead().insertRow();
    for (const name of ['音', '間隔 / 対象', 'n', '実物 / 道具への誤差', 'P寄り比', '接触 / 不明', 'ずれあり / 不明', '接触＋ずれなし', '時間']) { const th = document.createElement('th'); th.textContent = name; header.append(th); }
    const body = table.createTBody();
    for (const g of C.summarize(s)) { const row = body.insertRow(), values = [CONDITION_NAMES[g.condition], `${g.angle}° / ${s.config.targetLabels ? TARGETS[g.tool].letter : C.TOOLS[g.tool].short}${g.tool === 'M' ? '（ずれ0）' : ''}`, g.n, `${g.errP.toFixed(1)} / ${g.errA.toFixed(1)} cm`, g.pull === null ? '—' : `${Math.round(g.pull * 100)}%`, s.config.kind === 'baseline' ? '対象外' : `${percent(g.contactYes, g.contactYes + g.contactNo)} / ${g.contactUnknown}`, `${percent(g.noticedYes, g.noticedYes + g.noticedNo)} / ${g.noticedUnknown}`, s.config.kind === 'baseline' ? '対象外' : percent(g.joint, g.n), `${(g.ms / 1000).toFixed(2)} s`]; for (const v of values) row.insertCell().textContent = v; }
    target.append(table);
  }
  function openResults() { save(); $('sessionSelect').replaceChildren(...[...db.sessions].reverse().map(s => new Option(`${s.createdAt || s.id} / ${s.config.kind}${s.config.simulated ? ' / TEST' : ''}`, s.id))); if (engine) $('sessionSelect').value = engine.session.id; $('exportLegacy').hidden = !read('cam1.history', null); resultTable(); $('resultsDialog').showModal(); }
  $('resultsOpen').onclick = openResults; $('sessionSelect').onchange = resultTable;
  function download(name, data, type) { const blob = new Blob([data], { type }), url = URL.createObjectURL(blob), a = document.createElement('a'); a.href = url; a.download = name; document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000); }
  $('exportJson').onclick = () => { save(); download('auditory-retargeting-all.json', JSON.stringify({ ...db, storageFailed, exportedAt: new Date().toISOString() }, null, 2), 'application/json'); };
  $('exportLegacy').onclick = () => download('auditory-retargeting-legacy.json', JSON.stringify({ history: read('cam1.history', []), setup: read('cam1.setup', null), plan: read('cam1.plan', null), settings: read('cam1.set', null) }, null, 2), 'application/json');
  $('exportTrials').onclick = () => {
    const s = selectedSession(); if (!s) return;
    const rows = s.attempts.map(t => ({ version: s.version, session: s.id, kind: s.config.kind, simulated: s.config.simulated, prior_knowledge: s.config.priorKnowledge, seed: s.seed, trial: t.index, attempt: t.id, status: t.status, invalid_reason: t.invalidReason, condition: t.condition, angle_deg: t.angle, tool: t.tool, target_label: t.targetLabel || (s.config.targetLabels ? TARGETS[t.tool].letter : C.TOOLS[t.tool].short), target_radius_cm: t.targetRadiusCm ?? s.config.targetRadiusCm, signed_angle_deg: C.TOOLS[t.tool].side * t.angle, gap_cm: C.dist(t.T, t.P), A_x: t.T.x, A_y: t.T.y, P_x: t.P.x, P_y: t.P.y, S_x: t.S.x, S_y: t.S.y, E_x: t.E?.x, E_y: t.E?.y, err_A_cm: t.errA, err_P_cm: t.errP, pull_ratio: t.pull, toward_P_cm: t.towardP, perpendicular_cm: t.perpendicular, endpoint_near_P_3cm: t.nearP, contact_self_report: t.contact, noticed: t.noticed, confidence: t.confidence, duration_ms: t.ms, end_reason: t.endReason, speech_fallback: t.speechFallback, volume: s.config.volume, equipment: s.config.equipment, created_at: s.createdAt, interface_version: t.interfaceVersion || s.config.interfaceVersion || '2.0.0' }));
    download(`${s.id}-trials.csv`, C.csv(rows, rows.length ? Object.keys(rows[0]) : ['session', 'trial', 'status']), 'text/csv;charset=utf-8');
  };
  $('exportPaths').onclick = () => {
    const s = selectedSession(); if (!s) return;
    const rows = s.attempts.flatMap(t => t.path.map(p => ({ session: s.id, attempt: t.id, status: t.status, t_ms: p.t, x_cm: p.x, y_cm: p.y, raw_x_cm: p.rawX, raw_y_cm: p.rawY, sample_age_ms: p.sampleAgeMs, source_x_cm: p.audio?.source.x, source_y_cm: p.audio?.source.y, source_frame: p.audio?.frame, target_x_cm: p.audio?.target?.x ?? (p.audio?.frame === 'head' ? p.audio.source.x : null), target_y_cm: p.audio?.target?.y ?? (p.audio?.frame === 'head' ? p.audio.source.y : null), q: p.audio?.q, gain: p.audio?.gain, interval_s: p.audio?.interval })));
    download(`${s.id}-paths.csv`, C.csv(rows, ['session', 'attempt', 'status', 't_ms', 'x_cm', 'y_cm', 'raw_x_cm', 'raw_y_cm', 'sample_age_ms', 'source_x_cm', 'source_y_cm', 'source_frame', 'target_x_cm', 'target_y_cm', 'q', 'gain', 'interval_s']), 'text/csv;charset=utf-8');
  };

  function svgNode(tag, attrs = {}, text = null) { const n = document.createElementNS(NS, tag); for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, String(v)); if (text !== null) n.textContent = text; return n; }
  function pathString(points) { if (!points.length || points.some(p => !p)) return ''; return points.map((p, i) => `${i ? 'L' : 'M'}${p.x.toFixed(2)},${p.y.toFixed(2)}`).join(' ') + 'Z'; }
  function positionGroup(id, p, visible) { const node = $(id), show = visible && !!p; node.toggleAttribute('hidden', !show); node.style.display = show ? '' : 'none'; if (p) { node.setAttribute('transform', `translate(${p.x},${p.y})`); node.dataset.x = p.x; node.dataset.y = p.y; } }
  function drawScene() {
    if (cameraView.hidden) return;
    const W = cam.width, height = cam.height, g = camCtx, state = running ? engine?.state : 'setup', phase = setupPhase();
    g.fillStyle = '#171d26'; g.fillRect(0, 0, W, height);
    if (stream && video.readyState >= 2) g.drawImage(video, 0, 0, W, height);
    else if (TEST && H) { g.fillStyle = '#414854'; g.fillRect(0, 0, W, height); }
    else { g.fillStyle = '#bbc5d5'; g.font = '18px system-ui'; g.textAlign = 'center'; g.fillText(cameraPending ? 'カメラに接続中…' : '机を真上から映します', W / 2, height / 2); }
    svg.setAttribute('viewBox', `0 0 ${W} ${height}`);
    const paper = $('paperOverlay'); paper.replaceChildren();
    if (!running && setup.corners.length && ['corners', 'color', 'body'].includes(phase)) {
      const ps = setup.corners.map(p => ({ x: p.x * W, y: p.y * height }));
      paper.append(svgNode('polyline', { points: ps.map(p => `${p.x},${p.y}`).join(' ') + (ps.length === 4 ? ` ${ps[0].x},${ps[0].y}` : ''), fill: 'none', stroke: '#ffe06c', 'stroke-width': 2 }));
      ps.forEach((p, i) => { paper.append(svgNode('circle', { cx: p.x, cy: p.y, r: 5, fill: '#ffe06c' })); paper.append(svgNode('text', { x: p.x + 8, y: p.y - 9, fill: '#ffe06c', 'font-size': 15, 'font-weight': 700 }, i + 1)); });
    }
    const showTargets = !running && !setupStep() || state === 'learn' || state === 'finished' && engine.session.config.kind === 'demo';
    let geometry = null; if (setup.body && setup.S && setup.P) { try { geometry = C.geometry(setup, activeAngle()); } catch {} }
    for (const id of ['A', 'M', 'B']) {
      const node = $('target' + id), visible = showTargets && !!geometry, center = geometry && project(geometry[id]); node.toggleAttribute('hidden', !visible); node.style.display = visible ? '' : 'none';
      if (visible && center) { const points = circlePoints(geometry[id], objectRadius()), d = pathString(points); node.querySelectorAll('path').forEach(p => p.setAttribute('d', d)); const text = node.querySelector('text'); text.setAttribute('x', center.x); text.setAttribute('y', center.y); if (points.every(Boolean)) text.style.fontSize = `${Math.min(23, .68 * Math.min(Math.max(...points.map(p => p.x)) - Math.min(...points.map(p => p.x)), Math.max(...points.map(p => p.y)) - Math.min(...points.map(p => p.y))))}px`; node.dataset.x = center.x; node.dataset.y = center.y; node.classList.toggle('selected', !running && $('kind').value === 'demo' && $('tool').value === id); }
    }
    const showSetup = !running && !!H;
    positionGroup('bodyOverlay', setup.body && project(setup.body), showSetup);
    positionGroup('startOverlay', setup.S && project(setup.S), !!setup.S && (showSetup || ['learn', 'ready'].includes(state)));
    positionGroup('proxyOverlay', setup.P && project(setup.P), !!setup.P && (showSetup || state === 'finished' && engine.session.config.kind === 'demo'));
    if (setup.P && inverseH) { const center = project(setup.P), points = circlePoints(setup.P, objectRadius()), text = $('proxyOverlay').querySelector('text'); if (center && points.every(Boolean)) { text.setAttribute('x', Math.min(...points.map(p => p.x)) - center.x - 10); text.setAttribute('y', 4); } }
    positionGroup('handOverlay', hand && project(hand), !!hand && (showSetup || ['learn', 'ready'].includes(state)));
    positionGroup('keyboardCursor', keyboardPoint && { x: keyboardPoint.x * W, y: keyboardPoint.y * height }, !!keyboardPoint && !running);
    const trail = $('trailOverlay'); trail.replaceChildren(); const showTrail = state === 'finished' && engine.session.config.kind === 'demo' && engine.current?.status === 'complete'; trail.toggleAttribute('hidden', !showTrail); trail.style.display = showTrail ? '' : 'none';
    if (showTrail) { const t = engine.current; for (const [ps, color, dash] of [[t.path, '#fff', ''], [t.path.map(p => p.audio?.target || (p.audio?.frame === 'head' ? p.audio.source : null)).filter(C.point), '#cf9dff', '6 4']]) { const points = ps.map(project).filter(Boolean); if (points.length > 1) trail.append(svgNode('polyline', { points: points.map(p => `${p.x},${p.y}`).join(' '), fill: 'none', stroke: color, 'stroke-width': 2.5, 'stroke-dasharray': dash })); } const E = project(t.E); if (E) trail.append(svgNode('circle', { cx: E.x, cy: E.y, r: 5, fill: '#fff', stroke: '#172033', 'stroke-width': 2 })); }
  }
  function resize() {
    syncConditionPanel(); const r = surface.getBoundingClientRect(), scale = Math.min(r.width / cam.width, r.height / cam.height);
    cameraView.style.width = `${Math.max(1, cam.width * scale)}px`; cameraView.style.height = `${Math.max(1, cam.height * scale)}px`; viewport = { w: innerWidth, h: innerHeight }; drawScene();
  }
  new ResizeObserver(resize).observe(surface);
  window.addEventListener('resize', () => { if (running && (Math.abs(innerWidth - viewport.w) > 2 || Math.abs(innerHeight - viewport.h) > 2)) invalidate('viewport_changed'); resize(); });
  window.addEventListener('blur', () => { if (running) invalidate('focus_lost'); });
  document.addEventListener('visibilitychange', () => { if (document.hidden) { if (running) invalidate('hidden'); else cancelOutput(); save(); } });
  window.addEventListener('pagehide', () => { cancelOutput(); save(); stream?.getTracks().forEach(t => t.stop()); });
  function acceptSample(raw, timestamp) {
    if (!C.point(raw)) { hand = rawHand = marker = null; sampleAt = -Infinity; calibrationSamples = []; return; }
    const dt = timestamp - sampleAt, alpha = Number.isFinite(dt) ? 1 - Math.exp(-Math.max(dt, 1) / 30) : 1;
    hand = hand ? C.mix(hand, raw, alpha) : { ...raw }; rawHand = raw; sampleAt = timestamp; calibrationSamples.push({ ...hand, t: timestamp }); while (calibrationSamples.length && timestamp - calibrationSamples[0].t > 550) calibrationSamples.shift();
  }
  function loop(timestamp) {
    if (stream && video.readyState >= 2 && video.currentTime !== videoTime && timestamp - lastProcessedAt >= 25) {
      videoTime = video.currentTime; lastProcessedAt = timestamp;
      if (setup.color && H) { procCtx.drawImage(video, 0, 0, proc.width, proc.height); const r = C.findMarker(procCtx.getImageData(0, 0, proc.width, proc.height).data, proc.width, proc.height, setup.color, setup.tol); marker = r.point; trackingReason = r.reason; acceptSample(marker ? C.applyH(H, marker) : null, timestamp); }
      drawScene();
    }
    if (timestamp - sampleAt > 150) { hand = null; calibrationSamples = []; if (Number.isFinite(sampleAt) && stream) trackingReason = '映像が止まっています'; }
    if (running && engine && !paused) { const before = engine.state; engine.update(hand, timestamp, sampleAt, rawHand); if (before !== engine.state) { if (engine.state !== 'reach') cancelOutput(); save(); render(true); } if (engine.active && audio.context?.state !== 'running') invalidate('audio_suspended'); if (timestamp - lastSavedAt > 1000 && engine.state === 'reach') save(); }
    if (timestamp - lastUiAt > 100) { lastUiAt = timestamp; $('trackSt').textContent = hand ? '● 追跡中' : trackingReason; render(); }
    requestAnimationFrame(loop);
  }
  if (TEST) {
    $('testBadge').hidden = false;
    window.__redirectTest = { get engine() { return engine; }, get db() { return db; }, get setup() { return setup; }, get hand() { return hand; }, get phase() { return setupPhase(); }, get projection() { return inverseH; }, project, objectsInFrame,
      setSetup(su) { testInput = true; setup = Object.assign(freshSetup(), su); buildH(); save(); render(true); },
      feed(p, timestamp = now()) { acceptSample(p, timestamp); if (running && engine) engine.update(hand, timestamp, timestamp, rawHand); render(); },
      render: () => render(true), save, sound: audio, isStable };
  }
  restorePendingConfig(); buildH(); syncConditionPanel(); renderConfig(); render(true); resize(); requestAnimationFrame(loop); if (engine) save();
})();
