#!/bin/sh
set -eu

ROOT=${SFSC_ROOT:-/opt/sfsc-test}
SYSTEMD_DIR=${SFSC_SYSTEMD_DIR:-/etc/systemd/system}
CONFIG_DIR=${SFSC_CONFIG_DIR:-/etc/syncraft}
IMAGE=sfsc-appliance:directory-local
DIRECTORY_ROOT=
REPLACE_ACTIVE=0
REPLACE_ROOT=0

usage() {
  cat >&2 <<'EOF'
Usage: install-n1-directory-appliance.sh [--replace-active-appliance] [--replace-directory-root] EXISTING_HOST_DIRECTORY

The existing host directory is mounted read/write inside the appliance. It is
never created by this installer. MinIO is left running and unchanged.
EOF
  exit 2
}

for argument in "$@"; do
  case "$argument" in
    --replace-active-appliance) REPLACE_ACTIVE=1 ;;
    --replace-directory-root) REPLACE_ROOT=1 ;;
    --*) usage ;;
    *)
      [ -z "$DIRECTORY_ROOT" ] || usage
      DIRECTORY_ROOT=$argument
      ;;
  esac
done
[ -n "$DIRECTORY_ROOT" ] || usage

ROOT=$(python3 - "$ROOT" <<'PY'
import os
import sys

path = os.path.realpath(sys.argv[1], strict=True)
if not os.path.isdir(path) or any(ord(char) < 32 or char in ',%"\\' for char in path):
    raise SystemExit("server root must be an existing directory with a systemd/docker-safe path")
print(path)
PY
)

test -f "$ROOT/server/.env.directory"
test -d "$ROOT/server/sing-box"
test -x "$ROOT/server/runtime/sfsc-runtime-launcher"
python3 - "$ROOT/server/.env.directory" <<'PY'
import sys

values = {}
for line in open(sys.argv[1], encoding="utf-8"):
    line = line.strip()
    if not line or line.startswith("#") or "=" not in line:
        continue
    key, value = line.split("=", 1)
    values[key.strip()] = value.strip().strip('"').strip("'")
token = values.get("SFSC_ADMIN_TOKEN", "")
if values.get("SFSC_REQUIRE_ADMIN_TOKEN") != "1" or not token or token == "change-this-admin-token":
    raise SystemExit(".env.directory must require admin auth and replace the placeholder token")
PY

DIRECTORY_ROOT=$(python3 - "$DIRECTORY_ROOT" <<'PY'
import os
import sys

path = os.path.realpath(sys.argv[1], strict=True)
if not os.path.isdir(path) or path == "/":
    raise SystemExit("host directory must be an existing directory other than /")
if any(ord(char) < 32 or char in ',%"\\' for char in path):
    raise SystemExit("host directory path contains a character unsafe for systemd/docker mount arguments")
print(path)
PY
)

directory_config="$CONFIG_DIR/sfsc-directory.env"
new_config="$(mktemp)"
rollback_dir="$(mktemp -d)"
rollback_armed=0
directory_enable_attempted=0
trap 'installer_exit=$?; if [ "$installer_exit" -ne 0 ] && [ "$rollback_armed" -eq 1 ]; then rollback_install; fi; rm -f "$new_config"; rm -rf "$rollback_dir"; exit "$installer_exit"' EXIT
trap 'exit 1' HUP INT TERM
printf 'SFSC_ROOT="%s"\nSFSC_DIRECTORY_HOST_ROOT="%s"\n' "$ROOT" "$DIRECTORY_ROOT" > "$new_config"
chmod 0600 "$new_config"

if [ -f "$directory_config" ]; then
  if cmp -s "$new_config" "$directory_config"; then
    :
  elif [ "$REPLACE_ROOT" -eq 1 ]; then
    :
  else
    echo "Existing $directory_config selects a different server directory; inspect it or pass --replace-directory-root." >&2
    exit 1
  fi
elif [ -e "$directory_config" ]; then
  echo "$directory_config exists and is not a regular file." >&2
  exit 1
fi

unit_destination="$SYSTEMD_DIR/sfsc-appliance-directory.service"
old_unit_destination="$SYSTEMD_DIR/sfsc-appliance.service"
snapshot_file() {
  source_path=$1
  snapshot_path=$2
  if [ -f "$source_path" ]; then
    cp -p "$source_path" "$snapshot_path"
    : > "$snapshot_path.exists"
  elif [ -e "$source_path" ]; then
    echo "$source_path is not a regular file." >&2
    exit 1
  fi
}
snapshot_file "$directory_config" "$rollback_dir/directory.env.before"
snapshot_file "$unit_destination" "$rollback_dir/directory.unit.before"
snapshot_file "$old_unit_destination" "$rollback_dir/old.unit.before"
cp "$new_config" "$rollback_dir/directory.env.expected"
cp "$ROOT/server/systemd/sfsc-appliance-directory.service" "$rollback_dir/directory.unit.expected"

