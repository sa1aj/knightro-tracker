#!/usr/bin/env bash
set -euo pipefail
source /etc/knightro/runtime.conf
exec docker run --rm --name knightro-app --stop-timeout 30 --read-only \
  --tmpfs /tmp:rw,nosuid,noexec,size=64m --env-file /etc/knightro/app.env \
  --publish 127.0.0.1:8000:8000 --mount type=bind,src=/srv/knightro-data/app,dst=/data \
  --log-driver awslogs --log-opt "awslogs-region=$TASK_REGION" \
  --log-opt "awslogs-group=$TASK_LOG_GROUP" --log-opt "awslogs-stream=application-$TASK_RELEASE" \
  "$TASK_IMAGE"
