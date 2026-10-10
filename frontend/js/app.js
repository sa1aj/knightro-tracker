// Knightro Tracker frontend. One persistent Leaflet map; panels slide over it.
// SECURITY: captions are typed by strangers. Every piece of text goes into the page with
// textContent / text nodes (see h() below). Never use innerHTML with API data.
(async function () {
  'use strict';
  const { CONFIG, IMG, api, pixelPhoto, hash, sfx, fx, mapUtils } = window.KT;
  let campuses;
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
  const newReport = () => ({ step: 'location', pin: null, gps: null, caption: '', photo:null, captureToken:null, captureExpiresAt:0, camera:null, submitting: false, error: '', result: null });
  const myPosts = new Set(); // ids this device just posted, so we don't announce them as "new"

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
  let dropPin = null;

  const adminOn = () => !!(state.admin && state.admin.allowed && state.admin.mode);
  const campusSightings = () => [...state.sightings, ...(adminOn() ? state.testSightings : [])]
    .filter((s) => ageSec(s) < CONFIG.ACTIVE_WINDOW_SEC && mapUtils.contains(campus, {lat:s.lat, lng:s.long}))
    .sort((a, b) => b.timestamp - a.timestamp);
  const activeEvents = () => [...state.events, ...(adminOn() ? state.testEvents : [])].filter((e) => e.endsAt > nowSec());
  const activeBounties = () => state.bounties.filter(b => b.startsAt <= nowSec() && b.expiresAt > nowSec());
  const eventArt = () => CONFIG.EVENT_FRAMES.map((src, i) => '<img class="event-frame frame-' + i + '" src="' + src + '" alt="">').join('');
  const dropIcon = L.divIcon({ className: 'kt-drop', html: '<img src="' + CONFIG.PIN_IMAGE + '" alt="">', iconSize: [66, 74], iconAnchor: [33, 72] });

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
      ...activeEvents().filter((e) => (e.isTest || (e.probability >= .8 && e.startsAt <= nowSec() + 1800)) && Number.isFinite(e.lat) && Number.isFinite(e.long) && mapUtils.contains(campus, {lat:e.lat,lng:e.long}))
        .map((e) => ({ ...e, kind:'event', key:'e:' + e.eventId })),
      ...activeBounties().filter(b => b.campus === campus.id).map(b => ({...b,kind:'bounty',key:'b:'+b.bountyId})),
    ];
    const groups = mapUtils.cluster(items, (item) => map.latLngToLayerPoint([item.lat, item.long]));
    const seen = new Set();
    for (const group of groups) {
      const first = group.items[0], id = first.key;
      seen.add(id);
      let marker = markers.get(id);
      const multiple = group.items.length > 1;
      const selected = group.items.some((item) => state.panel === 'detail' && item.sightingId === state.selectedId);
      const signature = group.items.map((item) => item.key).join('|');
      if (!marker) {
        marker = L.marker([first.lat, first.long], { keyboard: true, riseOnHover: true })
          .on('click', () => {
            if (state.panel === 'report') return;
            fx.replay(marker.getElement()?.querySelector('.pin-art'), 'tap'); // bounce the art, never the positioned marker
            if (marker.items.length > 1) {
              state.stack = marker.items;
              openPanel('stack');
            } else openMapItem(marker.items[0]);
          })
          .on('mouseover', () => sfx.play('hover'))
          // Leaflet already turns Enter into a click on focused markers; Space should work too.
          .on('keypress', (e) => { if (e.originalEvent.key === ' ') { e.originalEvent.preventDefault(); marker.fire('click'); } })
          .addTo(map);
        markers.set(id, marker);
      }
      marker.items = group.items;
      marker.setLatLng([first.lat, first.long]);
      if (marker.signature !== signature) {
        const art = first.kind === 'sighting'
          ? '<img src="' + CONFIG.PIN_IMAGE + '" alt="">'
          : first.kind === 'bounty' ? '<strong class="bounty-art">2×</strong>' : eventArt();
        const test = group.items.some((item) => item.isTest);
        marker.setIcon(L.divIcon({
          className: 'kt-pin asset-pin ' + (first.kind === 'event' ? 'event-pin ' : '') + (multiple ? 'stack-pin ' : '') + (test ? 'test-pin ' : ''),
          html: '<div class="kt-pin-body"><span class="pin-art">' + art + '</span>' + (multiple ? '<b class="stack-count">' + group.items.length + '</b>' : '') + '<span class="age"></span></div>',
          iconSize: [66, 74], iconAnchor: [33, 72],
        }));
        marker.signature = signature;
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
    // Report pin
    const picking = state.panel === 'report' && state.report?.step === 'location' && state.report.pin;
    if (picking && !dropPin) {
      dropPin = L.marker([state.report.pin.lat, state.report.pin.lng], { icon: dropIcon, draggable: true, zIndexOffset: 1000, title: 'Sighting location. Drag to adjust.' })
        .on('dragstart', () => {
          sfx.play('grab');
          dropPin.getElement()?.classList.add('lifted');
        })
        .on('dragend', (e) => {
          dropPin.getElement()?.classList.remove('lifted');
          setPin(e.target.getLatLng());
        })
        .addTo(map);
      fx.replay(dropPin.getElement(), 'bounce');
    } else if (picking) {
      dropPin.setLatLng([state.report.pin.lat, state.report.pin.lng]);
    } else if (!picking && dropPin) {
      dropPin.remove();
      dropPin = null;
    }
    $('#map').classList.toggle('picking', state.panel === 'report' && state.report?.step === 'location');
  }

  map.on('click', (e) => {
    if (state.panel === 'report' && state.report?.step === 'location') setPin(e.latlng);
  });

  function updatePinAges() {
    for (const marker of markers.values()) {
      const opacity = Math.max(...marker.items.map((item) => item.kind !== 'sighting' ? 1 : mapUtils.opacity(item.timestamp, nowSec(), CONFIG.ACTIVE_WINDOW_SEC)));
      marker.setOpacity(opacity);
      const age = marker.getElement()?.querySelector('.age');
      if (age) age.textContent = marker.items.length > 1 ? 'OPEN STACK' : marker.items[0].isTest ? 'TEST' : marker.items[0].kind === 'bounty' ? 'BOUNTY ' + countdown(marker.items[0].expiresAt) : marker.items[0].kind === 'event' ? 'LIKELY EVENT' : shortAgo(marker.items[0]);
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
    if (state.report && !mapUtils.contains(campus, state.report.pin)) {
      state.report.pin = {...campus.center}; state.report.gps = null;
    }
    render();
  }
  map.on('zoomend moveend', () => renderMarkers());
  // A new container size can change what "fits"; update limits only, never reset the user's view.
  map.on('resize', () => applyCampusLimits(false));
  applyCampusLimits(true);
  $('#campus-select').append(...campuses.map((c) => h('option', {value:c.id}, c.name)));
  $('#campus-select').addEventListener('change', (e) => switchCampus(e.target.value));

  function setPin(latlng) {
    state.report.pin = { lat: latlng.lat, lng: latlng.lng };
    sfx.play('place');
    render();
    fx.replay(dropPin?.getElement(), 'bounce');
  }

  /** Center a point in the part of the map the panel isn't covering. */
  function focusOn(lat, lng, minZoom = 17) {
    const targetCampus = campuses.find((c) => mapUtils.contains(c, {lat, lng}));
    if (targetCampus && targetCampus.id !== campus.id) switchCampus(targetCampus.id);
    const z = Math.max(map.getZoom(), minZoom);
    const size = map.getSize();
    const panel = $('#panel'), status = $('#status');
    const open = panel.classList.contains('open');
    let target = L.point(size.x / 2, size.y / 2);
    if (open && isMobile()) target = L.point(size.x / 2, (status.offsetTop + status.offsetHeight + panel.offsetTop) / 2);
    else if (open) target = L.point(panel.offsetLeft / 2, size.y / 2 - 40);
    const offset = L.point(size.x / 2, size.y / 2).subtract(target);
    sfx.play('whoosh');
    map.flyTo(map.unproject(map.project([lat, lng], z).add(offset), z), z, { duration: 0.7, easeLinearity: 0.2 });
  }

  // ---------- data ----------
  function applySession(session) {
    state.accounts = session.accounts !== false;
    state.user = session.user; state.nextSightingAt = session.nextSightingAt;
    state.sessionLoaded = true; state.emailDelivery = session.emailDelivery;
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
    render();
    if (name === 'report') locate();
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
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { if (menuOpen) setMenu(false); else if (state.panel) closePanel(); } });
  document.querySelectorAll('[data-panel]').forEach((b) => b.addEventListener('click', () => openPanel(b.dataset.panel)));

  // ---------- report flow ----------
  let locateId = 0;
  const GPS_MSG = {
    locating: 'Finding your location…',
    ok: 'GPS placed the pin. Drag it or tap the map if it is off.',
    denied: 'Location permission was denied. Drag the pin or tap the map where you saw Knightro.',
    failed: "Couldn't get your location. Drag the pin or tap the map where you saw Knightro.",
    offcampus: "You don't appear to be on a supported UCF campus. Drag the pin or tap the map where you saw Knightro.",
    unsupported: 'Location needs HTTPS (or localhost). Drag the pin or tap the map where you saw Knightro.',
  };
  function locate() {
    const r = state.report;
    if (!r) return;
    const id = ++locateId;
    const fallback = (gps) => {
      if (id !== locateId || state.report !== r) return;
      const c = map.getCenter();
      r.gps = gps;
      r.pin = r.pin || (onCampus({ lat: c.lat, lng: c.lng }) ? { lat: c.lat, lng: c.lng } : { ...campus.center });
      sfx.play('place');
      render();
    };
    if (!navigator.geolocation || !window.isSecureContext) return fallback('unsupported');
    r.gps = 'locating';
    render();
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        if (id !== locateId || state.report !== r) return;
        const p = { lat: pos.coords.latitude, lng: pos.coords.longitude };
        if (!onCampus(p)) return fallback('offcampus');
        r.gps = 'ok';
        r.pin = p;
        sfx.play('place');
        render();
        focusOn(p.lat, p.lng, 18);
      },
      (err) => fallback(err.code === 1 ? 'denied' : 'failed'),
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 30000 }
    );
  }

  async function submitReport() {
    const r = state.report;
    if (!r || r.submitting || !onCampus(r.pin) || (CONFIG.ACCOUNTS && !r.photo)) return;
    if (CONFIG.ACCOUNTS && r.captureExpiresAt <= nowSec()) { r.camera?.expire(); updateCooldown(); return; }
    r.submitting = true;
    r.error = '';
    sfx.play('click');
    render();
    try {
      const res = await api.postSighting({ lat: r.pin.lat, long: r.pin.lng, caption: r.caption, photo:r.photo, captureToken:r.captureToken });
      state.nextSightingAt = res.nextSightingAt;
      myPosts.add(res.sightingId);
      state.sightings = [res, ...state.sightings.filter(s => s.sightingId !== res.sightingId)];
      state.reportsLoaded = false; state.leadersLoaded = false;
      if (state.report !== r) { refresh({quiet:true}); return; } // preserve cooldown if panel closed
      r.camera?.dispose(); r.camera = null;
      r.result = res;
      r.step = 'done';
      sfx.play('success');
      const btn = $('#btn-report').getBoundingClientRect();
      fx.burst(btn.left + btn.width / 2, btn.top, 120);
      await refresh({ quiet: true });
      fx.toast('SIGHTING POSTED!', (res.points == null ? '' : '+' + res.points + ' point(s). ') + 'Your pin is live in Recent Sightings.', 'good');
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

  function reportView(r) {
    const idx = r.step === 'location' ? 0 : 1;
    const steps = h('ol', { class: 'steps' },
      [['location', 'LOCATION'], ['details', CONFIG.ACCOUNTS ? 'PHOTO PROOF' : 'DETAILS']].map(([k, label], i) =>
        h('li', { class: i === idx ? 'on' : i < idx ? 'done' : '', 'aria-current': i === idx ? 'step' : null }, `${i + 1}. ${label}`)
      )
    );

    if (r.step === 'location') {
      const pinOk = onCampus(r.pin);
      const warn = ['denied', 'failed', 'offcampus', 'unsupported'].includes(r.gps);
      return [
        steps,
        h('p', { class: 'small' }, 'Where did you see Knightro? Confirm the gold pin on the map. Drag it, or tap the map to move it.'),
        r.gps && h('div', { class: `msg${warn ? ' warn' : ''}${r.gps === 'locating' ? ' scanning' : ''}` }, GPS_MSG[r.gps]),
        r.pin && h('dl', { class: 'kv' }, h('dt', {}, 'PIN'), h('dd', {}, pinOk ? placeName(r.pin.lat, r.pin.lng) : 'Off campus. Move the pin onto Main, Rosen, or Downtown campus.')),
        h('label', {class:'field'}, h('span', {class:'label'}, 'Jump to a building (optional)'), h('select', {id:'report-building', onchange:event => {
          const b = buildings.find(b => b.id === event.target.value); if (b) { const c = campuses.find(c => c.id === b.campus); if (c && c.id !== campus.id) switchCampus(c.id); setPin({lat:b.lat,lng:b.long}); focusOn(b.lat,b.long); }
        }}, h('option', {value:''}, 'Choose a campus building…'), ...buildings.filter(b => b.campus === campus.id).map(b => h('option', {value:b.id}, b.name)))),
        h('div', { class: 'actions' },
          h('button', { type: 'button', class: 'px-btn alt sm', onclick: () => { sfx.play('click'); locate(); }, disabled: r.gps === 'locating' }, 'USE MY LOCATION'),
          r.pin && h('button', { type: 'button', class: 'px-btn alt sm', onclick: () => focusOn(r.pin.lat, r.pin.lng) }, 'SHOW PIN')
        ),
        h('div', { class: 'panel-foot' },
          h('span'),
          h('button', {
            type: 'button',
            class: 'px-btn',
            disabled: !pinOk,
            onclick: () => { sfx.play('switch'); r.step = 'details'; render(); },
          }, 'CONFIRM LOCATION')
        ),
      ];
    }

    if (r.step === 'details' && !CONFIG.ACCOUNTS) {
      // Static GitHub Pages copy: the shared sightings service stores location + caption only.
      const counter = h('span', { class: 'muted small counter' }, `${r.caption.length}/${CONFIG.CAPTION_MAX}`);
      const ta = h('textarea', { id: 'rep-caption', maxlength: CONFIG.CAPTION_MAX, placeholder: 'Knightro is near the Student Union' });
      ta.value = r.caption;
      ta.addEventListener('input', () => { r.caption = ta.value; counter.textContent = `${ta.value.length}/${CONFIG.CAPTION_MAX}`; sfx.play('type'); });
      return [
        steps,
        h('dl', { class: 'kv' }, h('dt', {}, 'WHERE'), h('dd', {}, placeName(r.pin.lat, r.pin.lng))),
        h('p', { class: 'msg warn' }, 'Static demo: your sighting posts its location and caption to the shared map. Photo proof, accounts and points need the Knightro app server.'),
        h('div', { class: 'field' }, h('label', { class: 'label', for: 'rep-caption' }, 'What is he doing? (optional)'), ta, counter),
        r.error && h('div', { class: 'msg err', role: 'alert' }, r.error),
        h('div', { class: 'panel-foot' },
          h('button', { type: 'button', class: 'px-btn alt', disabled: r.submitting, onclick: () => { sfx.play('switch'); r.step = 'location'; r.error = ''; render(); } }, 'BACK'),
          h('button', { id:'rep-submit', type: 'button', class: `px-btn${r.submitting ? ' loading' : ''}`, disabled: r.submitting, onclick: submitReport }, r.submitting ? 'POSTING…' : 'POST SIGHTING')),
      ];
    }

    if (r.step === 'details') {
      if (!r.camera) r.camera = window.KT.camera.create(capture => {
        if (state.report !== r) return;
        r.photo = capture?.photo || null; r.captureToken = capture?.captureToken || null;
        r.captureExpiresAt = capture?.captureExpiresAt || 0; r.error = '';
        updateCooldown();
      });
      r.camera.element.inert = r.submitting;
      const counter = h('span', { class: 'muted small counter' }, `${r.caption.length}/${CONFIG.CAPTION_MAX}`);
      const ta = h('textarea', { id: 'rep-caption', maxlength: CONFIG.CAPTION_MAX, placeholder: 'Knightro is near the Student Union' });
      ta.value = r.caption;
      ta.addEventListener('input', () => {
        r.caption = ta.value;
        counter.textContent = `${ta.value.length}/${CONFIG.CAPTION_MAX}`;
        counter.classList.toggle('near', ta.value.length > CONFIG.CAPTION_MAX - 20);
        sfx.play('type');
      });
      return [
        steps,
        h('dl', { class: 'kv' }, h('dt', {}, 'WHERE'), h('dd', {}, placeName(r.pin.lat, r.pin.lng))),
        r.camera.element,
        h('div', { class: 'field' }, h('label', { class: 'label', for: 'rep-caption' }, 'What is he doing? (optional)'), ta, counter),
        h('p', { class: 'muted small' }, 'Live photos post immediately: 1 point, or 2 for your first daily bounty claim. Pins last 20 minutes.'),
        r.error && h('div', { class: 'msg err', role: 'alert' }, r.error),
        h('div', { class: 'panel-foot' },
          h('button', { type: 'button', class: 'px-btn alt', disabled: r.submitting, onclick: () => { sfx.play('switch'); r.camera?.dispose(); r.camera = null; r.photo = null; r.captureToken = null; r.step = 'location'; r.error = ''; render(); } }, 'BACK'),
          h('button', { id:'rep-submit', type: 'button', class: `px-btn${r.submitting ? ' loading' : ''}`, disabled: r.submitting || !r.photo || state.nextSightingAt > nowSec(), onclick: submitReport }, r.submitting ? 'POSTING…' : 'SUBMIT PHOTO')
        ),
      ];
    }

    // done
    return [
      h('div', { class: 'victory' }, h('img', { src: IMG.helm, alt: '' }), h('h3', {}, 'SIGHTING POSTED')),
      h('dl', { class: 'kv' }, h('dt', {}, 'WHERE'), h('dd', {}, placeName(r.pin.lat, r.pin.lng))),
      h('div', { class: 'msg', role: 'status' }, (r.result.points == null ? 'Saved to the shared sightings map. ' : '+' + r.result.points + ' point(s) awarded. ') + 'Your pin is live on the map and in Recent Sightings.'),
      h('div', { class: 'panel-foot' },
        h('button', { type: 'button', class: 'px-btn alt', onclick: closePanel }, 'CLOSE'),
        h('button', {
          type: 'button',
          class: 'px-btn',
          onclick: () => {
            openDetail(r.result.sightingId, 'recent');
          },
        }, 'VIEW SIGHTING')
      ),
    ];
  }

  /** Failed request: say what went wrong and offer a retry. */
  function errorBox(message, retry) {
    return h('div', { class: 'msg err error-box', role: 'alert' }, h('span', {}, message),
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
        h('div', { class: 'empty' }, h('img', { src: IMG.helm, alt: '' }), h('h3', {}, 'NO ACTIVE SIGHTINGS')),
        h('p', { class: 'muted' }, 'No active reports on this campus in the last 20 minutes. Spot him? Tap REPORT SIGHTING.'),
      ];
    }
    return campusSightings().map((s) => {
      const photo = photoFor(s);
      return h('button', { type: 'button', class: 'feed-item', onclick: () => { openDetail(s.sightingId, 'recent'); focusOn(s.lat, s.long); } },
        h('img', { src: photo.src, alt: '', class: photo.pixel ? 'pixel' : null }),
        h('span', { class: 'feed-text' },
          h('strong', {}, placeName(s.lat, s.long)),
          h('span', { class: 'muted small' }, `${timeAgo(s)} · ${clock(s)}`),
          s.caption && h('span', { class: 'small' }, s.caption)
        )
      );
    });
  }

  function detailView() {
    const s = campusSightings().find((x) => x.sightingId === state.selectedId) || state.sightings.find((x) => x.sightingId === state.selectedId);
    if (!s) return [h('p', { class: 'muted' }, 'This sighting is more than 20 minutes old and has left the map.')];
    const fresh = ageSec(s) < CONFIG.FRESH_SEC;
    const photo = photoFor(s);
    return [
      s.isTest && h('p', { class: 'msg warn' }, 'TEST SIGHTING · only visible to admins in Admin Mode · 0 points'),
      h('div', { class: 'label' }, s.sightingId === campusSightings()[0]?.sightingId ? 'Latest sighting' : 'Sighting'),
      h('figure', { class: 'photo-fig' },
        h('img', { class: `photo${photo.pixel ? ' pixel' : ''}`, src: photo.src, alt: s.photoUrl ? 'Reported Knightro sighting photo' : 'Illustration of Knightro' }),
        h('figcaption', { class: 'label' }, s.photoUrl ? (s.status === 'confirmed' ? 'Photo confirmed' : 'Community photo report') + ' · ' + s.points + ' point(s)' : s.isTest ? 'Test sighting · illustration' : s.source === 'aws' ? 'Shared map sighting · no photo' : 'Legacy sighting · illustration')
      ),
      h('div', { class: `fresh-note ${fresh ? 'live' : 'old'}` },
        fresh ? `SPOTTED ${timeAgo(s).toUpperCase()}. HE MAY STILL BE NEARBY.` : `SEEN ${timeAgo(s).toUpperCase()}. HE MAY HAVE MOVED ON.`),
      h('h3', {}, placeName(s.lat, s.long).toUpperCase()),
      h('dl', { class: 'kv' }, h('dt', {}, 'SEEN'), h('dd', {}, `${clock(s)} (${timeAgo(s)})`)),
      s.caption && h('p', { class: 'quote' }, s.caption),
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
    if (state.panel !== 'report') $('#report-label').textContent = remaining && state.user
      ? 'NEXT REPORT ' + Math.floor(remaining / 60) + ':' + String(remaining % 60).padStart(2, '0') : 'REPORT SIGHTING';
    const label = $('#cooldown-note');
    if (label) label.textContent = remaining ? 'Next sighting available in ' + remaining + ' seconds.' : 'You can report a sighting now.';
    const submit = $('#rep-submit');
    if (submit && !state.report?.submitting) {
      submit.disabled = remaining > 0 || (CONFIG.ACCOUNTS && (!state.report?.photo || state.report.captureExpiresAt <= nowSec()));
      submit.textContent = remaining ? 'WAIT ' + remaining + 's' : CONFIG.ACCOUNTS ? 'SUBMIT PHOTO' : 'POST SIGHTING';
    }
  }
  function accountView() {
    if (!CONFIG.ACCOUNTS) return [unavailableBox('Signing in')];
    if (state.user) return [
      h('h3', {}, 'WELCOME, ' + state.user.displayName.toUpperCase()),
      h('p', {}, state.user.email),
      h('p', {class:'small'}, 'Total points: ', h('strong', {}, String(state.user.score ?? 0))),
      state.admin?.allowed && h('p', {class:'msg warn'}, 'This account is authorized for Admin Mode. Use the ADMIN section of the menu.'),
      h('p', {class:'msg'}, 'UCF email verified. Live photo reports earn points immediately; your first report in today’s bounty section earns double. Your email stays private.'),
      h('p', {id:'cooldown-note',class:'small'}),
      h('p', {class:'muted small'}, 'An essential sign-in cookie keeps this browser signed in for 14 days. Signing out removes it. No advertising cookies are used.'),
      h('button', {type:'button',class:'px-btn alt',onclick:async (event) => {
        const button = event.currentTarget;
        button.disabled = true;
        try { await api.logout(); state.user = null; state.admin = null; state.testSightings = []; state.testEvents = []; state.nextSightingAt = 0; render(); }
        catch (error) { button.disabled = false; fx.toast('SIGN OUT FAILED',error.message,'bad'); }
      }}, 'SIGN OUT'),
    ];
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
      h('span',{class:'small'},eventTime(event.startsAt) + ' ET'),
      h('span',{class:'muted small'},(event.buildingName || event.location || 'Location to be announced') + (mapped ? '' : ' · No map pin')),
      h('span',{class:'small hint-reason'},event.reason || 'Possible appearance'));
  }
  function eventsView() {
    if (!state.eventsLoaded) return [h('p',{},'Loading campus events…')];
    return [
      h('p',{class:'small'},'Only events with evidence of a possible Knightro appearance. Pins appear within 30 minutes of the start. These are building-level hints, not confirmed sightings.'),
      state.eventsGeneratedAt && h('p',{class:'muted small'},'Last synced ' + eventTime(state.eventsGeneratedAt) + ' ET'),
      state.eventsError && errorBox(state.eventsError, loadEvents),
      ...activeEvents().map(eventRow),
      !activeEvents().length && h('p',{class:'msg'},state.eventsAvailable === false ? 'The event feed has not been published yet. Check back soon.' : 'No likely Knightro appearances in the current feed.'),
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
      h('dl',{class:'kv'},h('dt',{},'START'),h('dd',{},eventTime(event.startsAt) + ' ET'),h('dt',{},'END'),h('dd',{},eventTime(event.endsAt) + ' ET')),
      Array.isArray(event.hosts) && h('p',{class:'muted'},'Hosted by ' + event.hosts.join(', ')),
      safeUrl && h('a',{class:'px-btn',href:safeUrl,target:'_blank',rel:'noopener noreferrer'},'VIEW ON KNIGHTCONNECT'),
    ];
  }
  function stackView() {
    const items = state.stack.filter((item) => item.kind === 'event' ? activeEvents().some((e) => e.eventId === item.eventId) : item.kind === 'bounty' ? activeBounties().some(b => b.bountyId === item.bountyId) : state.sightings.some((s) => s.sightingId === item.sightingId));
    return [
      h('p',{class:'small'},items.length + ' pins in this area. Select one below, or zoom in to separate nearby pins.'),
      ...items.map((item) => item.kind === 'event' ? eventRow(item) : item.kind === 'bounty' ? bountyRow(item) : h('button',{type:'button',class:'event-row',onclick:() => openDetail(item.sightingId,'stack')},
        h('strong',{},'KNIGHTRO · ' + placeName(item.lat,item.long)),h('span',{},timeAgo(item)),item.caption && h('span',{class:'muted'},item.caption))),
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
      h('p',{class:'small'},'All-time campus spotters. Live photo reports earn 1 point; the first daily bounty claim earns 2.'),
      state.leadersError && errorBox(state.leadersError, loadLeaderboard),
      !state.leadersError && !state.leaders.length && h('div',{class:'empty-state'},h('img',{src:IMG.helm,alt:''}),h('p',{},'No points on the board yet. Be the first Knight!')),
      h('ol',{class:'leaderboard'},state.leaders.map((person, i) => h('li',{class: i < 3 ? 'top top-' + (i + 1) : null},h('b',{class:'rank'},String(i + 1)),h('span',{},person.displayName),h('strong',{},person.score + ' pts')))),
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
  function paintMissions() {
    const current = activeBounties().find(b => b.campus === campus.id);
    $('#mission-bounty').textContent = current ? '⚡ 2× DAILY BOUNTY · ' + countdown(current.expiresAt) : '⚡ DAILY BOUNTIES';
    const alert = state.alerts.find(a => a.expiresAt > nowSec());
    $('#mission-sense').textContent = alert ? '◎ KNIGHT-SENSE · NEW HINT' : '◎ KNIGHT-SENSE';
    $('#mission-sense').classList.toggle('has-alert', !!alert);
  }
  function bountyRow(b) {
    return h('button', {type:'button',class:'bounty-card',onclick:() => {
      if (state.panel !== 'bounties') openPanel('bounties');
      if (b.campus !== campus.id) switchCampus(b.campus);
      const bounds = L.latLngBounds(b.area.map(([lng,lat]) => [lat,lng]));
      map.fitBounds(bounds, {paddingTopLeft:[24,150], paddingBottomRight:isMobile() ? [24,Math.ceil(innerHeight*.6)] : [$('#panel').offsetWidth + 50,100], maxZoom:17});
    }}, h('strong', {class:'bounty-multiplier'}, '2×'), h('span', {}, h('strong',{},b.sectorName), h('span',{class:'small'}, b.buildings.length + ' BUILDINGS · UNTIL CAMPUS MIDNIGHT'),
      h('span',{class:'small bounty-buildings'},b.buildings.map(item => item.name).join(' · '))),
      h('b', {'data-expires':b.expiresAt,class:'bounty-clock'}, countdown(b.expiresAt)));
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
      ...state.alerts.filter(a => a.expiresAt > nowSec()).map(a => h('article',{class:'sense-card'},h('strong',{},a.message),h('p',{class:'small muted'},a.reason + ' · Unconfirmed hint'),h('span',{'data-expires':a.expiresAt,class:'small'},countdown(a.expiresAt)))),
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
    try { state.reports = (await api.getReports()).reports; state.reportsError = ''; }
    catch (error) { state.reportsError = error.message; }
    finally { state.reportsLoaded = true; if (state.panel === 'reports') render(); }
  }
  function reportsView() {
    if (!CONFIG.ACCOUNTS) return [unavailableBox('Photo reports')];
    return [h('p',{class:'small'},'Your live photo reports and awarded points. Reports appear immediately; removed reports earn no points.'),
      state.reportsError && errorBox(state.reportsError, loadReports),
      ...state.reports.map(r => h('article',{class:'report-card'},h('strong',{},r.placeLabel),h('span',{class:'report-status '+r.status},r.status.toUpperCase()),h('span',{class:'small'},r.status === 'pending' ? r.eligiblePoints + ' point(s) eligible after confirmation' : r.points + ' point(s) awarded'))),
      !state.reports.length && h('p',{class:'msg'},state.reportsLoaded ? 'No photo reports yet. Spot Knightro and take a photo.' : 'Loading your reports…'),
      h('button',{type:'button',class:'px-btn alt',onclick:loadReports},'REFRESH REVIEW STATUS')];
  }

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
      if (!tickerEl._typing) tickerEl.textContent = tickerText;
    }
    $('#ticker').classList.toggle('bad', !!state.netError);

    $('#status-text').textContent = !state.loaded ? 'CONNECTING…' : state.netError ? 'OFFLINE' : `LIVE · ${count} ACTIVE`;
    $('#btn-retry').hidden = !state.netError;
    $('#status').classList.toggle('bad', !!state.netError);
    $('#account-label').textContent = state.user ? state.user.displayName : 'Sign in / create account';
    $('#account-sub').textContent = !CONFIG.ACCOUNTS ? 'Needs the app server' : state.user ? (state.user.score ?? 0) + ' pts · account & sign out' : 'UCF email · no password';
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
  window.KT.knightroAnim.start($('#knightro-anim'), {
    frames: CONFIG.KNIGHTRO_FRAMES, fps: CONFIG.KNIGHTRO_FPS, holdFirstMs: CONFIG.KNIGHTRO_HOLD_FRONT_MS,
  });
  $('#btn-retry').addEventListener('click', () => {
    sfx.play('click');
    refresh(); loadEvents(); loadGame();
  });
  document.querySelectorAll('img[data-icon]').forEach((img) => (img.src = IMG[img.dataset.icon]));
  $('#nav-helm').src = IMG.helm;
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
    if (state.report?.photo && !state.report.submitting && state.report.captureExpiresAt <= nowSec()) state.report.camera?.expire();
    const active = state.sightings.filter((s) => ageSec(s) < CONFIG.ACTIVE_WINDOW_SEC);
    const expiredEvents = state.events.some((e) => e.endsAt <= nowSec());
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
