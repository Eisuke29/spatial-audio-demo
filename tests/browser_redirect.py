"""Chromium integration: one-screen procedural UI, camera projection and trial recovery.
Run from audio-demo with the local server on port 8765. All movement is synthetic.
"""
from pathlib import Path
import json
import math
from playwright.sync_api import sync_playwright

URL = 'http://127.0.0.1:8765/redirect.html'
OUT = Path(__file__).resolve().parent.parent / '.test-artifacts'
OUT.mkdir(exist_ok=True)
CHECKS = []
SETUP = {
    'corners': [{'x': .1, 'y': .55}, {'x': .6, 'y': .55}, {'x': .6, 'y': .2}, {'x': .1, 'y': .2}],
    'color': {'h': 0, 's': 1, 'v': 1}, 'body': {'x': 0, 'y': 0},
    'S': {'x': 0, 'y': 10}, 'P': {'x': 40, 'y': 0}, 'headBehind': 15, 'earAbove': 35, 'tol': 16
}


def check(condition, text):
    assert condition, text
    CHECKS.append(text)
    print('PASS', text, flush=True)


def state(page):
    return page.evaluate('window.__redirectTest.engine.state')


def fits(page, text):
    geometry = page.evaluate('''() => {
      const dialog=document.querySelector('dialog[open]');
      const nodes=[...document.querySelectorAll('button,input,select,textarea')].filter(n=>!n.disabled && n.checkVisibility() && n.getClientRects().length && (!dialog || dialog.contains(n)));
      const bad=nodes.filter(n=>{const r=n.getBoundingClientRect();return r.left<-.5||r.top<-.5||r.right>innerWidth+.5||r.bottom>innerHeight+.5;}).map(n=>n.id||n.name||n.textContent);
      const covered=nodes.filter(n=>{const r=n.getBoundingClientRect(),hit=document.elementFromPoint(r.left+r.width/2,r.top+r.height/2);return !hit || !(n.contains(hit)||hit.contains(n)||n.closest('label')&&n.closest('label')===hit.closest('label'));}).map(n=>n.id||n.name||n.textContent);
      return {w:innerWidth,h:innerHeight,sw:document.documentElement.scrollWidth,sh:document.documentElement.scrollHeight,body:document.body.scrollHeight,bad,covered};
    }''')
    check(geometry['sw'] <= geometry['w'] and geometry['sh'] <= geometry['h'] and geometry['body'] <= geometry['h'] and not geometry['bad'] and not geometry['covered'], f'{text}: no scrolling, clipping or covered controls {geometry}')


def feed_timer(page):
    page.evaluate('''() => {window.testTarget={...window.__redirectTest.setup.S};clearInterval(window.testFeed);window.testFeed=setInterval(()=>window.__redirectTest.feed(window.testTarget),40);}''')


def settings_visible(page):
    if not page.locator('#conditionsPanel').is_visible():
        page.locator('#conditionsOpen').click()
        return True
    return False


def confirm_preparation(page):
    page.locator('#verifySetup').click()
    page.locator('#testLeft').click()
    page.locator('#testRight').click()
    page.locator('#confirmAudio').click()


def prepare(browser, kind='demo', width=1280, height=720, storage=None, angle=20):
    page = browser.new_page(viewport={'width': width, 'height': height})
    errors = []
    page.on('pageerror', lambda e: errors.append(str(e)))
    page.set_default_timeout(6000)
    if storage:
        page.add_init_script(storage)
    page.clock.install()
    page.goto(URL + '?test=1')
    page.evaluate('(su)=>window.__redirectTest.setSetup(su)', SETUP)
    feed_timer(page)
    modal = settings_visible(page)
    page.locator('#kind').select_option(kind)
    if kind == 'demo':
        page.locator('#angle').select_option(str(angle))
    if kind != 'demo':
        page.locator('#repeats').fill('1')
        page.locator('[name=angles][value="20"]').uncheck()
    if modal:
        page.locator('[data-close=conditionsDialog]').click()
    confirm_preparation(page)
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
    start = page.evaluate('window.testTarget')
    for i in range(1, 13):
        page.evaluate('(p)=>{window.testTarget=p;}', {'x': start['x'] + (destination['x'] - start['x']) * i / 12, 'y': start['y'] + (destination['y'] - start['y']) * i / 12})
        page.clock.run_for(100)


