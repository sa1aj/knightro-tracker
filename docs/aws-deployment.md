# AWS handoff

The local implementation is prepared for a single persistent backend. No AWS resources were created and the old anonymous API is untouched. The repository's scraper/aws.yaml deploys the scraper, not this application's account/photo/bounty backend.

## Initial deployment shape

Use one EC2 application instance with durable EBS storage for /data and a hardened HTTPS reverse proxy or ALB in front. The Dockerfile runs as a non-root user, accepts a private bind address, and mounts /data for SQLite and the exported event feed. Keep port 8000 restricted to the proxy. Back up the SQLite database with its online backup API; do not copy only the main file while WAL writes are active. Test restore and schema migration before release.

Set PUBLIC_ORIGIN=https://your-domain. Preserve the public Host when forwarding requests; serve /frontend and /api from that same domain. /healthz accepts load-balancer probe hosts and tests database access. Add edge limits for requests, email verification, uploads (3 MB request maximum), and per-client IP abuse; forwarded headers are deliberately not trusted by the app. Use graceful process shutdown/service supervision and central logs. The standard-library application server must not be exposed directly to the Internet.

Build from the repository root:

```sh
docker build -t knightro-tracker .
docker run --rm -p 127.0.0.1:8000:8000 --mount type=bind,src=/srv/knightro-data,dst=/data --env-file /secure/knightro.env knightro-tracker
```

The mounted directory must be writable by UID 10001. For a private container network, adjust port publishing rather than opening the instance to the Internet. Development mail is intentionally unavailable with a public origin or non-loopback bind.

## SES SMTP verification email

Verify a sender/domain in the chosen SES region, configure DKIM, and create regional SES SMTP credentials. Set SMTP_HOST to that region's SMTP endpoint, SMTP_FROM to the verified sender, SMTP_PORT=587 and SMTP_SECURITY=starttls (or ssl/465), and SMTP_USER/SMTP_PASSWORD to SES SMTP credentials. These differ from ordinary AWS access keys. Inject credentials from Secrets Manager or your deployment secret store; never put them in Git or the frontend.

SES sandbox accounts can only deliver to verified recipients; request production access before sending codes to arbitrary UCF addresses. Verify one real UCF delivery and resend/error behavior after configuration. Local tests use mocked SMTP and do not establish real deliverability.

References: [SES SMTP requirements](https://docs.aws.amazon.com/ses/latest/dg/send-email-smtp.html), [regional SMTP credentials](https://docs.aws.amazon.com/ses/latest/dg/smtp-credentials.html), [production access](https://docs.aws.amazon.com/ses/latest/dg/request-production-access.html).

## Push and worker

Generate one P-256 VAPID key pair, set VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, and VAPID_SUBJECT, and retain the same keys across restarts. The private key belongs in the secret store. See [pywebpush configuration](https://github.com/web-push-libs/pywebpush). Test browser opt-in and an actual device delivery on the HTTPS domain. Local checks validate the queue/retry behavior using a mock delivery function; real Web Push requires configured keys and a subscribed browser.

The current process runs one background loop every 15 seconds. Bounties, alert deduplication, and push leases persist in SQLite, so restarts do not recreate a slot or discard queued work. Delivery can repeat after a worker crashes following a network send; alert tags collapse matching notifications. Reports publish and award points immediately after JPEG, verified-session, and two-minute capture-token validation. Optional operator review via backend/moderate.py can remove abusive reports and their points. Daily bounty boundaries and rotation use America/New_York campus midnights, including daylight-saving changes.

## Scaling or Lambda/Fargate later

Do not put SQLite on ephemeral Lambda/Fargate storage or run several replicas over independent database files. Before scaling, move users/sessions/capture tokens/score transactions and job leases to RDS PostgreSQL or DynamoDB conditional writes, move sanitized photos to private S3, and put push work in SQS with a worker. EventBridge can schedule bounty/event evaluations; unique slot/source constraints and idempotent moderation must survive that migration. Preserve submission-time bounty eligibility, atomic cooldowns, and ownership checks for removed photos.

An AWS-native storage adapter, infrastructure stack, live sender verification, and device push validation remain deployment work. The Dockerfile and environment contract make the current single-instance boundary explicit.
