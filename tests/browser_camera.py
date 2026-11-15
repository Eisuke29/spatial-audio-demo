"""Camera selection/lifecycle tests with generated video; no real iPad hardware.
Run after starting the localhost server: python -X utf8 tests/browser_camera.py [chromium|webkit]
"""
import ast
import json
import sys
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / '.test-artifacts'
OUT.mkdir(exist_ok=True)
constants = {}
for node in ast.parse((ROOT / 'tests/browser_redirect.py').read_text(encoding='utf-8')).body:
    if isinstance(node, ast.Assign):
        for target in node.targets:
            if isinstance(target, ast.Name) and target.id in ['GENERATED_CAMERA', 'SETUP']:
                constants[target.id] = ast.literal_eval(node.value)
VIDEO = constants['GENERATED_CAMERA'].split('navigator.mediaDevices.getUserMedia=')[0]
FIXTURE = VIDEO + r'''
window.cameraFixture={calls:[],tracks:[],stops:[],permission:false,enumFail:false,failNext:null,devices:[
  {kind:'videoinput',deviceId:'rear',label:'iPad Back Camera',facingMode:'environment'},
  {kind:'videoinput',deviceId:'front',label:'iPad Front Camera',facingMode:'user'}]};
navigator.mediaDevices.getSupportedConstraints=()=>({facingMode:true,deviceId:true,width:true,height:true});
navigator.mediaDevices.getUserMedia=async constraints=>{
  const f=window.cameraFixture;f.calls.push(JSON.parse(JSON.stringify(constraints)));
  if(f.tracks.some(t=>t.readyState==='live'))throw new DOMException('Previous camera still active','NotReadableError');
  if(f.failNext){const name=f.failNext;f.failNext=null;throw new DOMException('Fixture failure',name);}
  if(f.delay)await new Promise(resolve=>f.resume=resolve);
  const v=constraints.video;
  const device=v.deviceId?.exact?f.devices.find(d=>d.deviceId===v.deviceId.exact):v.facingMode?.exact?f.devices.find(d=>d.facingMode===v.facingMode.exact):f.devices.find(d=>d.facingMode==='environment')||f.devices[0];
  if(!device)throw new DOMException('Unavailable camera','NotFoundError');
  const stream=synthetic.captureStream(30),track=stream.getVideoTracks()[0],settings=track.getSettings.bind(track),stop=track.stop.bind(track);
  track.getSettings=()=>({...settings(),deviceId:device.deviceId,facingMode:device.facingMode});
  track.stop=()=>{f.stops.push(device.deviceId);stop();};f.tracks.push(track);f.permission=true;
  return stream;
};
navigator.mediaDevices.enumerateDevices=async()=>{
  const f=window.cameraFixture;if(f.enumFail)throw new DOMException('List unavailable','NotReadableError');
  return f.permission?[...f.devices,{kind:'audioinput',deviceId:'mic',label:'Microphone'}]:[{kind:'videoinput',deviceId:'',label:''}];
};
'''
URL = 'http://127.0.0.1:8765/redirect.html?test=1'
checks = []


def check(condition, text):
    assert condition, text
    checks.append(text)
    print('PASS', text, flush=True)


def connected(page, calls):
    page.wait_for_function('(n)=>cameraFixture.calls.length===n && !document.querySelector("#camSel").disabled', arg=calls)
    page.wait_for_function('document.querySelector("#video").readyState>=2')


def fits(page, text):
    bad = page.evaluate('''()=>{
      const nodes=[...document.querySelectorAll('button,input,select')].filter(n=>n.checkVisibility()&&!n.disabled);
      const bad=nodes.filter(n=>{const r=n.getBoundingClientRect();return r.left<-.5||r.top<-.5||r.right>innerWidth+.5||r.bottom>innerHeight+.5;});
      return document.documentElement.scrollWidth>innerWidth||document.documentElement.scrollHeight>innerHeight||bad.length;
    }''')
    check(not bad, text)


