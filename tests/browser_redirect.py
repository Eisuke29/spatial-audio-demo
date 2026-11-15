"""Real Chromium integration checks. Run a local HTTP server on port 8765 first.

Synthetic coordinates and generated video exercise the application, not human perception.
Test records are isolated from normal localStorage. Screenshots go to .test-artifacts/.
"""
from pathlib import Path
import json
import math
import time
from playwright.sync_api import sync_playwright

URL = 'http://127.0.0.1:8765/redirect.html'
OUT = Path(__file__).resolve().parent.parent / '.test-artifacts'
OUT.mkdir(exist_ok=True)
CHECKS = []
SETUP = {
    'corners': [{'x': .1, 'y': .9}, {'x': .7, 'y': .9}, {'x': .7, 'y': .25}, {'x': .1, 'y': .25}],
    'color': {'h': 0, 's': 1, 'v': 1}, 'body': {'x': 0, 'y': 0},
    'S': {'x': 0, 'y': 10}, 'P': {'x': 40, 'y': 0}, 'headBehind': 15, 'earAbove': 35, 'tol': 16
}


def check(condition, message):
    assert condition, message
    CHECKS.append(message)
    print('PASS', message, flush=True)


def state(page):
    return page.evaluate('window.__redirectTest.engine.state')


def feed_timer(page):
    page.evaluate('''() => {
        window.testTarget = {...window.__redirectTest.setup.S};
        clearInterval(window.testFeed);
        window.testFeed = setInterval(() => window.__redirectTest.feed(window.testTarget), 40);
    }''')


def prepare(browser, kind='demo', repeats=1, storage=None):
    page = browser.new_page(viewport={'width': 1440, 'height': 1000})
    errors = []
    page.on('pageerror', lambda e: errors.append(str(e)))
    if storage:
        page.add_init_script(storage)
    page.clock.install()
    page.goto(URL + '?test=1')
    page.evaluate('(su) => window.__redirectTest.setSetup(su)', SETUP)
    feed_timer(page)
    page.locator('#testLeft').click()
    page.locator('#calibrationCheck').check()
    page.locator('#audioCheck').check()
    page.locator('#kind').select_option(kind)
    if kind != 'demo':
        page.locator('#repeats').fill(str(repeats))
        page.locator('[name=angles][value="20"]').uncheck()
    page.locator('#startSession').click()
    return page, errors


def learn(page):
    page.clock.run_for(5100)
    page.locator('#learnDone').click()
    page.clock.run_for(650)
    assert state(page) == 'ready'


def begin(page):
    page.locator('#beginTrial').click()
    page.clock.run_for(4350)
    assert state(page) == 'reach', page.locator('#stageText').inner_text()


def move(page, destination=None):
    if destination is None:
        destination = page.evaluate('window.__redirectTest.setup.P')
    S = page.evaluate('window.__redirectTest.setup.S')
    for i in range(1, 16):
        page.evaluate('(p) => { window.testTarget = p; }', {'x': S['x'] + (destination['x'] - S['x']) * i / 15, 'y': S['y'] + (destination['y'] - S['y']) * i / 15})
        page.clock.run_for(100)


def answer(page, contact='yes', noticed='no'):
    page.locator(f'[name=noticed][value={noticed}]').check()
    if page.locator('#contactField').is_visible() and page.locator('[name=contact]').first.is_enabled():
        page.locator(f'[name=contact][value={contact}]').check()
    page.locator('[name=confidence][value="3"]').check()
    page.locator('#answerForm button[type=submit]').click()


def return_start(page):
    current = page.evaluate('window.testTarget')
    S = page.evaluate('window.__redirectTest.setup.S')
    for i in range(1, 12):
        page.evaluate('(p) => { window.testTarget = p; }', {'x': current['x'] + (S['x'] - current['x']) * i / 11, 'y': current['y'] + (S['y'] - current['y']) * i / 11})
        page.clock.run_for(100)
    page.clock.run_for(650)


