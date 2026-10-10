# Legacy AWS teammate setup

> **Legacy reference:** The live website now uses Vercel and Supabase. Follow [the current production setup](../supabase/README.md) for accounts, photos, database migrations, and manual event imports. These AWS/email-code instructions do not configure the current backend.

Prepared from GitHub `sa1aj/knightro-tracker` main at `5386b95`, including its latest visual, campus zoom, animation, retry, and app/static mode updates. This package supplies the missing application deployment and connects the existing event scraper. It does not provision anything until an AWS operator runs it. Confirm the actual AWS inventory first: we have not inspected that account.

## What to deploy

```text
Browser → Vercel /api function → HTTPS Caddy → application + background worker
                                                   ↓
                                          SQLite + photos on EBS
Existing scraper + existing database → private S3 event snapshot → application
Application → SES SMTP verification email / optional Web Push
Application → private S3 backups + CloudWatch logs
```

This is one application instance, appropriate for the current SQLite backend. Accounts, sessions, photos, scores, cooldowns, bounties, admin tools, and push jobs share persistent storage. Do not run multiple independent instances or put this SQLite database on ephemeral serverless storage. The scraper database remains separate.

### Files

| File | Purpose |
| --- | --- |
| `deploy/aws/application.json` | Application EC2, encrypted retained EBS, private retained S3, IAM, logs, SSM, security group, public IP |
| `deploy/aws/install.sh` | Build containers, mount the exact data volume, install supervised services and timers |
| `deploy/aws/secret.example.json` | Secrets Manager schema; example values only |
| `deploy/aws/generate_keys.py` | Generate gateway token and optional VAPID pair into a private file |
| `deploy/aws/Caddyfile` | HTTPS gateway; application requests require the private gateway token |
| `frontend/vercel.json`, `frontend/api/proxy.mjs` | Same-origin API routing with private Vercel settings |
| `scraper/aws.yaml` | Existing scraper stack with optional permission to publish one feed object |
| `scraper/scrape_and_publish.py` | Publish only after a successful complete scrape |
| `deploy/check_deployment.py` | Read-only post-deployment checks |
| `deploy/VALIDATION.md` | Local checks and remaining live checks |

## 1. Supply these values

- AWS region, an existing VPC, and a **public subnet in that VPC with an Internet Gateway route**. Permit outbound HTTPS and SES SMTP traffic in network ACLs. This stack creates billable EC2, EBS, S3, logs, and a public IPv4 address.
- A backend DNS hostname you control, such as `api.your-domain.com`. Create its A record using the stack's `PublicIp` before installing the gateway. Ports 80/443 must be reachable for certificate issuance; do not create an AAAA record without working IPv6.
- SES verified sender/domain, regional SMTP credentials, and production sending access. SES sandbox delivery is restricted to verified recipients. SMTP credentials differ from AWS API credentials.
- Explicit admin UCF emails as a comma-separated allowlist, or an empty string to disable admins.
- Existing scraper deployment identifiers and database environment. Confirm whether it actually runs as this repository's ECS task, Lambda, or another runtime; update that deployment rather than duplicating the scraper or database.

The frontend origin is `https://knightro-tracker-frontend-teal.vercel.app`. A future custom domain requires coordinated changes to `PUBLIC_ORIGIN` and the gateway Host configuration.

## 2. Store secrets

On a trusted computer with Python and `cryptography` installed (included in backend requirements), generate keys into a **private directory outside Git**:

```sh
python deploy/aws/generate_keys.py --contact operator@your-domain.com --output /secure/knightro-keys.json
```

The directory must already exist and be private. The generator refuses to overwrite a file and prints no key material. On Windows, use a directory restricted to your user; Unix file permissions alone do not configure Windows ACLs.

Create one JSON secret in AWS Secrets Manager using `deploy/aws/secret.example.json` as the schema. Replace every placeholder, insert the generated `PROXY_TOKEN` and three VAPID values, and keep the region consistent. `ADMIN_EMAILS` must be explicitly set. All three VAPID fields can instead be empty to defer push; signup still requires SMTP. Retain VAPID keys across releases so existing subscriptions remain valid.

Use the default AWS managed Secrets Manager encryption key. If you choose a customer-managed KMS key, separately grant this application's role `kms:Decrypt` for that key and update the key policy. Record the secret ARN. Never commit the real JSON, email credentials, private keys, or Vercel token.

## 3. Create the application stack

Run from the repository root using the operator's AWS CLI identity. Replace uppercase placeholders:

```sh
aws cloudformation validate-template --template-body file://deploy/aws/application.json --region REGION
aws cloudformation deploy --template-file deploy/aws/application.json \
  --stack-name knightro-application --region REGION --capabilities CAPABILITY_IAM \
  --parameter-overrides VpcId=VPC_ID PublicSubnetId=SUBNET_ID \
  ApplicationSecretArn=SECRET_ARN InstanceType=t3.small DataGiB=40
aws cloudformation describe-stacks --stack-name knightro-application --region REGION \
  --query 'Stacks[0].Outputs'
```

