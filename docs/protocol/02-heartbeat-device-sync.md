# Heartbeat And Device Sync

The heartbeat protocol lets a client report runtime state to the server and receive a redacted device snapshot back. It is also the main place where double-end protocol compatibility is surfaced to the UI.

`POST /api/devices/heartbeat` returns the server heartbeat response contract:

- top-level keys: `device`, `diagnostics`, `ok`;
- `ok` is `true`;
- `diagnostics.role` is `server`;
- `device` is the client heartbeat device summary and must never contain `vlessUri`.

The machine-readable mirror is `docs/protocol/schemas/heartbeat-device-sync.json`.

## 2xx Success Boundary

The client only treats HTTP 2xx as heartbeat success when the body is a JSON object matching the success contract. Malformed 2xx responses become local `heartbeat_failed` records and must not overwrite `lastSuccessfulHeartbeat`.

Required success properties include:

- top-level `diagnostics`;
- `diagnostics.role: "server"`;
- positive integer protocol versions for `claim`, `profile`, `adminState`, `clientStatus`, and `heartbeat`;
- `device.compatibility`;
- `device.sync`;
- `device.syncState === device.sync.state`;
- `device.speedMbps === device.sync.speedMbps`.

## Compatibility

`device.compatibility` has exact top-level keys:

`action`, `issues`, `localRole`, `ok`, `policy`, `remoteRole`, `severity`, `status`.

`policy` has exact keys:

`adminActions`, `heartbeat`, `profileIssue`, `reason`, `syncRun`.

Each `issues[]` item has exact keys:

`field`, `local`, `message`, `remote`, `type`.

The current policy keeps `policy.heartbeat` as `allow` even when diagnostics are missing or versions mismatch, so the server can continue observing device presence. `policy.syncRun` may be `warn`, and the client UI must use the current successful heartbeat or `lastSuccessfulHeartbeat` to require a compatibility confirmation before save/run operations.

## Device Sync

`device.sync` is the current device sync state used by the server console and client diagnostics. It must contain:

- `state`: one of `idle`, `syncing`, `error`, `stopping`, `offline`;
- `speedMbps`: finite number;
- `progressPercent`: nullable number;
- `currentFile`: string, redacted before diagnostics export;
- `conflicts`: conflict summary;
- `currentJob`: `null` or display-safe job object;
- `lastRun`: `null` or sync run contract;
- `scheduler`: `null` or scheduler contract.

`lastRun` uses the shared sync run contract and preserves `trigger`, which is either `manual` or `scheduler`.

## Scheduler

The scheduler summary has exact keys:

`enabled`, `intervalMs`, `jobs`, `lastError`, `lastTriggeredAt`, `nextRun`.

Each scheduler job has exact keys:

`id`, `lastError`, `lastTriggeredAt`, `name`, `nextRun`, `schedule`, `scheduleText`.

`schedule` must remain an object. Scheduler errors are empty strings or stable error codes.