restore_owned_file() {
  destination=$1
  before=$2
  expected=$3
  label=$4
  if [ -f "$destination" ] && cmp -s "$destination" "$expected"; then
    if [ -f "$before.exists" ]; then
      install -m "$(stat -c '%a' "$before")" "$before" "$destination.restore"
      mv -f "$destination.restore" "$destination"
    else
      rm -f "$destination"
    fi
  elif [ -f "$before.exists" ] && [ -f "$destination" ] && cmp -s "$destination" "$before"; then
    : # The installer had not changed this file.
  elif [ ! -f "$before.exists" ] && [ ! -e "$destination" ]; then
    : # The target remains absent as it was before this invocation.
  else
    echo "Rollback did not overwrite $label because its bytes changed after this installer wrote it." >&2
    return 1
  fi
}

restore_unit_state() {
  unit=$1
  was_enabled=$2
  was_active=$3
  if [ "$was_enabled" -eq 1 ]; then systemctl enable "$unit" || return 1; else systemctl disable "$unit" || return 1; fi
  if [ "$was_active" -eq 1 ]; then systemctl start "$unit" || return 1; else systemctl stop "$unit" || return 1; fi
}

rollback_install() {
  set +e
  rollback_failed=0
  directory_unit_restored=1
  if [ "$directory_enable_attempted" -eq 1 ]; then
    systemctl disable --now sfsc-appliance-directory.service || rollback_failed=1
  fi
  restore_owned_file "$unit_destination" "$rollback_dir/directory.unit.before" "$rollback_dir/directory.unit.expected" "directory unit" || { rollback_failed=1; directory_unit_restored=0; }
  restore_owned_file "$directory_config" "$rollback_dir/directory.env.before" "$rollback_dir/directory.env.expected" "directory environment" || rollback_failed=1
  systemctl daemon-reload || rollback_failed=1
  if [ -f "$old_unit_destination" ] && [ -f "$rollback_dir/old.unit.before.exists" ] \
    && cmp -s "$old_unit_destination" "$rollback_dir/old.unit.before"; then
    restore_unit_state sfsc-appliance.service "$old_enabled" "$old_active" || rollback_failed=1
  elif [ "$old_enabled" -eq 1 ] || [ "$old_active" -eq 1 ]; then
    echo "Rollback could not restore sfsc-appliance.service state because its unit bytes changed or its captured unit file is unavailable." >&2
    rollback_failed=1
  fi
  if [ "$directory_unit_restored" -eq 1 ] && [ -f "$unit_destination" ] \
    && { [ -f "$rollback_dir/directory.unit.before.exists" ] || [ "$REPLACE_ACTIVE" -eq 1 ]; }; then
    restore_unit_state sfsc-appliance-directory.service "$directory_enabled" "$directory_active" || rollback_failed=1
  elif [ "$directory_enabled" -eq 1 ] || [ "$directory_active" -eq 1 ]; then
    echo "Rollback could not restore sfsc-appliance-directory.service state because its unit bytes changed or its captured unit file is unavailable." >&2
    rollback_failed=1
  fi
  if [ "$rollback_failed" -ne 0 ]; then
    echo "Installer rollback was incomplete; inspect both appliance unit states and the recorded unit/environment files before retrying." >&2
  else
    echo "Installer failed; prior appliance unit state and owned unit/environment files were restored." >&2
  fi
  set -e
}

if [ -f "$unit_destination" ] && ! cmp -s "$ROOT/server/systemd/sfsc-appliance-directory.service" "$unit_destination" && [ "$REPLACE_ACTIVE" -ne 1 ]; then
  echo "Existing $unit_destination differs from the shipped unit; inspect it or pass --replace-active-appliance." >&2
  exit 1
elif [ -e "$unit_destination" ] && [ ! -f "$unit_destination" ]; then
  echo "$unit_destination exists and is not a regular file." >&2
  exit 1
fi

old_enabled=0
old_active=0
directory_enabled=0
directory_active=0
systemctl is-enabled --quiet sfsc-appliance.service && old_enabled=1 || true
systemctl is-active --quiet sfsc-appliance.service && old_active=1 || true
systemctl is-enabled --quiet sfsc-appliance-directory.service && directory_enabled=1 || true
systemctl is-active --quiet sfsc-appliance-directory.service && directory_active=1 || true
if { [ "$old_enabled" -eq 1 ] || [ "$old_active" -eq 1 ] || [ "$directory_enabled" -eq 1 ] || [ "$directory_active" -eq 1 ]; } && [ "$REPLACE_ACTIVE" -ne 1 ]; then
  echo "An appliance unit is already enabled or active. Review it, then pass --replace-active-appliance to switch explicitly." >&2
  exit 1
