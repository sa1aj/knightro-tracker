#!/usr/bin/env bash
set -euo pipefail
source /etc/knightro/runtime.conf
exec docker run --rm --name knightro-proxy --network host --env-file /etc/knightro/proxy.env \
  --mount type=bind,src=/opt/knightro-ops/Caddyfile,dst=/etc/caddy/Caddyfile,readonly \
  --mount type=bind,src=/srv/knightro-data/caddy-data,dst=/data \
  --mount type=bind,src=/srv/knightro-data/caddy-config,dst=/config \
  --log-driver awslogs --log-opt "awslogs-region=$TASK_REGION" \
  --log-opt "awslogs-group=$TASK_LOG_GROUP" --log-opt "awslogs-stream=proxy-$TASK_RELEASE" \
  "$TASK_CADDY"
