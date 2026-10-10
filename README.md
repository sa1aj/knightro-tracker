# Knightro Tracker 🛡️

Live UCF sightings, daily section bounties, and Knight-Sense building hints in the original black-and-gold pixel theme.

## Vercel and AWS deployment

The complete operator guide is [deploy/README.md](deploy/README.md). It includes an application CloudFormation stack, HTTPS gateway, private secrets, persistent storage, backups, and the connection to the existing scraper.

Vercel uses `frontend` as its project root and forwards `/api/*` through a Node function using private `KNIGHTRO_BACKEND_URL` and `KNIGHTRO_PROXY_TOKEN` environment variables. Deploy the backend and set these variables before releasing this frontend. Accounts, camera capture, cooldowns, points, and classified events require the application backend; an unavailable service is reported as an error.

## Run locally

Python 3.12+ and the backend dependencies:

```powershell
python -m pip install -r backend/requirements.txt
python backend/server.py --port 8001 --dev-mail
```

Open http://127.0.0.1:8001/frontend/. The application server provides accounts, photo reports, bounties, and push delivery. The default database lives outside the repository at ../knightro-tracker-data/knightro.db; override with --database PATH. Development mail saves verification codes in dev-mail beside that database, never sends email, and is restricted to loopback.

The radar HUD uses CARTO Dark Matter when `CARTO_BASEMAP_KEY` is configured in `frontend/js/config.js`. [Request a CARTO basemap key](https://www.carto.com/basemaps/) and restrict it to your frontend domains, including local development if needed. This is a browser-visible map key, not an AWS or backend secret. Without a key, the map uses dark-styled OpenStreetMap tiles with the appropriate provider attribution. No backend changes are required for either map provider.

## Behavior

- Larger 66×74 pins fade to 55% opacity and expire 20 minutes after submission.
- Official UCF footprints and coordinates determine building labels on the server. Inside a footprint is At; outside, Near is limited to 120m. Distant points use the campus name.
- Event hints require appearance evidence and a mapped building. Ordinary meetings receive no pins. Hints appear within 30 minutes of the start; attendance remains unconfirmed.
- Main Campus has four curated sections of five neighboring buildings. One daily bounty shades the selected section, including connecting paths. Downtown uses its two mapped academic buildings; Rosen currently earns standard points. A new section is randomly selected at midnight America/New_York, persists across restarts, and lasts the whole campus day.
- A user's first accepted photo report inside a daily bounty earns 2 points. Later reports earn 1 point and still appear normally, subject to the 120-second cooldown.
- Photo capture sits inside the existing report panel. It uses the live camera only, with no gallery picker, newspaper overlay, export step, or extra modal. Retake replaces the photo; capture, leaving the form, and backgrounding stop the live stream.
- A verified account obtains a single-use, two-minute camera session when snapping. Submit before that window expires or retake. Valid JPEG submissions publish immediately to the map, Recent Sightings, and the leaderboard, in one transaction.
- Images are decoded, size-limited, normalized, and stripped of EXIF. These are community photo reports; automatic mascot recognition is not claimed. A browser cannot cryptographically prove physical camera capture; camera-only UI and short-lived tokens enforce the normal workflow.
- Knight-Sense announces sudden clusters of six distinct verified app openings or likely mascot events starting within 15 minutes. Alerts name a building and do not reveal users' exact coordinates. Location signals are separately opt-in and retained only as account/sector/time for ten minutes.
- Optional Web Push uses browser permission, VAPID, a scoped service worker, and a persistent retry outbox.

## Admin Mode

Authorized accounts get an **ADMIN** section in the menu with an Admin Mode switch and an admin panel:
cooldown bypass (own account only), points add/deduct with a reason, test events, test sightings,
sighting removal, one-click test-data cleanup, and an action history.

- **Who is an admin:** a verified sign-in whose email is on the server-side allowlist `ADMIN_EMAILS`
  (comma-separated). When unset it defaults to `jo822842@ucf.edu`. Nothing in the browser grants access.
- **Enforcement:** every `/api/admin/*` call re-checks the session, the allowlist, and (for tools) that
  Admin Mode is on. Regular users get 403. Turning Admin Mode off also disables the cooldown bypass.
- **Test data stays separate:** test sightings use status `test` (0 points, never in public routes or the
  leaderboard); test events live in their own table and appear only for admins in Admin Mode.
- Point changes need a reason and confirmation, are idempotent per request ID, can't drop a total below 0,
  and count on the leaderboard. Every admin action is written to `admin_log`.

## Existing reports and optional review

The previous private pending-photo queue is removed. Migration publishes existing validated pending photos and awards their stored eligible points once, retaining original timestamps and pin expiry. Back up the database before release. Legacy scores remain intact.

Operators can optionally review or remove reports:

```powershell
python backend/moderate.py --database PATH --export PRIVATE_REVIEW_DIRECTORY
python backend/moderate.py --database PATH --sighting REPORT_ID --decision reject
# --decision approve marks an operator-confirmed photo without awarding points twice.
```

Rejecting a report removes it from public sightings and the leaderboard and restricts its photo to its owner. Review is not required for posting or rewards.

## Email and deployment

Set SMTP_HOST, SMTP_FROM, SMTP_PORT, SMTP_SECURITY=starttls (587) or ssl (465), and SMTP_USER/SMTP_PASSWORD. TLS certificates are verified. See [backend setup](backend/README.md), [AWS handoff](docs/aws-deployment.md), and [API contract](docs/api-contract.md). Credentials are absent from the repository.

## Event feed

```powershell
python scraper/export_events.py --database scraper/events.db
```

The export preserves descriptions for appearance classification. `--from-env` also reads the scraper's PostgreSQL database; `--bucket BUCKET` publishes a private S3 snapshot after a complete successful scrape. The application downloads that snapshot and returns classified events through `/api/events`. See [deployment](deploy/README.md) for the existing scraper integration.

## Checks

```powershell
python -m unittest discover -s backend -p "test_*.py" -v
node --test frontend/tests/*.test.cjs
node --check frontend/js/app.js
node --check frontend/js/camera.js
node --check frontend/js/knight-sense.js
node --check frontend/js/hud.js
node --check frontend/sw.js
```

Tests use disposable databases, synthetic photos, simulated camera streams, development mail, and mocked SMTP/Web Push. No real email or push is sent.
