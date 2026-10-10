// Frame-by-frame Knightro turnaround for the top title plaque.
// All frames are stacked in one fixed-size box and only one is visible at a time: no crossfade, no layout
// shift, no re-downloads. Playback starts after every frame has decoded, pauses while the page is hidden,
// and shows a still front-facing frame for reduced-motion users.
(function () {
  'use strict';

  function start(container, { frames, fps, holdFirstMs = 0 }) {
    if (!container || !frames || !frames.length) return;
    const reduce = matchMedia('(prefers-reduced-motion: reduce)');
    const missing = [];
    const imgs = frames.map((src, i) => {
      const img = new Image();
      img.alt = '';
      img.draggable = false;
      img.className = 'knightro-frame' + (i === 0 ? ' on' : '');
      img.src = src;
      container.append(img);
      return img;
    });
    let index = 0;
    let timer = 0;
    let playable = [];

    function show(next) {
      imgs[index].classList.remove('on');
      index = next;
      imgs[index].classList.add('on');
    }
    function schedule() {
      clearTimeout(timer);
      if (playable.length < 2 || document.hidden || reduce.matches) {
        if (reduce.matches && playable.length) show(playable[0]); // still, front-facing frame
        return;
      }
      const delay = 1000 / fps + (index === playable[0] ? holdFirstMs : 0);
      timer = setTimeout(() => {
        const at = playable.indexOf(index);
        show(playable[(at + 1) % playable.length]); // last frame wraps cleanly to the first
        schedule();
      }, delay);
    }

    // Preload + decode every frame before the first swap so the loop never flashes a blank frame.
    Promise.all(imgs.map((img, i) => img.decode().then(() => i, () => { missing.push(frames[i]); return null; })))
      .then((loaded) => {
        playable = loaded.filter((i) => i !== null);
        if (missing.length) console.error('Knightro animation: missing or unreadable frame(s):', missing);
        if (!playable.length) return;
        if (!playable.includes(index)) show(playable[0]);
        container.classList.add('ready');
        schedule();
      });
    document.addEventListener('visibilitychange', schedule);
    reduce.addEventListener?.('change', schedule);
  }

  window.KT.knightroAnim = { start };
})();
