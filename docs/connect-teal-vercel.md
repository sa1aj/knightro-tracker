# Connect the original Vercel frontend

Website: https://knightro-tracker-frontend-teal.vercel.app/

This project can use the existing Knightro Supabase backend. It does not need a new database or any AWS services. GitHub pushes provide the source code; each Vercel project needs its own private environment variables.

## One-time setup by the Vercel project owner

1. Open the Vercel project that owns the website above. In Settings, connect `sa1aj/knightro-tracker`, use `main` for the production branch, and set the Root Directory to `frontend`. Use the repository's `frontend/vercel.json` configuration.
2. In Settings → Environment Variables, add the following variables for **Production**:

   | Name | Value |
   | --- | --- |
   | `KNIGHTRO_BACKEND_URL` | `https://uetdvbrfqmjbusivudam.supabase.co/functions/v1/knightro-api` |
   | `KNIGHTRO_PROXY_TOKEN` | The existing `knightro_PROXY_TOKEN` secret from this Supabase project's Vault |

3. Obtain the existing proxy token through an authorized Supabase operator. Store it as a sensitive server environment variable. Never put it in Git, client JavaScript, screenshots, or a `NEXT_PUBLIC_` / `VITE_` variable. No Supabase service key belongs in Vercel.
4. Deploy the latest commit on `main` after saving the variables. Adding variables does not change a previously built deployment.

The backend approves this exact production hostname and the newer `knightro-tracker-potatogigabyte.vercel.app` hostname. Both frontends use the same data. Browser session cookies belong to each hostname, so users sign in separately on each site with the same account.

## Diagnose a remaining connection problem

- A menu saying **Needs the app server** means the site could not use its account API. Confirm the current deployment contains `frontend/api/proxy.mjs` and the API rewrite in `frontend/vercel.json`, and inspect Vercel Function logs for `/api/auth/session`.
- A 404 at `/api/auth/session` usually means the wrong root directory or an older deployment omitted the API function.
- A 503 describing missing backend settings means the private environment variables need configuring in that project and a new production deployment needs building.
- An unrecognized-origin error means the deployed hostname differs from the approved exact origins.

GitHub integration will deploy later source changes automatically. Database migrations and Supabase Edge Function releases are deployed separately using the instructions in `supabase/README.md`. The event feed reads the most recently imported completed scraper database; no recurring scraper is configured.
