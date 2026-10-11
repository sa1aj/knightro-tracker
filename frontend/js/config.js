window.KT = window.KT || {};

/*
 * Where the app gets its data. Chosen by where the page is served from — never silently mixed.
 *
 *  app    backend/server.py serves this frontend and /api on the same origin (local dev, Codespaces,
 *         or a deployed server). Every feature: accounts, photo reports, points, bounties, admin.
 *  static GitHub Pages (static files only, no Python server). Anonymous sightings use the team's AWS
 *         API; likely-Knightro events are filtered in the browser from data/events.json (same rules as the
 *         server). Features that need the app server
 *         are shown as unavailable instead of failing silently.
 *
 * Any other host (Vercel, a deployed server) starts in app mode. If /api answers that no backend is
 * connected yet (the Vercel gateway's 503, or a plain 404 page), api.js switches to static at startup.
 */
(function () {
  const AWS_SIGHTINGS_API = 'https://zxigfjv1p9.execute-api.us-east-1.amazonaws.com';
  const DEPLOYMENTS = {
    app: { name: 'app', API_BASE: '/api', SIGHTINGS_API: '/api', ACCOUNTS: true, STATIC_EVENTS_URL: null },
    static: { name: 'static', API_BASE: null, SIGHTINGS_API: AWS_SIGHTINGS_API, ACCOUNTS: false, STATIC_EVENTS_URL: 'data/events.json' },
  };
  let deployment = /\.github\.io$/i.test(location.hostname) ? DEPLOYMENTS.static : DEPLOYMENTS.app;
  // Local testing only: http://localhost:<port>/frontend/?deployment=static previews the GitHub Pages behavior.
  const forced = new URLSearchParams(location.search).get('deployment');
  const pinned = Boolean(forced && DEPLOYMENTS[forced] && /^(localhost|127\.0\.0\.1)$/.test(location.hostname));
  if (pinned) deployment = DEPLOYMENTS[forced];

  window.KT.CONFIG = {
    // Vercel mounts at /; the local Python server mounts at /frontend/.
    APP_BASE: new URL('../', document.currentScript.src).pathname,
    DEPLOYMENT: deployment.name,
    API_BASE: deployment.API_BASE,
    SIGHTINGS_API: deployment.SIGHTINGS_API,
    ACCOUNTS: deployment.ACCOUNTS,
    STATIC_EVENTS_URL: deployment.STATIC_EVENTS_URL,
    // Settings api.js switches to when app mode finds no backend connected. Null when the mode is pinned.
    FALLBACK: deployment === DEPLOYMENTS.app && !pinned ? DEPLOYMENTS.static : null,
    POLL_MS: 12000, ACTIVE_WINDOW_SEC: 1200, FRESH_SEC: 300,
    COOLDOWN_SEC: 120, CAPTION_MAX: 200,
    CAMPUSES_URL: 'data/campuses.json', BUILDINGS_URL: 'data/buildings.json', STOCK_PHOTOS: [],
    // Supplied Knightro map pin (assets/photos/images/knightro-pin.svg). Its viewBox is framed so the tip is the
    // exact bottom-centre of the image, which is where the marker anchors to the map coordinate.
    PIN_IMAGE: 'assets/photos/images/knightro-pin.svg', PIN_SIZE: [46, 58],
    EVENT_FRAMES: ['assets/photos/images/eventframe1-03.svg', 'assets/photos/images/eventframe2-05.svg', 'assets/photos/images/eventframe3-04.svg'],
    // Top-bar Knightro turnaround (8 supplied frames, in filename order). Adjust speed here.
    KNIGHTRO_FRAMES: [1, 2, 3, 4, 5, 6, 7, 8].map((n) => 'assets/photos/knightro%20animation/knightroanim-0' + n + '.svg'),
    KNIGHTRO_FPS: 8,
    KNIGHTRO_HOLD_FRONT_MS: 900, // linger on the front-facing frame before the next turn
  };
})();
