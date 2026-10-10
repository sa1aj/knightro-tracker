# Same-origin API

## Vercel gateway boundary

Production browser requests use `/api/*` on the Vercel frontend origin. The private function forwards cookies, original browser Origin, full JSON bodies, and upstream status/Set-Cookie headers. Caddy supplies the configured frontend Host. The application enforces verified sessions, single-use camera tokens, Origin checks, and cooldowns.

`X-Knightro-Client-IP` is trusted only when `X-Knightro-Proxy-Token` matches private `TRUSTED_PROXY_TOKEN`. Vercel supplies the edge client address; arbitrary forwarded headers are ignored. Vercel app mode uses this API; the preserved GitHub Pages static mode separately uses the legacy anonymous AWS sightings endpoint and marks account services unavailable. See [deployment](../deploy/README.md).

## Routes

All times are Unix seconds. GET responses are no-store. POST requires application/json and the configured Origin. Session cookies are HttpOnly and scoped to /api. Errors return {"error":"message","retryAfter":null}; rate limits include Retry-After.

- GET /healthz: read-only database probe.
- GET /api/auth/session: user (or null), nextSightingAt, cooldownSeconds, emailDelivery (development/smtp/unconfigured).
- POST /api/auth/code: email, mode (signup/login), displayName for signup. Generic delivery acknowledgement and expiresIn; never a code.
- POST /api/auth/verify: email and six-digit code. Rotates the session cookie.
- POST /api/auth/logout: clears the current session.
- POST /api/camera-session: empty object, verified account required and report cooldown enforced. Returns captureToken and expiresAt=server time+120 seconds. Replaces any earlier token for this account.
- POST /api/sightings: lat, long, optional caption (max 200), photo (JPEG data URL, max 2 MB decoded), captureToken. Requires a verified session, campus location, valid JPEG, fresh account-bound token, and 120-second cooldown. Consumes the token in the same transaction as posting. Client points, time, building, and bounty claims are ignored. Returns 201 with the complete sighting: sightingId, lat, long, caption, timestamp, campus, nextSightingAt, status=published, points, eligiblePoints, bountyId or null, buildingId, buildingName, placeLabel, photoUrl. The first daily bounty report awards 2 points; subsequent reports in that section publish for 1 point.
- GET /api/sightings: published, operator-confirmed, and legacy sightings from the last 20 minutes. Fields include sightingId, lat, long, caption, timestamp, campus, placeLabel, buildingId, status, points, photoUrl or null.
- GET /api/photos/REPORT_ID: sanitized JPEG. Published/confirmed photos are public; removed photos require the owning account.
- GET /api/my-reports: own latest 30 reports, status, points, eligiblePoints, timestamp, placeLabel. Requires a session.
- GET /api/leaderboard: public displayName and score (sum of published/confirmed/legacy points), period=all-time. No emails.
- GET /api/events: available, generatedAt, filter=likely-knightro, events. Appearance evidence plus a known building is required. Each includes eventId, title, description, location, startsAt, endsAt, lat, long, campus, buildingId, buildingName, probability, reason, hosts, url. Probability is a heuristic. Map hints appear within 30 minutes of the start.
- GET /api/game: serverTime, active bounties, unexpired alerts. Each bounty includes bountyId, sectorId, sectorName, campus, buildingId/buildingName (section anchor), lat/long (section center), buildings=[{buildingId,name}], area=[[longitude,latitude],...], startsAt, expiresAt, multiplier=2. Eligibility uses the same area polygon drawn on the map. Starts/expiry are successive campus midnights in America/New_York (23/25 hours on daylight-saving transitions). Main sections contain five buildings; Downtown contains its two mapped buildings. Alerts include alertId, message, reason, campus, createdAt, expiresAt; no user locations.
- POST /api/presence: opted-in foreground lat/long. Verified account required. Stores a sector and opening time, ages out in ten minutes. Off-campus returns 400; unknown sectors contribute nothing.
- GET /api/push/config: enabled, publicKey or null.
- POST /api/push/subscribe: browser Push API subscription with endpoint and keys.p256dh/auth. Verified accounts, recognized HTTPS push hosts, max five devices/account.
- POST /api/push/unsubscribe: removes this account's subscription and queued jobs.

## Admin routes (verified allowlisted accounts only)

Every route re-checks the session, the server-side `ADMIN_EMAILS` allowlist, and, except `/state` and `/mode`, that Admin Mode is on. Otherwise 401/403. POSTs follow the same Origin/JSON rules as above.

- GET /api/auth/session adds `admin: {allowed, mode, bypassCooldown}` only for allowlisted accounts, and `user.score` for everyone signed in.
- GET /api/admin/state · POST /api/admin/mode {enabled}: switching off also clears the cooldown bypass.
- POST /api/admin/cooldown {enabled}: bypass the 120-second cooldown for the admin's own account only.
- GET /api/admin/users?q=: name/email search with current score.
- POST /api/admin/points {userId, amount (int, ±1000, not 0), reason (3–140), requestId, confirm:true}: idempotent per requestId; a total can't go below 0.
- GET /api/admin/test-events · POST /api/admin/test-events {title, description, startsAt, endsAt, lat, long, eventId?} (create or edit) · POST /api/admin/test-events/delete {eventId, confirm:true}.
- GET /api/admin/test-sightings · POST /api/admin/test-sightings {lat, long, caption}: status `test`, 0 points, never public.
- GET /api/admin/sightings (last 24 h, all statuses) · POST /api/admin/sightings/remove {sightingId, reason, confirm:true}: rejects a real report (points revoked) or deletes a test one.
- POST /api/admin/test-data/clear {confirm:true} · GET /api/admin/log (latest 50 actions: who, what, when).

GET /api/leaderboard scores now include admin point adjustments.

JPEG validation establishes readable image evidence, not automated Knightro identification or cryptographic camera provenance. Optional operator rejection removes a report and its awarded points. The previous pending queue migrates once to published reports with stored eligible points and original expiry. Existing deployment endpoints remain unchanged.
