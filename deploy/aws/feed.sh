#!/usr/bin/env bash
set -euo pipefail
source /etc/knightro/runtime.conf
TASK_TEMP=$(mktemp /srv/knightro-data/app/events.XXXXXX)
trap 'rm -f -- "$TASK_TEMP"' EXIT
aws s3 cp "s3://$TASK_BUCKET/events/events.json" "$TASK_TEMP" --region "$TASK_REGION" --only-show-errors
python3 - "$TASK_TEMP" <<'PY'
import json, sys
from pathlib import Path
data = json.loads(Path(sys.argv[1]).read_text(encoding='utf-8'))
if not isinstance(data, dict) or not isinstance(data.get('events'), list) or not isinstance(data.get('generatedAt'), (int, float)):
    raise SystemExit('Invalid scraper feed; preserving the previous snapshot.')
PY
chown 10001:10001 "$TASK_TEMP"
chmod 644 "$TASK_TEMP"
mv -f -- "$TASK_TEMP" /srv/knightro-data/app/events.json