def answer(page, contact='yes', noticed='no'):
    page.locator(f'[name=noticed][value={noticed}]').check()
    if page.locator('#contactField').is_visible() and page.locator('[name=contact]').first.is_enabled():
        page.locator(f'[name=contact][value={contact}]').check()
    page.locator('[name=confidence][value="3"]').check()
    page.locator('#answerForm button[type=submit]').click()


def return_start(page):
    move(page, page.evaluate('window.__redirectTest.setup.S'))
    page.clock.run_for(650)


def assert_projection(page, text):
    data = page.evaluate('''() => {
      const t=window.__redirectTest,g=RedirectCore.geometry(t.setup,Number(document.querySelector('#angle').value));
      return ['A','M','B'].map(id=>{const n=document.querySelector('#target'+id),p=t.project(g[id]);return {id,hidden:n.hasAttribute('hidden'),label:n.querySelector('text').textContent,dx:Number(n.dataset.x)-p.x,dy:Number(n.dataset.y)-p.y};});
    }''')
    check(all(not n['hidden'] and abs(n['dx']) < .001 and abs(n['dy']) < .001 for n in data) and [n['label'] for n in data] == ['A', 'B', 'C'], text)
    geometry=page.evaluate('''()=>{const c=document.querySelector('#cam'),s=document.querySelector('#objectOverlay'),r=c.getBoundingClientRect(),t=s.getBoundingClientRect();const p=new DOMPoint(250,200).matrixTransform(s.getScreenCTM());return {ratio:r.width/r.height,expected:c.width/c.height,dx:r.left-t.left,dy:r.top-t.top,px:p.x-r.left-250/c.width*r.width,py:p.y-r.top-200/c.height*r.height};}''')
    check(abs(geometry['ratio']-geometry['expected'])<.001 and all(abs(geometry[k])<.01 for k in ['dx','dy','px','py']),text+' / video and SVG share exact aspect ratio and screen coordinates')


GENERATED_CAMERA = '''
const synthetic=document.createElement('canvas');synthetic.width=640;synthetic.height=480;
const ctx=synthetic.getContext('2d');window.syntheticMarker={x:.1,y:.55-.35*10/21};
const paint=()=>{
  ctx.fillStyle='#bca88c';ctx.fillRect(0,0,640,480);
  ctx.strokeStyle='#ab977d';ctx.lineWidth=1;
  for(let y=0;y<480;y+=21){ctx.beginPath();ctx.moveTo(0,y);ctx.lineTo(640,y+5);ctx.stroke();}
  ctx.fillStyle='#fafaf5';ctx.fillRect(64,96,320,168);
  const px=(.1+.5*40/29.7)*640,py=.55*480;
  ctx.fillStyle='#555b63';ctx.beginPath();ctx.arc(px,py,19,0,Math.PI*2);ctx.fill();
  ctx.fillStyle='#b8bec5';ctx.beginPath();ctx.arc(px,py-2,14,0,Math.PI*2);ctx.fill();
  ctx.fillStyle='#ff0000';ctx.beginPath();ctx.arc(window.syntheticMarker.x*640,window.syntheticMarker.y*480,9,0,Math.PI*2);ctx.fill();
};paint();setInterval(paint,33);
navigator.mediaDevices.getUserMedia=async()=>synthetic.captureStream(30);
navigator.mediaDevices.enumerateDevices=async()=>[{kind:'videoinput',deviceId:'one',label:'Generated video 1'},{kind:'videoinput',deviceId:'two',label:'Generated video 2'}];
'''


