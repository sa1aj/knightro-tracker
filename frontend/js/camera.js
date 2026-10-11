(function () {
  'use strict';
  const OTHER = { environment: 'user', user: 'environment' };
  const LABEL = { environment: 'rear', user: 'front' };

  /** Stop every track of a stream. Safe on null. */
  const release = (stream) => stream?.getTracks().forEach((track) => track.stop());

  /** Resolve once the video has real frames (or reject after `ms`). */
  function framesReady(video, ms = 6000) {
    if (video.readyState >= 2 && video.videoWidth) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const done = () => { cleanup(); resolve(); };
      const timer = setTimeout(() => { cleanup(); reject(Object.assign(new Error('Camera preview did not start.'), { name: 'PreviewTimeout' })); }, ms);
      const cleanup = () => { clearTimeout(timer); video.removeEventListener('loadeddata', check); video.removeEventListener('resize', check); };
      const check = () => { if (video.readyState >= 2 && video.videoWidth) done(); };
      video.addEventListener('loadeddata', check);
      video.addEventListener('resize', check);
    });
  }

  function create(onCapture) {
    const root = document.createElement('section');
    root.className = 'sighting-camera no-anim';
    root.setAttribute('aria-label', 'Live sighting camera');
    const viewport = document.createElement('div'); viewport.className = 'camera-viewport';
    const video = document.createElement('video'); video.autoplay = true; video.muted = true; video.playsInline = true;
    video.setAttribute('aria-label', 'Live camera preview');
    const preview = document.createElement('img'); preview.hidden = true; preview.alt = 'Your freshly captured sighting photo';
    // Flip control sits on the preview, like a phone camera app. Hidden until a second camera is confirmed.
    const flip = document.createElement('button'); flip.type = 'button'; flip.className = 'camera-flip'; flip.hidden = true;
    const flipGlyph = document.createElement('span'); flipGlyph.setAttribute('aria-hidden', 'true'); flipGlyph.textContent = '⟲ FLIP';
    flip.append(flipGlyph);
    viewport.append(video, preview, flip);
    const status = document.createElement('p'); status.className = 'small muted'; status.setAttribute('role', 'status');
    const button = document.createElement('button'); button.type = 'button'; button.className = 'px-btn camera-snap';
    const actions = document.createElement('div'); actions.className = 'camera-actions'; actions.append(button);
    root.append(viewport, status, actions);

    let stream = null, disposed = false, busy = false, captured = false, generation = 0;
    let facing = 'environment';      // rear camera first
    let cameras = 0;                 // number of video inputs, known after permission is granted
    let ready = false;               // the current preview has frames, so a capture is meaningful

    function stop() {
      release(stream);
      stream = null; ready = false; video.srcObject = null;
    }
    function paint() {
      button.disabled = busy || disposed || (!!stream && !ready && !captured);
      button.textContent = captured ? 'RETAKE PHOTO' : stream ? (ready ? 'TAKE PHOTO' : 'STARTING…') : busy ? 'STARTING…' : 'START CAMERA';
      flip.hidden = captured || cameras < 2;
      flip.disabled = busy || disposed;
      const next = LABEL[OTHER[facing]];
      flip.setAttribute('aria-label', 'Switch to the ' + next + ' camera');
      flip.title = 'Switch to the ' + next + ' camera';
      // Mirror only the live selfie preview (what people expect). The captured photo is never mirrored.
      viewport.classList.toggle('mirror', facing === 'user' && !captured);
    }
    async function countCameras() {
      try {
        const devices = await navigator.mediaDevices.enumerateDevices();
        cameras = devices.filter((d) => d.kind === 'videoinput').length;
      } catch { cameras = 0; }
    }
    /** Ask for one camera. Tries the exact facing first so a flip really changes camera, then a soft preference. */
    async function open(want) {
      const base = { width: { ideal: 1280 }, height: { ideal: 960 } };
      try {
        return await navigator.mediaDevices.getUserMedia({ video: { ...base, facingMode: { exact: want } }, audio: false });
      } catch (error) {
        if (!['OverconstrainedError', 'NotFoundError', 'NotReadableError'].includes(error.name)) throw error;
        return navigator.mediaDevices.getUserMedia({ video: { ...base, facingMode: { ideal: want } }, audio: false });
      }
    }
    /** (Re)start the live preview on `want`. Only the newest call may keep its stream. */
    async function start(want = facing, { fallbackTo = null } = {}) {
      const current = ++generation;
      captured = false; onCapture(null); preview.hidden = true; preview.removeAttribute('src'); video.hidden = false;
      stop(); // release the old camera first: many phones cannot open two at once
      busy = true; facing = want; paint();
      status.textContent = 'Opening your ' + LABEL[want] + ' camera…';
      try {
        if (!navigator.mediaDevices?.getUserMedia) throw Object.assign(new Error('insecure'), { name: 'Insecure' });
        const acquired = await open(want);
        if (disposed || current !== generation) { release(acquired); return; }
        stream = acquired; video.srcObject = stream;
        // Report the camera we actually got (a laptop "rear" request may still return its only camera).
        const actual = stream.getVideoTracks?.()[0]?.getSettings?.().facingMode;
        if (actual === 'user' || actual === 'environment') facing = actual;
        await video.play().catch(() => {});
        await framesReady(video);
        if (disposed || current !== generation) return;
        ready = true;
        await countCameras();
        if (disposed || current !== generation) return;
        status.textContent = 'Keep Knightro in frame, then take the photo.';
      } catch (error) {
        if (disposed || current !== generation) return;
        stop();
        if (fallbackTo) {
          // A failed flip: go back to the camera that was working, and say so.
          busy = false;
          await start(fallbackTo);
          if (!disposed && generation === current + 1) status.textContent = "Couldn't switch cameras. Still using the " + LABEL[facing] + ' camera.';
          return;
        }
        status.textContent = error.name === 'NotAllowedError'
          ? 'Allow camera access in your browser, then tap START CAMERA. A live photo is required.'
          : error.name === 'NotFoundError' ? 'No camera found. Open the tracker on a device with a camera.'
          : error.name === 'Insecure' ? 'A live camera requires HTTPS or localhost.'
          : error.name === 'NotReadableError' ? 'Your camera is busy in another app. Close it, then tap START CAMERA.'
          : 'Camera unavailable. Tap START CAMERA to try again.';
      } finally {
        if (current === generation) { busy = false; paint(); }
      }
    }
    async function snap() {
      if (!ready) return;
      busy = true; paint();
      try {
        const width = video.videoWidth, height = video.videoHeight;
        if (Math.min(width, height) < 240 || video.readyState < 2) throw new Error('Camera is still warming up. Try again.');
        const permit = await window.KT.api.cameraSession();
        if (disposed || !stream) return;
        // Draw the frame as the sensor delivers it: correct proportions, never mirrored.
        const canvas = document.createElement('canvas'), scale = Math.min(1, 800 / Math.max(width, height));
        canvas.width = Math.round(width * scale); canvas.height = Math.round(height * scale);
        canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
        const photo = canvas.toDataURL('image/jpeg', .7);
        preview.src = photo; preview.hidden = false; video.hidden = true; captured = true;
        ++generation; stop(); // the camera turns off as soon as the photo exists
        status.textContent = 'Photo ready. Submit within two minutes, or retake it.';
        onCapture({photo, captureToken: permit.captureToken, captureExpiresAt: permit.expiresAt});
      } catch (error) { if (!disposed) status.textContent = error.message; }
      finally { busy = false; paint(); }
    }
    button.onclick = () => { if (!busy) { if (captured || !stream) start(); else snap(); } };
    flip.onclick = () => { if (!busy && !captured) start(OTHER[facing], { fallbackTo: facing }); };
    const pause = () => {
      if (document.hidden && stream) {
        ++generation; stop(); busy = false; paint(); status.textContent = 'Camera paused. Tap START CAMERA when you return.';
      }
    };
    document.addEventListener('visibilitychange', pause);
    queueMicrotask(() => start());
    return {element: root, dispose() {
      disposed = true; ++generation; stop(); document.removeEventListener('visibilitychange', pause);
    }, expire() {
      if (!captured || disposed || busy) return;
      captured = false; preview.hidden = true; preview.removeAttribute('src'); video.hidden = false;
      status.textContent = 'This photo expired. Take another live photo to report a current sighting.';
      onCapture(null); paint();
    }};
  }
  window.KT.camera = {create};
})();
