// Admin panel UI. This file only *displays* tools: the server decides who is an admin
// (verified session + server-side allowlist) and re-checks every request. Hiding or
// showing anything here grants nothing.
(function () {
  'use strict';

  function create(ctx) {
    const { h, api, fx, sfx, state } = ctx;
    const pad = (n) => String(n).padStart(2, '0');
    const localDate = (d) => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
    const localTime = (d) => pad(d.getHours()) + ':' + pad(d.getMinutes());
    function blankEvent() {
      const start = new Date(Date.now() + 15 * 60000);
      return { title: '', description: '', date: localDate(start), time: localTime(start), hours: '1', building: '', visible: false };
    }
    const ui = {
      loading: {}, msg: {},
      query: '', users: null, selected: null, amount: '', reason: '', pending: null,
      event: blankEvent(), editing: null, deleteEventId: null,
      testCaption: '', testBuilding: '',
      sightings: null, sightingsFilter: 'all', reviewRequest: 0, removeId: null, removeReason: '',
      bounties: null, areas: [], bountySelection: {}, bountyPending: null,
      log: null, clearConfirm: false,
    };
    state.testSightings = [];
    state.testEvents = [];

    const enabled = () => !!(state.admin && state.admin.allowed && state.admin.mode);
    const requestId = () => (crypto.randomUUID ? crypto.randomUUID()
      : Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join(''));
    const nums = (text) => fx.numNodes(text); // digits in the readable number face
    const when = (sec) => new Date(sec * 1000).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
    const repaint = () => (state.panel === 'admin' ? ctx.render() : ctx.render({ panel: false }));

    /** Run one backend action with loading/success/error states. Success shows only after the server confirms. */
    async function run(section, action, success) {
      if (ui.loading[section]) return null;
      ui.loading[section] = true;
      ui.msg[section] = null;
      repaint();
      try {
        const result = await action();
        if (success) ui.msg[section] = { ok: true, text: typeof success === 'function' ? success(result) : success };
        sfx.play('success');
        return result;
      } catch (error) {
        ui.msg[section] = { ok: false, text: error.message };
        sfx.play('error');
        if (error.status === 401 || error.status === 403) await ctx.refreshSession();
        return null;
      } finally {
        ui.loading[section] = false;
        repaint();
      }
    }

    // ---------------------------------------------------------------- data
    async function loadTestData() {
      if (!enabled()) {
        state.testSightings = [];
        state.testEvents = [];
        return;
      }
      try {
        const [sightings, events] = await Promise.all([api.admin.testSightings(), api.admin.testEvents()]);
        state.testSightings = sightings.sightings || [];
        state.testEvents = events.events || [];
      } catch (error) {
        if (error.status === 401 || error.status === 403) await ctx.refreshSession();
      }
      ctx.render({ panel: !['report', 'account', 'admin'].includes(state.panel) });
    }
    async function loadReview() {
      const request = ++ui.reviewRequest;
      try {
        const result = await api.admin.sightings(ui.sightingsFilter);
        if (request === ui.reviewRequest) { ui.sightings = result.sightings; ui.msg.review = null; }
      } catch (error) {
        if (request === ui.reviewRequest) { ui.msg.review = { ok: false, text: error.message }; ui.sightings = ui.sightings || []; }
      }
    }
    async function loadLog() {
      try { ui.log = (await api.admin.log()).entries; }
      catch (error) { ui.msg.log = { ok: false, text: error.message }; ui.log = ui.log || []; }
    }
    async function loadBounties() {
      try {
        const result = await api.admin.bounties();
        ui.bounties = result.bounties || []; ui.areas = result.areas || [];
      } catch (error) {
        ui.msg.bounties = { ok: false, text: error.message }; ui.bounties = ui.bounties || [];
      }
    }
    async function loadDemo() {
      try { ui.demo = await api.admin.demo(); }
      catch (error) { ui.msg['demo-events'] = { ok: false, text: error.message }; }
    }
    async function loadPanel() {
      await Promise.all([loadTestData(), loadReview(), loadLog(), loadBounties(), loadDemo()]);
      // Visible test events also arrive in the public events feed; refresh it so markers and details match.
      if (ctx.loadEvents) await ctx.loadEvents();
      if (state.panel === 'admin') ctx.render();
    }
    async function afterChange() {
      await Promise.all([loadTestData(), loadReview(), loadLog(), ctx.loadEvents?.()]);
    }

    // ---------------------------------------------------------------- actions
    /** Demo events / sightings: one server-managed set each. The server checks admin + Admin Mode and never duplicates. */
    async function setDemo(kind, change) {
      const noun = kind === 'events' ? 'Demo events' : 'Demo sightings';
      const result = await run('demo-' + kind, () => api.admin.setDemo({ kind, ...change }), (r) => {
        const set = r[kind];
        if (!set.enabled) return noun + ' are off' + ('visible' in change ? ' (visibility saved for next time).' : '. The generated set was removed.');
        return noun + ' are on: ' + set.count + ' on ' + campusName(set.campus) + ', ' + (set.visible ? 'visible to users.' : 'admins only.');
      });
      if (!result) return;
      ui.demo = result;
      await afterChange();
      if (kind === 'sightings') await ctx.refresh?.({ quiet: true }); // public sightings feed (visible demo sightings)
      repaint();
    }
    const campusName = (id) => ({ main: 'Main Campus', downtown: 'Downtown Campus', rosen: 'Rosen College' }[id] || id);
    async function changeBounty(bounty, mode, sectorId) {
      const intent = JSON.stringify([bounty.bountyId, bounty.sectorId, mode, sectorId || null]);
      // Keep the request ID when retrying after a lost response: reroll only once.
      if (ui.bountyPending?.intent !== intent) ui.bountyPending = {
        intent, body: { campus: bounty.campus, bountyId: bounty.bountyId, currentSectorId: bounty.sectorId,
          mode, ...(mode === 'set' ? { sectorId } : {}), requestId: requestId(), confirm: true },
      };
      const result = await run('bounties', () => api.admin.changeBounty(ui.bountyPending.body),
        r => 'Bounty area changed to ' + r.bounty.sectorName + '. Existing points and daily claims are preserved.');
      if (result) { ui.bountyPending = null; delete ui.bountySelection[bounty.campus]; }
      await Promise.all([loadBounties(), loadLog(), ctx.loadGame?.()]);
      repaint();
    }
    async function setMode(on) {
      const result = await run('mode', () => api.admin.setMode(on), on ? 'Admin Mode is on.' : 'Admin Mode is off. Testing overrides were turned off.');
      if (!result) return;
      state.admin = { ...state.admin, ...result };
      fx.toast(on ? 'ADMIN MODE ON' : 'ADMIN MODE OFF', on ? 'Admin tools and test data are visible to you.' : 'Admin tools hidden. Cooldown bypass disabled.', on ? 'gold' : 'info');
      if (!on) {
        state.testSightings = [];
        state.testEvents = [];
        if (state.panel === 'admin') ctx.closePanel();
      } else {
        await loadTestData();
      }
      await ctx.refreshSession();
    }
    async function setBypass(on) {
      const result = await run('cooldown', () => api.admin.setCooldownBypass(on),
        on ? 'Cooldown bypass is active for your account.' : 'Cooldown bypass is off.');
      if (result) {
        state.admin = { ...state.admin, ...result };
        await ctx.refreshSession();
        await loadLog();
        repaint();
      }
    }
    async function search() {
      const result = await run('points', () => api.admin.users(ui.query.trim()));
      if (result) {
        ui.users = result.users;
        ui.msg.points = result.users.length ? null : { ok: false, text: 'No accounts match that search.' };
        repaint();
      }
    }
    function reviewPoints() {
      const amount = Number(ui.amount);
      const reason = ui.reason.trim();
      if (!ui.selected) return (ui.msg.points = { ok: false, text: 'Select a user first.' }), repaint();
      if (!Number.isInteger(amount) || amount === 0 || Math.abs(amount) > 1000) return (ui.msg.points = { ok: false, text: 'Enter a whole number between -1000 and 1000, not 0.' }), repaint();
      if (reason.length < 3 || reason.length > 140) return (ui.msg.points = { ok: false, text: 'Give a short reason (3–140 characters).' }), repaint();
      if (ui.selected.score + amount < 0) return (ui.msg.points = { ok: false, text: ui.selected.displayName + ' has ' + ui.selected.score + ' points; a deduction cannot go below zero.' }), repaint();
      // One request ID per reviewed change: retries or double clicks are applied once by the server.
      ui.pending = { userId: ui.selected.id, name: ui.selected.displayName, amount, reason, before: ui.selected.score, requestId: requestId() };
      ui.msg.points = null;
      repaint();
    }
    async function applyPoints() {
      const p = ui.pending;
      const result = await run('points', () => api.admin.adjustPoints({ userId: p.userId, amount: p.amount, reason: p.reason, requestId: p.requestId, confirm: true }),
        (r) => (r.duplicate ? 'Already applied. ' : 'Saved. ') + p.name + ' now has ' + r.score + ' points.');
      if (!result) return;
      ui.selected = { ...ui.selected, score: result.score };
      if (ui.users) ui.users = ui.users.map((u) => (u.id === result.userId ? { ...u, score: result.score } : u));
      ui.pending = null; ui.amount = ''; ui.reason = '';
      state.leadersLoaded = false;
      if (state.user && state.user.id === result.userId) await ctx.refreshSession();
      await loadLog();
      repaint();
    }
    function location(buildingId) {
      const b = ctx.buildings().find((x) => x.id === buildingId);
      if (b) return { lat: b.lat, long: b.long };
      const c = ctx.map.getCenter();
      return { lat: c.lat, long: c.lng };
    }
    async function saveEvent() {
      const e = ui.event;
      const start = new Date(e.date + 'T' + e.time);
      if (!e.date || !e.time || Number.isNaN(start.getTime())) return (ui.msg.events = { ok: false, text: 'Choose a date and time.' }), repaint();
      const startsAt = Math.floor(start.getTime() / 1000);
      const body = { title: e.title.trim(), description: e.description.trim(), startsAt, endsAt: startsAt + Number(e.hours) * 3600, ...location(e.building), visible: e.visible === true };
      if (ui.editing) body.eventId = ui.editing;
      const editing = !!ui.editing;
      const result = await run('events', () => api.admin.saveTestEvent(body), (editing ? 'Test event updated. ' : 'Test event created. ') + (body.visible ? 'Visible to other users.' : 'Visible only to admins in Admin Mode.'));
      if (!result) return;
      ui.event = blankEvent(); ui.editing = null;
      await afterChange();
      repaint();
    }
    function editEvent(event) {
      const start = new Date(event.startsAt * 1000);
      ui.editing = event.eventId;
      ui.event = { title: event.title, description: event.description || '', date: localDate(start), time: localTime(start),
        hours: String(Math.max(1, Math.min(48, Math.round((event.endsAt - event.startsAt) / 3600)))), building: event.buildingId || '', visible: event.visible === true };
      ui.msg.events = null;
      repaint();
    }
    /** Flip one saved test event's visibility. Saves the whole event so nothing else changes. */
    async function setEventVisible(event, visible) {
      const keys = ['eventId', 'title', 'description', 'startsAt', 'endsAt', 'lat', 'long'];
      const body = Object.fromEntries(keys.filter((k) => event[k] !== undefined).map((k) => [k, event[k]]));
      body.visible = visible;
      const result = await run('events', () => api.admin.saveTestEvent(body), visible ? '"' + event.title + '" is now visible to other users.' : '"' + event.title + '" is now hidden from other users.');
      if (!result) return;
      if (ui.editing === event.eventId) ui.event.visible = visible;
      await afterChange();
      repaint();
    }
    async function deleteEvent(eventId) {
      const result = await run('events', () => api.admin.deleteTestEvent(eventId), 'Test event deleted.');
      ui.deleteEventId = null;
      if (result) { if (ui.editing === eventId) { ui.editing = null; ui.event = blankEvent(); } await afterChange(); repaint(); }
    }
    async function createTestSighting() {
      const result = await run('tests', () => api.admin.createTestSighting({ caption: ui.testCaption.trim(), ...location(ui.testBuilding) }),
        (r) => 'Test sighting created: ' + r.sighting.placeLabel + '. Only admins in Admin Mode can see it.');
      if (!result) return;
      ui.testCaption = '';
      await afterChange();
      ctx.focusOn(result.sighting.lat, result.sighting.long);
      repaint();
    }
    async function removeSighting(sightingId) {
      const reason = ui.removeReason.trim();
      if (reason.length < 3) return (ui.msg.review = { ok: false, text: 'Give a short reason (3–140 characters).' }), repaint();
      const result = await run('review', () => api.admin.removeSighting(sightingId, reason),
        (r) => (r.status === 'deleted' ? 'Test sighting deleted.' : r.unchanged ? 'Already removed.' : 'Sighting removed from the map and its points revoked.'));
      ui.removeId = null; ui.removeReason = '';
      if (result) {
        state.leadersLoaded = false;
        await afterChange();
        await ctx.refreshSession();
        repaint();
      }
    }
    async function clearTestData() {
      const result = await run('danger', () => api.admin.clearTestData(),
        (r) => 'Removed ' + r.testEvents + ' test event(s) and ' + r.testSightings + ' test sighting(s).');
      ui.clearConfirm = false;
      if (result) { await afterChange(); repaint(); }
    }

    // ---------------------------------------------------------------- view helpers
    function field(label, id, control) {
      return h('div', { class: 'field' }, h('label', { class: 'label', for: id }, label), control);
    }
    function input(id, attrs, value, onInput) {
      const el = h(attrs.tag || 'input', { id, ...attrs, tag: null });
      el.value = value;
      el.addEventListener('input', () => onInput(el.value));
      el.addEventListener('change', () => onInput(el.value));
      return el;
    }
    function message(section) {
      const m = ui.msg[section];
      return m && h('div', { class: 'msg' + (m.ok ? ' ok' : ' err'), role: m.ok ? 'status' : 'alert' }, m.text);
    }
    function button(label, onclick, opts = {}) {
      const busy = opts.section && ui.loading[opts.section];
      return h('button', { type: 'button', class: 'px-btn ' + (opts.cls || ''), disabled: busy || opts.disabled, onclick },
        busy && opts.busyLabel ? opts.busyLabel : label);
    }
    function buildingSelect(id, value, onChange, mapLabel) {
      const select = h('select', { id }, h('option', { value: '' }, mapLabel),
        ...ctx.buildings().filter((b) => b.campus === ctx.campus().id).map((b) => h('option', { value: b.id }, b.name)));
      select.value = value;
      select.addEventListener('change', () => onChange(select.value));
      return select;
    }
    function demoCard(kind) {
      const set = ui.demo && ui.demo[kind];
      const busy = !!ui.loading['demo-' + kind];
      const here = ctx.campus().id;
      const supported = !ui.demo || (ui.demo.campuses || []).includes(here);
      const noun = kind === 'events' ? 'events' : 'sightings';
      const what = kind === 'events' ? 'Three future events in the next 7 days at real venues' : 'A short walk of recent sightings at outdoor campus spots';
      if (!set) return h('div', { class: 'admin-card' }, h('p', { class: 'small muted' }, 'Loading demo ' + noun + '…'));
      const otherCampus = set.enabled && set.campus !== here;
      return h('div', { class: 'admin-card demo-card' },
        h('strong', {}, kind === 'events' ? 'DEMO EVENTS' : 'DEMO SIGHTINGS'),
        h('p', { class: 'small muted' }, what + '. Scope: demo ' + noun + ' for the selected campus (' + campusName(here) + ').'),
        h('button', { type: 'button', class: 'switch-row', role: 'switch', 'aria-checked': String(!!set.enabled), disabled: busy || (!set.enabled && !supported),
          onclick: () => setDemo(kind, set.enabled ? { enabled: false } : { enabled: true, campus: here }) },
          h('span', {}, h('strong', {}, busy ? 'SAVING…' : set.enabled ? 'ON' : 'OFF'),
            h('small', {}, set.enabled ? set.count + ' ' + noun + ' on ' + campusName(set.campus) + '. Turning off removes only this set.'
              : supported ? 'Off: no demo ' + noun + ' exist.' : 'No mapped demo venues for ' + campusName(here) + '. Switch to Main or Downtown.')),
          h('span', { class: 'switch', 'aria-hidden': 'true' })),
        otherCampus && supported && button('MOVE SET TO ' + campusName(here).toUpperCase(), () => setDemo(kind, { enabled: true, campus: here }), { cls: 'alt sm', section: 'demo-' + kind, busyLabel: 'MOVING…' }),
        h('div', { class: 'demo-vis', role: 'group', 'aria-label': 'Who can see demo ' + noun },
          h('span', { class: 'label' }, 'Visibility'),
          ...[[false, 'ADMINS ONLY'], [true, 'VISIBLE TO USERS']].map(([value, label]) => h('button', {
            type: 'button', class: 'px-btn alt sm', 'aria-pressed': String(set.visible === value), disabled: busy,
            onclick: () => set.visible !== value && setDemo(kind, { visible: value }),
          }, label))),
        h('p', { class: 'small muted' }, set.enabled ? (set.visible ? 'Regular users see them, labeled TEST.' : 'Only admins in Admin Mode see them.')
          : 'Saved for when the set is on. A set that is off is hidden from everyone.'),
        message('demo-' + kind));
    }
    function section(title, note, ...children) {
      return h('section', { class: 'admin-sec' }, h('h3', { class: 'admin-sec-title' }, title), note && h('p', { class: 'small muted' }, note), ...children);
    }
    function bountyControls(bounty) {
      const areas = ui.areas.filter(area => area.campus === bounty.campus);
      const alternatives = areas.filter(area => area.sectorId !== bounty.sectorId);
      const chosen = alternatives.some(area => area.sectorId === ui.bountySelection[bounty.campus])
        ? ui.bountySelection[bounty.campus] : alternatives[0]?.sectorId;
      const select = h('select', { id: 'bounty-area-' + bounty.campus, disabled: !alternatives.length || ui.loading.bounties },
        ...alternatives.map(area => h('option', { value: area.sectorId }, area.sectorName)));
      if (chosen) select.value = chosen;
      select.addEventListener('change', () => { ui.bountySelection[bounty.campus] = select.value; });
      return h('div', { class: 'admin-card' },
        h('strong', {}, bounty.campus === 'main' ? 'MAIN CAMPUS' : 'DOWNTOWN'),
        h('p', { class: 'small' }, 'Current area: ', h('b', {}, bounty.sectorName)),
        alternatives.length ? field('Choose a replacement', 'bounty-area-' + bounty.campus, select)
          : h('p', { class: 'small muted' }, 'Only one area is configured for this campus; there is no alternative to reroll.'),
        h('div', { class: 'actions' },
          button('APPLY AREA', () => changeBounty(bounty, 'set', select.value), { section: 'bounties', busyLabel: 'SAVING…', disabled: !alternatives.length }),
          button('REROLL AREA', () => changeBounty(bounty, 'reroll'), { cls: 'alt', section: 'bounties', busyLabel: 'SAVING…', disabled: !alternatives.length })));
    }
    function photoHistoryFilter() {
      const select = h('select', { id: 'admin-photo-filter' },
        h('option', { value: 'all' }, 'All photos'),
        h('option', { value: 'accepted' }, 'Accepted photos'),
        h('option', { value: 'rejected' }, 'Rejected / removed photos'));
      select.value = ui.sightingsFilter;
      select.addEventListener('change', async () => {
        ui.sightingsFilter = select.value; ui.sightings = null; ui.msg.review = null;
        repaint(); await loadReview(); repaint();
      });
      return select;
    }
    const rejectedByChecker = s => s.status === 'rejected' && ['not-detected', 'review'].includes(s.photoCheck?.status);
    function describe(entry) {
      const d = entry.detail || {};
      switch (entry.action) {
        case 'admin-mode': return 'Admin Mode ' + (d.enabled ? 'on' : 'off');
        case 'cooldown-bypass': return 'Cooldown bypass ' + (d.enabled ? 'on' : 'off');
        case 'bounty-area': return (d.mode === 'reroll' ? 'Rerolled' : 'Changed') + ' ' + d.campus + ' bounty: ' + d.before + ' → ' + d.after;
        case 'points': return (d.amount > 0 ? '+' : '') + d.amount + ' pts to ' + d.user + ' (' + d.before + ' → ' + d.after + '): ' + d.reason;
        case 'test-event-create': return 'Created test event "' + d.title + '"';
        case 'test-event-edit': return 'Edited test event "' + d.title + '"';
        case 'test-event-delete': return 'Deleted test event "' + d.title + '"';
        case 'test-sighting-create': return 'Created test sighting: ' + (d.place || 'campus');
        case 'sighting-remove': return (d.result === 'deleted' ? 'Deleted test sighting' : 'Removed ' + d.reporter + "'s sighting (−" + d.points + ' pts)') + ': ' + d.reason;
        case 'demo-events': case 'demo-sightings': return (entry.action === 'demo-events' ? 'Demo events ' : 'Demo sightings ') + (d.enabled ? 'on (' + d.count + ')' : 'off') + ' · ' + (d.visible ? 'visible to users' : 'admins only') + ' · ' + campusName(d.campus);
        case 'test-data-clear': return 'Cleared test data (' + d.testEvents + ' events, ' + d.testSightings + ' sightings)';
        case 'POST admin/sightings/approve': return 'Approved photo ' + d.sightingId;
        default: return entry.action;
      }
    }

    // ---------------------------------------------------------------- view
    function view() {
      if (!state.admin || !state.admin.allowed) return [h('p', { class: 'msg err' }, 'This account is not authorized for admin tools.')];
      if (!enabled()) return [h('p', { class: 'msg' }, 'Admin Mode is off. Turn it on from the menu to use admin tools.')];
      const bypass = !!state.admin.bypassCooldown;
      const p = ui.pending;
      return [
        h('div', { class: 'admin-banner' },
          h('strong', {}, 'ADMIN MODE · ON'),
          h('span', { class: 'small' }, 'Signed in as ' + state.user.email + '. Every action is checked by the server and logged.'),
          button('TURN OFF ADMIN MODE', () => setMode(false), { cls: 'alt sm', section: 'mode' })),
        message('mode'),

        section('COOLDOWN BYPASS', 'Testing override for your account only. Other users keep the normal 2-minute cooldown.',
          h('button', { type: 'button', class: 'switch-row', role: 'switch', 'aria-checked': String(bypass), disabled: ui.loading.cooldown, onclick: () => setBypass(!bypass) },
            h('span', {}, h('strong', {}, bypass ? 'BYPASS ACTIVE' : 'BYPASS OFF'), h('small', {}, bypass ? 'Your reports skip the cooldown.' : 'Normal cooldown applies to you.')),
            h('span', { class: 'switch', 'aria-hidden': 'true' })),
          message('cooldown')),

        section('BOUNTY AREAS', 'Choose or reroll today’s area for everyone. A reroll always picks a different area. Resets at campus midnight; existing points and each user’s daily claim stay unchanged.',
          button('REFRESH AREAS', async () => { await loadBounties(); repaint(); }, { cls: 'alt sm', section: 'bounties' }),
          ui.bounties === null && h('p', { class: 'small muted' }, 'Loading bounty areas…'),
          ...(ui.bounties || []).map(bountyControls),
          h('p', { class: 'small muted' }, 'Rosen reports earn standard points; Rosen has no daily bounty area.'),
          message('bounties')),

        section('POINTS MANAGEMENT', 'Find a user, then add or deduct points with a reason.',
          h('div', { class: 'admin-row' },
            input('admin-q', { type: 'search', placeholder: 'Name or email', maxlength: 60, 'aria-label': 'Search users' }, ui.query, (v) => (ui.query = v)),
            button('SEARCH', search, { cls: 'sm', section: 'points', busyLabel: '…' })),
          ui.users && h('div', { class: 'admin-list' }, ui.users.map((u) => h('button', {
            type: 'button', class: 'admin-pick' + (ui.selected && ui.selected.id === u.id ? ' on' : ''), 'aria-pressed': String(!!(ui.selected && ui.selected.id === u.id)),
            onclick: () => { ui.selected = u; ui.pending = null; ui.msg.points = null; repaint(); },
          }, h('strong', {}, u.displayName), h('span', { class: 'small muted' }, u.email), h('b', {}, ...nums(Number(u.score).toLocaleString('en-US') + ' pts'))))),
          ui.selected && h('div', { class: 'admin-card' },
            h('p', {}, h('strong', {}, ui.selected.displayName), ' · current total ', h('strong', {}, ...nums(Number(ui.selected.score).toLocaleString('en-US') + ' pts'))),
            !p && h('div', { class: 'admin-row' },
              field('Amount (+/−)', 'admin-amount', input('admin-amount', { type: 'number', step: 1, min: -1000, max: 1000, placeholder: '5 or -5' }, ui.amount, (v) => (ui.amount = v))),
              field('Reason', 'admin-reason', input('admin-reason', { maxlength: 140, placeholder: 'Contest prize' }, ui.reason, (v) => (ui.reason = v)))),
            !p && button('REVIEW CHANGE', reviewPoints, { section: 'points' }),
            p && h('div', { class: 'confirm-box', role: 'alertdialog', 'aria-label': 'Confirm point change' },
              h('p', {}, ...nums((p.amount > 0 ? 'Add ' : 'Deduct ') + Math.abs(p.amount) + ' point(s) ' + (p.amount > 0 ? 'to ' : 'from ') + p.name + '?')),
              h('p', { class: 'small' }, ...nums(p.before + ' → ' + (p.before + p.amount) + ' pts · Reason: ' + p.reason)),
              h('div', { class: 'actions' },
                button('CONFIRM', applyPoints, { section: 'points', busyLabel: 'SAVING…' }),
                button('CANCEL', () => { ui.pending = null; repaint(); }, { cls: 'alt', section: 'points' })))),
          message('points')),

        section('DEMO DATA', 'Generated test data for checking the map and lists. Always marked TEST, worth 0 points, and kept out of rewards, rankings, bounties and Knightro probability.',
          demoCard('events'), demoCard('sightings')),

        section('TEST EVENTS', 'Fake events for testing. Always marked TEST and never award points. Hidden from other users unless you turn on visibility.',
          ...state.testEvents.map((e) => h('div', { class: 'admin-item' },
            h('span', {}, h('b', { class: 'test-tag' }, 'TEST'), ' ', e.demo && h('b', { class: 'test-tag demo-tag' }, 'DEMO'), e.demo && ' ', h('b', { class: 'vis-tag' + (e.visible ? ' on' : '') }, e.visible ? 'VISIBLE TO USERS' : 'ADMINS ONLY'), ' ', h('strong', {}, e.title), h('small', {}, when(e.startsAt) + ' · ' + (e.location || 'Map pin'))),
            e.demo ? h('span', { class: 'small muted' }, 'Managed by Demo Events')
            : ui.deleteEventId === e.eventId
              ? h('span', { class: 'actions' }, button('DELETE', () => deleteEvent(e.eventId), { cls: 'danger sm', section: 'events' }), button('KEEP', () => { ui.deleteEventId = null; repaint(); }, { cls: 'alt sm' }))
              : h('span', { class: 'actions' }, button(e.visible ? 'HIDE' : 'SHOW', () => setEventVisible(e, !e.visible), { cls: 'alt sm', section: 'events', busyLabel: '…' }), button('EDIT', () => editEvent(e), { cls: 'alt sm' }), button('DELETE', () => { ui.deleteEventId = e.eventId; repaint(); }, { cls: 'alt sm' })))),
          !state.testEvents.length && h('p', { class: 'small muted' }, 'No upcoming test events.'),
          h('div', { class: 'admin-card' },
            h('strong', { class: 'small' }, ui.editing ? 'EDIT TEST EVENT' : 'NEW TEST EVENT'),
            field('Title', 'admin-ev-title', input('admin-ev-title', { maxlength: 80, placeholder: 'Fake pep rally' }, ui.event.title, (v) => (ui.event.title = v))),
            field('Description', 'admin-ev-desc', input('admin-ev-desc', { tag: 'textarea', maxlength: 400, placeholder: 'What to test' }, ui.event.description, (v) => (ui.event.description = v))),
            h('div', { class: 'admin-row' },
              field('Date', 'admin-ev-date', input('admin-ev-date', { type: 'date' }, ui.event.date, (v) => (ui.event.date = v))),
              field('Time', 'admin-ev-time', input('admin-ev-time', { type: 'time' }, ui.event.time, (v) => (ui.event.time = v))),
              field('Hours', 'admin-ev-hours', input('admin-ev-hours', { type: 'number', min: 1, max: 48, step: 1 }, ui.event.hours, (v) => (ui.event.hours = v)))),
            field('Map location', 'admin-ev-where', buildingSelect('admin-ev-where', ui.event.building, (v) => (ui.event.building = v), 'Current map center')),
            h('button', { type: 'button', class: 'switch-row', role: 'switch', 'aria-checked': String(!!ui.event.visible), disabled: ui.loading.events,
              onclick: () => { ui.event.visible = !ui.event.visible; repaint(); } },
              h('span', {}, h('strong', {}, 'Visible to other users'), h('small', {}, ui.event.visible
                ? 'Regular users will see this on the map and in Events, labeled TEST EVENT. No points.'
                : 'Off: only admins in Admin Mode can see this event.')),
              h('span', { class: 'switch', 'aria-hidden': 'true' })),
            h('div', { class: 'actions' },
              button(ui.editing ? 'SAVE CHANGES' : 'CREATE TEST EVENT', saveEvent, { section: 'events', busyLabel: 'SAVING…' }),
              ui.editing && button('CANCEL EDIT', () => { ui.editing = null; ui.event = blankEvent(); repaint(); }, { cls: 'alt' }))),
          message('events')),

        section('TEST SIGHTINGS', 'Labeled TEST, worth 0 points, hidden from the public map and leaderboard.',
          field('Caption', 'admin-ts-caption', input('admin-ts-caption', { maxlength: 200, placeholder: 'Test pin' }, ui.testCaption, (v) => (ui.testCaption = v))),
          field('Location', 'admin-ts-where', buildingSelect('admin-ts-where', ui.testBuilding, (v) => (ui.testBuilding = v), 'Current map center')),
          button('CREATE TEST SIGHTING', createTestSighting, { section: 'tests', busyLabel: 'CREATING…' }),
          message('tests')),

        section('REVIEW SIGHTINGS', 'Accepted and rejected photos from the last 24 hours, newest first (up to 100 per filter). Rejected photos stay private and earn 0 points. Photos expire after 24 hours.',
          field('Show photos', 'admin-photo-filter', photoHistoryFilter()),
          button('REFRESH', async () => { await loadReview(); repaint(); }, { cls: 'alt sm' }),
          ui.sightings === null && h('p', { class: 'small muted' }, 'Loading…'),
          ui.sightings && !ui.sightings.length && h('p', { class: 'small muted' }, 'No photos match this filter in the last 24 hours.'),
          ...(ui.sightings || []).map((s) => h('div', { class: 'admin-item' },
            h('span', {},
              s.status === 'test' && h('b', { class: 'test-tag' }, 'TEST'), ' ',
              h('strong', {}, s.placeLabel || 'Sighting'),
              h('small', {}, ...nums(s.displayName + ' · ' + when(s.timestamp) + ' · ' + s.status + ' · ' + s.points + ' pt(s)')),
              s.caption && h('small', { class: 'quote' }, s.caption),
              s.photoCheck && h('small', { class: 'muted' }, s.photoCheck.status === 'unavailable' ? 'Checker unavailable · not published'
                : 'Model score: ' + Number(s.photoCheck.score).toFixed(3) + ' · Cutoff: ' + Number(s.photoCheck.threshold).toFixed(3) + ' · ' + (s.photoCheck.status === 'detected' ? 'Match detected' : 'Knightro not detected')),
              s.photoUrl && h('a', { href: s.photoUrl, target: '_blank', rel: 'noopener' },
                h('img', { src: s.photoUrl, alt: 'Submitted photo for review', class: 'admin-review-photo', loading: 'lazy' }), 'View full photo')),
            s.status === 'rejected' ? h('small', { class: 'muted' }, rejectedByChecker(s) ? 'REJECTED · KNIGHTRO NOT DETECTED' : 'REMOVED')
              : ui.removeId === s.sightingId
                ? h('div', { class: 'confirm-box' },
                  field('Reason', 'admin-remove-reason', input('admin-remove-reason', { maxlength: 140, placeholder: s.status === 'test' ? 'Test cleanup' : 'Not Knightro' }, ui.removeReason, (v) => (ui.removeReason = v))),
                  h('div', { class: 'actions' }, button('REMOVE', () => removeSighting(s.sightingId), { cls: 'danger sm', section: 'review', busyLabel: '…' }),
                    button('CANCEL', () => { ui.removeId = null; repaint(); }, { cls: 'alt sm' })))
                : button('REMOVE', () => { ui.removeId = s.sightingId; ui.removeReason = s.status === 'test' ? 'Test cleanup' : ''; repaint(); }, { cls: 'alt sm' }))),
          message('review')),

        section('CLEAN UP TEST DATA', 'Deletes every test event and test sighting. Real sightings are not touched.',
          ui.clearConfirm
            ? h('div', { class: 'confirm-box', role: 'alertdialog', 'aria-label': 'Confirm clearing test data' },
              h('p', {}, 'Delete all test events and test sightings?'),
              h('div', { class: 'actions' }, button('DELETE TEST DATA', clearTestData, { cls: 'danger', section: 'danger', busyLabel: 'DELETING…' }),
                button('CANCEL', () => { ui.clearConfirm = false; repaint(); }, { cls: 'alt' })))
            : button('CLEAR ALL TEST DATA', () => { ui.clearConfirm = true; repaint(); }, { cls: 'alt' }),
          message('danger')),

        section('ACTION HISTORY', 'Most recent first.',
          button('REFRESH', async () => { await loadLog(); repaint(); }, { cls: 'alt sm' }),
          ui.log === null && h('p', { class: 'small muted' }, 'Loading…'),
          ui.log && !ui.log.length && h('p', { class: 'small muted' }, 'No admin actions yet.'),
          ui.log && h('ol', { class: 'admin-log' }, ui.log.map((entry) => h('li', {},
            h('span', { class: 'small muted' }, when(entry.created) + ' · ' + (entry.adminName || 'Unknown') + (entry.adminEmail ? ' (' + entry.adminEmail + ')' : '')),
            h('span', {}, describe(entry))))),
          message('log')),
      ];
    }

    return { view, loadPanel, loadTestData, setMode, enabled };
  }

  window.KT.admin = { create };
})();
