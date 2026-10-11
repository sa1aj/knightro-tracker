// Knightro Tracker frontend. One persistent Leaflet map; panels slide over it.
// SECURITY: captions are typed by strangers. Every piece of text goes into the page with
// textContent / text nodes (see h() below). Never use innerHTML with API data.
(async function () {
  'use strict';
  const { CONFIG, IMG, api, pixelPhoto, hash, sfx, fx, mapUtils } = window.KT;
  let campuses;
  await api.ready; // settles CONFIG (app vs static) before anything reads it
  try {
    const response = await fetch(CONFIG.CAMPUSES_URL);
    if (!response.ok) throw new Error('Campus configuration could not load.');
    campuses = await response.json();
  } catch {
    document.body.classList.remove('booting');
    document.getElementById('status-text').textContent = 'CAMPUS MAP UNAVAILABLE — RELOAD TO RETRY';
    return;
  }
  let campus = campuses[0];
  const $ = (sel) => document.querySelector(sel);

  /** Build DOM safely: string children become text nodes, never HTML. */
  function h(tag, attrs, ...children) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (const c of children.flat()) {
      if (c == null || c === false) continue;
      el.append(c instanceof Node ? c : document.createTextNode(String(c)));
    }
    return el;
  }

  // ---------- numbers ----------
  // The pixel fonts make 5/8/S and 6/b look alike, so digits get their own clear face (.num in styles.css).
  const fmt = (n) => Number(n ?? 0).toLocaleString('en-US');
  /** Text with every number run wrapped in <span class="num">. Plain text stays plain (still textContent-safe). */
  function numText(text) {
    return String(text).split(/(\d+(?:[,.:]\d+)*)/).filter(Boolean).map((part) => (/^\d/.test(part) ? h('span', { class: 'num' }, part) : part));
  }
  const setNum = (el, text) => { if (el && el.textContent !== String(text)) el.replaceChildren(...numText(text)); };
  const pts = (n) => fmt(n) + (Number(n) === 1 ? ' pt' : ' pts');

  // ---------- time + places ----------
  const nowSec = () => Date.now() / 1000;
  const ageSec = (s) => Math.max(0, nowSec() - s.timestamp);
  function timeAgo(s) {
    const m = Math.floor(ageSec(s) / 60);
    return m < 1 ? 'just now' : `${m} min ago`;
  }
  const shortAgo = (s) => `${Math.max(1, Math.floor(ageSec(s) / 60))}M`;
  const clock = (s) => new Date(s.timestamp * 1000).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

  let buildings = [];
  fetch(CONFIG.BUILDINGS_URL)
    .then((r) => (r.ok ? r.json() : Promise.reject()))
    .then((d) => {
      buildings = d.buildings || [];
      state.events = state.events.map(resolveEvent);
      render();
    })
    .catch(() => { /* labels fall back to "On campus" when opened as a local file */ });

  function placeName(lat, long) {
    return mapUtils.place(lat, long, buildings, campuses);
  }
  const onCampus = (p) => campuses.some((c) => mapUtils.contains(c, p));
  const campusBounds = (c) => [[c.bounds.minLat, c.bounds.minLng], [c.bounds.maxLat, c.bounds.maxLng]];
  const isMobile = () => matchMedia('(max-width: 720px)').matches;

  function photoFor(s) {
    if (s.photoUrl?.startsWith('/api/photos/')) return {src:s.photoUrl,pixel:false};
    const list = CONFIG.STOCK_PHOTOS;
    if (list.length) return { src: list[hash(s.sightingId) % list.length], pixel: false };
    return { src: pixelPhoto(s.sightingId), pixel: true };
  }

  // ---------- state ----------
  const state = {
    sightings: [], events: [], eventsLoaded: false, eventsError: '', eventsGeneratedAt: null,
    user: null, admin: null, nextSightingAt: 0, sessionLoaded: false, emailDelivery: null,
    testSightings: [], testEvents: [],
    leaders: [], leadersLoaded: false, leadersError: '', selectedEvent: null, stack: [],
    bounties: [], alerts: [], gameLoaded: false, gameError: '', reports: [], reportsError: '', reportsLoaded: false, senseMessage: '',
    auth: { mode: 'signup', step: 'email', email: '', displayName: '', busy: false, error: '' },
    loaded: false,
    netError: '',
    panel: null, // 'report' | 'recent' | 'detail'
    backTo: null,
    selectedId: null,
    report: null,
  };
  // Report flow: 'capture' (photo + note) → 'location' (choose a method) → map placement mode → 'review' (submit) → 'done'.
  // pin is set only by an explicit Confirm Location; placing holds the temporary map-placement state.
  const newReport = () => ({ step: 'capture', pin: null, placing: null, gps: null, caption: '', photo:null, captureToken:null, captureExpiresAt:0, photoExpired:false, camera:null, submitting: false, error: '', result: null });
  const myPosts = new Set(); // ids this device just posted, so we don't announce them as "new"
  // This device's own saved reports, exactly as the server returned them. A poll that started before the post
  // (or a report still awaiting review, which public GET /sightings leaves out) can't make the new pin vanish.
  const ownPosts = new Map();
  const isPublic = (s) => !s.status || ['published', 'confirmed'].includes(s.status);
  function rememberOwn(saved, fallback) {
    const s = { ...saved };
    // The server's saved coordinates/time are authoritative; the request values only fill a gap.
    if (!Number.isFinite(s.lat)) s.lat = fallback.lat;
    if (!Number.isFinite(s.long)) s.long = fallback.lng;
    if (!Number.isFinite(s.timestamp)) s.timestamp = nowSec();
    ownPosts.set(s.sightingId, s);
    myPosts.add(s.sightingId);
    return s;
  }
  function allSightings() {
    const seen = new Set(state.sightings.map((s) => s.sightingId));
    const own = [...ownPosts.values()].filter((s) => !seen.has(s.sightingId) && s.status !== 'rejected');
    return [...state.sightings, ...own];
  }

  // ---------- map (created once, never replaced) ----------
  const MAX_ZOOM = 19; // OpenStreetMap's standard tiles stop at zoom 19.
  const map = L.map('map', {
    center: [campus.center.lat, campus.center.lng],
    zoom: 16, minZoom: 13, maxZoom: MAX_ZOOM,
    maxBoundsViscosity: 0.9,
    zoomControl: false,
  });
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    // OSM requires a Referer; send only the public origin for map tiles.
    referrerPolicy: 'origin',
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  }).addTo(map);
  const zoomControl = L.control.zoom({ position: 'bottomleft', zoomInTitle: 'Zoom in', zoomOutTitle: 'Zoom out' }).addTo(map);
  // Recenter lives in the zoom group so the three map controls always sit together.
  const recenterButton = L.DomUtil.create('a', 'leaflet-control-recenter', zoomControl.getContainer());
  recenterButton.href = '#';
  recenterButton.setAttribute('role', 'button');
  recenterButton.setAttribute('aria-label', 'Recenter map on this campus');
  recenterButton.title = 'Recenter map on this campus';
  recenterButton.innerHTML = '<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="M7 1h2v3H7zM7 12h2v3H7zM1 7h3v2H1zM12 7h3v2h-3zM5 5h6v6H5zM7 7v2h2V7z" fill="currentColor" fill-rule="evenodd"/></svg>';
  L.DomEvent.disableClickPropagation(recenterButton);
  L.DomEvent.on(recenterButton, 'click', (e) => { L.DomEvent.preventDefault(e); recenterMap(); });
  L.DomEvent.on(recenterButton, 'keydown', (e) => { if (e.key === ' ') { L.DomEvent.preventDefault(e); recenterMap(); } });
  map.on('zoomend', () => sfx.play('tick'));
  window.KT.map = map; // handy for debugging in dev tools

  const markers = new Map();
  const bountyAreas = new Map();
  let reportPin = null; // the confirmed report location, shown on the map behind the report panel

  const adminOn = () => !!(state.admin && state.admin.allowed && state.admin.mode);
  const campusSightings = () => [...allSightings(), ...(adminOn() ? state.testSightings : [])]
    .filter((s) => ageSec(s) < CONFIG.ACTIVE_WINDOW_SEC && mapUtils.contains(campus, {lat:s.lat, lng:s.long}))
    .sort((a, b) => b.timestamp - a.timestamp);
  const activeEvents = () => [...state.events, ...(adminOn() ? state.testEvents : [])].filter((e) => e.endsAt > nowSec());
  const activeBounties = () => state.bounties.filter(b => b.startsAt <= nowSec() && b.expiresAt > nowSec());
  const eventArt = () => CONFIG.EVENT_FRAMES.map((src, i) => '<img class="event-frame frame-' + i + '" src="' + src + '" alt="">').join('');
  // This calendar week (Mon–Sun, America/New_York). Map pins and the event list both use it.
  const thisWeek = () => mapUtils.weekRange(nowSec());
  const weekEvents = () => { const week = thisWeek(); return activeEvents().filter((e) => e.isTest || mapUtils.overlaps(e, week)); };
  const mappable = (e) => Number.isFinite(e.lat) && Number.isFinite(e.long) && onCampus({ lat: e.lat, lng: e.long });
  const campusOf = (e) => campuses.find((c) => mapUtils.contains(c, { lat: e.lat, lng: e.long }));
  // Event medallions: visible art matches the Knightro medallion (~49 px); the 56 px box doubles as the touch target.
  const EVENT_PIN = 56;
  CONFIG.EVENT_FRAMES.forEach((src) => { const img = new Image(); img.src = src; img.decode?.().catch(() => {}); }); // preload: no flash on the first hover

  // Event pin frames: idle 1; hover or selected plays 1 → 2 → 3 and holds 3. Only the art inside the marker changes.
  const FRAME_MS = 80;
  function eventFrame(marker, target) {
    clearTimeout(marker.frameTimer);
    const body = marker.getElement()?.querySelector('.kt-pin-body');
    if (!body) return;
    let frame = Number(body.dataset.frame) || 1;
    if (target <= frame || fx.reducedMotion()) { body.dataset.frame = String(target); return; }
    const step = () => {
      frame += 1; body.dataset.frame = String(frame);
      if (frame < target) marker.frameTimer = setTimeout(step, FRAME_MS);
    };
    marker.frameTimer = setTimeout(step, FRAME_MS);
  }
  const eventTarget = (marker) => (marker.hovered || marker.eventSelected ? 3 : 1);
  // The pin art's tip is its exact bottom-centre (see config.js), so that point is the anchor.
  // Round Knightro medallions, centred on their map point. The hover art is framed identically (config.js), so
  // the two images overlay exactly and only cross-fade.
  const [PIN_W, PIN_H] = CONFIG.PIN_SIZE;
  const PIN_LIFT = 0; // medallions sit centred on the point, so the camera needs no upward offset
  const pinArt = '<img class="pin-normal" src="' + CONFIG.PIN_IMAGE + '" alt=""><img class="pin-hover" src="' + CONFIG.PIN_HOVER_IMAGE + '" alt="">';
  // The report location uses the teardrop pin: its tip (bottom-centre) is the exact chosen point.
  const [PLACE_W, PLACE_H] = CONFIG.PLACE_PIN_SIZE;
  const reportIcon = L.divIcon({ className: 'kt-drop report-pin', html: '<span class="drop-art"><img src="' + CONFIG.PLACE_PIN_IMAGE + '" alt=""></span>', iconSize: [PLACE_W, PLACE_H], iconAnchor: [PLACE_W / 2, PLACE_H] });

  function renderMarkers() {
    const sections = activeBounties().filter(b => b.campus === campus.id && Array.isArray(b.area));
    const activeAreas = new Set(sections.map(b => b.bountyId));
    for (const [id, area] of bountyAreas) if (!activeAreas.has(id)) { area.remove(); bountyAreas.delete(id); }
    for (const b of sections) if (!bountyAreas.has(b.bountyId)) {
      const area = L.polygon(b.area.map(([lng,lat]) => [lat,lng]), {
        color:'#ffc904', weight:3, dashArray:'8 6', fillColor:'#ffc904', fillOpacity:.13,
        interactive:false, className:'bounty-area',
      }).addTo(map);
      bountyAreas.set(b.bountyId, area);
    }
    const items = [
      ...campusSightings().map((s) => ({ ...s, kind: 'sighting', key: 's:' + s.sightingId })),
      // Every likely event this week with a real venue on this campus. Events without coordinates stay list-only.
      ...weekEvents().filter((e) => (e.isTest || e.probability >= .8) && Number.isFinite(e.lat) && Number.isFinite(e.long) && mapUtils.contains(campus, {lat:e.lat,lng:e.long}))
        .map((e) => ({ ...e, kind:'event', key:'e:' + e.eventId })),
      ...activeBounties().filter(b => b.campus === campus.id).map(b => ({...b,kind:'bounty',key:'b:'+b.bountyId})),
    ];
    const groups = mapUtils.cluster(items, (item) => map.latLngToLayerPoint([item.lat, item.long]), 48 * pinScale);
    const seen = new Set();
    for (const group of groups) {
      const first = group.items[0], id = first.key;
      seen.add(id);
      let marker = markers.get(id);
      const multiple = group.items.length > 1;
      const eventSelected = group.items.some((item) => item.kind === 'event' && state.panel === 'event' && item.eventId === state.selectedEvent);
      const selected = eventSelected || group.items.some((item) => state.panel === 'detail' && item.sightingId === state.selectedId);
      const signature = group.items.map((item) => item.key + ':' + (item.status || '')).join('|');
      if (!marker) {
        marker = L.marker([first.lat, first.long], { keyboard: true, riseOnHover: true })
          .on('click', () => {
            if (state.panel === 'report') return;
            // A single event pin plays its frames on tap (details open immediately below); a stack pin opens a list instead.
            if (marker.isEvent && marker.items.length === 1) eventFrame(marker, 3);
            else fx.replay(marker.getElement()?.querySelector('.pin-art'), 'tap'); // bounce the art, never the positioned marker
            if (marker.items.length > 1) {
              state.stack = marker.items;
              openPanel('stack');
            } else openMapItem(marker.items[0]);
          })
          .on('mouseover', () => { sfx.play('hover'); if (marker.isEvent) { marker.hovered = true; eventFrame(marker, 3); } })
          .on('mouseout', () => { if (marker.isEvent) { marker.hovered = false; eventFrame(marker, eventTarget(marker)); } })
          // Leaflet already turns Enter into a click on focused markers; Space should work too.
          .on('keypress', (e) => { if (e.originalEvent.key === ' ') { e.originalEvent.preventDefault(); marker.fire('click'); } })
          .addTo(map);
        markers.set(id, marker);
      }
      marker.items = group.items;
      marker.setLatLng([first.lat, first.long]);
      if (marker.signature !== signature) {
        const art = first.kind === 'sighting'
          ? pinArt
          : first.kind === 'bounty' ? '<strong class="bounty-art">2×</strong>' : eventArt();
        const test = group.items.some((item) => item.isTest);
        const pending = first.kind === 'sighting' && !isPublic(first);
        const size = first.kind === 'sighting' ? [PIN_W, PIN_H] : first.kind === 'event' ? [EVENT_PIN, EVENT_PIN] : [66, 74];
        marker.setIcon(L.divIcon({
          className: 'kt-pin asset-pin ' + (first.kind === 'sighting' ? 'sighting-pin ' : '') + (first.kind === 'event' ? 'event-pin ' : '') + (multiple ? 'stack-pin ' : '') + (test ? 'test-pin ' : '') + (pending ? 'pending-pin ' : ''),
          html: '<div class="kt-pin-body" data-frame="' + (eventSelected || marker.hovered ? 3 : 1) + '"><span class="pin-art">' + art + '</span>' + (multiple ? '<b class="stack-count">' + group.items.length + '</b>' : '') + '<span class="age"></span></div>',
          // Medallions (sightings and events) are centred on their point; bounty tiles keep their bottom anchor.
          iconSize: size, iconAnchor: first.kind === 'bounty' ? [33, 72] : [size[0] / 2, size[1] / 2],
        }));
        marker.signature = signature;
        clearTimeout(marker.frameTimer); // the old element is gone; its pending frame step must not run
      }
      marker.isEvent = first.kind === 'event';
      if (marker.isEvent && marker.eventSelected !== eventSelected) {
        marker.eventSelected = eventSelected; // selecting another event or closing details updates the old pin here
        eventFrame(marker, eventTarget(marker));
      }
      // Toggle selection on the existing element so hover/selected states can ease back smoothly.
      marker.getElement()?.classList.toggle('sel', selected);
      const label = multiple ? group.items.length + ' nearby sightings, event hints, and missions. Open stack.' : first.kind === 'sighting' ? 'Knightro sighting ' + (first.placeLabel || placeName(first.lat, first.long)) : first.kind === 'bounty' ? 'Daily double-point bounty: ' + first.sectorName : first.title;
      marker.getElement()?.setAttribute('aria-label', label);
      marker.getElement()?.setAttribute('title', label);
      marker.setZIndexOffset(selected ? 800 : first.kind === 'sighting' ? 500 : 0);
    }
    for (const [id, marker] of markers) if (!seen.has(id)) { marker.remove(); markers.delete(id); }
    updatePinAges();
    // Confirmed report location (hidden while placing: the fixed centre pin takes over).
    const r = state.report;
    const showPin = state.panel === 'report' && r?.pin && !r.placing && r.step !== 'done';
    if (showPin && !reportPin) {
      reportPin = L.marker([r.pin.lat, r.pin.lng], { icon: reportIcon, interactive: false, keyboard: false, zIndexOffset: 1000 }).addTo(map);
      fx.replay(reportPin.getElement(), 'bounce');
    } else if (showPin) reportPin.setLatLng([r.pin.lat, r.pin.lng]);
    else if (reportPin) { reportPin.remove(); reportPin = null; }
  }

  function updatePinAges() {
    for (const marker of markers.values()) {
      const opacity = Math.max(...marker.items.map((item) => item.kind !== 'sighting' ? 1 : mapUtils.opacity(item.timestamp, nowSec(), CONFIG.ACTIVE_WINDOW_SEC)));
      marker.setOpacity(opacity);
      const age = marker.getElement()?.querySelector('.age');
      const one = marker.items[0];
      if (age) setNum(age, marker.items.length > 1 ? 'OPEN STACK' : one.isTest ? 'TEST' : one.kind === 'bounty' ? 'BOUNTY ' + countdown(one.expiresAt)
        : one.kind === 'event' ? 'LIKELY EVENT' : !isPublic(one) ? 'PENDING · ' + shortAgo(one) : shortAgo(one));
    }
  }
  // Zoom limits come from how much of the campus fits on screen. (The old code used
  // getBoundsZoom(bounds, true) — "zoom in until the *screen* fits inside the campus box" — so small
  // campuses forced the minimum zoom up to the maximum: Downtown was locked at 19/19.)
  function campusView(c) {
    const bounds = L.latLngBounds(campusBounds(c));
    const fit = map.getBoundsZoom(bounds, false); // the whole campus is visible at this zoom
    const minZoom = Math.max(13, Math.min(16, fit - 1));
    return { bounds, minZoom, startZoom: Math.min(18, Math.max(minZoom, fit + 1)) };
  }
  /** Apply the campus limits. moveTo=true also moves there (once per campus switch). */
  function applyCampusLimits(moveTo = false) {
    const view = campusView(campus);
    map.setMaxBounds(null); // drop the previous campus box first so nothing snaps back
    map.setMinZoom(view.minZoom);
    map.setMaxZoom(MAX_ZOOM);
    if (moveTo) map.setView([campus.center.lat, campus.center.lng], view.startZoom, {animate:false});
    map.setMaxBounds(view.bounds.pad(0.5)); // room to pan past the campus edge
    return view;
  }
  function switchCampus(id) {
    campus = campuses.find((c) => c.id === id) || campuses[0];
    applyCampusLimits(true);
    $('#campus-select').value = campus.id;
    $('#map').setAttribute('aria-label', 'Map of UCF ' + campus.name + ' with sightings and events');
    render(); // a report's confirmed location is never changed by switching campus
  }
  // Pins keep their proportion to the map: full size at street level (zoom 17+), shrinking to 55% zoomed out.
  // CSS scales only the inner art from its anchor (refinements.css); clustering uses the same scale.
  let pinScale = 1;
  function syncPinScale() {
    pinScale = Math.max(0.55, Math.min(1, 1 - (17 - map.getZoom()) * 0.15));
    const root = $('#map');
    root.style.setProperty('--pin-scale', pinScale.toFixed(3));
    root.classList.toggle('far-out', pinScale < 0.75);
  }
  map.on('zoom', syncPinScale); // every frame of a zoom animation, so pins resize smoothly
  syncPinScale();
  map.on('zoomend moveend', () => renderMarkers());
  // A new container size can change what "fits"; update limits only, never reset the user's view.
  map.on('resize', () => applyCampusLimits(false));
  applyCampusLimits(true);
  $('#campus-select').append(...campuses.map((c) => h('option', {value:c.id}, c.name)));
  $('#campus-select').addEventListener('change', (e) => switchCampus(e.target.value));


  /**
   * Screen point at the middle of the map area nothing covers: below the top controls, above the open sheet or
   * dock, and left of a side panel. Uses layout offsets, not transforms, so it is right while a panel slides in.
   */
  function clearMapCenter() {
    const size = map.getSize(), panel = $('#panel'), open = panel.classList.contains('open');
    const missions = $('.mission-bar'), dock = $('.dock');
    let top = missions.offsetTop + missions.offsetHeight + 8, bottom = dock.offsetTop - 8, left = 0, right = size.x;
    if (open) {
      if (panel.offsetWidth > size.x * 0.6) bottom = Math.min(bottom, panel.offsetTop - 8); // bottom sheet
      else right = panel.offsetLeft - 8; // side panel
    }
    if (bottom - top < 120) { top = 0; bottom = size.y; } // tiny screens: just use the middle
    return L.point((left + right) / 2, (top + bottom) / 2);
  }
  /**
   * Fly so (lat, lng) sits in the clear part of the map. `pinHeight` lifts the point so the whole pin art (which
   * stands above its coordinate) is centred. `done` runs once the flight settles.
   */
  function focusOn(lat, lng, minZoom = 17, { pinHeight = 0, done = null } = {}) {
    const targetCampus = campuses.find((c) => mapUtils.contains(c, {lat, lng}));
    if (targetCampus && targetCampus.id !== campus.id) switchCampus(targetCampus.id);
    const z = Math.min(MAX_ZOOM, Math.max(map.getZoom(), minZoom));
    const size = map.getSize();
    const target = clearMapCenter().add(L.point(0, pinHeight / 2));
    const offset = L.point(size.x / 2, size.y / 2).subtract(target);
    sfx.play('whoosh');
    if (done) {
      let finished = false;
      const finish = () => { if (!finished) { finished = true; clearTimeout(timer); map.off('moveend', finish); done(); } };
      const timer = setTimeout(finish, 1400); // also covers "already there" and reduced motion
      map.on('moveend', finish);
    }
    map.flyTo(map.unproject(map.project([lat, lng], z).add(offset), z), z, { duration: 0.7, easeLinearity: 0.2, animate: !fx.reducedMotion() });
  }

  // ---------- data ----------
  function applySession(session) {
    state.accounts = session.accounts !== false;
    state.user = session.user; state.nextSightingAt = session.nextSightingAt;
    state.sessionLoaded = true; state.emailDelivery = session.emailDelivery;
    state.authMode = session.authMode || 'email-code';
    const wasOn = adminOn();
    state.admin = session.admin || null; // Display only; the server enforces every admin action.
    if (!adminOn()) { state.testSightings = []; state.testEvents = []; if (state.panel === 'admin') closePanel(); }
    else if (!wasOn) admin.loadTestData();
  }
  async function refreshSession() {
    try { applySession(await api.getSession()); } catch { /* the next poll retries */ }
    render({ panel: !['report', 'account', 'admin'].includes(state.panel) });
  }
  let inFlight = false;
  async function refresh({ quiet = false } = {}) {
    if (inFlight) return;
    inFlight = true;
    const firstLoad = !state.hasData; // first successful load: drop all pins in, announce nothing
    const wasOffline = !!state.netError;
    try {
      const [all, session] = await Promise.all([api.getSightings(), api.getSession()]);
      const list = all.filter((s) => ageSec(s) < CONFIG.ACTIVE_WINDOW_SEC && onCampus({lat:s.lat,lng:s.long}));
      applySession(session);
      if (adminOn()) admin.loadTestData();
      const known = new Set(state.sightings.map((s) => s.sightingId));
      const fresh = list.filter((s) => !known.has(s.sightingId));
      state.sightings = list;
      state.hasData = true;
      state.netError = '';
      if (wasOffline && !quiet) {
        sfx.play('online');
        fx.toast('BACK ONLINE', 'Live sightings are updating again.', 'good', 1800);
      }
      const others = fresh.filter((s) => !myPosts.has(s.sightingId));
      if (!firstLoad && others.length) announce(others[0], others.length);
    } catch (err) {
      if (!state.netError) {
        sfx.play('offline');
        fx.toast('CONNECTION LOST', err.message, 'bad', 3200);
      }
      state.netError = err.message;
    } finally {
      state.loaded = true;
      inFlight = false;
      // Don't rebuild the report form under someone who is typing; everything else refreshes.
      render({ panel: !['report','account','admin'].includes(state.panel) });
      fx.replay($('#status'), 'blink');
    }
  }
  function announce(s, count) {
    sfx.play('newSighting');
    fx.toast(count > 1 ? `${count} NEW SIGHTINGS!` : 'NEW SIGHTING!', `${placeName(s.lat, s.long)}${s.caption ? ` · “${s.caption}”` : ''}`, 'gold');
    const el = markers.get('s:' + s.sightingId)?.getElement();
    if (el) {
      const r = el.getBoundingClientRect();
      fx.burst(r.left + r.width / 2, r.top + r.height / 2, 40, 0.6);
    }
  }
  setInterval(() => { if (!document.hidden) refresh(); }, CONFIG.POLL_MS);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });

  // ---------- panels ----------
  const TITLES = { report: 'REPORT A SIGHTING', recent: 'ACTIVE SIGHTINGS', detail: 'SIGHTING',
    account:'YOUR UCF ACCOUNT', events:'LIKELY KNIGHTRO EVENTS', event:'EVENT DETAILS', leaderboard:'KNIGHT LEADERBOARD', stack:'NEARBY PINS',
    bounties:'HIGH-VALUE BOUNTIES', sense:'KNIGHT-SENSE', reports:'MY PHOTO REPORTS', admin:'ADMIN PANEL' };

  function openPanel(name, backTo = null) {
    setMenu(false);
    if (CONFIG.ACCOUNTS && ['report','reports'].includes(name) && !state.user) { state.auth.after = name; name = 'account'; }
    if (name === 'report' && state.panel !== 'report' && state.nextSightingAt > nowSec()) {
      fx.toast('TAKE A BREATHER', 'Your next report unlocks in ' + Math.ceil(state.nextSightingAt - nowSec()) + ' seconds.', 'info');
      return;
    }
    if (state.panel === name && !['detail','stack','event'].includes(name)) return closePanel();
    sfx.play(state.panel ? 'switch' : 'open');
    state.report?.camera?.dispose();
    state.report = name === 'report' ? newReport() : null;
    state.panel = name;
    state.backTo = backTo;
    render(); // the report asks for GPS only when the user picks Use My Location
    if (name === 'events') loadEvents();
    if (name === 'leaderboard') loadLeaderboard();
    if (name === 'reports') loadReports();
    if (['bounties','sense'].includes(name)) loadGame();
    if (name === 'admin') admin.loadPanel();
    $('#panel-close').focus({ preventScroll: true });
  }
  function closePanel() {
    if (!state.panel) return;
    sfx.play('close');
    state.report?.camera?.dispose();
    locateId++; // a pending GPS answer belongs to the closed report
    state.panel = null;
    state.report = null;
    render();
  }
  function openDetail(id, backTo = null) {
    if (state.panel === 'report') return; // pins aren't selectable while placing the report pin
    sfx.play(state.panel ? 'switch' : 'open');
    state.selectedId = id;
    state.panel = 'detail';
    state.backTo = backTo;
    render();
  }

  $('#panel-close').addEventListener('click', closePanel);
  $('#panel-back').addEventListener('click', () => state.backTo && openPanel(state.backTo));
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (state.report?.placing) cancelPlacement(); else if (menuOpen) setMenu(false); else if (state.panel) closePanel();
  });
  document.querySelectorAll('[data-panel]').forEach((b) => b.addEventListener('click', () => openPanel(b.dataset.panel)));

  // ---------- report flow ----------
  // Every GPS request gets an id. Confirming, cancelling, opening placement or closing the report bumps it, so a slow
  // answer can never overwrite a location the user has already chosen.
  let locateId = 0;
  const GPS_MSG = {
    locating: 'Finding your location…',
    denied: 'Location permission was denied. Place the pin on the map instead.',
    failed: "Couldn't get your location. Place the pin on the map instead.",
    offcampus: "You don't appear to be on a UCF campus. Place the pin on the map instead.",
    unsupported: 'Location needs HTTPS. Place the pin on the map instead.',
  };
  function locate(inPlacement = false) {
    const r = state.report;
    if (!r) return;
    const id = ++locateId;
    const done = (status, p = null) => {
      if (id !== locateId || state.report !== r) return; // superseded
      if (inPlacement) {
        if (!r.placing) return;
        r.placing.gps = status === 'ok' ? null : status;
        if (p) { sfx.play('place'); centerPlacement(p, 18); r.placing.hint = 'GPS moved the map to you. Adjust if needed, then confirm.'; }
        render();
        return;
      }
      if (r.step !== 'location' || r.placing) return;
      r.gps = status === 'ok' ? null : status;
      if (p) startPlacement(p, 'GPS placed the pin. Adjust it if needed, then confirm.');
      else render();
    };
    if (!navigator.geolocation || !window.isSecureContext) return done('unsupported');
    if (inPlacement) r.placing.gps = 'locating'; else r.gps = 'locating';
    render();
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const p = { lat: pos.coords.latitude, lng: pos.coords.longitude };
        done(onCampus(p) ? 'ok' : 'offcampus', onCampus(p) ? p : null);
      },
      (err) => done(err.code === 1 ? 'denied' : 'failed'),
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 30000 }
    );
  }

  // ---------- map placement mode ----------
  // The report panel steps aside and a fixed pin marks the centre of the map; the user moves the map under it. The
  // pin's tip sits exactly on the map container's centre, so map.getCenter() is the chosen point.
  function centerPlacement(p, minZoom = 17) {
    const home = campuses.find((c) => mapUtils.contains(c, p));
    if (home && home.id !== campus.id) switchCampus(home.id);
    map.setView([p.lat, p.lng], Math.min(MAX_ZOOM, Math.max(map.getZoom(), minZoom)), { animate: false });
  }
  function startPlacement(start = null, hint = '') {
    const r = state.report;
    if (!r || r.step === 'done') return;
    locateId++;
    setMenu(false);
    r.camera?.dispose(); r.camera = null; // the camera never runs behind the map
    r.gps = null;
    r.placing = { hint, gps: null };
    const from = start || r.pin;
    if (from) centerPlacement(from);
    else {
      // Nothing chosen yet: start from the current view if it is on campus, otherwise the campus view. This is only a
      // starting view; nothing is saved until Confirm Location.
      const c = map.getCenter();
      if (!onCampus({ lat: c.lat, lng: c.lng })) map.setView([campus.center.lat, campus.center.lng], campusView(campus).startZoom, { animate: false });
    }
    sfx.play('switch');
    render();
    map.invalidateSize();
    updatePlacement();
    $('#place-confirm').focus({ preventScroll: true });
  }
  function confirmPlacement() {
    const r = state.report;
    if (!r?.placing) return;
    const c = map.getCenter(), p = { lat: c.lat, lng: c.lng };
    if (!onCampus(p)) return;
    locateId++;
    r.pin = p; r.placing = null; r.gps = null; r.step = 'review'; r.error = '';
    sfx.play('place');
    render();
  }
  function cancelPlacement() {
    const r = state.report;
    if (!r?.placing) return;
    locateId++;
    r.placing = null; // the previously confirmed pin (if any) is untouched
    sfx.play('close');
    render();
  }
  let placeFrame = 0;
  function updatePlacement() {
    if (!state.report?.placing) return;
    const c = map.getCenter(), ok = onCampus({ lat: c.lat, lng: c.lng });
    const where = $('#place-where');
    where.textContent = ok ? placeName(c.lat, c.lng) : 'Off campus. Move onto Main, Rosen or Downtown.';
    where.classList.toggle('bad', !ok);
    $('#place-confirm').disabled = !ok;
  }
  map.on('move', () => { if (state.report?.placing) { cancelAnimationFrame(placeFrame); placeFrame = requestAnimationFrame(updatePlacement); } });
  map.on('movestart', () => document.body.classList.add('map-moving'));
  map.on('moveend', () => { document.body.classList.remove('map-moving'); updatePlacement(); });
  $('#place-confirm').addEventListener('click', confirmPlacement);
  $('#place-back').addEventListener('click', cancelPlacement);
  $('#place-gps').addEventListener('click', () => { sfx.play('click'); locate(true); });
  $('#place-pin-img').src = CONFIG.PLACE_PIN_IMAGE;

  async function submitReport() {
    const r = state.report;
    if (!r || r.submitting || r.placing || !onCampus(r.pin) || (CONFIG.ACCOUNTS && !r.photo)) return;
    if (CONFIG.ACCOUNTS && r.captureExpiresAt <= nowSec()) { expirePhoto(r); return; }
    r.submitting = true;
    r.error = '';
    sfx.play('click');
    render();
    try {
      r.requestId = r.requestId || crypto.randomUUID();
      const res = await api.postSighting({ requestId:r.requestId, lat: r.pin.lat, long: r.pin.lng, caption: r.caption, photo:r.photo, captureToken:r.captureToken });
      state.nextSightingAt = res.nextSightingAt;
      const saved = rememberOwn(res, r.pin); // the pin exists locally right away, whatever the next poll returns
      state.reportsLoaded = false; state.leadersLoaded = false;
      if (state.report !== r) { refresh({quiet:true}); return; } // preserve cooldown if panel closed
      r.camera?.dispose(); r.camera = null;
      r.result = saved;
      r.step = 'done';
      sfx.play('success');
      const btn = $('#btn-report').getBoundingClientRect();
      fx.burst(btn.left + btn.width / 2, btn.top, 120);
      render(); // show SEE SIGHTING now; the background refresh below must not delay it
      refresh({ quiet: true });
      fx.toast('SIGHTING POSTED!', (res.points == null ? '' : '+' + pts(res.points) + '. ') + (isPublic(saved) ? 'Your pin is live in Recent Sightings.' : 'Your photo report was saved.'), 'good');
    } catch (err) {
      if (state.report !== r) return;
      r.error = err.message;
      if (err.status === 429) state.nextSightingAt = nowSec() + (err.retryAfter || CONFIG.COOLDOWN_SEC);
      if (err.status === 401) { state.user = null; state.auth.after = 'report'; openPanel('account'); }
      sfx.play('error');
      fx.replay($('#panel'), 'shake');
      fx.toast("COULDN'T POST", err.message, 'bad', 2800);
    } finally {
      r.submitting = false;
      render();
    }
  }

  /** A captured photo is only valid for its capture token's lifetime; after that it must be retaken. */
  function expirePhoto(r) {
    if (!r.photo) return;
    if (r.camera) { r.camera.expire(); return; } // still on the photo step: the camera handles it
    r.photo = null; r.captureToken = null; r.captureExpiresAt = 0; r.requestId = null; r.photoExpired = true;
    if (state.report === r && state.panel === 'report') render();
  }
  function toPhotoStep(r) { sfx.play('switch'); r.step = 'capture'; r.error = ''; render(); }

  function reportView(r) {
    const order = ['capture', 'location', 'review'];
    const idx = Math.max(0, order.indexOf(r.step));
    const steps = h('ol', { class: 'steps three' },
      [CONFIG.ACCOUNTS ? 'PHOTO' : 'DETAILS', 'LOCATION', 'SUBMIT'].map((label, i) =>
        h('li', { class: i === idx ? 'on' : i < idx ? 'done' : '', 'aria-current': i === idx ? 'step' : null }, `${i + 1}. ${label}`)));
    const captionField = () => {
      const counter = h('span', { class: 'muted small counter' }, `${r.caption.length}/${CONFIG.CAPTION_MAX}`);
      const ta = h('textarea', { id: 'rep-caption', maxlength: CONFIG.CAPTION_MAX, placeholder: 'Knightro is near the Student Union' });
      ta.value = r.caption;
      ta.addEventListener('input', () => {
        r.caption = ta.value;
        counter.textContent = `${ta.value.length}/${CONFIG.CAPTION_MAX}`;
        counter.classList.toggle('near', ta.value.length > CONFIG.CAPTION_MAX - 20);
        sfx.play('type');
      });
      return h('div', { class: 'field' }, h('label', { class: 'label', for: 'rep-caption' }, 'What is he doing? (optional)'), ta, counter);
    };

    // 1. Photo (or just the note on the static demo).
    if (r.step === 'capture') {
      if (CONFIG.ACCOUNTS && !r.photo && !r.camera) r.camera = window.KT.camera.create(capture => {
        if (state.report !== r) return;
        r.photo = capture?.photo || null; r.captureToken = capture?.captureToken || null;
        r.requestId = null; r.photoExpired = false;
        r.captureExpiresAt = capture?.captureExpiresAt || 0; r.error = '';
        render(); // enables NEXT
      });
      if (r.camera) r.camera.element.inert = r.submitting;
      const next = () => {
        sfx.play('switch');
        r.camera?.dispose(); r.camera = null; // release the camera as soon as the photo step is left
        r.error = ''; r.step = r.pin ? 'review' : 'location';
        render();
      };
      return [
        steps,
        !CONFIG.ACCOUNTS && h('p', { class: 'msg warn' }, 'Static demo: your sighting posts its location and caption to the shared map. Photo proof, accounts and points need the Knightro app server.'),
        CONFIG.ACCOUNTS && (r.camera ? r.camera.element : h('figure', { class: 'report-photo' },
          h('img', { src: r.photo, alt: 'Your sighting photo' }),
          h('button', { type: 'button', class: 'px-btn alt sm', onclick: () => { sfx.play('click'); r.photo = null; r.captureToken = null; render(); } }, 'RETAKE PHOTO'))),
        r.photoExpired && !r.photo && h('p', { class: 'msg warn' }, 'Your photo expired. Take a new one to continue.'),
        captionField(),
        CONFIG.ACCOUNTS && h('p', { class: 'muted small' }, 'Next, choose where you saw him. Submit within 2 minutes of taking the photo.'),
        h('div', { class: 'panel-foot' },
          h('button', { type: 'button', class: 'px-btn alt', onclick: closePanel }, 'CANCEL'),
          h('button', { id: 'rep-next', type: 'button', class: 'px-btn', disabled: CONFIG.ACCOUNTS && !r.photo, onclick: next }, 'NEXT: LOCATION')),
      ];
    }

    // 2. Choose how to set the location. Placing a pin on the map is the default; GPS and buildings propose a spot.
    if (r.step === 'location') {
      const warn = r.gps && r.gps !== 'locating';
      return [
        steps,
        h('h3', {}, 'WHERE DID YOU SEE KNIGHTRO?'),
        h('button', { type: 'button', class: 'px-btn place-main', onclick: () => startPlacement() }, 'PLACE PIN ON MAP'),
        h('p', { class: 'muted small' }, 'Move the map under a fixed pin, then confirm. No location permission needed.'),
        h('div', { class: 'loc-alt' },
          h('span', { class: 'label' }, 'Or'),
          h('button', { type: 'button', class: 'px-btn alt sm', disabled: r.gps === 'locating', onclick: () => { sfx.play('click'); locate(false); } }, r.gps === 'locating' ? 'FINDING YOU…' : 'USE MY LOCATION')),
        r.gps && h('div', { class: `msg${warn ? ' warn' : ''}${r.gps === 'locating' ? ' scanning' : ''}`, role: 'status' }, GPS_MSG[r.gps]),
        h('label', { class: 'field' }, h('span', { class: 'label' }, 'Or jump to a building'), h('select', { id: 'report-building', onchange: (event) => {
          const b = buildings.find((x) => x.id === event.target.value);
          if (b) startPlacement({ lat: b.lat, lng: b.long }, 'Centred on ' + b.name + '. Adjust if needed, then confirm.');
        } }, h('option', { value: '' }, 'Choose a campus building…'), ...buildings.filter((b) => b.campus === campus.id).map((b) => h('option', { value: b.id }, b.name)))),
        h('div', { class: 'panel-foot' },
          h('button', { type: 'button', class: 'px-btn alt', onclick: () => toPhotoStep(r) }, 'BACK'),
          h('span')),
      ];
    }

    // 3. Review and submit: photo, note, and the confirmed location (changeable). Submitting is its own action.
    if (r.step === 'review') {
      const coords = r.pin.lat.toFixed(5) + ', ' + r.pin.lng.toFixed(5);
      return [
        steps,
        CONFIG.ACCOUNTS && (r.photo
          ? h('figure', { class: 'report-photo review' }, h('img', { src: r.photo, alt: 'Your sighting photo' }),
            h('figcaption', { class: 'small muted' }, 'Photo valid for ', h('b', { class: 'num', 'data-expires': r.captureExpiresAt }, countdown(r.captureExpiresAt))))
          : h('div', { class: 'msg warn' }, 'Your photo expired before it was submitted. Retake it to continue. Your location is kept.')),
        h('div', { class: 'loc-summary' },
          h('span', { class: 'label' }, 'Location'),
          h('strong', {}, placeName(r.pin.lat, r.pin.lng)),
          h('span', { class: 'small muted num' }, coords),
          h('button', { type: 'button', class: 'px-btn alt sm', disabled: r.submitting, onclick: () => startPlacement() }, 'CHANGE LOCATION')),
        r.caption && h('p', { class: 'quote' }, r.caption),
        r.error && errorBox(r.error),
        h('div', { class: 'panel-foot' },
          h('button', { type: 'button', class: 'px-btn alt', disabled: r.submitting, onclick: () => toPhotoStep(r) }, CONFIG.ACCOUNTS && !r.photo ? 'RETAKE PHOTO' : 'BACK'),
          h('button', { id: 'rep-submit', type: 'button', class: `px-btn${r.submitting ? ' loading' : ''}`,
            disabled: r.submitting || (CONFIG.ACCOUNTS && !r.photo) || state.nextSightingAt > nowSec() || !onCampus(r.pin), onclick: submitReport },
          r.submitting ? 'POSTING…' : 'SUBMIT SIGHTING')),
      ];
    }

    // done
    const saved = r.result, live = isPublic(saved);
    return [
      // Checkmark when the sighting is public; warning when it was saved but not posted.
      h('div', { class: 'victory' + (live ? '' : ' not-posted') }, h('img', { class: 'result-art', src: 'assets/photos/icons/' + (live ? 'success' : 'warning') + '.svg', alt: '' }), h('h3', {}, live ? 'SIGHTING POSTED' : 'NOT POSTED')),
      h('dl', { class: 'kv' }, h('dt', {}, 'WHERE'), h('dd', {}, placeName(saved.lat, saved.long))),
      live
        ? h('div', { class: 'msg', role: 'status' }, ...numText((saved.points == null ? 'Saved to the shared sightings map. ' : '+' + pts(saved.points) + ' awarded. ') + 'Your pin is live on the map and in Recent Sightings.'))
        : h('div', { class: 'msg warn', role: 'status' }, 'This report is not public. Take a new photo with Knightro clearly in frame.'),
      h('div', { class: 'panel-foot' },
        h('button', { type: 'button', class: 'px-btn alt', onclick: closePanel }, 'CLOSE'),
        h('button', { type: 'button', class: 'px-btn', onclick: () => showSighting(saved.sightingId) }, 'SEE SIGHTING')
      ),
    ];
  }

  /**
   * Take the map to the exact sighting the user just created and open it. The pin comes from ownPosts, so it is
   * there on the first tap even if the background refresh is slow, failed, or returned an older list.
   */
  function showSighting(id) {
    const s = ownPosts.get(id) || state.sightings.find((x) => x.sightingId === id);
    if (!s) return;
    locateId++; // a late GPS answer from the report must not move the map afterwards
    state.report?.camera?.dispose();
    state.report = null;
    state.selectedId = id; state.panel = 'detail'; state.backTo = 'recent';
    const home = campuses.find((c) => mapUtils.contains(c, { lat: s.lat, lng: s.long }));
    if (home && home.id !== campus.id) switchCampus(home.id);
    sfx.play('switch');
    render();
    focusOn(s.lat, s.long, 18, { pinHeight: PIN_LIFT, done: () => spotlight(id) });
  }
  /** Bring a sighting's marker to the front, pulse it, and give it keyboard focus. */
  function spotlight(id) {
    if (state.selectedId !== id) return; // the user moved on during the flight
    renderMarkers();
    const marker = [...markers.values()].find((m) => m.items.some((item) => item.sightingId === id));
    const el = marker?.getElement();
    if (!el) return;
    marker.setZIndexOffset(900);
    fx.replay(el, 'spotlight');
    clearTimeout(el._spotTimer);
    el._spotTimer = setTimeout(() => el.classList.remove('spotlight'), 3000); // pulse ends; the pin returns to normal
    fx.replay(el.querySelector('.pin-art'), 'tap');
    el.focus({ preventScroll: true });
  }

  /** Failed request: say what went wrong and offer a retry. */
  function errorBox(message, retry) {
    return h('div', { class: 'msg err error-box', role: 'alert' }, h('img', { class: 'msg-ico', src: 'assets/photos/icons/warning.svg', alt: '' }), h('span', {}, message),
      retry && h('button', { type: 'button', class: 'px-btn sm alt', onclick: () => { sfx.play('click'); retry(); } }, 'RETRY'));
  }
  /** A feature this deployment doesn't include (static GitHub Pages copy). Not an error, no retry. */
  function unavailableBox(feature) {
    return h('div', { class: 'msg warn notice-box' }, h('strong', {}, 'NOT ON THIS SITE'),
      h('span', {}, feature + ' needs the Knightro app server. This GitHub Pages copy is a static demo: it shows live sightings and likely Knightro events only.'));
  }
  function recentView() {
    if (!state.loaded) return [h('p', { class: 'muted loading-line' }, 'Loading sightings…')];
    if (state.netError && !state.hasData) {
      return [h('h3', {}, "CAN'T LOAD SIGHTINGS"), errorBox(state.netError, () => refresh())];
    }
    if (!campusSightings().length) {
      return [
        h('div', { class: 'empty' }, h('img', { class: 'empty-art', src: 'assets/photos/icons/recent-spots.svg', alt: '' }), h('h3', {}, 'NO ACTIVE SIGHTINGS')),
        h('p', { class: 'muted' }, 'No active reports on this campus in the last 20 minutes. Spot him? Tap REPORT SIGHTING.'),
      ];
    }
    return campusSightings().map((s) => {
      const photo = photoFor(s);
      return h('button', { type: 'button', class: 'feed-item', onclick: () => { openDetail(s.sightingId, 'recent'); focusOn(s.lat, s.long, 17, { pinHeight: PIN_LIFT, done: () => spotlight(s.sightingId) }); } },
        h('img', { src: photo.src, alt: '', class: photo.pixel ? 'pixel' : null }),
        h('span', { class: 'feed-text' },
          h('strong', {}, placeName(s.lat, s.long)),
          h('span', { class: 'muted small' }, ...numText(`${timeAgo(s)} · ${clock(s)}`), !isPublic(s) && ' · PENDING REVIEW'),
          s.caption && h('span', { class: 'small' }, s.caption)
        )
      );
    });
  }

  function detailView() {
    const id = state.selectedId;
    const s = campusSightings().find((x) => x.sightingId === id) || state.sightings.find((x) => x.sightingId === id) || ownPosts.get(id);
    if (!s || ageSec(s) >= CONFIG.ACTIVE_WINDOW_SEC) return [h('p', { class: 'muted' }, 'This sighting is more than 20 minutes old and has left the map.')];
    const fresh = ageSec(s) < CONFIG.FRESH_SEC;
    const photo = photoFor(s);
    const mine = ownPosts.has(s.sightingId);
    return [
      s.isTest && h('p', { class: 'msg warn' }, 'TEST SIGHTING · only visible to admins in Admin Mode · 0 points'),
      // Moderation status exactly as the server reported it; a pending report is never shown as public.
      s.status === 'pending' && h('p', { class: 'msg warn' }, 'NOT POSTED · Take a new photo with Knightro clearly in frame.'),
      s.status === 'rejected' && h('p', { class: 'msg err' }, 'NOT PUBLIC · This report was removed or Knightro was not detected.'),
      h('div', { class: 'label' }, mine ? 'Your sighting' : s.sightingId === campusSightings()[0]?.sightingId ? 'Latest sighting' : 'Sighting'),
      h('figure', { class: 'photo-fig' },
        h('img', { class: `photo${photo.pixel ? ' pixel' : ''}`, src: photo.src, alt: s.photoUrl ? 'Reported Knightro sighting photo' : 'Illustration of Knightro' }),
        h('figcaption', { class: 'label' }, ...numText(s.photoUrl
          ? (s.status === 'confirmed' ? 'Photo confirmed' : s.status === 'pending' ? 'Photo report · not posted' : 'Community photo report') + (s.points == null ? '' : ' · ' + pts(s.points))
          : s.isTest ? 'Test sighting · illustration' : s.source === 'aws' ? 'Shared map sighting · no photo' : 'Legacy sighting · illustration'))
      ),
      h('div', { class: `fresh-note ${fresh ? 'live' : 'old'}` },
        ...numText(fresh ? `SPOTTED ${timeAgo(s).toUpperCase()}. HE MAY STILL BE NEARBY.` : `SEEN ${timeAgo(s).toUpperCase()}. HE MAY HAVE MOVED ON.`)),
      h('h3', {}, placeName(s.lat, s.long).toUpperCase()),
      h('dl', { class: 'kv' }, h('dt', {}, 'SEEN'), h('dd', {}, ...numText(`${clock(s)} (${timeAgo(s)})`))),
      s.caption && h('p', { class: 'quote' }, s.caption),
      h('div', { class: 'actions' }, h('button', { type: 'button', class: 'px-btn alt sm', onclick: () => focusOn(s.lat, s.long, 17, { pinHeight: PIN_LIFT, done: () => spotlight(s.sightingId) }) }, 'SHOW ON MAP')),
    ];
  }

  // ---------- navigation, verified accounts, events, leaderboard ----------
  let menuOpen = false;
  function setMenu(open) {
    if (open === menuOpen) return;
    menuOpen = open;
    const nav = $('#navigation'), toggle = $('#btn-menu');
    if (!open && nav.contains(document.activeElement)) toggle.focus({ preventScroll: true });
    nav.classList.toggle('open', open);
    // Phones: the menu and a panel never show at once. The panel is kept (not closed) so a report in progress survives.
    document.body.classList.toggle('menu-open', open);
    nav.inert = !open;
    nav.setAttribute('aria-hidden', String(!open));
    toggle.classList.toggle('open', open);
    toggle.setAttribute('aria-expanded', String(open));
    toggle.setAttribute('aria-label', open ? 'Close menu' : 'Open menu');
    sfx.play(open ? 'open' : 'close');
  }
  $('#btn-menu').addEventListener('click', () => setMenu(!menuOpen));
  document.addEventListener('pointerdown', (e) => {
    if (!e.target.closest('#navigation, #btn-menu')) setMenu(false);
  });
  function updateCooldown() {
    const remaining = Math.max(0, Math.ceil(state.nextSightingAt - nowSec()));
    if (state.panel !== 'report') setNum($('#report-label'), remaining && state.user
      ? 'NEXT REPORT ' + Math.floor(remaining / 60) + ':' + String(remaining % 60).padStart(2, '0') : 'REPORT SIGHTING');
    const label = $('#cooldown-note');
    if (label) setNum(label, remaining ? 'Next sighting available in ' + remaining + ' seconds.' : 'You can report a sighting now.');
    const submit = $('#rep-submit');
    if (submit && !state.report?.submitting) {
      submit.disabled = remaining > 0 || !onCampus(state.report?.pin) || (CONFIG.ACCOUNTS && (!state.report?.photo || state.report.captureExpiresAt <= nowSec()));
      setNum(submit, remaining ? 'WAIT ' + remaining + 's' : 'SUBMIT SIGHTING');
    }
  }
  function accountView() {
    if (!CONFIG.ACCOUNTS) return [unavailableBox('Signing in')];
    if (state.user) return [
      h('h3', {}, 'WELCOME, ' + state.user.displayName.toUpperCase()),
      h('p', {}, state.user.email),
      h('p', {class:'stat'}, h('span', {class:'label'}, 'Total points'), h('strong', {class:'num stat-value'}, fmt(state.user.score))),
      state.admin?.allowed && h('p', {class:'msg warn'}, 'This account is authorized for Admin Mode. Use the ADMIN section of the menu.'),
      h('p', {class:'msg'}, (state.authMode === 'password' ? 'Your UCF email address has not been verified. ' : 'UCF email verified. ') + 'Photos where the checker detects Knightro post automatically and earn points; your first matching report in today’s bounty section earns double. Your email stays private.'),
      h('p', {id:'cooldown-note',class:'small'}),
      h('p', {class:'muted small'}, 'An essential sign-in cookie keeps this browser signed in for 14 days. Signing out removes it. No advertising cookies are used.'),
      h('button', {type:'button',class:'px-btn alt',onclick:async (event) => {
        const button = event.currentTarget;
        button.disabled = true;
        try { await api.logout(); state.user = null; state.admin = null; state.testSightings = []; state.testEvents = []; state.nextSightingAt = 0; render(); }
        catch (error) { button.disabled = false; fx.toast('SIGN OUT FAILED',error.message,'bad'); }
      }}, 'SIGN OUT'),
    ];
    if (state.authMode === 'password') return passwordAccountView();
    const a = state.auth;
    const email = h('input', {id:'account-email',type:'email',autocomplete:'email',required:true,maxlength:254,placeholder:'you@ucf.edu',disabled:a.busy});
    email.value = a.email;
    email.addEventListener('input', () => { a.email = email.value; });
    const name = h('input', {id:'account-name',autocomplete:'nickname',required:a.mode === 'signup',minlength:2,maxlength:30,placeholder:'Your public Knight name',disabled:a.busy});
    name.value = a.displayName;
    name.addEventListener('input', () => { a.displayName = name.value; });
    const code = h('input', {id:'account-code',inputmode:'numeric',pattern:'[0-9]{6}',maxlength:6,autocomplete:'one-time-code',required:true,placeholder:'123456',disabled:a.busy});
    const error = h('div', {class:'msg err',role:'alert',hidden:!a.error}, a.error);
    const submit = h('button', {type:'submit',class:'px-btn',disabled:a.busy}, a.busy ? 'PLEASE WAIT…' : a.step === 'code' ? 'VERIFY & SIGN IN' : 'EMAIL ME A CODE');
    const form = h('form', {class:'account-form',onsubmit:async (event) => {
      event.preventDefault();
      if (a.busy) return;
      const verificationCode = code.value;
      a.busy = true; a.error = ''; render();
      try {
        if (a.step === 'email') {
          await api.requestCode(a.email.trim(), a.displayName.trim(), a.mode);
          a.step = 'code';
        } else {
          const session = await api.verifyCode(a.email.trim(), verificationCode);
          applySession(session);
          fx.toast('WELCOME, KNIGHT', 'Your UCF account is ready.', 'good');
          const next = a.after; a.after = null; a.step = 'email';
          if (next) { closePanel(); openPanel(next); }
        }
      } catch (err) { a.error = err.message; }
      finally { a.busy = false; if (state.panel === 'account') render(); }
    }},
      a.step === 'email' ? [
        h('div',{class:'field'},h('label',{for:'account-email'},'UCF EMAIL'),email),
        a.mode === 'signup' && h('div',{class:'field'},h('label',{for:'account-name'},'PUBLIC DISPLAY NAME'),name),
      ] : [
        h('p',{},'If this address can sign in, a code was sent to ' + a.email + '. Codes expire in 10 minutes.'),
        h('div',{class:'field'},h('label',{for:'account-code'},'SIX-DIGIT EMAIL CODE'),code),
      ],
      error, submit);
    return [
      h('h3',{},a.mode === 'signup' ? 'JOIN THE KNIGHT WATCH' : 'WELCOME BACK'),
      state.emailDelivery === 'development' && h('p',{class:'msg warn'},'Local preview: verification codes are saved to the development mail folder instead of being emailed.'),
      state.emailDelivery === 'unconfigured' && h('p',{class:'msg warn'},'Email sign-in is not available yet. Please try again later.'),
      h('p',{class:'small'},'Create an account or sign in using a code sent to your @ucf.edu or @knights.ucf.edu inbox. No password needed.'),
      form,
      h('button',{type:'button',class:'px-btn alt',disabled:a.busy,onclick:() => {
        if (a.step === 'code') a.step = 'email';
        else a.mode = a.mode === 'signup' ? 'login' : 'signup';
        a.error = ''; render();
      }},a.step === 'code' ? 'CHANGE EMAIL / SEND AGAIN' : a.mode === 'signup' ? 'ALREADY A KNIGHT? SIGN IN' : 'CREATE AN ACCOUNT'),
      h('p',{class:'muted small'},'Signing in sets an essential cookie for 14 days. Your email stays private; your display name and sighting points appear on the leaderboard.'),
    ];
  }
  const eventTime = (value) => new Date(value * 1000).toLocaleString([], {timeZone:'America/New_York',month:'short',day:'numeric',hour:'numeric',minute:'2-digit'});
  function passwordAccountView() {
    const a = state.auth;
    const email = h('input', {id:'account-email',type:'email',autocomplete:'email',required:true,maxlength:254,placeholder:'you@ucf.edu',disabled:a.busy});
    email.value = a.email;
    email.oninput = () => {a.email=email.value;};
    const name = h('input', {id:'account-name',autocomplete:'nickname',required:true,minlength:2,maxlength:30,placeholder:'Your public Knight name',disabled:a.busy});
    name.value = a.displayName;
    name.oninput = () => {a.displayName=name.value;};
    const password = h('input', {id:'account-password',type:'password',autocomplete:a.mode==='signup'?'new-password':'current-password',required:true,minlength:12,maxlength:128,disabled:a.busy});
    const form = h('form', {class:'account-form',onsubmit:async event => {
      event.preventDefault();
      if(a.busy) return;
      const secret = password.value;
      password.value = ''; a.busy=true; a.error=''; render();
      try {
        const session = a.mode==='signup' ? await api.signup(a.email.trim(),secret,a.displayName.trim()) : await api.login(a.email.trim(),secret);
        applySession(session);
        fx.toast('WELCOME, KNIGHT','Your account is ready.','good');
        const next=a.after;a.after=null;
        if(next) {closePanel();openPanel(next);}
      } catch(error) {a.error=error.message;}
      finally {a.busy=false;if(state.panel==='account') render();}
    }},
      h('div',{class:'field'},h('label',{for:'account-email'},'UCF EMAIL'),email),
      a.mode==='signup'&&h('div',{class:'field'},h('label',{for:'account-name'},'PUBLIC DISPLAY NAME'),name),
      h('div',{class:'field'},h('label',{for:'account-password'},'PASSWORD · 12+ CHARACTERS'),password),
      h('div',{class:'msg err',role:'alert',hidden:!a.error},a.error),
      h('button',{type:'submit',class:'px-btn',disabled:a.busy},a.busy?'PLEASE WAIT…':a.mode==='signup'?'CREATE ACCOUNT':'SIGN IN'));
    return [
      h('h3',{},a.mode==='signup'?'JOIN THE KNIGHT WATCH':'WELCOME BACK'),
      h('p',{class:'small'},'Use an @ucf.edu or @knights.ucf.edu address and a password. Email ownership is not verified yet.'),
      form,
      h('button',{type:'button',class:'px-btn alt',disabled:a.busy,onclick:()=>{a.mode=a.mode==='signup'?'login':'signup';a.error='';render();}},a.mode==='signup'?'ALREADY A KNIGHT? SIGN IN':'CREATE AN ACCOUNT'),
      h('p',{class:'muted small'},'Signing in uses an essential cookie for up to 14 days. Keep your password safe; email password recovery is not available yet.'),
    ];
  }
  function resolveEvent(event) {
    return event; // The backend alone selects likely events and resolves their building sector.
  }
  let eventsInFlight = false;
  async function loadEvents() {
    if (eventsInFlight) return;
    eventsInFlight = true;
    try {
      const data = await api.getEvents();
      state.events = (data.events || []).filter((e) => e.eventId && typeof e.title === 'string' && Number.isFinite(e.startsAt) && Number.isFinite(e.endsAt) && e.endsAt > nowSec())
        .map(resolveEvent).sort((a,b) => a.startsAt - b.startsAt);
      state.eventsGeneratedAt = data.generatedAt;
      state.eventsError = '';
      state.eventsAvailable = data.available !== false;
    } catch (err) { state.eventsError = err.message; }
    finally {
      state.eventsLoaded = true; eventsInFlight = false;
      render({panel:['events','event','stack'].includes(state.panel)});
    }
  }
  function openMapItem(item) {
    if (item.kind === 'sighting') { openDetail(item.sightingId, state.panel === 'stack' ? 'stack' : null); }
    else if (item.kind === 'bounty') { openPanel('bounties'); }
    else { state.selectedEvent = item.eventId; state.panel = 'event'; state.backTo = 'events'; render(); }
  }
  function eventRow(event) {
    const mapped = Number.isFinite(event.lat) && Number.isFinite(event.long) && onCampus({lat:event.lat,lng:event.long});
    return h('button',{type:'button',class:'event-row',onclick:() => {
      state.selectedEvent = event.eventId; state.panel = 'event'; state.backTo = 'events'; render();
      if (mapped) focusOn(event.lat,event.long);
    }},
      h('strong',{},event.title),
      h('span',{class:'small'},...numText(eventTime(event.startsAt) + ' ET')),
      h('span',{class:'muted small'},(event.buildingName || event.location || 'Location to be announced') + (mapped ? '' : ' · Location not mapped')),
      h('span',{class:'small hint-reason'},event.reason || 'Possible appearance'));
  }
  function eventsView() {
    if (!state.eventsLoaded) return [h('p',{},'Loading campus events…')];
    // Same rule as the map: this week's events on the selected campus. Events with no mappable venue cannot belong to
    // a campus map, so they are listed (with their location status) whichever campus is selected.
    const week = thisWeek();
    const day = (t) => new Date(t * 1000).toLocaleDateString([], { timeZone: 'America/New_York', weekday: 'short', month: 'short', day: 'numeric' });
    const all = weekEvents().sort((a, b) => a.startsAt - b.startsAt);
    const here = all.filter((e) => !mappable(e) || campusOf(e)?.id === campus.id);
    const elsewhere = all.length - here.length;
    return [
      h('p',{class:'small'},'Events with evidence of a possible Knightro appearance on ' + campus.name + ' this week. Pins are building-level hints, not confirmed sightings.'),
      h('p',{class:'label week-label'},...numText('This week · ' + day(week.start) + ' – ' + day(week.end - 1))),
      state.eventsGeneratedAt && h('p',{class:'muted small'},...numText('Last synced ' + eventTime(state.eventsGeneratedAt) + ' ET')),
      state.eventsError && errorBox(state.eventsError, loadEvents),
      ...here.map(eventRow),
      !here.length && h('p',{class:'msg'},state.eventsAvailable === false ? 'The event feed has not been published yet. Check back soon.' : 'No likely Knightro appearances on this campus this week.'),
      elsewhere > 0 && h('p',{class:'muted small'},...numText(elsewhere + (elsewhere === 1 ? ' more event' : ' more events') + ' this week on other campuses. Switch campus in the menu to see ' + (elsewhere === 1 ? 'it.' : 'them.'))),
      h('button',{type:'button',class:'px-btn alt',onclick:loadEvents},'REFRESH EVENTS'),
    ];
  }
  function eventView() {
    const event = activeEvents().find((e) => e.eventId === state.selectedEvent);
    if (!event) return [h('p',{},'This event has ended or is no longer in the feed.')];
    let safeUrl = null;
    try { const url = new URL(event.url); if (url.protocol === 'https:') safeUrl = url.href; } catch { /* no external link */ }
    return [
      event.isTest && h('p',{class:'msg warn'},'TEST EVENT · only visible to admins in Admin Mode'),
      h('div',{class:'event-hero'},CONFIG.EVENT_FRAMES.map((src,i) => h('img',{src,alt:'',class:'event-frame frame-' + i}))),
      h('h3',{},event.title), h('p',{},event.location || 'Location to be announced'),
      h('p',{class:'msg'},event.reason + '. Knightro attendance is unconfirmed.'),
      h('dl',{class:'kv'},h('dt',{},'START'),h('dd',{},...numText(eventTime(event.startsAt) + ' ET')),h('dt',{},'END'),h('dd',{},...numText(eventTime(event.endsAt) + ' ET'))),
      Array.isArray(event.hosts) && h('p',{class:'muted'},'Hosted by ' + event.hosts.join(', ')),
      safeUrl && h('a',{class:'px-btn',href:safeUrl,target:'_blank',rel:'noopener noreferrer'},'VIEW ON KNIGHTCONNECT'),
    ];
  }
  function stackView() {
    const items = state.stack.filter((item) => item.kind === 'event' ? activeEvents().some((e) => e.eventId === item.eventId) : item.kind === 'bounty' ? activeBounties().some(b => b.bountyId === item.bountyId) : state.sightings.some((s) => s.sightingId === item.sightingId));
    return [
      h('p',{class:'small'},...numText(items.length + ' pins in this area. Select one below, or zoom in to separate nearby pins.')),
      ...items.map((item) => item.kind === 'event' ? eventRow(item) : item.kind === 'bounty' ? bountyRow(item) : h('button',{type:'button',class:'event-row',onclick:() => openDetail(item.sightingId,'stack')},
        h('strong',{},'KNIGHTRO · ' + placeName(item.lat,item.long)),h('span',{},...numText(timeAgo(item))),item.caption && h('span',{class:'muted'},item.caption))),
    ];
  }
  async function loadLeaderboard() {
    if (!CONFIG.ACCOUNTS) { state.leadersLoaded = true; return; }
    try { const data = await api.getLeaderboard(); state.leaders = data.leaders || []; state.leadersError = ''; }
    catch (err) { state.leadersError = err.message; }
    finally { state.leadersLoaded = true; if (state.panel === 'leaderboard') render(); }
  }
  function leaderboardView() {
    if (!CONFIG.ACCOUNTS) return [unavailableBox('The leaderboard')];
    if (!state.leadersLoaded) return [h('p',{class:'muted loading-line'},'Loading the Knight leaderboard…')];
    return [
      h('p',{class:'small'},'All-time campus spotters. Approved photo reports earn 1 point; the first daily bounty claim earns 2.'),
      state.leadersError && errorBox(state.leadersError, loadLeaderboard),
      !state.leadersError && !state.leaders.length && h('div',{class:'empty-state'},h('img',{src:IMG.helm,alt:''}),h('p',{},'No points on the board yet. Be the first Knight!')),
      h('ol',{class:'leaderboard'},state.leaders.map((person, i) => h('li',{class: i < 3 ? 'top top-' + (i + 1) : null},
        h('b',{class:'rank num','aria-label':'Rank ' + (i + 1)},String(i + 1)),
        h('span',{class:'lb-name'},person.displayName),
        h('strong',{class:'lb-score'},h('span',{class:'num'},fmt(person.score)),h('small',{},Number(person.score) === 1 ? ' pt' : ' pts'))))),
      h('button',{type:'button',class:'px-btn alt',onclick:loadLeaderboard},'REFRESH LEADERBOARD'),
    ];
  }

  // ---------- missions, coarse alerts, and photo review ----------
  function countdown(expires) {
    const seconds = Math.max(0, Math.ceil(expires - nowSec()));
    return seconds >= 3600 ? Math.floor(seconds / 3600) + 'h ' + Math.floor(seconds % 3600 / 60) + 'm'
      : Math.floor(seconds / 60) + ':' + String(seconds % 60).padStart(2, '0');
  }
  let gameInFlight = false, alertsLoaded = false;
  const seenAlerts = new Set();
  async function loadGame() {
    if (!CONFIG.ACCOUNTS) { state.gameLoaded = true; return; }
    if (gameInFlight) return;
    gameInFlight = true;
    try {
      const data = await api.getGame();
      state.bounties = (data.bounties || []).filter(b => b.bountyId && Number.isFinite(b.expiresAt) && Number.isFinite(b.lat) && Number.isFinite(b.long));
      state.alerts = (data.alerts || []).filter(a => a.expiresAt > nowSec());
      for (const alert of state.alerts) {
        if (alertsLoaded && !seenAlerts.has(alert.alertId)) fx.toast('KNIGHT-SENSE', alert.message, 'gold', 6000);
        seenAlerts.add(alert.alertId);
      }
      alertsLoaded = true; state.gameError = '';
    } catch (error) { state.gameError = error.message; }
    finally {
      state.gameLoaded = true; gameInFlight = false;
      render({panel:['bounties','sense'].includes(state.panel)});
    }
  }
  const chipIcon = (name) => h('img', { class: 'chip-ico', src: 'assets/photos/icons/' + name + '.svg', alt: '', width: 16, height: 16 });
  function paintMissions() {
    const current = activeBounties().find(b => b.campus === campus.id);
    // .m-long words drop on narrow phones so the countdown itself is never cut off.
    const bounty = current ? countdown(current.expiresAt) : '';
    if ($('#mission-bounty').dataset.text !== bounty) {
      $('#mission-bounty').dataset.text = bounty;
      $('#mission-bounty').replaceChildren(...(current
        ? [chipIcon('bounty'), ...numText('2×'), h('span', { class: 'm-long' }, ' BOUNTY ·'), ' ', h('span', { class: 'num' }, bounty)]
        : [chipIcon('bounty'), 'DAILY BOUNTIES']));
    }
    const alert = state.alerts.find(a => a.expiresAt > nowSec());
    if ($('#mission-sense').dataset.alert !== String(!!alert)) {
      $('#mission-sense').dataset.alert = String(!!alert);
      $('#mission-sense').replaceChildren(chipIcon('knight-sense'), 'KNIGHT-SENSE', ...(alert ? [h('span', { class: 'm-long' }, ' · NEW HINT')] : []));
      $('#mission-sense').setAttribute('aria-label', alert ? 'Knight-Sense: new hint' : 'Knight-Sense'); // even when the words are hidden
    }
    $('#mission-sense').classList.toggle('has-alert', !!alert);
  }
  function bountyRow(b) {
    return h('button', {type:'button',class:'bounty-card',onclick:() => {
      if (state.panel !== 'bounties') openPanel('bounties');
      if (b.campus !== campus.id) switchCampus(b.campus);
      const bounds = L.latLngBounds(b.area.map(([lng,lat]) => [lat,lng]));
      map.fitBounds(bounds, {paddingTopLeft:[24,150], paddingBottomRight:isMobile() ? [24,Math.ceil(innerHeight*.6)] : [$('#panel').offsetWidth + 50,100], maxZoom:17});
    }}, h('strong', {class:'bounty-multiplier'}, '2×'), h('span', {}, h('strong',{},b.sectorName), h('span',{class:'small'}, ...numText(b.buildings.length + ' BUILDINGS · UNTIL CAMPUS MIDNIGHT')),
      h('span',{class:'small bounty-buildings'},b.buildings.map(item => item.name).join(' · '))),
      h('b', {'data-expires':b.expiresAt,class:'bounty-clock num'}, countdown(b.expiresAt)));
  }
  function bountiesView() {
    if (!CONFIG.ACCOUNTS) return [unavailableBox('Daily bounties')];
    const daily = activeBounties().filter(b => b.campus === campus.id);
    return [
      h('div',{class:'mission-intro'},h('span',{class:'eyebrow'},'TODAY’S CAMPUS CHALLENGE'),h('h3',{},'All day. Double points.'),h('p',{},'Spot Knightro in today’s shaded section' + (campus.id === 'main' ? ' across five buildings and their connecting paths.' : '.') + ' Resets at campus midnight.')),
      h('p',{class:'msg'},'First bounty report: 2 points. Later reports: 1 point. The section is a challenge, not a guaranteed Knightro location.'),
      state.gameError && errorBox(state.gameError, loadGame),
      ...daily.map(bountyRow),
      !daily.length && h('p',{class:'muted'},campus.id === 'rosen' ? 'Daily bounties are available on Main and Downtown. Rosen sightings earn 1 point.' : state.gameLoaded ? 'Today’s bounty is being prepared. Checking again shortly.' : 'Checking current bounties…'),
      campus.id === 'downtown' && h('p',{class:'small muted'},'This section covers Downtown’s two mapped academic buildings.'),
      h('button',{type:'button',class:'px-btn',onclick:() => openPanel('report')},'SNAP A KNIGHTRO PHOTO'),
    ];
  }
  function senseView() {
    if (!CONFIG.ACCOUNTS) return [unavailableBox('Knight-Sense alerts')];
    return [
      h('div',{class:'mission-intro'},h('span',{class:'eyebrow'},'TRUST YOUR KNIGHT-SENSE'),h('h3',{},'A hint. A building. A head start.'),h('p',{},'A sudden cluster of verified app openings or an upcoming likely mascot event can trigger a campus-wide alert. Hints name a building and never reveal users’ exact locations.')),
      state.gameError && errorBox(state.gameError, loadGame),
      ...state.alerts.filter(a => a.expiresAt > nowSec()).map(a => h('article',{class:'sense-card'},h('strong',{},a.message),h('p',{class:'small muted'},a.reason + ' · Unconfirmed hint'),h('span',{'data-expires':a.expiresAt,class:'small num'},countdown(a.expiresAt)))),
      !state.alerts.some(a => a.expiresAt > nowSec()) && h('p',{class:'msg'},'All quiet. Keep an eye on the map for the next signal.'),
      h('button',{type:'button',class:'px-btn',onclick:async () => {
        if (!state.user) return openPanel('account');
        try { state.senseMessage = await window.KT.sense.enable(); } catch (error) { state.senseMessage = error.message; }
        if (state.panel === 'sense') render();
      }},'ENABLE PUSH ALERTS'),
      h('button',{type:'button',class:'px-btn alt',onclick:async () => {
        if (!state.user) return openPanel('account');
        try { state.senseMessage = await window.KT.sense.disable(); } catch (error) { state.senseMessage = error.message; }
        if (state.panel === 'sense') render();
      }},'DISABLE PUSH ON THIS DEVICE'),
      h('p',{class:'small muted'},'Optional: contribute a location signal when you open the app. The server retains only your building sector and account ID for up to 10 minutes. You can turn this off anytime.'),
      h('button',{type:'button',class:'px-btn alt',onclick:async () => {
        if (!state.user) return openPanel('account');
        const on = !window.KT.sense.presenceEnabled(); window.KT.sense.setPresence(on);
        state.senseMessage = on ? 'Location signals enabled when you open the app. Allow location access when prompted.' : 'Location signals disabled on this device.';
        render(); if (on) await window.KT.sense.presence(state.user, true);
      }}, window.KT.sense.presenceEnabled() ? 'TURN OFF LOCATION SIGNALS' : 'OPT IN TO LOCATION SIGNALS'),
      state.senseMessage && h('p',{class:'msg',role:'status'},state.senseMessage),
      h('p',{class:'small muted'},'Push needs browser permission and server VAPID configuration. Supported iPhones require adding the site to the Home Screen.'),
    ];
  }
  async function loadReports() {
    if (!CONFIG.ACCOUNTS) { state.reportsLoaded = true; return; }
    try {
      state.reports = (await api.getReports()).reports; state.reportsError = '';
      // Keep this device's own pins in step with moderation (e.g. pending -> published or rejected).
      for (const report of state.reports) {
        const own = ownPosts.get(report.sightingId);
        if (own && report.status && own.status !== report.status) { ownPosts.set(own.sightingId, { ...own, status: report.status, points: report.points }); render({ panel: false }); }
      }
    }
    catch (error) { state.reportsError = error.message; }
    finally { state.reportsLoaded = true; if (state.panel === 'reports') render(); }
  }
  function reportsView() {
    if (!CONFIG.ACCOUNTS) return [unavailableBox('Photo reports')];
    return [h('p',{class:'small'},'Your photo reports and awarded points. Pending reports stay private and earn points after approval; removed reports earn no points.'),
      state.reportsError && errorBox(state.reportsError, loadReports),
      ...state.reports.map(r => h('article',{class:'report-card'},h('strong',{},r.placeLabel),h('span',{class:'report-status '+r.status},r.status.toUpperCase()),h('span',{class:'small'},...numText(r.status === 'pending' ? 'Not posted · 0 pts' : r.status === 'rejected' ? 'Not public · 0 pts' : pts(r.points) + ' awarded')))),
      !state.reports.length && h('p',{class:'msg'},state.reportsLoaded ? 'No photo reports yet. Spot Knightro and take a photo.' : 'Loading your reports…'),
      h('button',{type:'button',class:'px-btn alt',onclick:loadReports},'REFRESH REVIEW STATUS')];
  }

  let lastWeekStart = thisWeek().start;

  // ---------- render ----------
  let lastViewKey = '';
  let viewShownAt = 0;
  let lastCount = -1;
  let lastTickerKey = '';

  function render({ panel: updatePanel = true } = {}) {
    const panel = $('#panel');
    const open = !!state.panel;
    panel.classList.toggle('open', open);
    panel.setAttribute('aria-hidden', String(!open));
    panel.inert = !open;
    if (!open) lastViewKey = '';
    if (open && updatePanel) {
      $('#panel-title').textContent = TITLES[state.panel];
      $('#panel-back').hidden = !(['detail','event'].includes(state.panel) && state.backTo);
      const views = {report: () => reportView(state.report), recent: recentView, detail: detailView,
        account: accountView, events: eventsView, event: eventView, leaderboard: leaderboardView, stack: stackView,
        bounties:bountiesView, sense:senseView, reports:reportsView, admin:() => admin.view()};
      const view = views[state.panel]().filter(Boolean);
      const body = $('#panel-body');
      const scroll = body.scrollTop;
      const focusedId = document.activeElement?.id;
      body.replaceChildren(...view);
      // Stagger the content in only when the view changes, not on every background refresh.
      const key = `${state.panel}:${state.report?.step || ''}:${state.selectedId || ''}`;
      if (key !== lastViewKey) {
        view.forEach((el, i) => el.style.setProperty('--i', Math.min(i, 10)));
        fx.replay(body, 'stagger');
        body.scrollTop = 0;
        lastViewKey = key;
        viewShownAt = performance.now();
      } else {
        // Same view re-rendered (GPS answered, pin moved, data refreshed). If the entrance is still
        // playing, continue it from where it is; otherwise show the new elements without replaying it.
        const elapsed = performance.now() - viewShownAt;
        view.forEach((el, i) => {
          if (elapsed < 800) {
            el.style.setProperty('--i', Math.min(i, 10));
            el.style.animationDelay = `calc(var(--i) * 50ms + 90ms - ${Math.round(elapsed)}ms)`;
          } else el.classList.add('no-anim');
        });
        body.scrollTop = scroll;
      }
      if (focusedId && body.querySelector(`#${focusedId}`)) body.querySelector(`#${focusedId}`).focus();
    }

    // Map placement mode: the report panel and unrelated chrome step aside (CSS), the fixed pin and bars appear.
    const placing = state.report?.placing;
    document.body.classList.toggle('report-open', state.panel === 'report');
    document.body.classList.toggle('placing', !!placing);
    $('#place-ui').hidden = !placing;
    if (placing) {
      $('#place-hint-text').textContent = placing.gps ? GPS_MSG[placing.gps] : (placing.hint || 'Move the map to place your sighting.');
      $('#place-hint').classList.toggle('warn', !!placing.gps && placing.gps !== 'locating');
      $('#place-gps').disabled = placing.gps === 'locating';
      $('#place-gps').textContent = placing.gps === 'locating' ? 'LOCATING…' : 'MY LOCATION';
      updatePlacement();
    }

    // Report button doubles as cancel while reporting.
    const reporting = state.panel === 'report';
    $('#btn-report').classList.toggle('active', reporting);
    $('#report-label').textContent = !reporting ? 'REPORT SIGHTING' : state.report?.step === 'done' ? 'CLOSE REPORT' : 'CANCEL REPORT';
    $('#btn-recent').classList.toggle('active', state.panel === 'recent');

    renderMarkers();

    // Count badge with a little tweened pop.
    const count = campusSightings().length;
    const badge = $('#recent-count');
    badge.hidden = !count;
    if (count !== lastCount) {
      const from = Math.max(0, lastCount);
      fx.tween({ from, to: count, duration: 500, onUpdate: (v) => (badge.textContent = Math.round(v)) });
      if (lastCount >= 0) fx.replay(badge, 'pop');
      lastCount = count;
    }

    // Ticker: typed out when the message changes; ages update quietly.
    const latest = campusSightings()[0];
    const tickerKey = !state.loaded ? 'loading' : state.netError ? 'error' : latest ? latest.sightingId : 'empty';
    const tickerText = !state.loaded
      ? 'CONNECTING TO KNIGHTRO HQ…'
      : state.netError
        ? "CAN'T REACH THE SERVER. RETRYING…"
        : latest
          ? `LAST SEEN: ${placeName(latest.lat, latest.long).toUpperCase()} · ${timeAgo(latest).toUpperCase()}${latest.caption ? ` · “${latest.caption.toUpperCase()}”` : ''}`
          : 'NO SIGHTINGS IN THE LAST 20 MINUTES. SPOT KNIGHTRO? TAP REPORT.';
    const tickerEl = $('#ticker-text');
    if (tickerKey !== lastTickerKey) {
      fx.typewriter(tickerEl, tickerText, { sound: lastTickerKey !== '' });
      lastTickerKey = tickerKey;
    } else if (tickerEl.dataset.full !== tickerText) {
      tickerEl.dataset.full = tickerText; // e.g. "2 MIN AGO" -> "3 MIN AGO": no retyping
      if (!tickerEl._typing) tickerEl.replaceChildren(...fx.numNodes(tickerText));
    }
    $('#ticker').classList.toggle('bad', !!state.netError);

    setNum($('#status-text'), !state.loaded ? 'CONNECTING…' : state.netError ? 'OFFLINE' : `LIVE · ${count} ACTIVE`);
    $('#btn-retry').hidden = !state.netError;
    $('#status').classList.toggle('bad', !!state.netError);
    $('#account-label').textContent = state.user ? state.user.displayName : 'Sign in / create account';
    const accountIcon = 'assets/photos/icons/' + (state.user ? 'profile' : 'sign-in') + '.svg'; // profile once signed in
    if ($('#account-ico').getAttribute('src') !== accountIcon) $('#account-ico').setAttribute('src', accountIcon);
    setNum($('#account-sub'), !CONFIG.ACCOUNTS ? 'Needs the app server' : state.user ? pts(state.user.score) + ' · account & sign out' : state.authMode === 'password' ? 'UCF email · password' : 'UCF email · no password');
    document.querySelectorAll('.navigation [data-panel]').forEach((b) => b.toggleAttribute('aria-current', b.dataset.panel === state.panel));
    const allowed = !!(state.admin && state.admin.allowed);
    $('#nav-admin').hidden = !allowed;
    $('#nav-admin-panel').hidden = !adminOn();
    $('#admin-mode-toggle').setAttribute('aria-checked', String(adminOn()));
    $('#admin-mode-note').textContent = adminOn() ? (state.admin.bypassCooldown ? 'On · cooldown bypass active' : 'On · tools visible') : 'Off · tools hidden';
    document.body.classList.toggle('admin-mode', adminOn());
    updateCooldown();
    paintMissions();
  }

  // ---------- chrome ----------
  // Keep sheets inside what is actually visible: browser toolbars and the on-screen keyboard shrink the visual
  // viewport (iOS does not resize the layout for the keyboard), so expose its height and the keyboard overlap.
  const vv = window.visualViewport;
  function syncViewport() {
    const height = vv ? vv.height : innerHeight;
    const keyboard = vv ? Math.max(0, Math.round(innerHeight - vv.height - vv.offsetTop)) : 0;
    document.documentElement.style.setProperty('--vvh', Math.round(height) + 'px');
    document.documentElement.style.setProperty('--kb', keyboard + 'px');
    document.body.classList.toggle('keyboard-open', keyboard > 80);
  }
  vv?.addEventListener('resize', syncViewport);
  vv?.addEventListener('scroll', syncViewport);
  addEventListener('resize', syncViewport);
  syncViewport();
  // A focused field inside the sheet stays visible once the keyboard has finished opening.
  $('#panel-body').addEventListener('focusin', (e) => {
    if (!e.target.matches('input, textarea, select')) return;
    setTimeout(() => e.target.scrollIntoView({ block: 'nearest' }), 300);
  });
  window.KT.knightroAnim.start($('#knightro-anim'), {
    frames: CONFIG.KNIGHTRO_FRAMES, fps: CONFIG.KNIGHTRO_FPS, holdFirstMs: CONFIG.KNIGHTRO_HOLD_FRONT_MS,
  });
  $('#btn-retry').addEventListener('click', () => {
    sfx.play('click');
    refresh(); loadEvents(); loadGame();
  });
  document.querySelectorAll('img[data-icon]').forEach((img) => (img.src = IMG[img.dataset.icon]));
  function recenterMap() {
    map.flyTo([campus.center.lat, campus.center.lng], campusView(campus).startZoom, { duration: 0.7 });
    sfx.play('whoosh');
    fx.replay(recenterButton, 'spin');
  }
  const admin = window.KT.admin.create({ h, api, fx, sfx, state, map, render, closePanel, focusOn, refreshSession,
    buildings: () => buildings, campus: () => campus });
  $('#admin-mode-toggle').addEventListener('click', () => admin.setMode(!adminOn()));
  const soundBtn = $('#btn-sound');
  const paintSound = () => {
    const on = sfx.enabled();
    soundBtn.setAttribute('aria-pressed', String(on));
    soundBtn.setAttribute('aria-label', on ? 'Sound on' : 'Sound off');
    soundBtn.classList.toggle('muted', !on);
  };
  soundBtn.addEventListener('click', () => {
    const on = !sfx.enabled();
    sfx.set(on);
    paintSound();
    sfx.play(on ? 'toggleOn' : 'toggleOff');
    fx.replay(soundBtn, 'pop');
  });
  paintSound();

  // Hover + press sounds for every button (mouse only, so phones don't double up).
  document.addEventListener('pointerover', (e) => {
    const b = e.target.closest('button:not(:disabled)');
    if (b && e.pointerType === 'mouse' && !b.contains(e.relatedTarget)) sfx.play('hover');
  });
  document.addEventListener('click', (e) => {
    const b = e.target.closest('.tile, .report-btn');
    if (b) fx.replay(b, 'press');
  });

  // Boot sequence: CRT power-on, chrome tweens in, then the first data load drops the pins.
  // Browsers block sound until a tap, so the power-on chime plays on a tap in the first few seconds.
  const loadedAt = performance.now();
  addEventListener('pointerdown', () => { if (performance.now() - loadedAt < 6000) sfx.play('boot'); }, { once: true });
  setTimeout(() => document.body.classList.remove('booting'), 2200);

  setInterval(() => {
    if (state.report?.photo && !state.report.submitting && state.report.captureExpiresAt <= nowSec()) expirePhoto(state.report);
    const active = state.sightings.filter((s) => ageSec(s) < CONFIG.ACTIVE_WINDOW_SEC);
    for (const [id, s] of ownPosts) if (ageSec(s) >= CONFIG.ACTIVE_WINDOW_SEC) ownPosts.delete(id);
    const expiredEvents = state.events.some((e) => e.endsAt <= nowSec());
    const week = thisWeek().start;
    if (week !== lastWeekStart) { lastWeekStart = week; render({ panel: state.panel === 'events' }); } // a new calendar week: new pins/list
    const expiredBounties = state.bounties.some(b => b.expiresAt <= nowSec());
    if (active.length !== state.sightings.length || expiredEvents || expiredBounties) {
      state.sightings = active; state.events = state.events.filter((e) => e.endsAt > nowSec()); state.bounties = activeBounties();
      render({panel: !['account','report','admin'].includes(state.panel)});
    } else updatePinAges();
    updateCooldown();
    paintMissions();
    document.querySelectorAll('[data-expires]').forEach(el => el.textContent = countdown(Number(el.dataset.expires)));
  }, 1000);
  setInterval(() => { if (!document.hidden) loadEvents(); }, 60000);
  render();
  refresh();
  loadEvents();
  loadGame();
  if (CONFIG.ACCOUNTS) setInterval(() => { if (!document.hidden) loadGame(); }, 15000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) { loadGame(); window.KT.sense.presence(state.user); } });
})();
