(function () {
  'use strict';
  const { CONFIG } = window.KT;
  let STATIC = CONFIG.DEPLOYMENT === 'static';

  /** A feature this deployment doesn't have (e.g. accounts on the static GitHub Pages site). */
  function unavailable(feature) {
    return Object.assign(new Error(feature + ' needs the Knightro app server, which this static GitHub Pages copy does not include.'),
      { status: 'unavailable' });
  }

  async function request(base, path, body) {
    if (base === null) throw unavailable('This feature');
    const sameOrigin = !/^https?:/i.test(base);
    let res;
    try {
      res = await fetch(base + path, {
        // Session cookies only ever go to our own origin; the AWS API gets no credentials.
        credentials: sameOrigin ? 'same-origin' : 'omit', cache: 'no-store',
        ...(body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(path === '/sightings' && body !== undefined ? 25000 : 15000),
      });
    } catch (error) {
      throw Object.assign(new Error(error.name === 'TimeoutError'
        ? 'Knightro HQ took too long to answer. Check your connection and retry.'
        : "Can't reach Knightro HQ. Check your connection and retry."), { status: 'network' });
    }
    const json = (res.headers.get('Content-Type') || '').includes('application/json');
    const data = json ? await res.json().catch(() => null) : null;
    if (!res.ok) {
      let message = data?.error;
      if (!message && !json && sameOrigin && res.status === 404) {
        // A plain 404 page means no app server is answering /api (e.g. a static file server).
        message = 'Knightro HQ is unavailable. Please try again later.';
      }
      throw Object.assign(new Error(message || `Request failed (${res.status}). Please retry.`),
        { status: res.status, retryAfter: data?.retryAfter, noServer: !json && res.status === 404 });
    }
    if (!json || !data || typeof data !== 'object') throw Object.assign(new Error('Knightro HQ sent an unexpected response. Please retry.'), { status: res.status });
    return data;
  }
  const app = (path, body) => request(CONFIG.API_BASE, path, body);

  // Static site: anonymous AWS sightings carry no photo, account, or points. Mark them so the UI says so.
  const fromAws = (s) => ({ ...s, caption: s.caption || '', photoUrl: null, points: null, status: 'anonymous', source: 'aws' });

  /**
   * App mode on a host that may not have a backend yet (e.g. Vercel before KNIGHTRO_BACKEND_URL is set):
   * ask once at startup. The gateway's "being configured" 503 (api/proxy.mjs) or no server at all (plain
   * 404) switches this page to static mode. Any other answer, including the app server's own 503s or
   * being offline, keeps app mode and its normal errors.
   */
  const ready = (async () => {
    if (STATIC || !CONFIG.FALLBACK) return;
    try { await app('/auth/session'); }
    catch (error) {
      const unconfigured = error.status === 503 && /being configured/i.test(error.message);
      if (!unconfigured && !error.noServer) return;
      const { name, ...settings } = CONFIG.FALLBACK;
      Object.assign(CONFIG, settings, { DEPLOYMENT: name });
      STATIC = true;
    }
  })();

  window.KT.api = {
    ready,
    get deployment() { return CONFIG.DEPLOYMENT; },
    // On the static site there is no session server. Say so explicitly instead of pretending to be signed out.
    getSession: () => (STATIC
      ? Promise.resolve({ user: null, admin: null, nextSightingAt: 0, emailDelivery: 'unavailable', accounts: false })
      : app('/auth/session').then((s) => ({ ...s, accounts: true }))),
    requestCode: (email, displayName, mode) => app('/auth/code', { email, displayName, mode }),
    verifyCode: (email, code) => app('/auth/verify', { email, code }),
    signup: (email, password, displayName) => app('/auth/signup', {email, password, displayName}),
    login: (email, password) => app('/auth/login', {email, password}),
    logout: () => app('/auth/logout', {}),
    async getEvents() {
      if (!STATIC) return app('/events');
      // No server on the static site: apply the server's likely-Knightro rules to the raw feed here.
      const [feed, buildings] = await Promise.all([request('', CONFIG.STATIC_EVENTS_URL), request('', CONFIG.BUILDINGS_URL)]);
      return window.KT.mapUtils.eventHints(feed, buildings.buildings || [], Date.now() / 1000);
    },
    getGame: () => app('/game'),
    getReports: () => app('/my-reports'),
    cameraSession: () => app('/camera-session', {}),
    pushConfig: () => app('/push/config'),
    subscribe: (subscription) => app('/push/subscribe', {subscription}),
    unsubscribe: (endpoint) => app('/push/unsubscribe', {endpoint}),
    openedNear: (lat, long) => app('/presence', {lat, long}),
    getLeaderboard: () => app('/leaderboard'),
    async getSightings() {
      const data = await request(CONFIG.SIGHTINGS_API, '/sightings');
      return (data.sightings || []).map((s) => (STATIC ? fromAws(s) : s))
        .filter((s) => Number.isFinite(s.lat) && Number.isFinite(s.long) && Number.isFinite(s.timestamp))
        .sort((a, b) => b.timestamp - a.timestamp);
    },
    async postSighting(body) {
      if (!STATIC) return app('/sightings', body);
      // AWS accepts location + caption only. Success is reported only after its 201 response.
      const sent = { lat: body.lat, long: body.long, caption: body.caption || '' };
      const res = await request(CONFIG.SIGHTINGS_API, '/sightings', sent);
      if (!res.sightingId) throw new Error('The sightings service did not confirm your report. Please retry.');
      return fromAws({ ...sent, ...res, nextSightingAt: 0 });
    },
    // Admin routes. The server authorizes every call from the verified session; nothing here grants access.
    admin: {
      state: () => app('/admin/state'),
      setMode: (enabled) => app('/admin/mode', {enabled}),
      setCooldownBypass: (enabled) => app('/admin/cooldown', {enabled}),
      users: (q) => app('/admin/users?q=' + encodeURIComponent(q)),
      adjustPoints: (body) => app('/admin/points', body),
      testEvents: () => app('/admin/test-events'),
      saveTestEvent: (body) => app('/admin/test-events', body),
      deleteTestEvent: (eventId) => app('/admin/test-events/delete', {eventId, confirm:true}),
      testSightings: () => app('/admin/test-sightings'),
      createTestSighting: (body) => app('/admin/test-sightings', body),
      sightings: (status = 'all') => app('/admin/sightings?status=' + encodeURIComponent(status)),
      removeSighting: (sightingId, reason) => app('/admin/sightings/remove', {sightingId, reason, confirm:true}),
      clearTestData: () => app('/admin/test-data/clear', {confirm:true}),
      log: () => app('/admin/log'),
    },
  };
})();