def webkit_ui_only(browser, ipad):
    # Windows Playwright WebKit has neither mediaDevices nor canvas.captureStream.
    # Exercise its UI and outgoing constraints; do not claim video capture coverage.
    shim = '''
    window.cameraFixture={calls:[],permission:false};
    const media=new EventTarget();
    media.getSupportedConstraints=()=>({facingMode:true,deviceId:true});
    media.enumerateDevices=async()=>cameraFixture.permission?[{kind:'videoinput',deviceId:'rear',label:'Back Camera'},{kind:'videoinput',deviceId:'front',label:'Front Camera'}]:[];
    media.getUserMedia=async c=>{cameraFixture.calls.push(c);cameraFixture.permission=true;throw new DOMException('Mock unavailable camera','NotReadableError');};
    Object.defineProperty(navigator,'mediaDevices',{value:media});
    '''
    errors = []
    page = browser.new_page(**ipad);page.add_init_script(shim)
    page.on('pageerror', lambda e: errors.append(str(e)));page.goto(URL)
    check(page.locator('#camSel').is_visible() and page.evaluate('cameraFixture.calls.length') == 0, 'WebKit camera picker appears without requesting access')
    for choice, facing in [('facing:user', 'user'), ('facing:environment', 'environment')]:
        page.locator('#camSel').select_option(choice);page.locator('#camStart').click()
        page.wait_for_function('document.querySelector("#notice").textContent.includes("別のアプリ")')
        check(page.evaluate('cameraFixture.calls.at(-1).video.facingMode.exact') == facing, f'WebKit sends the chosen {facing} facing constraint')
        check(page.locator('#camSel').is_enabled() and page.locator('#camStart').is_enabled(), f'WebKit retains selection and retry after {facing} capture failure')
    page.evaluate('navigator.mediaDevices.dispatchEvent(new Event("devicechange"))')
    page.locator('#camSel option[value="device:rear"]').wait_for(state='attached')
    page.locator('#camSel').select_option('device:rear');page.locator('#camStart').click()
    page.wait_for_function('cameraFixture.calls.length===3 && !document.querySelector("#camSel").disabled')
    check(page.evaluate('cameraFixture.calls.at(-1).video.deviceId.exact') == 'rear', 'WebKit sends the named device ID')
    page.locator('#settingsOpen').click();page.locator('#cameraPick').click()
    check(page.evaluate('document.activeElement.id') == 'camSel', 'WebKit settings returns focus to the camera picker')
    page.screenshot(path=str(OUT / 'camera-webkit-ipad.png'))
    check(not errors, 'WebKit UI and request handling have no uncaught page errors');page.close()
    for w, h in [(1194, 834), (834, 1194), (1024, 768), (768, 1024), (390, 844), (320, 568), (568, 320)]:
        page = browser.new_page(viewport={'width': w, 'height': h});page.add_init_script(shim);page.goto(URL)
        fits(page, f'WebKit camera chooser fits {w}x{h}');page.close()


