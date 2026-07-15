# Diagnostic Bundle

`GET /api/diagnostics/export` returns public support material. It is intentionally stricter and more redacted than `GET /api/client/status`.

Top-level response keys are `ok`, `filename`, and `bundle`. `bundle.schemaVersion` is `1`.

The machine-readable mirror is `docs/protocol/schemas/diagnostic-bundle.json`.

## Bundle Shape

The diagnostic bundle has exact top-level keys:

`app`, `environment`, `generatedAt`, `logs`, `role`, `schemaVersion`, `status`, `summary`.

`bundle.status` has exact keys:

`appVersion`, `binaries`, `diagnostics`, `heartbeat`, `jobs`, `lastSuccessfulHeartbeat`, `lastSync`, `profileImported`, `profileSummary`, `safeguards`.

`bundle.logs` has exact keys:

`electron`, `rclone`, `singbox`.

Each log meta object has exact keys:

`exists`, `maxChars`, `modifiedAt`, `path`, `size`, `text`, `truncated`.

## Heartbeat Snapshot

`bundle.status.heartbeat` and `bundle.status.lastSuccessfulHeartbeat` are `null` or diagnostic heartbeat snapshots with exact keys:

`compatibility`, `device`, `errorCode`, `ok`, `remoteErrorCode`, `sentAt`, `server`, `serverDiagnostics`, `status`.

Diagnostic heartbeat device snapshots have exact keys:

`bucket`, `enabled`, `online`, `prefix`, `status`, `sync`.

Diagnostic device sync snapshots have exact keys:

`currentFile`, `lastRun`, `scheduler`, `speedMbps`, `state`, `syncState`.

The diagnostic scheduler snapshot has exact keys:

`enabled`, `intervalMs`, `jobs`, `lastError`, `lastTriggeredAt`, `nextRun`.

Each diagnostic scheduler job has exact keys:

`id`, `lastError`, `lastTriggeredAt`, `name`, `nextRun`, `schedule`, `scheduleText`.

## Fallback Rules

`summary.heartbeatOk`, `summary.heartbeatErrorCode`, and `summary.heartbeatRemoteErrorCode` come from the current heartbeat attempt.

Device status, server protocol versions, compatibility status, compatibility severity, and sync-run compatibility policy use the current successful heartbeat if available; otherwise they fall back to `lastSuccessfulHeartbeat`. This keeps support context visible when the latest heartbeat fails because of network or server availability.

## Redaction Boundary

The bundle is safe to send to support. It must recursively remove or redact:

- SyncKey and `sfsc://import/v1#` values;
- VLESS URI values;
- admin token values;
- storage secrets;
- heartbeat secrets;
- secret vault refs and keys;
- raw local file paths, usernames, current file names, conflict file names, and recent sync file names.

Local UI state may keep operational paths for the user, but diagnostic export must downgrade those values to basenames, booleans, counts, sizes, timestamps, error codes, or `redacted`.
