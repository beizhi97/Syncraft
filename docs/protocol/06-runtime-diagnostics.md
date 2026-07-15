# Runtime Diagnostics

Runtime diagnostics are the shared version handshake used by server health, admin state, client status, heartbeat, smoke checks, and both UIs.

`src/core/diagnostics.js` is the implementation source. The machine-readable mirror is `docs/protocol/schemas/runtime-diagnostics.json`.

## Diagnostics Shape

The runtime diagnostics object has these fields:

`app`, `buildId`, `buildTime`, `protocols`, `role`, `version`.

`app` is `singbox-folder-sync`. `role` identifies `server` or `client`. `version` is the product version. `buildId` may be empty and `buildTime` may be null when build metadata is unavailable.

The diagnostics object and its `protocols` object use exact current keys. Protocol values must be JSON numbers that are positive integers; strings and booleans are invalid. A wrong app id, wrong role, missing envelope field, extra envelope field, or malformed protocol value makes the entire diagnostics snapshot unavailable for compatibility decisions.

`protocols` contains positive integer versions for:

`claim`, `profile`, `adminState`, `clientStatus`, `heartbeat`.

These protocol versions, not the product version string alone, decide double-end compatibility.

## Compatibility Result

The compatibility result has exact keys:

`action`, `issues`, `localRole`, `ok`, `policy`, `remoteRole`, `severity`, `status`.

The result is `compatible` only when every required protocol version exists and matches. Otherwise status is `mismatch`, severity is `warning`, and each issue identifies a protocol field with one of:

`local_missing`, `remote_missing`, `remote_older`, `remote_newer`.

Action selection is deterministic:

- no issues: `none`;
- any missing local or remote protocol: `diagnostics_missing`;
- only `remote_older`: `upgrade_remote`;
- only `remote_newer`: `upgrade_local`;
- mixed older and newer directions: `manual_check`.

Partial legacy diagnostics are not treated as compatible. Missing `adminState`, `clientStatus`, or `heartbeat` versions each produce a `remote_missing` issue.

Compatibility is derived data. A received object is invalid when its issue directions, version/null relationships, action, status, severity, or policy differ from the result recomputed from local and remote diagnostics. A shaped but forged `action: "none"` or `syncRun: "allow"` must never bypass confirmation.

## Policy

Compatibility policy has exact keys:

`adminActions`, `heartbeat`, `profileIssue`, `reason`, `syncRun`.

Current policy always allows heartbeat and admin actions so support and recovery remain possible. A mismatch changes `profileIssue` and `syncRun` to `warn`; compatible runtimes use `allow`. `reason` must equal the compatibility `action`.

When `syncRun` is `warn`, the client-local save/run APIs require explicit compatibility confirmation. Preview and heartbeat remain available.

## Freshness And Migration

Each device heartbeat replaces the stored client diagnostics snapshot. If a heartbeat omits diagnostics, the server clears stale diagnostics and derives `diagnostics_missing`; it must not reuse an older compatible result.

Legacy admin-state users may retain diagnostics only when the stored object satisfies the complete current client diagnostics contract. Incomplete diagnostics are normalized to null so operators see an explicit compatibility warning.

`ADMIN_STATE_VERSION` and `PROFILE_VERSION` are the single implementation sources for persisted admin state and every issued or legacy profile producer. A newer unsupported admin-state version is rejected instead of silently downgraded.
