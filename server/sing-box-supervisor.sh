#!/bin/sh
set -eu

CONFIG_PATH="${SINGBOX_CONFIG_PATH:-/etc/sing-box/config.json}"
CONTROL_DIR="${SINGBOX_CONTROL_DIR:-/sfsc-control}"
LISTEN_PORT="${SINGBOX_LISTEN_PORT:-45678}"
PID_FILE="$CONTROL_DIR/singbox.pid"
SINGBOX_PID=""

mkdir -p "$CONTROL_DIR"

start_singbox() {
  sing-box check -c "$CONFIG_PATH"
  sing-box run -c "$CONFIG_PATH" &
  SINGBOX_PID="$!"
  printf '%s\n' "$SINGBOX_PID" > "$PID_FILE"
}

stop_singbox() {
  if [ -n "$SINGBOX_PID" ] && kill -0 "$SINGBOX_PID" 2>/dev/null; then
    kill -TERM "$SINGBOX_PID"
    attempts=0
    while kill -0 "$SINGBOX_PID" 2>/dev/null && [ "$attempts" -lt 50 ]; do
      attempts=$((attempts + 1))
      sleep 0.1
    done
    if kill -0 "$SINGBOX_PID" 2>/dev/null; then
      kill -KILL "$SINGBOX_PID" 2>/dev/null || true
    fi
    wait "$SINGBOX_PID" 2>/dev/null || true
  fi
}

wait_ready() {
  listen_port_hex="$(printf '%04X' "$LISTEN_PORT")"
  attempts=0
  while [ "$attempts" -lt 50 ]; do
    if ! kill -0 "$SINGBOX_PID" 2>/dev/null; then
      return 1
    fi
    if awk -v port=":$listen_port_hex" '
      $2 ~ port "$" && $4 == "0A" { found = 1 }
      END { exit !found }
    ' /proc/net/tcp /proc/net/tcp6 2>/dev/null; then
      return 0
    fi
    attempts=$((attempts + 1))
    sleep 0.1
  done
  return 1
}

write_result() {
  request_id="$1"
  ok="$2"
  error_code="$3"
  message="$4"
  config_sha256="$5"
  result_path="$CONTROL_DIR/restart-result-$request_id.json"
  result_tmp="$result_path.tmp"
  printf '{"requestId":"%s","ok":%s,"errorCode":"%s","message":"%s","restartedAt":"%s","configSha256":"%s"}\n' \
    "$request_id" "$ok" "$error_code" "$message" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$config_sha256" > "$result_tmp"
  mv "$result_tmp" "$result_path"
}

restart_singbox() {
  request_id="$1"
  expected_config_sha256="$2"
  config_sha256="$(sha256sum "$CONFIG_PATH")"
  config_sha256="${config_sha256%% *}"
  if [ "$config_sha256" != "$expected_config_sha256" ]; then
    write_result "$request_id" false "singbox_config_mismatch" "sing-box config does not match the requested version" "$config_sha256"
    return
  fi
  if ! sing-box check -c "$CONFIG_PATH"; then
    write_result "$request_id" false "singbox_config_invalid" "sing-box config check failed" "$config_sha256"
    return
  fi
  stop_singbox
  if start_singbox && wait_ready; then
    write_result "$request_id" true "" "sing-box restarted and ready" "$config_sha256"
  else
    write_result "$request_id" false "singbox_restart_failed" "sing-box process did not become ready" "$config_sha256"
  fi
}

cleanup() {
  stop_singbox
  rm -f "$PID_FILE"
}
trap 'cleanup; exit 0' INT TERM
trap cleanup EXIT

start_singbox
while true; do
  for request_path in "$CONTROL_DIR"/restart-request-*.json; do
    [ -f "$request_path" ] || continue
    request_name="${request_path##*/}"
    request_value="${request_name#restart-request-}"
    request_value="${request_value%.json}"
    request_id="${request_value%%-*}"
    expected_config_sha256="${request_value#*-}"
    case "$request_id" in
      *[!a-f0-9]*|'') rm -f "$request_path"; continue ;;
    esac
    case "$expected_config_sha256" in
      *[!a-f0-9]*|'') rm -f "$request_path"; continue ;;
    esac
    if [ "${#request_id}" -ne 24 ] || [ "${#expected_config_sha256}" -ne 64 ]; then
      rm -f "$request_path"
      continue
    fi
    processing_path="$CONTROL_DIR/restart-processing-$request_id.json"
    if mv "$request_path" "$processing_path" 2>/dev/null; then
      restart_singbox "$request_id" "$expected_config_sha256"
      rm -f "$processing_path"
    fi
  done

  if ! kill -0 "$SINGBOX_PID" 2>/dev/null; then
    wait "$SINGBOX_PID" || true
    sleep 1
    start_singbox
  fi
  sleep 0.2
done
