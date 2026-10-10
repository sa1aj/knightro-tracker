# Legacy AWS deployment

> **Legacy reference:** The live website now uses Vercel and Supabase. Follow [the current production setup](../supabase/README.md) for accounts, photos, database migrations, and manual event imports. These AWS/email-code instructions do not configure the current backend.

The stack, installer, secrets schema, Vercel configuration, scraper integration, and recovery instructions are in [deploy/README.md](../deploy/README.md). Local validation results are in [deploy/VALIDATION.md](../deploy/VALIDATION.md).

Deploy one persistent application host for the current SQLite backend. Keep the existing scraper and its database, then publish a private S3 snapshot after full successful scrapes. Vercel forwards same-origin API requests through an authenticated HTTPS gateway; accounts, photos, rewards, admin tools, bounties, and push jobs use the application backend.

No AWS resources have been provisioned by this work. The operator still needs network and DNS configuration, SES credentials and sender verification, private Vercel settings, and live acceptance checks. Before multiple application replicas or serverless hosting, migrate application transactions and leases to shared storage and photos to object storage.
