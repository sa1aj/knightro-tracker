(function () {
  'use strict';
  function create(onCapture) {
    const root = document.createElement('section');
    root.className = 'sighting-camera no-anim';
    root.setAttribute('aria-label', 'Live sighting camera');
    const viewport = document.createElement('div'); viewport.className = 'camera-viewport';
    const video = document.createElement('video'); video.autoplay = true; video.muted = true; video.playsInline = true;
    video.setAttribute('aria-label', 'Live camera preview');
    const preview = document.createElement('img'); preview.hidden = true; preview.alt = 'Your freshly captured sighting photo';
    viewport.append(video, preview);
    const status = document.createElement('p'); status.className = 'small muted'; status.setAttribute('role', 'status');
    const button = document.createElement('button'); button.type = 'button'; button.className = 'px-btn camera-snap';
    const actions = document.createElement('div'); actions.className = 'camera-actions'; actions.append(button);
    root.append(viewport, status, actions);
    let stream = null, disposed = false, busy = false, captured = false, generation = 0;
    function stop() {
      stream?.getTracks().forEach(track => track.stop());
      stream = null; video.srcObject = null;
    }
    function resetButton() {
      button.disabled = busy || disposed;
      button.textContent = captured ? 'RETAKE PHOTO' : stream ? 'TAKE PHOTO' : 'START CAMERA';
    }
    async function start() {
      const current = ++generation;
      captured = false; onCapture(null); preview.hidden = true; preview.removeAttribute('src'); video.hidden = false;
      busy = true; resetButton(); status.textContent = 'Opening your camera…';
      try {
        if (!navigator.mediaDevices?.getUserMedia) throw new Error('A live camera requires HTTPS or localhost.');
        const acquired = await navigator.mediaDevices.getUserMedia({
          video: {facingMode: {ideal: 'environment'}, width: {ideal: 1280}, height: {ideal: 960}}, audio: false,
        });
        if (disposed || current !== generation) { acquired.getTracks().forEach(track => track.stop()); return; }
        stream = acquired; video.srcObject = stream; await video.play();
        status.textContent = 'Keep Knightro in frame, then take the photo.';
      } catch (error) {
        stop();
        if (!disposed) status.textContent = error.name === 'NotAllowedError'
          ? 'Allow camera access in your browser, then try again. A live photo is required.'
          : error.name === 'NotFoundError' ? 'No camera found. Open the tracker on a device with a camera.'
          : 'Camera unavailable. Check camera access and try again.';
      } finally { busy = false; resetButton(); }
    }
    async function snap() {
      busy = true; resetButton();
      try {
        const width = video.videoWidth, height = video.videoHeight;
        if (Math.min(width, height) < 240 || video.readyState < 2) throw new Error('Camera is still warming up. Try again.');
        const permit = await window.KT.api.cameraSession();
        if (disposed || !stream) return;
        const canvas = document.createElement('canvas'), scale = Math.min(1, 1400 / Math.max(width, height));
        canvas.width = Math.round(width * scale); canvas.height = Math.round(height * scale);
        canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
        const photo = canvas.toDataURL('image/jpeg', .85);
        preview.src = photo; preview.hidden = false; video.hidden = true; captured = true;
        stop();
        status.textContent = 'Photo ready. Submit within two minutes, or retake it.';
        onCapture({photo, captureToken: permit.captureToken, captureExpiresAt: permit.expiresAt});
      } catch (error) { if (!disposed) status.textContent = error.message; }
      finally { busy = false; resetButton(); }
    }
    button.onclick = () => { if (!busy) { if (captured || !stream) start(); else snap(); } };
    const pause = () => {
      if (document.hidden && stream) {
        ++generation; stop(); busy = false; resetButton(); status.textContent = 'Camera paused. Tap START CAMERA when you return.';
      }
    };
    document.addEventListener('visibilitychange', pause);
    queueMicrotask(start);
    return {element: root, dispose() {
      disposed = true; ++generation; stop(); document.removeEventListener('visibilitychange', pause);
    }, expire() {
      if (!captured || disposed || busy) return;
      captured = false; preview.hidden = true; preview.removeAttribute('src'); video.hidden = false;
      status.textContent = 'This photo expired. Take another live photo to report a current sighting.';
      onCapture(null); resetButton();
    }};
  }
  window.KT.camera = {create};
})();