Record `InstanceId`, `PublicIp`, `DataVolumeId`, `StorageBucket`, and `LogGroup`. Create the DNS A record now. The security group exposes only 80/443; administration uses Systems Manager Session Manager, without an SSH port. The instance role supplies runtime access, not the operator's deployment permissions.

EBS and S3 have retention policies: deleting the stack leaves those resources and their charges. Root disk contents are disposable. Review change sets before future updates, especially instance replacement; retained old volumes are not automatically migrated into new volumes. Back up and plan recovery before replacing the host or storage.

## 4. Install through Session Manager

Connect to `InstanceId` using Session Manager. Obtain the **complete reviewed release** by cloning the pushed GitHub commit or securely uploading this full source ZIP and extracting it. Do not deploy files piecemeal. Before the changes are pushed, use the supplied ZIP.

Wait for cloud-init to finish. The instance bootstrap installs Docker, Git, and Python. If initial network access preceded public-IP association, inspect `/var/log/cloud-init-output.log` and retry `sudo dnf install -y docker git python3` followed by `sudo systemctl enable --now docker`. Amazon Linux 2023 supplies AWS CLI; confirm `aws --version`.

From the repository root, run:

```sh
sudo bash deploy/aws/install.sh REGION SECRET_ARN DATA_VOLUME_ID STORAGE_BUCKET LOG_GROUP \
  api.your-domain.com https://knightro-tracker-frontend-teal.vercel.app \
  operator@your-domain.com --initialize-volume
```

Use `--initialize-volume` only on the new empty stack volume. The installer matches the exact EBS serial and refuses existing signatures or partitions before formatting. On later installs, omit the flag; an existing ext4 volume is never formatted. Review the script before executing it on a production host.

The installer creates private root-owned environment files, mounts persistent `/srv/knightro-data`, builds the application image, resolves the Caddy image to its digest, and validates Caddy configuration. Existing databases are backed up locally and to S3 before the new application starts and migrates them. Application port 8000 binds to host loopback. The background worker runs inside the same application process.

```sh
sudo systemctl status knightro-app knightro-proxy
sudo systemctl list-timers 'knightro-*'
curl --fail https://api.your-domain.com/healthz
```

Container logs go to the stack's CloudWatch group. Service/timer errors appear in `journalctl -u knightro-app`, `-u knightro-feed`, or `-u knightro-backup`. The feed timer runs every minute. Until the scraper publishes its first S3 object, it retains the bundled dated snapshot and reports download failures; that snapshot is not proof of a working scraper connection.

Direct `/api/*` requests to the backend without the gateway token return 404. The public `/healthz` endpoint is intentionally available for probes. It confirms database access, not email deliverability or worker health.

## 5. Configure Vercel

Use **Root Directory `frontend`**, Framework Preset **Other**, Node **22 or later**, and default static build/output settings. Keep `frontend/api/proxy.mjs` in the deployment and apply `frontend/vercel.json`; do not export a static-only copy that omits the function.

Set these private Production environment variables:

| Vercel variable | Value |
| --- | --- |
| `KNIGHTRO_BACKEND_URL` | `https://api.your-domain.com` (origin only) |
| `KNIGHTRO_PROXY_TOKEN` | Exact `PROXY_TOKEN` from Secrets Manager |

Redeploy after changing variables. Do not use a browser-public environment prefix or put these values in `frontend/js/config.js`. Deploy and check the backend before merging/releasing this frontend; the updated frontend requires it and reports explicit service errors if configuration is missing.

The browser calls `/api/*` on Vercel. The private function forwards cookies, browser Origin, JSON bodies, and response cookies through HTTPS. Caddy sets the fixed frontend Host; backend Origin checks still apply. Secure, HttpOnly session cookies belong to the Vercel origin. Email rate limits use the Vercel-provided client IP only after authenticating the gateway token. Preview domains cannot authenticate against this fixed production origin: use a separate staging backend or keep previews read-only; do not broadly allow arbitrary origins.

The former anonymous AWS sightings API is no longer the submission path **on Vercel in app mode**. The latest upstream GitHub Pages static mode remains available with anonymous sightings and browser-classified event hints; it explicitly marks accounts, photos, and rewards unavailable. Existing anonymous reports are not imported into verified accounts or assigned invented ownership. Decide separately whether any legacy data should be migrated.

## 6. Connect the existing scraper

