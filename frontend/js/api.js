(function () {
  'use strict';
  const { CONFIG } = window.KT;
  async function request(path, body) {
    let res;
    try {
      res = await fetch(CONFIG.API_BASE + path, {
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
    getEvents: () => request('/events'),
    getGame: () => request('/game'),
    getReports: () => request('/my-reports'),
    cameraSession: () => request('/camera-session', {}),
    pushConfig: () => request('/push/config'),
    subscribe: (subscription) => request('/push/subscribe', {subscription}),
    unsubscribe: (endpoint) => request('/push/unsubscribe', {endpoint}),
    openedNear: (lat, long) => request('/presence', {lat, long}),
    getLeaderboard: () => request('/leaderboard'),
    async getSightings() {
      const data = await request('/sightings');
      return (data.sightings || []).filter((s) => Number.isFinite(s.lat) && Number.isFinite(s.long) && Number.isFinite(s.timestamp))
        .sort((a, b) => b.timestamp - a.timestamp);
    },
    postSighting: (body) => request('/sightings', body),
  };
})();