with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    initial = browser.new_page(viewport={'width': 1440, 'height': 1000})
    initial.goto(URL)
    check(initial.evaluate('typeof window.__redirectTest') == 'undefined', 'normal URL exposes no input-injection hook')
    check(initial.locator('#startSession').is_disabled(), 'setup and headphone confirmation gate the start')
    for w, h in [(1920, 1080), (1440, 1000), (1280, 800), (1024, 768), (768, 1024), (390, 844), (320, 740)]:
        initial.set_viewport_size({'width': w, 'height': h})
        initial.wait_for_timeout(100)
        check(initial.evaluate('document.documentElement.scrollWidth <= innerWidth'), f'no page overflow at {w}x{h}')
    initial.screenshot(path=str(OUT / 'redirect-mobile.png'), full_page=True)
    initial.set_viewport_size({'width': 1440, 'height': 1000})
    initial.screenshot(path=str(OUT / 'redirect-desktop.png'), full_page=True)
    initial.locator('#helpOpen').click()
    check(initial.locator('#helpDialog').is_visible(), 'help opens as an accessible dialog')
    initial.locator('[data-close=helpDialog]').click()
    initial.close()

    page, errors = prepare(browser)
    check(state(page) == 'learn', 'new session starts with visual learning, not an automatic reach')
    check(not page.locator('.setup-panel').is_visible(), 'participant view hides camera, setup, condition and P')
    check(page.locator('#learnDone').is_disabled(), 'learning enforces minimum viewing time')
    page.screenshot(path=str(OUT / 'redirect-learning.png'), full_page=True)
    learn(page)
    begin(page)
    check(not page.locator('#map').is_visible(), 'map is hidden during reach')
    move(page)
    page.clock.run_for(1000)
    check(state(page) == 'reach', 'dwelling at P does not create a contact event')
    page.keyboard.press('Space')
    check(state(page) == 'answer', 'Space captures endpoint and opens separate answers')
    check(page.locator('#answerForm [name=contact]:checked').count() == 0, 'contact is not inferred from proximity to P')
    page.set_viewport_size({'width': 390, 'height': 844})
    page.screenshot(path=str(OUT / 'redirect-answer-mobile.png'), full_page=True)
    page.set_viewport_size({'width': 1440, 'height': 1000})
    # Resizing after endpoint is intentionally still an invalid trial.
    check(state(page) == 'interrupted', 'resize during unanswered trial invalidates rather than silently changing layout')
    page.locator('#nextTrial').click()
    return_start(page)
    begin(page)
    move(page)
    page.keyboard.press('Space')
    answer(page)
    check(state(page) == 'finished', 'demo completes after exactly one valid response')
    check(page.locator('#feedback').is_visible(), 'demo shows feedback only after the answer')
    page.screenshot(path=str(OUT / 'redirect-feedback.png'), full_page=True)
    page.locator('#resultsOpen').click()
    with page.expect_download() as download:
        page.locator('#exportTrials').click()
    trial_csv = download.value
    trial_csv.save_as(OUT / 'browser-trials.csv')
    check((OUT / 'browser-trials.csv').read_text(encoding='utf-8-sig').count('complete') == 1, 'CSV exports valid and invalid attempts separately')
    with page.expect_download() as download:
        page.locator('#exportJson').click()
    download.value.save_as(OUT / 'browser-all.json')
    data = json.loads((OUT / 'browser-all.json').read_text(encoding='utf-8'))
    check(data['sessions'][0]['config']['simulated'] is True, 'synthetic sessions are explicitly marked and stored separately')
    check(len(data['sessions'][0]['attempts'][-1]['path']) > 20, 'time-stamped hand and source trajectory survives export')
    check(not errors, 'demo browser flow has no uncaught JavaScript errors')
    page.close()

    # A complete balanced comparison, with real DOM answers and production scheduling.
    page, errors = prepare(browser, 'pilot')
    learn(page)
    length = page.evaluate('window.__redirectTest.engine.session.plan.length')
    for i in range(length):
        begin(page)
        move(page)
        page.keyboard.press('Space')
        answer(page, contact='no' if i % 4 == 0 else 'yes', noticed='unsure' if i % 5 == 0 else 'no')
        if i < length - 1:
            check(not page.locator('#feedback').is_visible() and not page.locator('#map').is_visible(), f'comparison trial {i+1} gives no position feedback')
            return_start(page)
            page.locator('#nextTrial').click()
            page.clock.run_for(650)
    check(length == 12, 'single-angle single-repeat comparison contains four conditions times three tools')
    check(page.locator('#finalDialog').is_visible(), 'final awareness question precedes the comparison results')
    page.locator('#finalForm button').click()
    check(state(page) == 'finished', 'comparison completes all assignments once')
    counts = page.evaluate('window.__redirectTest.engine.session.attempts.reduce((o,t)=>(o[t.condition]=(o[t.condition]||0)+1,o),{})')
    check(set(counts.values()) == {3}, 'completed browser plan is balanced across all four conditions')
    check(not errors, 'full comparison flow has no uncaught JavaScript errors')
    page.close()

    # Mid-reach pause, stale callbacks, focus loss, data recovery and unavailable storage.
    page, errors = prepare(browser)
    learn(page)
    page.locator('#beginTrial').click()
    page.locator('#pause').click()
    page.clock.run_for(5000)
    check(state(page) == 'interrupted', 'pause cancels a delayed speech callback before it can start movement')
    check(page.evaluate('window.__redirectTest.sound.nodes.size') == 0, 'pause leaves no audio sources scheduled')
    page.locator('#pause').click()
    page.locator('#nextTrial').click()
    page.clock.run_for(650)
    begin(page)
    page.evaluate('window.dispatchEvent(new Event("blur"))')
    check(state(page) == 'interrupted', 'focus loss during reach records an invalid attempt')
    check(page.evaluate('window.__redirectTest.engine.session.index') == 0, 'interruptions do not advance the assignment')
    page.reload()
    check(state(page) == 'learn', 'reload restores the plan but requires relearning and setup checks')
    check(not page.locator('#calibrationCheck').is_checked() and not page.locator('#audioCheck').is_checked(), 'reload never silently reuses checked calibration or audio confirmation')
    check(not errors, 'interrupt-and-reload flow has no uncaught JavaScript errors')
    page.close()

    page, errors = prepare(browser, storage='Storage.prototype.setItem = function() { throw new DOMException("quota", "QuotaExceededError"); };')
    check(page.locator('#storageWarning').is_visible(), 'quota failure is visible while in-memory recording remains available')
    check(page.evaluate('window.__redirectTest.db.sessions.length') == 1, 'quota failure retains the new session in memory')
    check(not errors, 'storage failure causes no uncaught JavaScript errors')
    page.close()

    # Camera permission rejection through the real UI.
    page = browser.new_page()
    page.add_init_script('navigator.mediaDevices.getUserMedia = async () => { throw new DOMException("denied", "NotAllowedError"); };')
    page.goto(URL)
    page.locator('#camStart').click()
    check('許可' in page.locator('#notice').inner_text(), 'camera permission failure has an actionable message')
    check(page.locator('#startSession').is_disabled(), 'camera rejection cannot start a recording')
    page.close()

    # Additional recovery, keyboard and narrow-screen answer checks.
    page, errors = prepare(browser)
    page.reload()
    check(page.locator('#closeSavedSession').is_visible(), 'unfinished saved session can be closed without losing its data')
    page.locator('#closeSavedSession').click()
    check(page.evaluate('window.__redirectTest.engine.session.closed'), 'closing an unfinished session preserves and marks it closed')
    page.evaluate('(su) => window.__redirectTest.setSetup(su)', {**SETUP, 'P': {'x': 45, 'y': 0}})
    feed_timer(page)
    page.locator('#testLeft').click()
    page.locator('#calibrationCheck').check()
    page.locator('#audioCheck').check()
    page.locator('#startSession').click()
    check(page.evaluate('window.__redirectTest.db.sessions.length') == 2, 'changed calibration can start a separate session after closing the old one')
    page.set_viewport_size({'width': 390, 'height': 844})
    learn(page)
    begin(page)
    move(page)
    page.keyboard.press('Space')
    page.screenshot(path=str(OUT / 'redirect-answer-mobile.png'), full_page=True)
    check(page.locator('#answerForm').is_visible() and page.evaluate('document.documentElement.scrollWidth <= innerWidth'), 'actual response form fits a 390px screen without overflow')
    page.locator('[name=noticed][value=no]').focus()
    page.keyboard.press('Escape')
    check(state(page) == 'interrupted', 'Escape cancels an unanswered trial even while a radio input has focus')
    page.locator('#nextTrial').click()
    return_start(page)
    begin(page)
    move(page)
    page.keyboard.press('F')
    check(state(page) == 'answer' and page.evaluate('window.__redirectTest.engine.current.contact') == 'no', 'F records a failed reach and forces the contact response to no')
    answer(page, noticed='unsure')
    check(state(page) == 'finished' and page.evaluate('window.__redirectTest.engine.current.contact') == 'no', 'failed reach remains a completed negative outcome after answering')
    check(not errors, 'recovery and keyboard paths have no uncaught JavaScript errors')
    page.close()

    page = browser.new_page()
    page.add_init_script('localStorage.setItem("redirect.v2", "{broken-json");')
    page.goto(URL)
    check(page.locator('#storageWarning').is_visible(), 'malformed stored JSON produces a visible recovery warning')
    page.locator('#resultsOpen').click()
    with page.expect_download() as download:
        page.locator('#exportJson').click()
    download.value.save_as(OUT / 'recovered-storage.json')
    recovered = json.loads((OUT / 'recovered-storage.json').read_text(encoding='utf-8'))
    check(recovered['recoveredUnparsedRecord']['raw'] == '{broken-json', 'malformed original storage is preserved in the exported recovery data')
    page.close()

    # Generated video enters through HTMLVideoElement, homography and color tracking.
    page = browser.new_page(viewport={'width': 1440, 'height': 1000})
    page.add_init_script('''
      const synthetic = document.createElement('canvas'); synthetic.width=640; synthetic.height=480;
      const context=synthetic.getContext('2d');
      window.syntheticMarker={x:.2,y:.6};
      const paint=()=>{ context.fillStyle='#444';context.fillRect(0,0,640,480);context.fillStyle='#ff0000';context.beginPath();context.arc(window.syntheticMarker.x*640,window.syntheticMarker.y*480,12,0,Math.PI*2);context.fill(); };
      paint(); setInterval(paint,33);
      navigator.mediaDevices.getUserMedia=async()=>synthetic.captureStream(30);
      navigator.mediaDevices.enumerateDevices=async()=>[{kind:'videoinput',deviceId:'one',label:'Generated video 1'},{kind:'videoinput',deviceId:'two',label:'Generated video 2'}];
    ''')
    page.goto(URL + '?test=1')
    page.locator('#camStart').click()
    page.wait_for_function('document.querySelector("#video").readyState >= 2')
    rect = page.locator('#cam').bounding_box()
    for point in SETUP['corners']:
        page.locator('#cam').click(position={'x': rect['width'] * point['x'], 'y': rect['height'] * point['y']})
    check('シール' in page.locator('#setupPrompt').inner_text(), 'camera UI accepts four ordered A4 corners')
    page.locator('#cam').click(position={'x': rect['width'] * .2, 'y': rect['height'] * .6})
    page.locator('#cam').click(position={'x': rect['width'] * .15, 'y': rect['height'] * .9})
    page.wait_for_function('window.__redirectTest.isStable()')
    page.locator('#capturePosition').click()
    page.evaluate('window.syntheticMarker = {x:.9,y:.8}')
    page.wait_for_function('window.__redirectTest.hand && window.__redirectTest.hand.x > 38')
    page.wait_for_function('window.__redirectTest.isStable()')
    page.locator('#capturePosition').click()
    recorded = page.evaluate('window.__redirectTest.setup')
    check(abs(recorded['P']['x'] - 39.6) < .4, 'video marker is mapped to the expected physical-plane centimetres')
    check(recorded['S'] is not None and recorded['P'] is not None, 'S and P are registered explicitly through the camera UI')
    page.screenshot(path=str(OUT / 'redirect-camera-calibrated.png'), full_page=True)
    page.locator('#camSel').select_option('two')
    page.wait_for_function('window.__redirectTest.setup.corners.length === 0')
    check(page.evaluate('window.__redirectTest.setup.S === null && window.__redirectTest.setup.P === null'), 'switching cameras invalidates the entire plane/S/P calibration')
    page.close()

    # Exercise the production audio renderer, not just a mocked Web Audio graph.
    page = browser.new_page()
    page.goto(URL)
    result = page.evaluate('''async () => {
      const render = async (x) => {
        const offline = new OfflineAudioContext(2,24000,48000);
        const a = new RedirectAudio();
        a.context=offline;a.master=offline.createGain();a.master.gain.value=.25;a.master.connect(offline.destination);
        a.panner=offline.createPanner();a.panner.panningModel='HRTF';a.panner.rolloffFactor=0;a.panner.connect(a.master);
        a.buffer=offline.createBuffer(1,7200,48000);const data=a.buffer.getChannelData(0);
        for(let i=0;i<data.length;i++)data[i]=Math.sin(i*1.79)*.25*Math.min(1,i/240,(7199-i)/240);
        a.position({frame:'head',source:{x,y:0}},{body:{x:0,y:0},headBehind:0,earAbove:5});
        a.pulse(0,.65);const b=await offline.startRendering();
        const power=[0,1].map(c=>b.getChannelData(c).reduce((s,v)=>s+v*v,0));
        return {power,finite:[...b.getChannelData(0),...b.getChannelData(1)].every(Number.isFinite),peak:Math.max(...b.getChannelData(0).map(Math.abs),...b.getChannelData(1).map(Math.abs))};
      };
      return {left:await render(-40),right:await render(40)};
    }''')
    check(result['left']['finite'] and result['right']['finite'], 'real OfflineAudioContext renders finite binaural samples')
    check(result['left']['power'][0] > result['left']['power'][1] and result['right']['power'][1] > result['right']['power'][0], 'actual HRTF rendering preserves left/right source orientation')
    check(0 < result['left']['peak'] < 1 and 0 < result['right']['peak'] < 1, 'rendered test output is non-silent and below digital clipping')
    page.close()
    browser.close()

report = {'checks': len(CHECKS), 'passed': CHECKS, 'browser': 'Playwright Chromium', 'scope': 'synthetic integration; not a human experiment'}
(OUT / 'browser-report.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
print(f'ALL {len(CHECKS)} BROWSER CHECKS PASSED', flush=True)