The app reads private `s3://STORAGE_BUCKET/events/events.json`; it does not access the scraper database. Use the scraper's existing database credentials and runtime role. Export supports SQLite or PostgreSQL with `DATABASE_URL`, or `DATABASE_HOST`, `DATABASE_PASSWORD`, and optional user/name/port. PostgreSQL separate-variable mode defaults to TLS `sslmode=require`; to verify the server identity, also supply a trusted RDS CA file and `DATABASE_SSLMODE=verify-full` / `DATABASE_SSLROOTCERT`.

One manual export from an environment with the scraper dependencies and runtime permissions:

```sh
python scraper/export_events.py --from-env --output /data/events.json --bucket STORAGE_BUCKET
```

Do not put database passwords in command arguments. The exporter retains descriptions so the application can classify likely Knightro appearances. Ordinary club meetings are excluded from map hints.

### If the scraper uses this repository's ECS stack

1. Build/push the updated `scraper/Dockerfile` image using the existing ECR repository and release tag.
2. Update the **existing** scraper stack with `scraper/aws.yaml`, keeping existing VPC/subnet/database/secret parameters and setting `EventsBucket=STORAGE_BUCKET` and the new image.
3. Review the change set. Do not replace the RDS database or create a second scraper stack.
4. Confirm the new task uses `scrape_and_publish.py` (the updated Docker CMD). Remove an old task command override that still directly runs `scraper.py`.
5. Run one full task and verify the feed object's timestamp; then retain the existing schedule. Limited smoke runs deliberately do not publish.

The template grants the optional **task runtime role** `s3:PutObject` on just the feed object and grants the existing Scheduler role permission to pass that runtime role. The execution role is separate. A failed scrape or partial `--limit` run preserves the previous feed. A publication failure causes a nonzero task exit after the database scrape completes.

### If the scraper uses another runtime

Install the updated scraper requirements (including `boto3`), set `EVENTS_BUCKET=STORAGE_BUCKET`, and run the complete scrape followed by the exporter/publisher only on success. Grant its runtime role this policy; do not make the bucket public:

```json
{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Action":"s3:PutObject","Resource":"arn:aws:s3:::STORAGE_BUCKET/events/events.json"}]}
```

Use the actual AWS partition in the ARN if outside standard commercial regions. Do not replace a working schedule with a duplicate. Confirm one full publication before calling the integration complete.

## 7. Acceptance checks

```sh
python deploy/check_deployment.py --site https://knightro-tracker-frontend-teal.vercel.app/
```

This checks public API contracts, SMTP configuration status, and the deployed service worker path without creating accounts or reports. It does not prove real mail or push delivery. Also check:

- A real UCF verification email arrives; sign-in persists on refresh; invalid domains are rejected.
- A live camera capture submits with its single-use token, creates a public photo/pin, awards points, and enforces the 120-second cooldown.
- Leaderboard, recent reports, campus bounds, clusters, bounties, and admin authorization work; a regular user cannot access admin tools.
- The scraper's new snapshot reaches `/api/events`; ordinary meetings do not become appearance hints.
- HTTPS push opt-in and actual device delivery work when VAPID is configured.
- Restart the application and confirm account/report persistence. Perform a backup restore drill before launch.

## Backups, updates, and recovery

The nightly timer makes a SQLite online backup (including committed WAL state), checks integrity, compresses it, and uploads it privately under `backups/`. Backups expire after 30 days; S3 versioning is enabled. Monitor backup failures and disk space. Photos are stored in the application database. Caddy certificate data also lives on EBS. S3 event versions outside the backup prefix are retained and may need a separate retention policy later.

For updates, deploy the reviewed source revision and rerun the installer without the initialization flag. It saves a predeployment backup before migrations. If installation fails after stopping services, inspect the error and recover deliberately; it does not automatically roll back a partially migrated database.

For recovery, stop the app, restore an integrity-checked backup into the persistent app directory with UID/GID 10001, and remove only that database's stale WAL/SHM files while stopped. Restore the **matching application image and database backup** together if a migration makes the old image incompatible. Use the preserved EBS volume or a reviewed replacement/restore plan; never initialize a volume containing production data.

For greater availability or multiple replicas, first migrate application transactions to shared storage and photos to object storage. This package is a single-host deployment and does not add RDS/SQS/DynamoDB unnecessarily to the current app.

### Official references

[Vercel Node functions](https://vercel.com/docs/functions/runtimes/node-js), [rewrites](https://vercel.com/docs/rewrites), [request headers](https://vercel.com/docs/headers/request-headers), [Caddy reverse proxy](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy), [SES SMTP credentials](https://docs.aws.amazon.com/ses/latest/dg/smtp-credentials.html), [SES production access](https://docs.aws.amazon.com/ses/latest/dg/request-production-access.html), [SSM instance permissions](https://docs.aws.amazon.com/systems-manager/latest/userguide/setup-instance-permissions.html).
