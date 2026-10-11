// Effects: synthesized retro sound effects, tweening, confetti, centered toasts and a typewriter ticker.
// Everything is generated in code (Web Audio + canvas), so there are no audio or image files to load.
(function () {
  'use strict';
  const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

  // ---------------------------------------------------------------- sound
  let ctx = null;
  let master = null;
  let noiseBuf = null;
  let enabled = (() => {
    try {
      const v = localStorage.getItem('kt-sound');
      return v === null ? true : v === 'on'; // on by default; browsers keep it silent until the first tap
    } catch {
      return true;
    }
  })();

  function audio() {
    if (!ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      ctx = new AC();
      master = ctx.createGain();
      master.gain.value = 0.55;
      master.connect(ctx.destination);
    }
    if (ctx.state === 'suspended') ctx.resume();
    return ctx;
  }
  // Browsers only allow audio after a user gesture: unlock on the first one.
  const unlock = () => enabled && audio();
  addEventListener('pointerdown', unlock, { passive: true });
  addEventListener('keydown', unlock);

  function tone({ f = 440, to, type = 'square', dur = 0.08, vol = 0.06, delay = 0, attack = 0.005 }) {
    if (!enabled || !ctx) return; // ctx exists only after the first user gesture
    const t = ctx.currentTime + delay;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = type;
    o.frequency.setValueAtTime(f, t);
    if (to) o.frequency.exponentialRampToValueAtTime(to, t + dur);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(master);
    o.start(t);
    o.stop(t + dur + 0.03);
  }

  function noise({ dur = 0.2, vol = 0.06, delay = 0, from = 800, to = 3000, filter = 'bandpass', q = 1 }) {
    if (!enabled || !ctx) return; // ctx exists only after the first user gesture
    if (!noiseBuf) {
      noiseBuf = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
      const d = noiseBuf.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    }
    const t = ctx.currentTime + delay;
    const src = ctx.createBufferSource();
    src.buffer = noiseBuf;
    const fl = ctx.createBiquadFilter();
    fl.type = filter;
    fl.Q.value = q;
    fl.frequency.setValueAtTime(from, t);
    fl.frequency.exponentialRampToValueAtTime(to, t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + dur * 0.3);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(fl).connect(g).connect(master);
    src.start(t);
    src.stop(t + dur + 0.03);
  }

  const arp = (freqs, step, opt = {}) => freqs.forEach((f, i) => tone({ ...opt, f, delay: (opt.delay || 0) + i * step }));
  let lastHover = 0;
  let lastType = 0;

  const SFX = {
    click: () => tone({ f: 880, to: 620, dur: 0.05, vol: 0.05 }),
    hover() {
      const n = performance.now();
      if (n - lastHover < 80) return;
      lastHover = n;
      tone({ f: 1400, dur: 0.025, vol: 0.014, type: 'triangle' });
    },
    open() {
      arp([392, 523, 659, 784], 0.04, { dur: 0.07, vol: 0.045 });
      noise({ dur: 0.2, vol: 0.025, from: 500, to: 4000 });
    },
    close() {
      arp([784, 523, 392], 0.04, { dur: 0.06, vol: 0.04 });
      noise({ dur: 0.16, vol: 0.02, from: 3500, to: 400 });
    },
    switch: () => arp([660, 880], 0.035, { dur: 0.05, vol: 0.04 }),
    whoosh: () => noise({ dur: 0.5, vol: 0.05, from: 250, to: 2600, q: 0.7 }),
    place() {
      tone({ f: 620, to: 180, dur: 0.13, vol: 0.07 });
      noise({ dur: 0.07, vol: 0.05, from: 300, to: 120, filter: 'lowpass' });
    },
    grab: () => tone({ f: 330, to: 440, dur: 0.05, vol: 0.03, type: 'triangle' }),
    pinDrop(i = 0) {
      tone({ f: 1400, to: 320, dur: 0.18, vol: 0.03, type: 'triangle', delay: i * 0.08 });
      tone({ f: 140, to: 60, dur: 0.1, vol: 0.07, delay: i * 0.08 + 0.17 });
    },
    newSighting() {
      arp([784, 988, 1175, 1568], 0.075, { dur: 0.11, vol: 0.05 });
      arp([392, 494], 0.15, { dur: 0.16, vol: 0.035, type: 'triangle' });
    },
    success() {
      arp([523, 659, 784, 1046, 784, 1046, 1318], 0.075, { dur: 0.12, vol: 0.055 });
      arp([262, 330, 392, 523], 0.15, { dur: 0.18, vol: 0.04, type: 'triangle' });
      noise({ dur: 0.6, vol: 0.02, from: 2000, to: 8000, delay: 0.3, filter: 'highpass' });
    },
    error() {
      tone({ f: 220, to: 90, dur: 0.26, vol: 0.07, type: 'sawtooth' });
      tone({ f: 150, dur: 0.22, vol: 0.05, delay: 0.13 });
    },
    type() {
      const n = performance.now();
      if (n - lastType < 70) return;
      lastType = n;
      tone({ f: 1700 + Math.random() * 500, dur: 0.014, vol: 0.013 });
    },
    tick: () => tone({ f: 2400, dur: 0.018, vol: 0.016, type: 'triangle' }),
    boot() {
      tone({ f: 90, to: 900, dur: 0.45, vol: 0.04, type: 'sawtooth' });
      arp([523, 784, 1046, 1568], 0.08, { delay: 0.42, dur: 0.1, vol: 0.05 });
    },
    toggleOn: () => arp([523, 784, 1046], 0.05, { dur: 0.06, vol: 0.05 }),
    toggleOff: () => arp([784, 392], 0.06, { dur: 0.07, vol: 0.05 }),
    online: () => arp([523, 784], 0.08, { dur: 0.08, vol: 0.045 }),
    offline: () => arp([392, 262], 0.1, { dur: 0.12, vol: 0.05, type: 'sawtooth' }),
  };

  const sfx = {
    play(name, ...args) {
      try {
        SFX[name]?.(...args);
      } catch {
        /* audio unavailable */
      }
    },
    enabled: () => enabled,
    set(on) {
      enabled = on;
      try {
        localStorage.setItem('kt-sound', on ? 'on' : 'off');
      } catch {
        /* ignore */
      }
      if (on) audio();
    },
  };

  // ---------------------------------------------------------------- tween
  const ease = {
    linear: (t) => t,
    outCubic: (t) => 1 - Math.pow(1 - t, 3),
    outBack: (t) => 1 + 2.70158 * Math.pow(t - 1, 3) + 1.70158 * Math.pow(t - 1, 2),
    outElastic: (t) => (t === 0 || t === 1 ? t : Math.pow(2, -10 * t) * Math.sin((t * 10 - 0.75) * ((2 * Math.PI) / 3)) + 1),
    inOutCubic: (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2),
  };
  /** Animate a number from `from` to `to`; returns a cancel function. */
  function tween({ from = 0, to = 1, duration = 400, easing = ease.outCubic, onUpdate, onDone }) {
    if (reducedMotion()) {
      onUpdate?.(to);
      onDone?.();
      return () => {};
    }
    const t0 = performance.now();
    let raf = 0;
    const step = (now) => {
      const p = Math.min(1, (now - t0) / duration);
      onUpdate?.(from + (to - from) * easing(p));
      if (p < 1) raf = requestAnimationFrame(step);
      else onDone?.();
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }

  /** Restart a CSS animation class on an element. */
  function replay(el, cls) {
    if (!el) return;
    el.classList.remove(cls);
    void el.offsetWidth; // force reflow so the animation starts again
    el.classList.add(cls);
  }

  // ---------------------------------------------------------------- confetti
  const canvas = document.getElementById('fx');
  const g = canvas.getContext('2d');
  let parts = [];
  let running = false;
  function resize() {
    const dpr = window.devicePixelRatio || 1;
    canvas.width = innerWidth * dpr;
    canvas.height = innerHeight * dpr;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  addEventListener('resize', resize);
  resize();
  const COLORS = ['#ffc904', '#ffe27a', '#fff1b0', '#0c0c0e', '#ffffff', '#b88b00'];

  function burst(x, y, count = 90, spread = 1) {
    if (reducedMotion()) return;
    for (let i = 0; i < count; i++) {
      const a = Math.random() * Math.PI * 2;
      const v = (3 + Math.random() * 7) * spread;
      parts.push({
        x, y,
        vx: Math.cos(a) * v,
        vy: Math.sin(a) * v - 5,
        s: 3 + Math.floor(Math.random() * 4),
        c: COLORS[i % COLORS.length],
        life: 1,
        decay: 0.008 + Math.random() * 0.012,
        rot: Math.random() * Math.PI,
        vr: (Math.random() - 0.5) * 0.4,
      });
    }
    if (!running) {
      running = true;
      requestAnimationFrame(loop);
    }
  }
  function loop() {
    g.clearRect(0, 0, innerWidth, innerHeight);
    parts = parts.filter((p) => p.life > 0 && p.y < innerHeight + 20);
    for (const p of parts) {
      p.vy += 0.28;
      p.vx *= 0.985;
      p.x += p.vx;
      p.y += p.vy;
      p.rot += p.vr;
      p.life -= p.decay;
      g.save();
      g.globalAlpha = Math.max(0, Math.min(1, p.life * 1.5));
      g.translate(p.x, p.y);
      g.rotate(Math.round(p.rot / (Math.PI / 4)) * (Math.PI / 4)); // snap rotation for a pixel look
      g.fillStyle = p.c;
      g.fillRect(-p.s / 2, -p.s / 2, p.s, p.s);
      g.restore();
    }
    if (parts.length) requestAnimationFrame(loop);
    else {
      running = false;
      g.clearRect(0, 0, innerWidth, innerHeight);
    }
  }

  // ---------------------------------------------------------------- readable numbers
  /** Nodes for text with each number run in <span class="num"> (clear digits; see styles.css). Never parses HTML. */
  function numNodes(text) {
    return String(text).split(/(\d+(?:[,.:]\d+)*)/).filter(Boolean).map((part) => {
      if (!/^\d/.test(part)) return document.createTextNode(part);
      const span = document.createElement('span'); span.className = 'num'; span.textContent = part; return span;
    });
  }

  // ---------------------------------------------------------------- toasts (centered on screen)
  const toastBox = document.getElementById('toasts');
  /** Show a big centered message. Text is set with textContent (safe for user captions). */
  function toast(title, sub = '', kind = 'info', ms = 2400) {
    toastBox.querySelectorAll('.toast').forEach((t) => t.classList.add('out'));
    const el = document.createElement('div');
    el.className = `toast ${kind}`;
    const h = document.createElement('strong');
    h.textContent = title;
    el.append(h);
    if (sub) {
      const s = document.createElement('span');
      s.append(...numNodes(sub));
      el.append(s);
    }
    toastBox.append(el);
    setTimeout(() => el.classList.add('out'), ms);
    setTimeout(() => el.remove(), ms + 600);
  }

  // ---------------------------------------------------------------- typewriter
  /** Type `text` into `el` one character at a time. Returns immediately if text is unchanged. */
  function typewriter(el, text, { sound = false, speed = 18 } = {}) {
    if (el.dataset.full === text) return;
    el.dataset.full = text;
    clearInterval(el._typer);
    if (reducedMotion()) {
      el.replaceChildren(...numNodes(text));
      return;
    }
    const host = el.parentElement;
    replay(host, 'glitch');
    let i = 0;
    el.textContent = '';
    el._typing = true;
    host.classList.add('typing');
    el._typer = setInterval(() => {
      i += 1;
      // Always type toward the latest full text (it may have been updated mid-typing).
      const full = el.dataset.full;
      el.textContent = full.slice(0, i);
      if (sound && full[i - 1] !== ' ') sfx.play('type');
      if (i >= full.length) {
        clearInterval(el._typer);
        el._typing = false;
        host.classList.remove('typing');
        el.replaceChildren(...numNodes(full)); // typed: now show the digits in the readable face
      }
    }, speed);
  }

  window.KT.sfx = sfx;
  window.KT.fx = { tween, ease, replay, burst, toast, typewriter, reducedMotion, numNodes };
})();
