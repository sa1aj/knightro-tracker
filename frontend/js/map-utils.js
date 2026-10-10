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
    /** Building containing the point (footprint), else the nearest within 120 m. Mirrors backend campus.building_at. */
    buildingAt(lat, lng, buildings) {
      const containing = buildings.filter(b => (b.polygons || []).some(r => util.inside(lat, lng, r)));
      const pool = containing.length ? containing : buildings;
      const nearest = pool.reduce((best, b) => !best || util.distance(lat, lng, b) < util.distance(lat, lng, best) ? b : best, null);
      return nearest && (containing.length || util.distance(lat, lng, nearest) <= 120) ? nearest : null;
    },
    /**
     * Likely-Knightro event filter for the static (GitHub Pages) site, which has no server to ask.
     * Mirrors backend campus.event_hint: listing evidence plus a mapped building, never feed-supplied odds.
     */
    eventHint(event, buildings) {
      const norm = (v) => String(v ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
      const title = norm(event.title);
      const text = norm(String(event.title ?? '') + ' ' + String(event.description ?? ''));
      const hosts = Array.isArray(event.hosts) ? norm(event.hosts.map(String).join(' ')) : '';
      let probability, reason;
      if (/\bknightro\b/.test(text)) {
        if (/\b(no|without|not|cancelled|canceled)\b.{0,35}\bknightro\b|\bknightro\b.{0,35}\b(not attending|cancelled|canceled|will not)\b/.test(text)) return null;
        [probability, reason] = [0.95, 'Event listing mentions Knightro'];
      } else if (/\b(pep rally|homecoming kickoff|homecoming parade|spirit splash)\b/.test(title)) {
        [probability, reason] = [0.85, 'Campus spirit event; mascot attendance is possible'];
      } else if (hosts.includes('ucf athletics') && /\b(football|basketball|volleyball)\b.*\b(vs|versus|home game)\b/.test(title)) {
        [probability, reason] = [0.8, 'UCF Athletics home event; mascot attendance is possible'];
      } else return null;
      const location = norm(event.location);
      const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      let b = buildings.find(x => [x.name, ...(x.aliases || []).filter(a => a.length >= 3)]
        .some(name => new RegExp('\\b' + escape(norm(name)) + '\\b').test(location)));
      if (!b) {
        if (!Number.isFinite(event.lat) || !Number.isFinite(event.long)) return null;
        b = util.buildingAt(event.lat, event.long, buildings);
      }
      if (!b) return null;
      return { ...event, lat: b.lat, long: b.long, buildingId: b.id, buildingName: b.name, campus: b.campus, probability, reason };
    },
    /** Apply eventHint to a raw feed the same way backend campus.read_events does. */
    eventHints(feed, buildings, now) {
      const events = (feed.events || []).filter(e => e && e.eventId && typeof e.title === 'string'
        && Number.isFinite(e.startsAt) && Number.isFinite(e.endsAt) && e.endsAt > now && e.endsAt >= e.startsAt)
        .map(e => util.eventHint(e, buildings)).filter(Boolean);
      return { ...feed, events, filter: 'likely-knightro' };
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
