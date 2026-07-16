#!/bin/sh
set -eu

ROOT=${SFSC_ROOT:-/opt/sfsc-test}
IMAGE=${SFSC_APPLIANCE_IMAGE:-sfsc-appliance:local}
SYSTEMD_DIR=${SFSC_SYSTEMD_DIR:-/etc/systemd/system}

test -f "$ROOT/server/.env"
test -f "$ROOT/server/sing-box/config.json"
mkdir -p "$ROOT/server/data/app" "$ROOT/server/data/control" /ssd/sfsc-test/minio

docker build -f "$ROOT/server/appliance.Dockerfile" -t "$IMAGE" "$ROOT"

install -m 0644 "$ROOT/server/systemd/sfsc-minio.service" "$SYSTEMD_DIR/sfsc-minio.service"
install -m 0644 "$ROOT/server/systemd/sfsc-appliance.service" "$SYSTEMD_DIR/sfsc-appliance.service"

systemctl disable --now sfsc-appliance.service sfsc-minio.service 2>/dev/null || true
docker stop singbox-folder-sync-server singbox-folder-sync-tunnel singbox-folder-sync-minio 2>/dev/null || true
docker rm singbox-folder-sync-server singbox-folder-sync-tunnel singbox-folder-sync-minio 2>/dev/null || true

systemctl daemon-reload
systemctl enable --now sfsc-minio.service

attempt=0
until curl --fail --silent http://127.0.0.1:9000/minio/health/live >/dev/null; do
  attempt=$((attempt + 1))
  if [ "$attempt" -ge 30 ]; then
    systemctl status sfsc-minio.service --no-pager || true
    exit 1
  fi
  sleep 1
done

systemctl enable --now sfsc-appliance.service
attempt=0
until curl --fail --silent http://127.0.0.1:5177/healthz >/dev/null; do
  attempt=$((attempt + 1))
  if [ "$attempt" -ge 60 ]; then
    systemctl status sfsc-appliance.service --no-pager || true
    docker logs sfsc-appliance 2>&1 || true
    exit 1
  fi
  sleep 1
done

systemctl is-enabled sfsc-minio.service sfsc-appliance.service
systemctl is-active sfsc-minio.service sfsc-appliance.service
curl --fail --silent http://127.0.0.1:5177/healthz
echo
