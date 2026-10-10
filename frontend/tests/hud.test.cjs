const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require.resolve('../js/hud.js'), 'utf8');

test('missing CARTO keys keep the map readable and configured keys preserve provider attribution', () => {
  const window = {KT: {}}; vm.runInNewContext(source, {window});
  const fallback = window.KT.hud.basemap('');
  assert.equal(fallback.fallback, true);
  assert.equal(fallback.url, 'https://tile.openstreetmap.org/{z}/{x}/{y}.png');
  assert.ok(fallback.options.attribution.includes('OpenStreetMap'));
  assert.ok(!fallback.options.attribution.includes('CARTO'));
  const carto = window.KT.hud.basemap(' test/key ');
  assert.equal(carto.fallback, false);
  assert.ok(carto.url.endsWith('?key=test%2Fkey'));
  assert.ok(carto.url.includes('/dark_all/{z}/{x}/{y}{r}.png'));
  assert.ok(carto.options.attribution.includes('CARTO'));
});

function setup() {
  let reduced = false, replays = 0;
  const panes = {}, handlers = new Map();
  const element = () => {
    const classes = new Set();
    return {style: {}, attributes: {}, classes,
      setAttribute(key, value) { this.attributes[key] = value; },
      classList: {add: value => classes.add(value), remove: value => classes.delete(value)},
      get offsetWidth() { replays++; return 400; },
      addEventListener(name, fn) { this[name] = fn; },
      remove() { this.removed = true; },
    };
  };
  const map = {
    origin: {x: 12, y: 30}, size: {x: 390, y: 844},
    createPane(name) { return panes[name] = element(); },
    containerPointToLayerPoint(point) { assert.equal(point.join(','), '0,0'); return this.origin; },
    getSize() { return this.size; },
    on(name, fn) { handlers.set(name, fn); },
    off(name) { handlers.delete(name); },
  };
  const window = {KT: {}};
  vm.runInNewContext(source, {window});
  const radar = window.KT.hud.createRadar(map, {DomUtil: {setPosition(el, point) { el.position = point; }}}, () => reduced);
  return {radar, panes, map, handlers, element, replays: () => replays, reduce: () => reduced = true};
}

test('radar panes remain between tiles and interactive overlays and follow viewport changes', () => {
  const s = setup();
  for (const pane of Object.values(s.panes)) {
    assert.ok(+pane.style.zIndex > 200 && +pane.style.zIndex < 400);
    assert.equal(pane.style.pointerEvents, 'none');
    assert.equal(pane.attributes['aria-hidden'], 'true');
    assert.equal(pane.style.width, '390px');
  }
  s.map.origin = {x: -50, y: 90}; s.map.size = {x: 800, y: 600};
  s.handlers.get('move zoom resize')();
  assert.equal(s.panes.radarScanlines.position.x, -50);
  assert.equal(s.panes.radarSweep.style.height, '600px');
  s.radar.dispose();
  assert.equal(s.handlers.size, 0);
  assert.ok(Object.values(s.panes).every(p => p.removed));
});

test('only fresh sightings pulse once, even when clustering replaces their marker', () => {
  const s = setup(), first = s.element(), replacement = s.element();
  const fresh = {kind: 'sighting', sightingId: 'fresh', timestamp: 950};
  const stale = {kind: 'sighting', sightingId: 'stale', timestamp: 600};
  s.radar.pulse(first, [stale, {kind: 'event', timestamp: 990}, {kind: 'bounty', timestamp: 990}], 1000, 300);
  assert.equal(s.replays(), 0);
  s.radar.pulse(first, [fresh], 1000, 300);
  assert.ok(first.classes.has('radar-ping'));
  s.radar.pulse(first, [fresh], 1001, 300);
  s.radar.pulse(replacement, [fresh], 1002, 300);
  assert.equal(s.replays(), 1);
  assert.ok(!replacement.classes.has('radar-ping'));
  s.radar.pulse(replacement, [fresh, {kind: 'sighting', sightingId: 'new', timestamp: 1002}], 1003, 300);
  assert.equal(s.replays(), 2);
});

test('sweeps finish and reduced motion suppresses all decorative replay', () => {
  const s = setup();
  s.radar.sweep(); assert.ok(s.panes.radarSweep.classes.has('sweeping'));
  s.panes.radarSweep.animationend({animationName: 'knightSenseSweep'});
  assert.ok(!s.panes.radarSweep.classes.has('sweeping'));
  s.reduce(); s.radar.sweep();
  const pin = s.element();
  s.radar.pulse(pin, [{kind: 'sighting', sightingId: 'fresh', timestamp: 999}], 1000, 300);
  assert.equal(s.replays(), 1);
  assert.ok(!pin.classes.has('radar-ping'));
});