engine = sys.argv[1] if len(sys.argv) > 1 else 'chromium'
with sync_playwright() as p:
    browser = getattr(p, engine).launch(headless=True)
    ipad = dict(p.devices['iPad Pro 11'])
    ipad.pop('default_browser_type', None)
    if engine == 'webkit':
        probe = browser.new_page();probe.goto(URL)
        capture = probe.evaluate('!!navigator.mediaDevices && typeof HTMLCanvasElement.prototype.captureStream==="function"');probe.close()
        if not capture:
            webkit_ui_only(browser, ipad)
            version = browser.version;browser.close()
            (OUT / 'camera-webkit-report.json').write_text(json.dumps({'engine': engine, 'version': version, 'checks': len(checks), 'passed': checks, 'scope': 'WebKit Windows UI and outgoing constraints using a media API shim; no capture backend and no physical iPad'}, ensure_ascii=False, indent=2), encoding='utf-8')
            print(f'ALL {len(checks)} WEBKIT UI/CONSTRAINT CHECKS PASSED (NO CAPTURE BACKEND)', flush=True)
            sys.exit(0)
    page = browser.new_page(**ipad)
    page.set_default_timeout(10000)
    errors = []
    page.on('pageerror', lambda e: errors.append(str(e)))
    page.add_init_script(FIXTURE)
    page.goto(URL)
    check(page.locator('#camSel').is_visible(), 'camera picker is visible before permission')
    check(page.evaluate('cameraFixture.calls.length') == 0, 'opening the page does not request camera access')
    check(page.locator('#camSel option[value="facing:user"]').count() == 1 and page.locator('#camSel option[value="facing:environment"]').count() == 1, 'front and rear choices exist before device labels are exposed')
    page.locator('#camSel').select_option('facing:user')
    check(page.evaluate('cameraFixture.calls.length') == 0, 'choosing before start does not activate the camera')
    page.locator('#camStart').click();connected(page, 1)
    check(page.evaluate('cameraFixture.calls[0].video.facingMode.exact') == 'user' and page.evaluate('cameraFixture.calls[0].audio') is False, 'front selection requests the front camera without microphone')
    check(page.locator('#camSel option[value="device:rear"]').inner_text() == 'iPad Back Camera' and page.locator('#camSel option[value="device:front"]').inner_text() == 'iPad Front Camera', 'permission refreshes the named cameras on this device')
    check(page.locator('#camSel option[value="device:mic"]').count() == 0, 'microphones never appear in the camera list')
    page.evaluate('(su)=>window.__redirectTest.setSetup(su)', constants['SETUP'])
    page.locator('#camSel').select_option('facing:environment');connected(page, 2)
    check(page.evaluate('cameraFixture.tracks[0].readyState') == 'ended' and page.evaluate('cameraFixture.calls[1].video.facingMode.exact') == 'environment', 'switching to rear releases the front camera before acquiring the next')
    check(page.evaluate('window.__redirectTest.setup.corners.length===0 && window.__redirectTest.setup.S===null && window.__redirectTest.setup.P===null && window.__redirectTest.setup.color===null'), 'switching clears geometry, S/P and camera-dependent marker color')
    page.locator('#camSel').select_option('device:front');connected(page, 3)
    check(page.evaluate('cameraFixture.calls[2].video.deviceId.exact') == 'front' and page.evaluate('cameraFixture.calls[2].video.facingMode===undefined'), 'named-device selection uses its exact device ID')
    page.evaluate('cameraFixture.failNext="NotReadableError"')
    page.locator('#camSel').select_option('facing:environment')
    page.wait_for_function('!document.querySelector("#camSel").disabled')
    check(page.locator('#camStart').is_visible() and '別のアプリ' in page.locator('#notice').inner_text() and page.evaluate('cameraFixture.tracks.every(t=>t.readyState==="ended")'), 'failed switching stops old tracks and leaves a usable retry')
    page.locator('#camSel').select_option('auto');page.locator('#camStart').click();connected(page, 5)
    check(page.evaluate('cameraFixture.calls[4].video.facingMode.ideal') == 'environment', 'automatic mode prefers rear without requiring it')
    page.evaluate('cameraFixture.enumFail=true')
    page.locator('#camSel').select_option('facing:user');connected(page, 6)
    check(page.locator('#notice').inner_text() == '' and page.evaluate('cameraFixture.tracks.at(-1).readyState') == 'live', 'a device-list error does not discard a working camera')
    page.evaluate('cameraFixture.enumFail=false;cameraFixture.devices.push({kind:"videoinput",deviceId:"usb",label:"USB camera"});navigator.mediaDevices.dispatchEvent(new Event("devicechange"))')
    page.locator('#camSel option[value="device:usb"]').wait_for(state='attached')
    check(page.locator('#camSel').input_value() == 'facing:user', 'device changes refresh the list without changing the chosen camera')
    page.locator('#camSel').select_option('device:usb');connected(page, 7)
    check(page.evaluate('cameraFixture.calls[6].video.deviceId.exact') == 'usb', 'newly attached camera can be selected')
    page.evaluate('cameraFixture.delay=true')
    page.locator('#camSel').select_option('facing:user')
    check(page.locator('#camSel').is_disabled(), 'the picker is locked while a camera switch is pending')
    page.evaluate('cameraFixture.delay=false;cameraFixture.resume()');connected(page, 8)
    page.locator('#settingsOpen').click();page.locator('#cameraPick').click()
    check(page.evaluate('document.activeElement.id') == 'camSel', 'settings returns focus to the same visible camera picker')
    page.reload()
    check(page.locator('#camSel').input_value() == 'facing:user' and page.evaluate('cameraFixture.calls.length') == 0, 'reload remembers the selection and waits for an explicit start')
    page.locator('#camStart').click();connected(page, 1)
    check(page.evaluate('cameraFixture.calls[0].video.facingMode.exact') == 'user', 'restarting honors the remembered front camera')
    check(not errors, 'camera switching has no uncaught page errors')
    page.screenshot(path=str(OUT / f'camera-{engine}-ipad.png'));page.close()

    for w, h in [(1194, 834), (834, 1194), (1024, 768), (768, 1024), (390, 844), (320, 568), (568, 320)]:
        page = browser.new_page(viewport={'width': w, 'height': h})
        page.add_init_script(FIXTURE);page.goto(URL)
        fits(page, f'camera chooser fits {w}x{h}')
        page.close()
    page = browser.new_page()
    page.add_init_script(FIXTURE + 'cameraFixture.enumFail=true;')
    page.goto(URL);page.locator('#camSel').select_option('facing:environment');page.locator('#camStart').click();connected(page, 1)
    check(page.evaluate('cameraFixture.tracks.at(-1).readyState') == 'live', 'rear camera can start even when enumeration is unavailable from the beginning')
    page.close()
    version = browser.version;browser.close()

(OUT / f'camera-{engine}-report.json').write_text(json.dumps({'engine': engine, 'version': version, 'checks': len(checks), 'passed': checks, 'scope': 'generated video and iPad emulation; not physical iPad hardware'}, ensure_ascii=False, indent=2), encoding='utf-8')
print(f'ALL {len(checks)} {engine.upper()} CAMERA CHECKS PASSED', flush=True)