fi

if [ -n "${SFSC_DIRECTORY_CHECK_ONLY:-}" ]; then
  [ "$SFSC_DIRECTORY_CHECK_ONLY" = "1" ] || { echo "SFSC_DIRECTORY_CHECK_ONLY must be 1 when set." >&2; exit 2; }
  echo "Directory deployment inputs validated; no image, unit, service, or directory changes were made."
  exit 0
fi

# Use a distinct image tag so preparing directory mode never retags the image
# used by an existing S3/MinIO appliance.
docker build -f "$ROOT/server/appliance.Dockerfile" -t "$IMAGE" "$ROOT"

rollback_armed=1
if [ "$REPLACE_ACTIVE" -eq 1 ]; then
  if [ "$old_active" -eq 1 ] || [ "$old_enabled" -eq 1 ]; then
    systemctl disable --now sfsc-appliance.service
  fi
  if [ "$directory_active" -eq 1 ] || [ "$directory_enabled" -eq 1 ]; then
    systemctl disable --now sfsc-appliance-directory.service
  fi
fi

mkdir -p "$ROOT/server/data/app" "$ROOT/server/data/control"
install -d -m 0700 "$CONFIG_DIR"
install -d -m 0755 "$SYSTEMD_DIR"
tmp_unit="$SYSTEMD_DIR/sfsc-appliance-directory.service.new"
install -m 0644 "$ROOT/server/systemd/sfsc-appliance-directory.service" "$tmp_unit"
mv -f "$tmp_unit" "$SYSTEMD_DIR/sfsc-appliance-directory.service"
if [ ! -f "$directory_config" ] || [ "$REPLACE_ROOT" -eq 1 ]; then
  install -m 0600 "$new_config" "$directory_config.new"
  mv -f "$directory_config.new" "$directory_config"
fi

systemctl daemon-reload
directory_enable_attempted=1
systemctl enable --now sfsc-appliance-directory.service

attempt=0
  attempt_limit=${SFSC_DIRECTORY_STARTUP_ATTEMPTS:-60}
  case "$attempt_limit" in *[!0-9]*|'') echo "SFSC_DIRECTORY_STARTUP_ATTEMPTS must be a positive integer." >&2; exit 2 ;; esac
  [ "$attempt_limit" -gt 0 ] || { echo "SFSC_DIRECTORY_STARTUP_ATTEMPTS must be a positive integer." >&2; exit 2; }
while :; do
  api_status=$(curl --silent --show-error --max-time 2 http://127.0.0.1:5177/api/health 2>/dev/null || true)
  root_status=$(curl --silent --show-error --max-time 2 http://127.0.0.1:5177/healthz 2>/dev/null || true)
  if python3 - "$api_status" "$root_status" <<'PY'
import json
import sys

try:
    api = json.loads(sys.argv[1])
    probe = json.loads(sys.argv[2])
    checks = probe["checks"]
    if not (
        api.get("ok") is True
        and api.get("adminAuth", {}).get("enabled") is True
        and checks.get("node", {}).get("ok") is True
        and checks.get("storage", {}).get("mode") == "directory"
        and checks.get("storage", {}).get("dataWritable") is True
        and checks.get("storage", {}).get("directoryRootWritable") is True
    ):
        raise ValueError("startup evidence is incomplete")
    print(json.dumps({
        "apiReachable": True,
        "adminAuthEnabled": True,
        "appStateWritable": True,
        "directoryRootWritable": True,
        "fullHealthzOk": probe.get("ok") is True
    }, sort_keys=True))
except (ValueError, KeyError, TypeError, json.JSONDecodeError):
    raise SystemExit(1)
PY
  then
    break
  fi
  attempt=$((attempt + 1))
  if [ "$attempt" -ge "$attempt_limit" ]; then
    systemctl status sfsc-appliance-directory.service --no-pager || true
    echo "Directory appliance API or selected directory mount did not become available. MinIO was not stopped." >&2
    exit 1
  fi
  sleep 1
done

systemctl is-enabled sfsc-appliance-directory.service
systemctl is-active sfsc-appliance-directory.service
echo "Management API and selected read/write directory mount are available. First-use connection and device authorization may still be pending."
if [ "$(python3 -c 'import json,sys; print(str(json.loads(sys.argv[1]).get("ok") is True).lower())' "$root_status")" != "true" ]; then
  echo "Full appliance health is not yet ready; complete first-use connection setup and validate a real client data path."
fi
if systemctl is-active --quiet sfsc-minio.service; then
  echo "MinIO remains active and unchanged; directory mode does not depend on it."
fi
rollback_armed=0
