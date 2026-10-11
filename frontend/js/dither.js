// Ordered (Bayer 4×4) dither patterns, generated once and exposed as CSS custom properties.
// Each tile is drawn at 1 pixel per dot on a transparent background, then scaled by CSS
// (background-size, image-rendering: pixelated) so dots stay crisp: 2 CSS px per dot.
//
//   --dt-<color>-<percent>   flat pattern, 4×4 tile → use `background-size: 8px 8px`
//   --dr-<color>-<dir>        ramp, dense → sparse:
//       down/up   vertical,   4×32 tile → `background-size: 8px 64px; repeat-x`
//       right/left horizontal, 32×4 tile → `background-size: 64px 8px; repeat-y`
//   --drs-<color>-<dir>       short ramp for small parts (buttons, cards): 4×8 tile → `8px 16px`, 8×4 → `16px 8px`
//
// Colors match the palette tokens in css/styles.css (kept here because this runs before first paint).
(function () {
  'use strict';
  const COLORS = { lo: '#b88b00', hi: '#ffe27a', gold: '#ffc904', ink: '#0c0c0e', line: '#353943', cream: '#cfc5ad', steel: '#4a4f5c', paper: '#ffffff', ember: '#a8392c' };
  const BAYER = [[0, 8, 2, 10], [12, 4, 14, 6], [3, 11, 1, 9], [15, 7, 13, 5]];

  function tile(color, w, h, level) {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const g = c.getContext('2d');
    g.fillStyle = color;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      if (BAYER[y % 4][x % 4] < level(x, y)) g.fillRect(x, y, 1, 1);
    }
    return 'url("' + c.toDataURL('image/png') + '")';
  }
  const flat = (color, pct) => tile(color, 4, 4, () => Math.round(16 * pct / 100));
  const ramp = (len) => (t) => Math.round(13 * (1 - t / (len - 1))); // dense (≈80%) → empty

  const root = document.documentElement.style;
  const set = (name, value) => root.setProperty(name, value);
  for (const [name, color] of Object.entries(COLORS)) {
    for (const pct of [12, 25, 50, 75]) set(`--dt-${name}-${pct}`, flat(color, pct));
    for (const [prefix, len] of [['dr', 32], ['drs', 8], ['drq', 4]]) {
      const fade = ramp(len);
      set(`--${prefix}-${name}-down`, tile(color, 4, len, (x, y) => fade(y)));
      set(`--${prefix}-${name}-up`, tile(color, 4, len, (x, y) => fade(len - 1 - y)));
      set(`--${prefix}-${name}-right`, tile(color, len, 4, (x) => fade(x)));
      set(`--${prefix}-${name}-left`, tile(color, len, 4, (x) => fade(len - 1 - x)));
    }
  }
  document.documentElement.classList.add('dither-ready');
})();
