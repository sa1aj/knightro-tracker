#!/usr/bin/env bash
# Run on the new application EC2 instance through SSM, after DNS is configured.
set -euo pipefail
umask 077
if [[ $EUID -ne 0 || $# -lt 8 || $# -gt 9 ]]; then
  echo 'Usage: sudo bash deploy/aws/install.sh REGION SECRET_ARN DATA_VOLUME_ID BUCKET LOG_GROUP BACKEND_DOMAIN FRONTEND_ORIGIN TLS_EMAIL [--initialize-volume]'
  exit 2
fi
TASK_REGION=$1
TASK_SECRET=$2
TASK_VOLUME=$3
TASK_BUCKET=$4
TASK_LOG_GROUP=$5
TASK_DOMAIN=$6
TASK_ORIGIN=$7
TASK_CONTACT=$8
TASK_INITIALIZE=${9:-}
[[ $TASK_REGION =~ ^[a-z0-9-]+$ && $TASK_VOLUME =~ ^vol-[a-f0-9]+$ && $TASK_BUCKET =~ ^[a-z0-9.-]+$ ]] || exit 2
[[ -z $TASK_INITIALIZE || $TASK_INITIALIZE == --initialize-volume ]] || exit 2
command -v aws >/dev/null
command -v docker >/dev/null
TASK_SOURCE=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)
TASK_DISK=''
while read -r TASK_PATH TASK_SERIAL; do
  if [[ ${TASK_SERIAL//-/} == ${TASK_VOLUME//-/} ]]; then TASK_DISK=$TASK_PATH; fi
done < <(lsblk -dn -o PATH,SERIAL)
if [[ -z $TASK_DISK || ! -b $TASK_DISK ]]; then
  echo 'The exact EBS volume was not found by serial. Confirm the stack attachment is complete.'
  exit 1
fi
[[ $(lsblk -nlo NAME "$TASK_DISK" | wc -l) -eq 1 ]] || { echo 'Refusing a disk with child partitions.'; exit 1; }
TASK_FS=$(blkid -o value -s TYPE "$TASK_DISK" || true)
if [[ -z $TASK_FS ]]; then
  [[ $TASK_INITIALIZE == --initialize-volume ]] || { echo 'New volume is unformatted. Re-run with --initialize-volume only for the new stack volume.'; exit 1; }
  [[ -z $(wipefs --no-act --noheadings "$TASK_DISK") ]] || { echo 'Existing disk signatures detected; refusing format.'; exit 1; }
  mkfs.ext4 "$TASK_DISK"
elif [[ $TASK_FS != ext4 ]]; then
  echo 'Expected an ext4 application volume. No formatting was performed.'
  exit 1
fi
TASK_UUID=$(blkid -o value -s UUID "$TASK_DISK")
mkdir -p /srv/knightro-data
if mountpoint -q /srv/knightro-data; then
  [[ $(findmnt -no UUID /srv/knightro-data) == "$TASK_UUID" ]] || { echo 'A different volume is mounted at the data path.'; exit 1; }
else
  [[ -z $(find /srv/knightro-data -mindepth 1 -maxdepth 1 -print -quit) ]] || { echo 'Data path is not empty; refusing to hide existing files.'; exit 1; }
  if ! grep -Fq "UUID=$TASK_UUID " /etc/fstab; then
    printf 'UUID=%s /srv/knightro-data ext4 defaults,nofail 0 2\n' "$TASK_UUID" >> /etc/fstab
  fi
  mount /srv/knightro-data
fi
mkdir -p /srv/knightro-data/{app,caddy-data,caddy-config,backups} /etc/knightro /opt/knightro-ops
chmod 700 /etc/knightro /srv/knightro-data/backups
chown 10001:10001 /srv/knightro-data/app
cp -a "$TASK_SOURCE/deploy/aws/." /opt/knightro-ops/
aws secretsmanager get-secret-value --region "$TASK_REGION" --secret-id "$TASK_SECRET" --output json |
  python3 /opt/knightro-ops/render_environment.py --directory /etc/knightro --origin "$TASK_ORIGIN" --domain "$TASK_DOMAIN" --contact "$TASK_CONTACT"
TASK_RELEASE=$(date -u +%Y%m%d%H%M%S)
TASK_IMAGE="knightro-app:$TASK_RELEASE"
docker build --tag "$TASK_IMAGE" "$TASK_SOURCE"
docker pull "${CADDY_IMAGE:-caddy:2-alpine}"
TASK_CADDY=$(docker image inspect "${CADDY_IMAGE:-caddy:2-alpine}" --format '{{index .RepoDigests 0}}')
docker run --rm --env-file /etc/knightro/proxy.env \
  --mount type=bind,src=/opt/knightro-ops/Caddyfile,dst=/etc/caddy/Caddyfile,readonly \
  "$TASK_CADDY" caddy validate --config /etc/caddy/Caddyfile
systemctl stop knightro-proxy.service knightro-app.service 2>/dev/null || true
if [[ -f /srv/knightro-data/app/knightro.db ]]; then
  TASK_BACKUP="/srv/knightro-data/backups/predeploy-$TASK_RELEASE.db"
  python3 /opt/knightro-ops/backup_database.py /srv/knightro-data/app/knightro.db "$TASK_BACKUP"
  aws s3 cp "$TASK_BACKUP" "s3://$TASK_BUCKET/backups/predeploy-$TASK_RELEASE.db" --region "$TASK_REGION" --only-show-errors
fi
if [[ ! -f /srv/knightro-data/app/events.json ]]; then
  cp "$TASK_SOURCE/frontend/data/events.json" /srv/knightro-data/app/events.json
  chown 10001:10001 /srv/knightro-data/app/events.json
  chmod 644 /srv/knightro-data/app/events.json
fi
{
  printf 'TASK_REGION=%q\nTASK_BUCKET=%q\nTASK_LOG_GROUP=%q\n' "$TASK_REGION" "$TASK_BUCKET" "$TASK_LOG_GROUP"
  printf 'TASK_IMAGE=%q\nTASK_CADDY=%q\nTASK_RELEASE=%q\n' "$TASK_IMAGE" "$TASK_CADDY" "$TASK_RELEASE"
} > /etc/knightro/runtime.conf
chmod 600 /etc/knightro/runtime.conf
cat > /etc/systemd/system/knightro-app.service <<'UNIT'
[Unit]
Description=Knightro application and background worker
After=docker.service network-online.target
Requires=docker.service
RequiresMountsFor=/srv/knightro-data
[Service]
ExecStartPre=-/usr/bin/docker rm -f knightro-app
ExecStart=/bin/bash /opt/knightro-ops/start-app.sh
ExecStop=/usr/bin/docker stop --time 30 knightro-app
Restart=always
RestartSec=10
TimeoutStopSec=40
[Install]
WantedBy=multi-user.target
UNIT
cat > /etc/systemd/system/knightro-proxy.service <<'UNIT'
[Unit]
Description=Knightro HTTPS gateway
After=docker.service knightro-app.service network-online.target
Requires=docker.service
RequiresMountsFor=/srv/knightro-data
[Service]
ExecStartPre=-/usr/bin/docker rm -f knightro-proxy
ExecStart=/bin/bash /opt/knightro-ops/start-proxy.sh
ExecStop=/usr/bin/docker stop --time 20 knightro-proxy
Restart=always
RestartSec=10
TimeoutStopSec=30
[Install]
WantedBy=multi-user.target
UNIT
for TASK_JOB in feed backup; do
  cat > "/etc/systemd/system/knightro-$TASK_JOB.service" <<UNIT
[Unit]
Description=Knightro $TASK_JOB
After=network-online.target
RequiresMountsFor=/srv/knightro-data
[Service]
Type=oneshot
ExecStart=/bin/bash /opt/knightro-ops/$TASK_JOB.sh
UNIT
done
cat > /etc/systemd/system/knightro-feed.timer <<'UNIT'
[Unit]
Description=Refresh the private scraper event snapshot
[Timer]
OnBootSec=60
OnUnitActiveSec=60
[Install]
WantedBy=timers.target
UNIT
cat > /etc/systemd/system/knightro-backup.timer <<'UNIT'
[Unit]
Description=Nightly online application backup
[Timer]
OnCalendar=*-*-* 04:00:00 UTC
RandomizedDelaySec=10m
Persistent=true
[Install]
WantedBy=timers.target
UNIT
systemctl daemon-reload
systemctl enable --now knightro-app.service knightro-proxy.service knightro-feed.timer knightro-backup.timer
echo 'Installed. Check /healthz, configure the two private Vercel variables, then run deploy/check_deployment.py.'
