const assert = require('node:assert/strict');
const {test} = require('node:test');
const fs = require('node:fs');
const vm = require('node:vm');
const code = fs.readFileSync(require.resolve('../js/camera.js'),'utf8');
const settle = () => new Promise(resolve => setImmediate(resolve));

function setup(acquire) {
  const elements = [], listeners = new Map(), captures = [], streams = [], frames = [];
  const document = {
    hidden:false,
    createElement(tag) {
      const element = {tag, children:[], hidden:false, readyState:4, videoWidth:1280, videoHeight:960,
        append(...children) {this.children.push(...children);},
        setAttribute(name,value) {this[name]=value;}, removeAttribute(name) {delete this[name];},
        async play() {},
        getContext() {return {drawImage(source) {frames.push(source);}};},
        toDataURL(type,quality) {assert.equal(type,'image/jpeg'); assert.ok(quality>0); return 'data:image/jpeg;base64,camera-frame';},
      };
      elements.push(element); return element;
    },
    addEventListener(name,fn) {listeners.set(name,fn);},
    removeEventListener(name) {listeners.delete(name);},
  };
  function stream() {
    const track = {stopped:false, stop() {this.stopped=true;}};
    const value = {track, getTracks:() => [track]}; streams.push(value); return value;
  }
  const window = {KT:{api:{cameraSession:async () => ({captureToken:'fresh-token',expiresAt:1000})}}};
  vm.runInNewContext(code,{window,document,queueMicrotask,navigator:{mediaDevices:{getUserMedia: async options => {
    assert.equal(options.audio,false); assert.equal(options.video.facingMode.ideal,'environment');
    return acquire ? acquire(stream) : stream();
  }}}});
  const camera = window.KT.camera.create(value => captures.push(value));
  return {camera,document,listeners,captures,streams,frames,elements,button:() => elements.find(e=>e.tag==='button')};
}

test('capture uses the inline live video, a fresh token, and stops the camera immediately', async () => {
  const s = setup(); await settle();
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
  assert.match(s.elements.find(e=>e.tag==='p').textContent,/Allow camera access/);
  s.camera.dispose();
});
