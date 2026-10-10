#!/usr/bin/env bash
set -euo pipefail
umask 077
source /etc/knightro/runtime.conf
TASK_STAMP=$(date -u +%Y%m%dT%H%M%SZ)
TASK_TEMP=$(mktemp -d /srv/knightro-data/backups/job.XXXXXX)
trap 'rm -f -- "$TASK_TEMP/knightro.db" "$TASK_TEMP/knightro.db.gz"; rmdir -- "$TASK_TEMP"' EXIT
python3 /opt/knightro-ops/backup_database.py /srv/knightro-data/app/knightro.db "$TASK_TEMP/knightro.db"
gzip "$TASK_TEMP/knightro.db"
aws s3 cp "$TASK_TEMP/knightro.db.gz" "s3://$TASK_BUCKET/backups/$TASK_STAMP.db.gz" --region "$TASK_REGION" --only-show-errors
