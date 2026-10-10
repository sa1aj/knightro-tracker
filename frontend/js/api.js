(function () {
  'use strict';
  const { CONFIG } = window.KT;
  const AWS_API = 'https://zxigfjv1p9.execute-api.us-east-1.amazonaws.com';
  async function request(path, body, base = CONFIG.API_BASE) {
    let res;
    try {
      res = await fetch(base + path, {
        credentials: 'same-origin', cache: 'no-store',
        ...(body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(15000),
      });
    } catch { throw new Error("Can't reach Knightro HQ. Check your connection and try again."); }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(data.error || (res.status === 404 ? 'Account services are unavailable. Start the Knightro application server.' : `Request failed (${res.status})`));
      Object.assign(err, { status: res.status, retryAfter: data.retryAfter });
      throw err;
    }
    return data;
  }
  window.KT.api = {
    getSession: () => request('/auth/session'),
    requestCode: (email, displayName, mode) => request('/auth/code', { email, displayName, mode }),
    verifyCode: (email, code) => request('/auth/verify', { email, code }),
    logout: () => request('/auth/logout', {}),
    getEvents: () => request('/events.json', undefined, ''),
    getGame: () => request('/game'),
    getReports: () => request('/my-reports'),
    cameraSession: () => request('/camera-session', {}),
    pushConfig: () => request('/push/config'),
    subscribe: (subscription) => request('/push/subscribe', {subscription}),
    unsubscribe: (endpoint) => request('/push/unsubscribe', {endpoint}),
    openedNear: (lat, long) => request('/presence', {lat, long}),
    getLeaderboard: () => request('/leaderboard'),
    async getSightings() {
      const data = await request('/sightings', undefined, AWS_API);
      return (data.sightings || []).filter((s) => Number.isFinite(s.lat) && Number.isFinite(s.long) && Number.isFinite(s.timestamp))
        .sort((a, b) => b.timestamp - a.timestamp);
    },
    postSighting: (body) => request('/sightings', body, AWS_API),
    // Admin routes. The server authorizes every call from the verified session; nothing here grants access.
    admin: {
      state: () => request('/admin/state'),
      setMode: (enabled) => request('/admin/mode', {enabled}),
      setCooldownBypass: (enabled) => request('/admin/cooldown', {enabled}),
      users: (q) => request('/admin/users?q=' + encodeURIComponent(q)),
      adjustPoints: (body) => request('/admin/points', body),
      testEvents: () => request('/admin/test-events'),
      saveTestEvent: (body) => request('/admin/test-events', body),
      deleteTestEvent: (eventId) => request('/admin/test-events/delete', {eventId, confirm:true}),
      testSightings: () => request('/admin/test-sightings'),
      createTestSighting: (body) => request('/admin/test-sightings', body),
      sightings: () => request('/admin/sightings'),
      removeSighting: (sightingId, reason) => request('/admin/sightings/remove', {sightingId, reason, confirm:true}),
      clearTestData: () => request('/admin/test-data/clear', {confirm:true}),
      log: () => request('/admin/log'),
    },
  };
})();
