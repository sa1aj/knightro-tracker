# Supabase backend

Production project: `uetdvbrfqmjbusivudam` (`knightro`). The SQL migrations and three Edge Functions in this folder implement the hosted backend. The Python backend remains available for local development and the earlier AWS deployment.

Live frontend: [Knightro Tracker](https://knightro-tracker-potatogigabyte.vercel.app/). Vercel project `knightro-tracker` (`prj_6PTNUZzrXdYYjXNVHBBVSPgf9Cec`) uses `frontend` as its source root and has the private Production environment variables configured. It was initially deployed directly from source. When connecting this Git repository to Vercel, deploy the version containing this Supabase backend and keep the private environment variables configured.

## Connect the existing Vercel site

Use `frontend` as the Vercel project root. Set these **private server environment variables** for Production, then deploy the frontend changes in this branch:

| Variable | Value |
| --- | --- |
| `KNIGHTRO_BACKEND_URL` | `https://uetdvbrfqmjbusivudam.supabase.co/functions/v1/knightro-api` |
| `KNIGHTRO_PROXY_TOKEN` | The existing Vault secret named `knightro_PROXY_TOKEN` |

Retrieve the proxy token in the Supabase dashboard's Vault page. Do not generate a different token, put it in browser JavaScript, or use a `NEXT_PUBLIC_` / `VITE_` prefix. Supabase service keys are not needed in Vercel. Only the Vercel server calls the Edge API; browsers use the same-origin `/api/*` proxy.

The canonical production origin is stored in Vault as `knightro_PUBLIC_ORIGIN`, currently `https://knightro-tracker-potatogigabyte.vercel.app`. The JSON array in `knightro_PUBLIC_ORIGINS` also approves `https://knightro-tracker-frontend-teal.vercel.app`. Both sites can use the same backend, accounts, photos, and event feed once their private Vercel settings are configured. Other aliases and preview URLs do not accept account or report writes until an operator explicitly configures the intended origin. Redeploy after changing Vercel environment variables. See [the teal site connection guide](../docs/connect-teal-vercel.md) for its owner's setup steps.

## Accounts and cookies

- Password signup accepts `@ucf.edu` and `@knights.ucf.edu`, with a public display name and a 12–128 character password.
- Email delivery is disabled. **An accepted email address does not prove UCF affiliation or ownership.** The frontend labels addresses unverified. There is no email-based password recovery in this release.
- The private API uses Supabase Auth's admin create-user endpoint with `email_confirm: true` to allow password login without sending email. This provider flag is an operational login setting; the application reports `emailVerified: false` and stores `ucf_email_verified: false` in app metadata. Hosted global email confirmation settings do not need to be disabled.
- An Auth trigger enforces UCF domains even when someone accesses the provider directly. Signup and login through the app have IP and email rate limits.
- The browser gets an opaque 14-day `kt_session` cookie: HttpOnly, Secure, SameSite=Lax, Path=/api. Only a hash is stored. Provider access and refresh tokens are encrypted with AES-GCM before storage, and are never returned to JavaScript. Logout deletes the app session and revokes the current provider session.
- Authorization uses database account IDs and current server state. User-editable metadata never grants admin access.

## Sightings, points, and photos

The database transaction enforces campus bounds, a fresh single-use two-minute capture token, the 120-second per-account cooldown, and point awards. The client sends a UUID `requestId` so a retry can return the already committed report. Main, Rosen, and Downtown are supported; the existing curated bounty sections rotate at midnight America/New_York.

JPEGs are decoded, resized to at most 800 pixels on their longer side, and re-encoded without EXIF/GPS metadata. Images must be under 300 KB after normalization. The private `knightro-photos` bucket has no public policies. Authorized API requests serve photos through `/api/photos/<report UUID>`.

Published photos are retained for 24 hours. Abandoned upload reservations expire after 10 minutes. The worker removes their objects and clears photo references; report history and earned points remain. Reservation accounting caps photos at 750 MB. Camera-only UI and capture tokens enforce the normal workflow, but cannot prove that a browser used a physical camera or that a photo shows Knightro.

## Manual event database imports

**There is no scraper schedule.** Supabase stores the last completed scraper snapshot. Run Chromium on the operator's computer when a new snapshot is wanted, or import an existing completed SQLite database directly:

```powershell
# Run from the repository root. Retrieve the import token from Supabase Vault.
$env:SUPABASE_URL = 'https://uetdvbrfqmjbusivudam.supabase.co'
$env:KNIGHTRO_IMPORT_TOKEN = '<knightro_IMPORT_TOKEN from Vault>'
python scraper/import_supabase.py --database scraper/events.db
```

The importer needs only Python's standard library and the existing scraper export helper; it does not need Chromium or scraper dependencies. It reads a consistent read-only SQLite snapshot and requires the latest scrape run to be complete. Failed and limited runs cannot overwrite the feed. The Edge importer validates the full snapshot, preserves raw listings privately, and computes likely Knightro hints using the existing appearance and building rules. Imports older than the stored snapshot are rejected; identical imports are idempotent. Limits: 5,000 events, 8 MB per import, 20 imports per hour.

To scrape once and import that newly completed database, install the scraper dependencies and Chromium as described in `scraper/README.md`, then run from the scraper folder:

```powershell
python scrape_and_publish.py
```

With the Supabase variables set, this command uses the Supabase importer. Without them, the earlier S3 publishing option is retained. `--limit` never publishes. The Supabase importer currently accepts SQLite databases; a PostgreSQL scraper database needs an equivalent completed snapshot exporter.

## Maintenance and notifications

The single `knightro-maintenance` cron job invokes `knightro-worker` every minute for photo cleanup, expired sessions/presence, daily bounties, Knight-Sense hints, and queued Web Push. It does **not** collect events or import a database. A lease prevents overlapping workers. VAPID keys are generated once and stored in Vault. Notification retries stop after five attempts; expired endpoints are removed.

Presence is separately opt-in and stored only as account ID, building ID, and time for ten minutes. Six distinct app openings in five minutes can produce a building hint. Event hints can alert within 15 minutes of the start. Neither source confirms mascot attendance.

## Grant the first administrator

First create the account on the deployed website. Find its UUID in Supabase Authentication → Users, confirm it belongs to the intended person, then run this in the SQL editor with that exact UUID:

```sql
insert into knightro.admins(user_id)
values ('<confirmed account UUID>'::uuid)
on conflict (user_id) do nothing;
```

Reload the site to show the Admin menu. Admin Mode gates moderation, test data, point adjustments, and the optional cooldown bypass. Every mutation is audited. Never grant access based only on an unverified email address. To revoke an administrator, delete that UUID's row from `knightro.admins`; permission is read on every API call.

## Deployment and migration history

The checked-in migration versions match the hosted project's migration history. This matters because replaying a differently timestamped copy would attempt to create the same tables again.

For future deployments, use an authenticated Supabase CLI. Discover the installed commands with `supabase --help`, `supabase db push --help`, and `supabase functions deploy --help`. Link this project, provide the database password securely when required, then apply pending migrations and deploy the functions:

```bash
supabase link --project-ref uetdvbrfqmjbusivudam
supabase db push
supabase functions deploy knightro-api --project-ref uetdvbrfqmjbusivudam --no-verify-jwt
supabase functions deploy event-import --project-ref uetdvbrfqmjbusivudam --no-verify-jwt
supabase functions deploy knightro-worker --project-ref uetdvbrfqmjbusivudam --no-verify-jwt
```

JWT verification is deliberately disabled at the gateway because each function authenticates a **distinct private caller secret** before processing requests. The worker and importer do not accept browser sessions. Application mutations also validate the original browser Origin. The platform's built-in `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are used only inside Edge Functions; custom application secrets are read from encrypted Vault through a service-only RPC.

The migrations target this dedicated Knightro project. Before using another project, update the deployment project URL and allowed origin in the maintenance migration. Never apply the UCF-only Auth trigger to a shared project serving unrelated applications.

## Private data boundary and operations

All application tables are in the unexposed `knightro` schema, with RLS enabled and direct access revoked from `anon` and `authenticated`. RLS has no client policies intentionally: clients cannot query these tables. Only `service_role` can execute `public.kt_rpc`; it uses invoker rights. Privileged Auth triggers and Vault accessors have empty search paths and restricted execution grants. Photos are private. Database queries never return session boxes, import secrets, or other users' email addresses through public routes.

Supabase's security advisor may report informational "RLS enabled, no policy" notices for these private tables. They describe the intentional deny-by-default client boundary. Foreign key indexes are included. Keep provider limits and project status visible in the Supabase dashboard; photo caps and retention reduce storage use but do not guarantee unlimited free usage. A free project can pause after inactivity and must be restored before the app can serve accounts again.

Back up application data and the scraper database before destructive changes. When deleting an Auth account manually, also remove its `<account UUID>/` storage folder: database cascading deletion removes upload records, so the worker cannot discover those orphaned objects afterward. Vault keys are deployment secrets; do not commit, attach, or paste them into chat. Rotate caller tokens in Vault and update the corresponding trusted caller together.
