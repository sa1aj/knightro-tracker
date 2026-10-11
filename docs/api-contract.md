# Production API: Vercel and Supabase

The live website uses same-origin `/api/*` requests. Vercel forwards requests to the private Supabase `knightro-api` Edge Function. [Supabase operations](../supabase/README.md) covers deployment and secrets. The previous email-code Python API is documented separately in [the legacy reference](legacy-python-api.md).

## Gateway and sessions

The proxy forwards JSON bodies, cookies, the original browser Origin, and the Vercel client IP. It attaches the private `X-Knightro-Proxy-Token`; the Edge API checks it against Supabase Vault. Browser clients never receive the proxy token or Supabase service keys. Mutations require the configured canonical Origin and `application/json`.

The backend uses Supabase password accounts and an opaque `kt_session` cookie: HttpOnly, Secure, SameSite=Lax, Path=/api, up to 14 days. Authorization is checked on every request. GET responses use `Cache-Control: no-store`. Times are Unix seconds. Errors contain `error`; cooldown and rate-limit errors also contain `retryAfter` and a Retry-After header.

## Accounts

- `POST /api/auth/signup`: `{email, password, displayName}`. Only `@ucf.edu` and `@knights.ucf.edu`; password 12–128 characters, display name 2–30 characters. Returns the signed-in session and sets the cookie.
- `POST /api/auth/login`: `{email, password}`. Returns the session and sets the cookie.
- `GET /api/auth/session`: `{user, nextSightingAt, cooldownSeconds:120, authMode:"password", emailDelivery:"disabled", accounts:true}`. A user includes `id`, `displayName`, `email`, `score`, and `emailVerified:false`; signed-out `user` is null.
- `POST /api/auth/logout`: clears the app session and revokes this browser's provider session.

Email codes and email-based password recovery are disabled. An accepted UCF domain does not verify ownership or affiliation. `/auth/code`, `/auth/verify`, and the Python `/healthz` probe are not routes in this production backend.

## Camera photos and sightings

- `POST /api/camera-session`: `{}`; signed-in account required. Returns `captureToken` and `expiresAt`, 120 seconds ahead. Replaces the previous capture token; the posting cooldown is enforced.
- `POST /api/sightings`: `{requestId, lat, long, caption?, photo, captureToken}`. `requestId` is a UUID reused for retries of the same report; caption is at most 200 characters. `photo` is a JPEG data URL under 2 MB decoded, with dimensions at least 240 pixels, no side over 1600 pixels, and at most 2 megapixels. Photos are normalized to at most 800 pixels on their longer side and at most 300 KB. Requires a valid campus location and fresh capture token. Posting consumes the token, enforces a 120-second per-account cooldown, and awards points transactionally. Retake after an expired capture. Client-supplied points, time, building, and bounty claims are ignored.
- Successful POST returns 201 with `sightingId`, coordinates, caption, timestamp, campus/building labels, status, points, eligiblePoints, bountyId or null, photoUrl, and nextSightingAt. A retry returns the existing report without awarding points twice. The first report per account inside a daily bounty earns two points; others earn one.
- `GET /api/sightings`: `{sightings:[...]}` containing published and confirmed reports from the last 20 minutes.
- `GET /api/photos/<report UUID>`: normalized JPEG through the API. Published/confirmed photos are readable; rejected photos require the owner or an administrator. Private objects are retained for 24 hours, then photoUrl becomes null; history and points remain.
- `GET /api/my-reports`: signed-in account's latest 30 reports as `{reports:[...]}`.
- `GET /api/leaderboard`: `{leaders:[{id,displayName,score}], period:"all-time"}`. Scores include published/confirmed reports and administrator adjustments; no other user's email is public.

Before committing a new report, the API calls the private image classifier on the normalized stored JPEG. High-scoring matches publish and earn points; lower scores and checker outages produce `status:"pending"`, `points:0`, and eligible points held until admin approval. Pending photos are readable only by the owner or administrators. Browser `photoCheck`, status, scores, and decision fields are ignored. Pending reports consume the capture token and normal cooldown. Retries return pending reports idempotently too.

Pins expire independently of photo retention. The classifier recognizes Knightro depictions and cannot prove a live encounter or physical camera capture. [Photo checker operations](photo-checker.md) describes the pinned model and calibration.

## Events, bounties, and hints

- `GET /api/events`: classified event hints from the last manually imported completed scraper database, with `events`, `available`, `generatedAt`, `importedAt`, `stale`, and `filter:"likely-knightro"` when a feed exists. Ordinary meetings do not receive map pins. Each hint includes its event ID, title, description, location, start/end times, coordinates, building, campus, reason, hosts, and source URL. Likelihood is a heuristic. Map hints appear within 30 minutes of start.
- `GET /api/game`: serverTime, active daily bounties, and unexpired alerts. Bounties include a sector polygon and startsAt/expiresAt at successive campus midnights in America/New_York. The server uses that same polygon for point eligibility. Main has curated sections; Downtown covers its two mapped academic buildings; Rosen currently earns standard points.
- `POST /api/presence`: opted-in foreground `{lat,long}`. Signed-in account required; only account ID, resolved building ID, and time are retained for ten minutes. Unknown/off-campus building signals do not contribute. Six distinct openings can produce an unconfirmed Knight-Sense hint without exposing precise user coordinates.
- `GET /api/push/config`: `{enabled,publicKey}`.
- `POST /api/push/subscribe`: `{subscription:{endpoint,keys:{p256dh,auth}}}`. Signed-in account, recognized HTTPS browser push service, at most five subscriptions per account.
- `POST /api/push/unsubscribe`: `{endpoint}`; removes this account's subscription and queued jobs.

Event ingestion uses the separate private `event-import` function with its own operator token. Browsers cannot import snapshots. The maintenance worker cleans up data and delivers notifications; no recurring scrape or import is configured.

## Administrator routes

Only confirmed account UUIDs granted in `knightro.admins` have administrator access. These permissions are read on every call; neither an email domain nor client fields grant access. Tools also require Admin Mode, except state/mode routes.

- `GET /api/auth/session` adds `admin:{allowed,mode,bypassCooldown}` for authorized accounts.
- `GET /api/admin/state` and `POST /api/admin/mode {enabled}`. Turning the mode off clears cooldown bypass.
- `POST /api/admin/cooldown {enabled}`: own-account cooldown bypass.
- `GET /api/admin/users?q=`: account name/email search with scores, for admins in Admin Mode.
- `POST /api/admin/points {userId,amount,reason,requestId,confirm:true}`: nonzero integer amount up to ±1000, reason 3–140 characters, idempotent request ID. Cannot reduce a score below zero.
- `GET /api/admin/test-events`; `POST /api/admin/test-events {title,description,startsAt,endsAt,lat,long,eventId?}`; `POST /api/admin/test-events/delete {eventId,confirm:true}`.
- `GET /api/admin/test-sightings`; `POST /api/admin/test-sightings {lat,long,caption}`. Test reports earn zero points and are excluded from public sightings/leaderboard.
- `GET /api/admin/sightings`: up to 100 reports from the last day, pending first, with private `photoCheck` status/score/model metadata.
- `POST /api/admin/sightings/approve {sightingId,confirm:true}`: approves an unexpired pending photo, publishes as confirmed, and awards eligible points once. Repeated approvals are idempotent and bounty awards cannot duplicate.
- `POST /api/admin/sightings/remove {sightingId,reason,confirm:true}`: rejects the report and revokes its points.
- `POST /api/admin/test-data/clear {confirm:true}` and `GET /api/admin/log`.

Administrator mutations are audited and follow the same Origin, session, and JSON requirements as other writes.