with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    initial = browser.new_page(viewport={'width': 1440, 'height': 900})
    initial.goto(URL)
    check(initial.evaluate('typeof window.__redirectTest') == 'undefined', 'production URL exposes no test-input hook')
    check(initial.locator('#camStart').is_visible() and initial.locator('#startSession').is_hidden(), 'initial screen offers only the current preparation action')
    check(initial.locator('#stageTitle').inner_text() == 'カメラを開始してください', 'initial heading is an instruction, not a catchphrase')
    for w,h in [(1920,1080),(1440,900),(1366,768),(1280,720),(1024,600),(768,1024),(390,844),(375,667),(320,568),(844,390),(568,320),(1280,360)]:
        initial.set_viewport_size({'width':w,'height':h});initial.wait_for_timeout(100)
        fits(initial,f'initial {w}x{h}')
        if w == 320:
            initial.locator('#conditionsOpen').click();fits(initial,'mobile condition dialog');initial.locator('[data-close=conditionsDialog]').click()
    initial.screenshot(path=str(OUT/'ui21-initial-mobile.png'))
    initial.set_viewport_size({'width':1280,'height':720});initial.wait_for_timeout(100)
    initial.screenshot(path=str(OUT/'ui21-initial.png'))
    initial.locator('#settingsOpen').click();fits(initial,'advanced settings');initial.locator('#recordingTab').click();fits(initial,'recording settings');initial.locator('[data-close=settingsDialog]').click()
    initial.locator('#helpOpen').click();fits(initial,'short help');initial.locator('[data-close=helpDialog]').click();initial.close()

    page,errors=prepare(browser)
    check(state(page)=='learn','preparation enters learning')
    check(not page.locator('.setup-panel').is_visible(),'participant view hides operator preparation')
    assert_projection(page,'learning A/B/C are projected onto the calibrated camera frame')
    check(page.locator('#proxyOverlay').get_attribute('hidden') is not None,'learning hides the P label')
    check(page.locator('#learnDone').is_disabled(),'learning retains its minimum viewing time')
    fits(page,'learning 1280x720');page.screenshot(path=str(OUT/'ui21-learning.png'))
    learn(page);fits(page,'return to S');begin(page)
    check(page.locator('#cameraView').is_hidden() and page.locator('#stageMask').is_visible(),'reach hides the entire camera and its object overlay')
    fits(page,'reach controls');move(page);page.clock.run_for(600)
    check(state(page)=='reach','dwelling still does not count as contact')
    page.keyboard.press('Space');fits(page,'answer form 1280x720')
    check(page.locator('[name=contact]:checked').count()==0,'contact remains an independent response')
    page.locator('#answerForm button').click()
    check(page.locator('#answerError').is_visible() and state(page)=='answer','incomplete answers show an inline error without advancing')
    answer(page);check(state(page)=='finished','one valid response finishes the demo')
    fits(page,'feedback');page.screenshot(path=str(OUT/'ui21-feedback.png'))
    page.locator('#resultsOpen').click()
    with page.expect_download() as d:page.locator('#exportTrials').click()
    d.value.save_as(OUT/'ui21-trials.csv')
    with page.expect_download() as d:page.locator('#exportJson').click()
    d.value.save_as(OUT/'ui21-all.json')
    data=json.loads((OUT/'ui21-all.json').read_text(encoding='utf-8'))
    check(data['sessions'][0]['config']['interfaceVersion']=='2.1.1' and data['sessions'][0]['config']['targetLabels']=={'A':'A','M':'B','B':'C'},'records preserve the new UI version and legacy-ID to A/B/C mapping')
    check(len(data['sessions'][0]['attempts'][0]['path'])>20,'trajectory and audio requests survive export')
    check(not errors,'demo has no uncaught browser errors');page.close()

    for w,h in [(1024,600),(390,844),(320,568),(568,320)]:
        page,errors=prepare(browser,width=w,height=h)
        fits(page,f'learning {w}x{h}');learn(page);begin(page);move(page);page.keyboard.press('Space')
        fits(page,f'answers {w}x{h}')
        page.screenshot(path=str(OUT/f'ui21-answer-{w}.png'))
        page.locator('[name=noticed][value=no]').focus();page.keyboard.press('Escape')
        check(state(page)=='interrupted',f'Esc works from a focused radio at {w}px')
        check(not errors,f'no browser errors at {w}px');page.close()

    page,errors=prepare(browser,'pilot');learn(page)
    n=page.evaluate('window.__redirectTest.engine.session.plan.length')
    for i in range(n):
        begin(page);move(page);page.keyboard.press('Space');answer(page,contact='no' if i%3==0 else 'yes',noticed='unsure' if i%4==0 else 'no')
        if i<n-1:
            check(page.locator('#cameraView').is_hidden() and page.locator('#feedback').is_hidden(),f'comparison {i+1}: no camera or answer feedback')
            return_start(page);page.locator('#nextTrial').click();page.clock.run_for(650)
    check(n==12 and page.locator('#finalDialog').is_visible(),'all 4x3 assignments end in the final awareness question')
    page.locator('#finalForm button').click()
    counts=page.evaluate('window.__redirectTest.engine.session.attempts.reduce((a,t)=>(a[t.condition]=(a[t.condition]||0)+1,a),{})')
    check(set(counts.values())=={3},'browser comparison remains balanced')
    check(not errors,'comparison has no uncaught browser errors');page.close()

    page,errors=prepare(browser,angle=10);learn(page);page.locator('#beginTrial').click();page.locator('#pause').click();page.clock.run_for(5000)
    check(state(page)=='interrupted' and page.evaluate('window.__redirectTest.sound.nodes.size')==0,'pause cancels pending instruction callbacks and audio')
    page.locator('#pause').click();page.locator('#nextTrial').click();page.clock.run_for(650);begin(page)
    page.evaluate('window.dispatchEvent(new Event("blur"))')
    check(state(page)=='interrupted' and page.evaluate('window.__redirectTest.engine.session.index')==0,'focus loss preserves the assignment')
    page.locator('#nextTrial').click();page.clock.run_for(650);begin(page)
    page.set_viewport_size({'width':1200,'height':700})
    page.wait_for_function('window.__redirectTest.engine.state==="interrupted" && window.__redirectTest.engine.current.invalidReason==="viewport_changed"')
    check(state(page)=='interrupted' and page.evaluate('window.__redirectTest.engine.current.invalidReason')=='viewport_changed','viewport resize interrupts a reach without advancing its assignment')
    page.reload();check(state(page)=='learn' and not page.locator('#calibrationCheck').is_checked(),'reload restores the plan and requires preparation confirmation')
    check(page.locator('#angle').input_value()=='10' and page.locator('#angle').is_disabled(),'reload restores and locks the original condition choices')
    check(page.locator('#closeSavedSession').is_visible(),'starting separately is available before redoing preparation')
    page.evaluate('(su)=>window.__redirectTest.setSetup(su)',SETUP);feed_timer(page);confirm_preparation(page)
    page.locator('#closeSavedSession').click();check(page.evaluate('window.__redirectTest.engine.session.closed'),'old session can be closed without deleting it')
    check(page.locator('#angle').is_enabled(),'closing the old record unlocks new condition choices')
    page.locator('#startSession').click();check(page.evaluate('window.__redirectTest.db.sessions.length')==2,'a new session is stored separately')
    learn(page);begin(page);move(page);page.keyboard.press('F');answer(page,noticed='unsure')
    check(state(page)=='finished' and page.evaluate('window.__redirectTest.engine.current.contact')=='no','F remains a completed failed reach outcome')
    check(not errors,'recovery has no uncaught browser errors');page.close()

    page,errors=prepare(browser,storage='Storage.prototype.setItem=function(){throw new DOMException("quota","QuotaExceededError")};')
    check(page.locator('#storageWarning').is_visible() and page.evaluate('window.__redirectTest.db.sessions.length')==1,'quota failure is visible and retains data in memory');page.close()
    page=browser.new_page();page.add_init_script('localStorage.setItem("redirect.v2","{broken-json")');page.goto(URL);page.locator('#resultsOpen').click()
    with page.expect_download() as d:page.locator('#exportJson').click()
    d.value.save_as(OUT/'ui21-recovered.json');check(json.loads((OUT/'ui21-recovered.json').read_text(encoding='utf-8'))['recoveredUnparsedRecord']['raw']=='{broken-json','malformed stored data is preserved in the recovery export');page.close()

    # Full procedural preparation with real HTMLVideoElement frames and the production tracker.
    page=browser.new_page(viewport={'width':1280,'height':720});page.set_default_timeout(7000);page.add_init_script(GENERATED_CAMERA)
    errors=[];page.on('pageerror',lambda e:errors.append(str(e)));page.goto(URL+'?test=1');page.locator('#camStart').click()
    page.wait_for_function('document.querySelector("#video").readyState>=2');rect=page.locator('#cam').bounding_box()
    def click_image(x,y):page.locator('#cam').click(position={'x':rect['width']*x,'y':rect['height']*y})
    for i,point in enumerate(SETUP['corners']):
        check(['手前左','手前右','奥右','奥左'][i] in page.locator('#stageTitle').inner_text(),f'corner {i+1} has one explicit instruction')
        click_image(point['x'],point['y']);fits(page,f'paper step {i+1}')
    check(page.evaluate('window.__redirectTest.phase')=='color','four paper points advance to color selection')
    page.locator('#setupBack').click();check(page.evaluate('window.__redirectTest.setup.corners.length')==3,'back returns to the preceding corner without restarting everything')
    click_image(SETUP['corners'][3]['x'],SETUP['corners'][3]['y'])
    click_image(.1,.55-.35*10/21);click_image(.1,.55)
    page.wait_for_function('window.__redirectTest.isStable()');page.locator('#capturePosition').click()
    page.evaluate('window.syntheticMarker={x:.1+.5*40/29.7,y:.55}')
    page.wait_for_function('window.__redirectTest.hand && window.__redirectTest.hand.x>39');page.wait_for_function('window.__redirectTest.isStable()');page.locator('#capturePosition').click()
    recorded=page.evaluate('window.__redirectTest.setup')
    check(abs(recorded['P']['x']-40)<.35 and abs(recorded['P']['y'])<.35,'raw video marker maps to the expected physical centimetres')
    assert_projection(page,'A/B/C positions match the inverse calibration over the actual video')
    check(page.evaluate('window.__redirectTest.objectsInFrame()'),'all three objects fit inside the video')
    fits(page,'camera object confirmation');page.screenshot(path=str(OUT/'ui21-camera-overlay.png'))
    page.locator('#angle').select_option('5')
    check(page.evaluate('''() => {
      const nodes=[...document.querySelectorAll('.object')];
      return nodes.every(node=>{const r=node.querySelector('text').getBBox(),points=[[r.x,r.y],[r.x+r.width,r.y],[r.x,r.y+r.height],[r.x+r.width,r.y+r.height]];
        return nodes.filter(n=>n!==node).every(n=>points.every(([x,y])=>!n.querySelector('.object-face').isPointInFill(new DOMPoint(x,y))));});
    }'''),'five-degree target letters are not obscured by adjacent objects')
    page.screenshot(path=str(OUT/'ui21-camera-5deg.png'))
    page.locator('#angle').select_option('20')
    page.set_viewport_size({'width':1024,'height':600});page.wait_for_timeout(100)
    assert_projection(page,'camera projection after viewport resize');fits(page,'resized camera confirmation')
    page.set_viewport_size({'width':1280,'height':720});page.wait_for_timeout(100)
    # Preview settings should not cause the red virtual object to contaminate red tracking.
    page.locator('#tool').select_option('B');page.wait_for_timeout(200)
    check(abs(page.evaluate('window.__redirectTest.hand.x')-40)<.35,'virtual red overlay is excluded from raw color tracking')
    page.locator('#verifySetup').click();check(page.locator('#confirmAudio').is_disabled(),'audio step requires both left and right checks')
    page.locator('#testLeft').click();check(page.locator('#confirmAudio').is_disabled(),'one channel alone cannot finish audio preparation')
    page.locator('#testRight').click();page.locator('#confirmAudio').click();page.locator('#startSession').click()
    check(page.locator('#proxyOverlay').get_attribute('hidden') is not None,'real-video learning hides the explicit P label')
    page.screenshot(path=str(OUT/'ui21-camera-learning.png'))
    page.locator('#operator').click();page.locator('#camSel').select_option('device:two')
    page.wait_for_function('window.__redirectTest.setup.corners.length===0')
    check(page.evaluate('window.__redirectTest.setup.S===null && window.__redirectTest.setup.P===null'),'camera change invalidates the projection and S/P registration')
    check(not errors,'procedural camera flow has no uncaught browser errors');page.close()

    page=browser.new_page(viewport={'width':1280,'height':720})
    page.add_init_script(GENERATED_CAMERA.replace('480','360').replace('64,96,320,168','64,72,320,126'))
    page.goto(URL+'?test=1');page.locator('#camStart').click()
    page.wait_for_function('document.querySelector("#video").readyState>=2')
    page.evaluate('(su)=>window.__redirectTest.setSetup(su)',SETUP)
    page.locator('#angle').select_option('5')
    assert_projection(page,'16:9 camera and five-degree objects')
    check(page.evaluate('document.querySelector("#cam").width/document.querySelector("#cam").height')==640/360,'wide camera retains its source aspect ratio')
    page.screenshot(path=str(OUT/'ui21-camera-wide.png'))
    page.locator('#angle').select_option('40')
    check(page.locator('#verifySetup').is_disabled() and '外' in page.locator('#stageText').inner_text(),'out-of-frame targets block confirmation and explain recovery')
    page.close()

    page=browser.new_page();page.add_init_script('navigator.mediaDevices.getUserMedia=async()=>{throw new DOMException("denied","NotAllowedError")}');page.goto(URL);page.locator('#camStart').click()
    check('許可' in page.locator('#notice').inner_text() and page.locator('#camStart').is_visible(),'camera denial gives a fix and leaves retry available');page.close()
    browser_version=browser.version;browser.close()

report={'checks':len(CHECKS),'passed':CHECKS,'browser':browser_version,'interface_version':'2.1.1','scope':'synthetic software integration; not a human experiment'}
(OUT/'browser-report.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8')
print(f'ALL {len(CHECKS)} BROWSER CHECKS PASSED',flush=True)
