# Knightro Tracker 🛡️

Live UCF sightings, camera photos, daily section bounties, and Knight-Sense building hints in a black-and-gold pixel theme.

**Live website: [Knightro Tracker](https://knightro-tracker-potatogigabyte.vercel.app/)**

## Current production setup

The frontend is hosted on **Vercel**. **Supabase** provides accounts, Postgres data, photo storage, and the API. Events come from the last completed scraper database that an operator manually imports.

```text
Browser → Vercel /api proxy → Supabase knightro-api
                                 ├─ Auth and private Postgres data
                                 └─ Private photo storage

Completed scraper database → manual event-import → stored event feed
Supabase maintenance worker → cleanup, bounties, hints, and Web Push
```

There is **no recurring scraper**, and AWS is not required for this production setup. The maintenance worker does not scrape or import events.

| Component | Source | Setup guide |
| --- | --- | --- |
| Frontend and same-origin API proxy | `frontend/` | [Vercel configuration](supabase/README.md#connect-the-existing-vercel-site) |
| Database, accounts, photos, and API | `supabase/` | [Supabase operations](supabase/README.md) |
| Manually run event scraper and importer | `scraper/` | [Scraper instructions](scraper/README.md) |
| Current browser API | `/api/*` | [API contract](docs/api-contract.md) |

## Accounts and reports

- Create an account with `@ucf.edu` or `@knights.ucf.edu`, a public display name, and a password of 12–128 characters.
- Email codes and email-based password recovery are disabled. **Email ownership is unverified**; the accepted domain does not prove affiliation.
- Sessions use a secure HttpOnly cookie lasting up to 14 days.
- Snap a fresh camera photo and submit within two minutes. Reports have a **120-second cooldown per account**.
- Pins fade and expire after 20 minutes. Main, Rosen, and Downtown campuses are supported, with building labels from official UCF footprints.
- A first report inside the day's selected bounty section earns two points; other reports earn one. Bounties rotate at midnight America/New_York.
- JPEGs are normalized to at most 800 pixels on their longer side and stripped of EXIF/GPS metadata. Photos expire after 24 hours; report history and points remain.
- Nearby pins group together. The left menu gives access to accounts, leaderboard, events, and authorized admin tools.
- Knight-Sense hints use likely event listings and separately opted-in building-level presence. Hints do not confirm mascot attendance. Web Push requires browser permission.

Camera tokens and image validation protect the normal report workflow; they do not identify Knightro automatically or prove physical camera capture against a modified client.

## Deployment and teammate handoff

The current Supabase project is `uetdvbrfqmjbusivudam` (`knightro`). The Vercel project is `knightro-tracker`, with **`frontend` as its root directory**.

Set these private Vercel Production variables before deploying:

| Variable | Value |
| --- | --- |
| `KNIGHTRO_BACKEND_URL` | `https://uetdvbrfqmjbusivudam.supabase.co/functions/v1/knightro-api` |
| `KNIGHTRO_PROXY_TOKEN` | Existing Supabase Vault secret `knightro_PROXY_TOKEN` |

Keep the proxy token and Supabase service keys out of frontend JavaScript and Git. The allowed request origin is the canonical live website above. See [the operations guide](supabase/README.md) for migration history, function deployment, maintenance, and secret handling.

Administrators are granted by a **confirmed account UUID** in `knightro.admins`; an unverified email address cannot grant admin access. [First administrator setup](supabase/README.md#grant-the-first-administrator) explains the process. Admin Mode provides moderation, points adjustments, test data, and an audited cooldown bypass.

## Update the event feed manually

Run the scraper when new data is wanted, or import an existing completed SQLite database. From the repository root:

```powershell
$env:SUPABASE_URL = 'https://uetdvbrfqmjbusivudam.supabase.co'
$env:KNIGHTRO_IMPORT_TOKEN = '<existing knightro_IMPORT_TOKEN from Supabase Vault>'
python scraper/import_supabase.py --database scraper/events.db
```

Importing an existing database needs Python only; it does not launch Chromium. Failed, limited, or older snapshots cannot replace the live feed. The database file is operator data and is excluded from Git. See [scraper setup](scraper/README.md) to run a new scrape.

## Local development and legacy deployments

The current hosted backend lives in `supabase/`. The earlier Python/SQLite backend remains available for local development:

```powershell
python -m pip install -r backend/requirements.txt
python backend/server.py --port 8001 --dev-mail
```

Open `http://127.0.0.1:8001/frontend/`. This local backend uses development email codes rather than production's Supabase password accounts. Its database defaults to `../knightro-tracker-data/knightro.db`.

Historical [Python backend](backend/README.md), [AWS deployment](deploy/README.md), and [Python API](docs/legacy-python-api.md) documentation is marked **legacy**. The GitHub Pages compatibility mode still uses its earlier anonymous sightings service and does not provide production account features.
