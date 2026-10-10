(function () {
  'use strict';
  const util = {
    contains: (campus, p) => p && p.lat >= campus.bounds.minLat && p.lat <= campus.bounds.maxLat && p.lng >= campus.bounds.minLng && p.lng <= campus.bounds.maxLng,
    opacity: (timestamp, now, windowSec) => 1 - .45 * Math.max(0, Math.min(1, (now - timestamp) / windowSec)),
    distance: (lat, lng, b) => Math.hypot((lat - b.lat) * 111320, (lng - b.long) * 111320 * Math.cos(lat * Math.PI / 180)),
    inside(lat, lng, ring) {
      let contained = false;
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const a = ring[i], b = ring[j];
        if ((a[1] > lat) !== (b[1] > lat) && lng < (b[0] - a[0]) * (lat - a[1]) / (b[1] - a[1]) + a[0]) contained = !contained;
      }
      return contained;
    },
    place(lat, lng, buildings, campuses) {
      const containing = buildings.filter(b => (b.polygons || []).some(r => util.inside(lat, lng, r)));
      const candidates = containing.length ? containing : buildings;
      const nearest = candidates.reduce((best, b) => !best || util.distance(lat, lng, b) < util.distance(lat, lng, best) ? b : best, null);
      if (nearest && (containing.length || util.distance(lat, lng, nearest) <= 120)) return `${containing.length ? 'At' : 'Near'} ${nearest.name}`;
      return campuses.find(c => util.contains(c, {lat, lng}))?.name || 'On campus';
    },
    cluster(items, project, radius = 48) {
      const groups = [];
      for (const item of items) {
        const p = project(item);
        const group = groups.find((g) => Math.hypot(g.point.x - p.x, g.point.y - p.y) <= radius);
        if (group) group.items.push(item);
        else groups.push({ point: p, items: [item] });
      }
      return groups;
    },
  };
  if (typeof module !== 'undefined') module.exports = util;
  else window.KT.mapUtils = util;
})();
