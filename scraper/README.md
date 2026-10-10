# KnightConnect event scraper

Collects all publicly listed **upcoming and ongoing events** from [KnightConnect](https://knightconnect.campuslabs.com/engage/events), then stores them in SQLite or PostgreSQL. Runs once and exits. The current production workflow is an operator-run scrape followed by a manual Supabase import; there is no recurring scraper.

## Current Supabase integration

Production uses a **manual** database import with no recurring scrape. After someone completes a scraper run, `import_supabase.py --database events.db` uploads that completed SQLite snapshot to the private Supabase importer. This command does not browse KnightConnect. Set `SUPABASE_URL` and `KNIGHTRO_IMPORT_TOKEN` in the operator's environment; see [Supabase operations](../supabase/README.md) for the commands and Vault secret names.

`scrape_and_publish.py` runs the scraper once and imports the resulting database when those variables are set. Failed or limited runs never replace the live feed. The AWS scheduling instructions later in this document describe the older optional deployment; no such scraper schedule is created by the Supabase setup.

## How it collects events

1. Opens the public event listing in headless Chromium and clicks **Load More** until the displayed count matches the total. This avoids the one-week limit of the site's main RSS/iCal feed.
2. Downloads each event's public `…/engage/event/<id>.ics` calendar file, which is linked from the event detail page.
3. Parses and validates every calendar before updating the database in one transaction.

The scraper checks `robots.txt` before fetching the listing and calendar files. It does not directly call the site's `/engage/api/` endpoints, which are excluded by robots.txt. The browser loads the listing as a normal visitor would. There is no login or collection of attendee/submitter accounts.

## Run on your computer

Requires Python 3.12+ and Internet access. Open a terminal in this folder.

**Windows PowerShell:**

```powershell
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
.\.venv\Scripts\python.exe -m playwright install chromium
.\.venv\Scripts\python.exe scraper.py
```

**macOS / Linux:**

```bash
python3 -m venv .venv
.venv/bin/python -m pip install -r requirements.txt
.venv/bin/python -m playwright install chromium
# Linux may also need: .venv/bin/python -m playwright install-deps chromium
.venv/bin/python scraper.py
```

This creates `events.db` in your current folder. A complete run takes several minutes. It waits one second between calendar downloads and retries transient HTTP errors with backoff. Avoid simultaneous SQLite runs against the same file.

An initial completed snapshot of 516 listings collected on October 9, 2026 was imported into Supabase. Local `events.db` files are excluded from Git; a fresh checkout needs an operator-provided completed database or a new scraper run.

Optional commands (use your virtual environment's Python):

```bash
python scraper.py --limit 3           # Small smoke test; does not reconcile the full listing
python scraper.py --headed            # Show the browser for debugging
python scraper.py --browser-channel chrome  # Use installed Chrome instead of downloading Chromium
python scraper.py --browser-channel msedge  # Use installed Microsoft Edge
python scraper.py --database-url sqlite:///another-file.db
python -m unittest discover -s tests -v
```

Use `DATABASE_URL` to select PostgreSQL without putting credentials on the command line. For example, in PowerShell:

```powershell
$env:DATABASE_URL = 'postgresql+psycopg://USER:URL_ENCODED_PASSWORD@HOST:5432/events?sslmode=require'
.\.venv\Scripts\python.exe scraper.py
```

On macOS/Linux set the same variable with `export DATABASE_URL='…'`. The database must already exist; tables are created automatically. PostgreSQL runs use an advisory lock to prevent overlapping scrapes. Alternatively, set `DATABASE_HOST`, `DATABASE_PASSWORD`, and optionally `DATABASE_USER` / `DATABASE_NAME`; passwords in those separate variables do not need URL encoding. PostgreSQL connections in that mode require TLS.

## Connect the production tracker map

After a successful SQLite scrape, import the completed database from the repository root:

```powershell
$env:SUPABASE_URL = 'https://uetdvbrfqmjbusivudam.supabase.co'
$env:KNIGHTRO_IMPORT_TOKEN = '<existing knightro_IMPORT_TOKEN from Supabase Vault>'
python scraper/import_supabase.py --database scraper/events.db
```

The live website reads this stored feed through Supabase. The importer does not launch Chromium, and does not need the scraper's browser dependencies. Alternatively, with those variables configured, run `scrape_and_publish.py` from this folder to scrape once and import only if the full run succeeds. See [Supabase operations](../supabase/README.md).

### Legacy static-file and AWS publishing

`python scraper/export_events.py --database scraper/events.db` writes `frontend/data/events.json` for the earlier Python backend or static compatibility site. Exporting that file alone does not update the live Supabase feed.

The PostgreSQL/S3 exporter and `aws.yaml` remain for operators of the older deployment. See [the legacy AWS guide](../deploy/README.md) before changing an existing AWS stack. They are not required for current production.

## Database contents

`events` has one row per KnightConnect event ID. It includes:

| Field | Meaning |
|---|---|
| `event_id`, `source_url` | Stable identity and public detail page |
| `name`, `description` | Event title and plain-text calendar description |
| `starts_at`, `ends_at` | Date/time normalized to UTC |
| `location`, `latitude`, `longitude` | Location data supplied by the calendar |
| `hosts`, `categories` | JSON arrays of host/category values supplied by the calendar |
| `status` | Calendar status, such as `CONFIRMED` or `CANCELLED` |
| `calendar_text` | Original calendar file for auditing/re-parsing |
| `first_seen_at`, `last_seen_at` | When the scraper first and most recently observed the event |
| `is_listed` | Whether the event was present in the most recent completed full discovery |

`scrape_runs` records start/end timestamps, status (`running`, `complete`, `limited`, `failed`), and event count. A process killed by the OS may leave a `running` record.

Re-running updates changed details without duplicate rows. Historical rows remain stored. An event missing from a successful full run becomes `is_listed = false`; absence alone does **not** mean canceled. Limited runs never mark other events unlisted. If any calendar fails or does not match the expected event ID, that run exits with status 1 and preserves the previous event data. A subsequent full run retries from the beginning.

SQLite stores UTC datetimes without a timezone suffix; PostgreSQL uses timezone-aware timestamps. Treat SQLite timestamps as UTC in your application. Descriptions can contain URLs; render them as text unless you explicitly sanitize/linkify them. Calendar categories may combine the site's theme and category labels. Fields absent from calendars (such as image assets, perk filters and RSVP details) are not collected. Host values are kept as exported, including any combined multi-host text.

Example queries:

```sql
SELECT event_id, name, starts_at, ends_at, location, hosts, source_url
FROM events
WHERE is_listed = true AND ends_at > CURRENT_TIMESTAMP
ORDER BY starts_at;

SELECT started_at, finished_at, status, event_count
FROM scrape_runs
ORDER BY started_at DESC;
```

You can open the SQLite file with a SQLite database viewer. PostgreSQL consumers can use the same table and column names.

## Docker

Requires Docker with Linux container support. The image and Python package pin the same Playwright version, as required by [Playwright's Docker documentation](https://playwright.dev/python/docs/docker).

```bash
docker build --platform linux/amd64 -t knightconnect-scraper .
docker volume create knightconnect-data
docker run --rm --init --shm-size=1g -v knightconnect-data:/data knightconnect-scraper
```

The database persists in the named volume at `/data/events.db`. To use PostgreSQL, supply `DATABASE_URL` or the separate database variables instead. For a limited container run:

```bash
docker run --rm --init --shm-size=1g -v knightconnect-data:/data knightconnect-scraper python scraper.py --limit 3
```

## Legacy AWS deployment (optional historical setup)

`aws.yaml` is a CloudFormation template for **ECS Fargate + EventBridge Scheduler + private PostgreSQL RDS**. Browser scraping is packaged as a Linux container; Fargate lets a full run finish without Lambda's invocation time limit. Scheduling ECS tasks through EventBridge Scheduler is supported in the [AWS documentation](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/tasks-scheduled-eventbridge-scheduler.html).

The template creates a cluster, task definition, log group, generated RDS password managed by Secrets Manager, encrypted PostgreSQL database with seven days of backups, and a recurring schedule. It does not create the surrounding VPC. RDS accepts connections only from the task's security group; tasks have no inbound rules. The generated password is injected into the container at startup. Database deletion/replacement retains a snapshot.

Prerequisites:

- An AWS account, AWS CLI v2 configured for it, and Docker.
- An existing VPC, public subnets with an Internet Gateway route for tasks, and private subnets in at least two different Availability Zones for RDS. All subnets must belong to the chosen VPC. The task's public IP provides outbound access to the website and AWS APIs.
- A private ECR repository in the same region. Build and push the Docker image for `linux/amd64`, following [ECR's image push instructions](https://docs.aws.amazon.com/AmazonECR/latest/userguide/docker-push-ecr-image.html).

PowerShell example after pushing the image (replace the example values):

```powershell
aws cloudformation deploy --template-file aws.yaml --stack-name knightconnect-events --capabilities CAPABILITY_IAM --parameter-overrides ImageUri=123456789012.dkr.ecr.us-east-1.amazonaws.com/knightconnect-scraper:v1 VpcId=vpc-EXAMPLE TaskSubnets=subnet-PUBLIC1,subnet-PUBLIC2 DatabaseSubnets=subnet-PRIVATE1,subnet-PRIVATE2 ScheduleState=DISABLED
aws cloudformation describe-stacks --stack-name knightconnect-events --query 'Stacks[0].Outputs'
```

Deployment creates billable resources. The database keeps running between scrapes; the Fargate task runs only when invoked. Nothing is deployed by downloading this project.

Before enabling the schedule, run one manual ECS task. Create a local `network.json` using the **TaskSecurityGroupId output** and your public subnets:

```json
{
  "awsvpcConfiguration": {
    "subnets": ["subnet-PUBLIC1", "subnet-PUBLIC2"],
    "securityGroups": ["sg-TASK_SECURITY_GROUP_OUTPUT"],
    "assignPublicIp": "ENABLED"
  }
}
```

Then use the output ARNs:

```powershell
aws ecs run-task --cluster CLUSTER_ARN_OUTPUT --task-definition TASK_DEFINITION_ARN_OUTPUT --launch-type FARGATE --platform-version 1.4.0 --network-configuration file://network.json
```

Check the `failures` array in the response, the container's final exit code, and CloudWatch logs in the **LogGroup output**. Success ends with `database transaction committed` and exit code 0. When verified, repeat the deployment command with the same parameter values and `ScheduleState=ENABLED`; the default schedule runs every six hours. Change the `Schedule` parameter if desired. Scheduler invocation success only confirms task dispatch, so monitor ECS task completion/logs too; the template does not add email notifications or automatically retry a failed scrape.

The starter template uses RDS's generated master credential to create and write the tables. For an existing production database, provision a dedicated database user with access limited to these tables and use its credentials in your task definition instead. To query the private database from a computer, use your existing VPN or an SSM tunnel; it has no public endpoint access.

For local recurring runs, point Windows Task Scheduler or cron at the virtual environment's Python and this script, and set the working directory to this folder. Choose an interval longer than a full run and prevent overlapping local instances.

## Limits and maintenance

The public page and calendars are not a versioned integration contract. If labels, pagination, calendar URLs or robots rules change, the scraper fails rather than silently replacing the database with incomplete data. It does not establish a consistent server-side snapshot: an event added/removed during pagination can require a rerun. Browser loading and calendar HTTP downloads have explicit timeouts, and downloads retry transient failures. A record's details are the last successful observation, not a guarantee that the event is still occurring. No past-event backfill or change-history table is included.

Dependencies and browser versions are pinned for reproducibility. When updating Playwright, update both `requirements.txt` and `Dockerfile` to the same version and re-test. `metadata.create_all()` initializes tables, but does not migrate an existing schema; future schema changes need an explicit migration.

See `VERIFICATION.md` for the checks performed on this deliverable.
