# Validation and release boundary

Source baseline: GitHub `origin/main` at `5386b9568fc0bc394231fdc96c71bcb6f21d078f`, fetched before packaging on October 10, 2026. A new upstream update arrived during preparation; the branch was rebased onto it, preserving its visual, campus zoom, animation, retry, and static/app mode changes.

## Completed locally

- 19 frontend tests: map/camera behavior and event classification plus cookie credentials, preserved photo/token/points payloads, real camera-session calls, explicit session outages, preserved static-mode behavior, gateway path/configuration checks, upload limits, redirect rejection, and Set-Cookie forwarding.
- 32 backend/helper tests: account and admin authorization, photos and rewards, push queue behavior, authenticated forwarded IPs, successful/failed/limited event publication, SQLAlchemy row export, private environment validation, VAPID key compatibility, and online backups including committed WAL data.
- Both CloudFormation templates passed `cfn-lint` 1.57.2: `deploy/aws/application.json` and `scraper/aws.yaml`.
- Caddy 2.11.7 from its official release validated `deploy/aws/Caddyfile` using dummy configuration. No gateway server was started.
- All five deployment shell scripts parsed without errors using the Tree-sitter Bash grammar. This is a syntax check, not execution under Linux or native `bash -n`.
- The read-only deployment checker passed against an isolated local application: session, sightings, classified events, leaderboard, game, push configuration, and service worker path. No email or sighting was created.
- `git diff --check` passed.

Dependencies and validation utilities were installed in an isolated workspace directory, not committed into the source package.

## Not established by these checks

No AWS account inventory was accessed and no resources were created. CloudFormation has not been deployed, the Linux installer and Docker images have not run in AWS, and the Vercel function/rewrites have not been deployed. Real PostgreSQL/RDS connectivity, S3 publication, SES delivery, DNS/certificate issuance, device push delivery, and production restore remain operator acceptance checks in [the guide](README.md).

The SQLAlchemy exporter was exercised against a SQLite fixture with native dates/JSON/listing booleans. Its PostgreSQL configuration is prepared but needs the existing database's live check. SMTP and browser push tests use mock delivery; they do not establish actual deliverability.

Deploy the backend and configure the private Vercel variables before releasing this frontend. Vercel app mode uses the verified application API; an unavailable backend produces an explicit error. The preserved GitHub Pages static mode supports anonymous sightings only; the legacy AWS endpoint is not a substitute for account, camera, or reward services.
