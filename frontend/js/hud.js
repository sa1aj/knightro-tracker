// Decorative radar layers only. No API requests, permissions, or location inference.
(function () {
  'use strict';
  function basemap(key) {
    const cartoKey = typeof key === 'string' ? key.trim() : '';
    const credit = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';
    return {
      fallback: !cartoKey,
      url: cartoKey ? 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png?key=' + encodeURIComponent(cartoKey) : 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
      options: {maxZoom: 19, subdomains: 'abcd', referrerPolicy: 'origin',
        attribution: credit + (cartoKey ? ', &copy; <a href="https://carto.com/attribution/">CARTO</a>' : '')},
    };
  }
  function createRadar(map, leaflet, reducedMotion) {
    const scanlines = map.createPane('radarScanlines');
    const sweepPane = map.createPane('radarSweep');
    scanlines.style.zIndex = '250'; // tilePane: 200; polygons: 400; markers: 600
    sweepPane.style.zIndex = '260';
    for (const pane of [scanlines, sweepPane]) {
      pane.setAttribute('aria-hidden', 'true');
      pane.style.pointerEvents = 'none';
    }
    // Map panes move with the map. Keep these decorative layers aligned to the viewport.
    function align() {
      const origin = map.containerPointToLayerPoint([0, 0]);
      const size = map.getSize();
      for (const pane of [scanlines, sweepPane]) {
        leaflet.DomUtil.setPosition(pane, origin);
        pane.style.width = size.x + 'px';
        pane.style.height = size.y + 'px';
      }
    }
    map.on('move zoom resize', align);
    align();
    sweepPane.addEventListener('animationend', (event) => {
      if (event.animationName === 'knightSenseSweep') sweepPane.classList.remove('sweeping');
    });
    const pulsed = new Set();
    function pulse(element, items, now, freshSeconds) {
      if (!element) return;
      const fresh = items.filter(item => item.kind === 'sighting' &&
        Number.isFinite(item.timestamp) && now >= item.timestamp && now - item.timestamp < freshSeconds);
      const unplayed = fresh.some(item => !pulsed.has(item.sightingId));
      fresh.forEach(item => pulsed.add(item.sightingId));
      if (reducedMotion()) { element.classList.remove('radar-ping'); return; }
      if (unplayed) {
        element.classList.remove('radar-ping');
        void element.offsetWidth;
        element.classList.add('radar-ping');
      }
    }
    function sweep() {
      if (reducedMotion()) return;
      sweepPane.classList.remove('sweeping');
      void sweepPane.offsetWidth;
      sweepPane.classList.add('sweeping');
    }
    function dispose() {
      map.off('move zoom resize', align);
      map.off('unload', dispose);
      scanlines.remove(); sweepPane.remove();
      pulsed.clear();
    }
    map.on('unload', dispose);
    return {pulse, sweep, dispose};
  }
  window.KT.hud = {createRadar, basemap};
})();
