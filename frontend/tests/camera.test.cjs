const assert = require('node:assert/strict');
const {test} = require('node:test');
const fs = require('node:fs');
const vm = require('node:vm');
const code = fs.readFileSync(require.resolve('../js/camera.js'),'utf8');
const settle = async (n = 4) => { for (let i = 0; i < n; i++) await new Promise(resolve => setImmediate(resolve)); };

/** acquire(make, options) may return a stream, a promise, or throw. cameras = number of video inputs reported. */
function setup(acquire, {cameras = 1} = {}) {
  const elements = [], listeners = new Map(), captures = [], streams = [], frames = [], requests = [];
  const document = {
    hidden:false,
    createElement(tag) {
      const classes = new Set();
      const element = {tag, children:[], hidden:false, readyState:4, videoWidth:1280, videoHeight:960,
        classList:{toggle(name, on) { if (on) classes.add(name); else classes.delete(name); }, contains:(name) => classes.has(name)},
        append(...children) {this.children.push(...children);},
        setAttribute(name,value) {this[name]=value;}, getAttribute(name) {return this[name];}, removeAttribute(name) {delete this[name];},
        addEventListener() {}, removeEventListener() {},
        async play() {},
        getContext() {return {drawImage(source) {frames.push(source);}};},
        toDataURL(type,quality) {assert.equal(type,'image/jpeg'); assert.ok(quality>0); return 'data:image/jpeg;base64,camera-frame';},
      };
      elements.push(element); return element;
    },
    addEventListener(name,fn) {listeners.set(name,fn);},
    removeEventListener(name) {listeners.delete(name);},
  };
  function stream(facing = 'environment') {
    const track = {stopped:false, stop() {this.stopped=true;}, getSettings:() => ({facingMode:facing})};
    const value = {track, facing, getTracks:() => [track], getVideoTracks:() => [track]}; streams.push(value); return value;
  }
  const window = {KT:{api:{cameraSession:async () => ({captureToken:'fresh-token',expiresAt:1000})}}};
  vm.runInNewContext(code,{window,document,queueMicrotask,setTimeout,clearTimeout,navigator:{mediaDevices:{
    getUserMedia: async options => {
      assert.equal(options.audio,false);
      const want = options.video.facingMode.exact || options.video.facingMode.ideal;
      requests.push(want);
      return acquire ? acquire(() => stream(want), options) : stream(want);
    },
    enumerateDevices: async () => Array.from({length:cameras}, (_, i) => ({kind:'videoinput', deviceId:'cam' + i})),
  }}});
  const camera = window.KT.camera.create(value => captures.push(value));
  const live = () => streams.filter(s => !s.track.stopped);
  return {camera,document,listeners,captures,streams,frames,elements,requests,live,
    button:() => elements.find(e=>e.tag==='button' && e.className==='px-btn camera-snap'),
    flip:() => elements.find(e=>e.tag==='button' && e.className==='camera-flip'),
    status:() => elements.find(e=>e.tag==='p').textContent,
    viewport:() => elements.find(e=>e.className==='camera-viewport')};
}

test('starts on the rear camera; capture uses the inline live video, a fresh token, and stops the camera immediately', async () => {
  const s = setup(); await settle();
  assert.equal(s.requests[0],'environment');
  assert.equal(s.button().textContent,'TAKE PHOTO');
  s.button().onclick(); await settle();
  assert.equal(s.frames[0].tag,'video');
  assert.equal(s.captures.at(-1).captureToken,'fresh-token');
  assert.ok(s.captures.at(-1).photo.startsWith('data:image/jpeg;'));
  assert.ok(s.streams[0].track.stopped);
  assert.equal(s.button().textContent,'RETAKE PHOTO');
  assert.ok(s.elements.every(e=>!['input','dialog'].includes(e.tag)));
  s.camera.dispose(); assert.equal(s.listeners.size,0);
});

test('closing the report while permission is pending releases a late camera stream', async () => {
  let resolve;
  const s = setup(make => new Promise(done => {resolve = () => done(make());}));
  await settle(); s.camera.dispose(); resolve(); await settle();
  assert.ok(s.streams[0].track.stopped);
  assert.equal(s.captures.length,1); assert.equal(s.captures[0],null);
});

test('expired photos are cleared; retakes use a new stream; backgrounding pauses it', async () => {
  const s = setup(); await settle(); s.button().onclick(); await settle();
  s.camera.expire(); assert.equal(s.captures.at(-1),null);
  assert.equal(s.button().textContent,'START CAMERA');
  s.button().onclick(); await settle();
  assert.equal(s.streams.length,2);
  s.document.hidden=true; s.listeners.get('visibilitychange')();
  assert.ok(s.streams[1].track.stopped);
  assert.equal(s.button().textContent,'START CAMERA'); s.camera.dispose();
});

test('denied camera permission leaves a retry and cannot supply a photo', async () => {
  const s = setup(async () => {throw Object.assign(new Error('denied'),{name:'NotAllowedError'});});
  await settle(); assert.equal(s.button().textContent,'START CAMERA');
  assert.equal(s.button().disabled,false);
  assert.equal(s.captures.at(-1),null);
  assert.match(s.status(),/Allow camera access/);
  s.camera.dispose();
});

test('the flip control is hidden when only one camera exists', async () => {
  const s = setup(null, {cameras:1}); await settle();
  assert.equal(s.flip().hidden,true);
  s.camera.dispose();
});

test('flipping releases the old stream first, waits for the new preview, and mirrors only the selfie preview', async () => {
  const s = setup(null, {cameras:2}); await settle();
  assert.equal(s.flip().hidden,false);
  assert.match(s.flip()['aria-label'],/front camera/);
  s.flip().onclick();
  assert.ok(s.streams[0].track.stopped, 'rear stream stops before the front one is requested');
  assert.equal(s.button().disabled,true, 'no capture while switching');
  await settle();
  assert.deepEqual(s.requests,['environment','user']);
  assert.equal(s.live().length,1); assert.equal(s.live()[0].facing,'user');
  assert.equal(s.button().textContent,'TAKE PHOTO'); assert.equal(s.button().disabled,false);
  assert.ok(s.viewport().classList.contains('mirror'));
  s.button().onclick(); await settle();
  assert.equal(s.live().length,0, 'camera off after capture');
  assert.equal(s.flip().hidden,true, 'no flipping a captured photo');
  assert.ok(!s.viewport().classList.contains('mirror'), 'captured photo is shown unmirrored');
  s.camera.dispose();
});

test('repeated flip taps never leave more than one stream or a frozen preview', async () => {
  const s = setup(null, {cameras:2}); await settle();
  for (let i = 0; i < 6; i++) s.flip().onclick();
  await settle(8);
  assert.equal(s.live().length,1);
  assert.equal(s.button().textContent,'TAKE PHOTO');
  assert.equal(s.flip().disabled,false);
  s.camera.dispose();
  assert.equal(s.live().length,0);
});

test('a failed switch returns to the working camera and says so', async () => {
  const s = setup((make, options) => {
    if (options.video.facingMode.exact === 'user' || options.video.facingMode.ideal === 'user') throw Object.assign(new Error('busy'),{name:'NotReadableError'});
    return make();
  }, {cameras:2});
  await settle();
  s.flip().onclick(); await settle(8);
  assert.equal(s.live().length,1); assert.equal(s.live()[0].facing,'environment');
  assert.match(s.status(),/Couldn't switch cameras/);
  assert.equal(s.button().textContent,'TAKE PHOTO');
  s.camera.dispose();
});
