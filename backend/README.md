# Backend

Python 3.12+; install backend/requirements.txt. server.py serves the frontend and same-origin /api with transactional SQLite storage. A 15-second background loop rotates daily bounties and delivers push. It binds to loopback by default. Use --bind 0.0.0.0 only inside a private deployment behind an HTTPS proxy; --dev-mail requires loopback.

## Verification email

Signup/sign-in sends a random six-digit code valid for ten minutes. Salted hashes, single consumption, five attempts, per-email and per-IP request limits protect the flow. Verified @ucf.edu and @knights.ucf.edu accounts receive rotated opaque session cookies (HttpOnly, SameSite=Lax, Path=/api, 14 days; Secure with HTTPS PUBLIC_ORIGIN). Every mutation checks Origin and JSON content type. Host is checked except for the read-only /healthz probe.

SMTP_HOST and SMTP_FROM configure delivery. SMTP_SECURITY=starttls/587 is the default; ssl/465 is also supported. SMTP_USER and SMTP_PASSWORD must be supplied together. TLS certificates are verified and timeouts enforced. Incomplete configuration fails at startup. backend/.env.example documents variables; it is not loaded automatically. Local --dev-mail saves codes beside the database and cannot use a public origin.

## Live photos, publication, and points

POST /api/camera-session issues a single-use account-bound token lasting 120 seconds. The inline frontend camera requests it at snap time. There is no photo picker or extra dialog. POST /api/sightings requires that token and a JPEG data URL (2 MB decoded, 240px minimum dimension, 16 megapixels maximum). Pillow decodes, normalizes to at most 1600px, and removes EXIF/GPS metadata.

The server consumes the token, validates the campus/building, enforces a 120-second cooldown, determines bounty eligibility, inserts a published report, and awards points in one transaction. Reports immediately appear on the map, in Recent Sightings, and on the leaderboard. Normal reports earn 1 point; the first report per account per daily bounty earns 2. Later reports inside that area continue posting for 1 point. A published photo is public by opaque report ID. This validates image format and a recent capture session; it does not identify Knightro automatically or prove camera provenance against a modified client.

Pins expire 20 minutes after submission; historical points remain. The previous version's validated pending photos migrate to published with their stored candidate points, preserving timestamps. Legacy scores survive migration. Back up the database before release.

Optional moderate.py --decision approve marks a published photo confirmed without doubling points. --decision reject removes its public pin/score and makes the photo owner-only. Review is not required to post. --export writes live photos to a private review directory.

## Daily bounty sections

Four Main Campus choices each contain five curated neighboring buildings. The boundary is a convex hull of their official footprints, padded about 25m and including connecting paths. Downtown has a section covering its two mapped academic buildings. Rosen reports currently earn normal points.

One section per configured campus is randomly selected for the whole America/New_York calendar day. The persistent unique(campus,starts) slot prevents rerolls on restart or duplicate workers. The map uses the same polygon as server eligibility; there is no 120m bounty radius. Daylight-saving transitions correctly use successive campus midnights. Old half-hour drops retire during schema migration.

## Knight-Sense and push

Location signals are optional. Verified foreground openings resolve to a known building; presence stores only account/sector/time, never exact coordinates. At most one opening/account/minute contributes. Six distinct accounts in five minutes against at most two in the preceding window triggers an unconfirmed building hint. Records expire after ten minutes. Alert deduplication, a 15-minute global cooldown, and a one-hour sector cooldown limit noise. Upcoming likely appearances also generate hints based on listing text and official building matches.

Set VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, and VAPID_SUBJECT with pywebpush installed. HTTPS and browser permission are required outside localhost. The service worker is scoped to /frontend/. Authenticated subscriptions are limited to five/account and recognized HTTPS browser push services.

Persistent push jobs are leased, retried with backoff up to five attempts, and discarded when alerts expire. 404/410 removes the subscription. Delivery is at least once after a worker crash; alert-specific notification tags collapse repeats. Changing the VAPID key requires resubscription. iPhone Web Push requires a supported Home Screen app.

## Production

Use one instance with durable SQLite/local block storage behind a hardened HTTPS proxy, edge limits, request timeouts, and PUBLIC_ORIGIN. Preserve public Host; do not trust arbitrary forwarded headers. The standard-library server is for development and must stay private in deployment. Before multiple replicas or serverless, move transactions and leases to shared storage and photos to object storage. See [AWS handoff](../docs/aws-deployment.md). The existing scraper Lambda and GitHub Pages do not deploy this application backend.
