# Client Design

## Goal

The client is a Windows `.exe` app that imports a VLESS long link, configures folder sync jobs, and runs only the sync job through the tunnel. It must ship with bundled `sing-box.exe` and `rclone.exe`, and must not change system proxy, routing, DNS, firewall, or TUN settings.

## Engine Selection

Runtime engines:

- Tunnel kernel: `sing-box`
- Sync engine: `rclone`
- Storage protocol: S3-compatible MinIO

This keeps the first version practical. `sing-box` handles VLESS/REALITY, while `rclone` handles folder walking, retries, multipart upload, multi-thread downloads, progress, and S3 compatibility.

Rejected product directions:

- custom sync protocol: too much risk before proving the product shape
- system TUN mode: unnecessary and invasive
- system proxy: would pollute the whole PC
- sing-box mux: can collapse multiple logical streams onto one outer connection, which fights the user's single-flow throttling problem

## Runtime Flow

```text
client UI
  -> parse vless:// long URI
  -> generate sing-box client config
  -> start local mixed proxy on 127.0.0.1:18081
  -> run rclone with process-scoped proxy env
  -> show progress, logs, schedule, and speed
```

The rclone process receives:

```powershell
$env:HTTP_PROXY="socks5://127.0.0.1:18081"
$env:HTTPS_PROXY="socks5://127.0.0.1:18081"
$env:ALL_PROXY="socks5://127.0.0.1:18081"
```

No other process is affected.

## Job Interface

A saved sync job contains:

- local folder
- direction: upload or download
- server space and relative remote folder choice
- derived bucket and prefix target
- schedule: manual, interval, daily, or startup
- safety: dry-run, delete protection, destructive sync opt-in
- performance: transfers, checkers, streams, chunk size, retries, bandwidth limit

The UI accepts an optional relative remote subdirectory and server space (`device` or `shared`), then derives the S3 bucket/prefix target from the imported profile. An empty subdirectory in device space uses the device-specific prefix delivered by the SyncKey. Shared space requires an explicit subdirectory so multiple devices cannot write to the shared root. Users never hand-write raw S3 remote paths, access keys, endpoints, or execution prefixes.

Bandwidth limit is stored as rclone-compatible `bandwidthLimit`: `off`, `500k`, `10M`, `1G`, or a product-generated two-entry timetable such as `08:00,10M 18:00,off`. The UI presents this as an enable switch, a fixed/scheduled mode selector, a positive integer input, a KB/s, MB/s, or GB/s unit selector, and time inputs for scheduled mode; free-form bwlimit strings are not part of the product UI.

Schedule is stored as `schedule.mode`. The client UI exposes manual, interval with a configurable minute value, daily with a time picker, and startup as a one-shot trigger after the local runtime starts. The local runtime schedules saved interval, daily, and startup jobs automatically and exposes the next trigger in `GET /api/client/status.scheduler`; startup jobs use the shared `on-startup` next-run marker until they fire.

The client stores recent sync runs in `data/sync-history.json`, capped at 20 records. Each run records start/end time, status, job summary, key transfer metrics, stable error code, conflict summary, and exit information. `GET /api/client/status`, `GET /api/sync/history`, and the server heartbeat all expose the latest run so both the client and server console can show the most recent result without reading raw logs. Local history can keep client-only fields, but `sync.lastRun` sent in heartbeats is normalized through the shared `src/core/syncRun.js` contract before upload. A non-zero rclone sync exit records `errorCode: "rclone_sync_failed"`; a user stop records `status: "stopped"` and is not treated as that failure. The settings drawer renders the recent 20 runs as a compact history list with status, time, direction, transfer metrics, conflict count/sample files, exit code, and error/detail text, plus a summary row with total runs, success/error/conflict counts, peak speed, and latest run time. Only verified bidirectional bisync events can be presented as conflicts; one-way runs ignore legacy conflict counters. Runs with verified conflicts are presented as a warning state even if the process exit status was otherwise successful, and the latest-sync summary calls out the conflict count directly. Operators can filter the list by run status, conflict presence, and by text across task name, path/file detail, conflict samples, and error fields.

Local JSON state files are written through a per-file queue and atomic temp-file replacement. This keeps `profile.json`, `jobs.json`, `secrets.json`, `sync-history.json`, and `claim-recovery.json` readable while background status, import, scheduler, and save operations overlap. The runtime accepts `SFSC_CLIENT_DATA_ROOT` or `SFSC_DATA_ROOT` for an explicit state directory; otherwise it tries the package `data/` directory and falls back to `%LOCALAPPDATA%\Syncraft\data` when the package directory is not writable. Profile import also snapshots `profile.json`, `jobs.json`, and `secrets.json` before committing a new SyncKey/profile; if job refresh, scheduler refresh, or a local write fails, those files are restored to the pre-import state while `claim-recovery.json` stays pending for retry. Remote terminal redeem errors `claim_not_found`, `claim_already_used`, `claim_expired`, and remote `validation_failed` clear the pending recovery stash after rollback. A redeemed profile that is missing required server-issued heartbeat, storage, or tunnel material also clears the pending recovery stash because replaying the same SyncKey can only return the same unusable profile; the UI tells the user to check server configuration and generate a new SyncKey. `claim_redeem_rate_limited`, `server_state_write_failed`, `claim_redeem_failed`, and local job/scheduler/persistence failures keep recovery pending. If an existing JSON state file is already corrupt, including a pending claim recovery stash, `GET /api/client/status` still opens and exposes `safeguards.localState` with `local_state_corrupt` on the affected file; write endpoints stop with that stable error instead of overwriting the damaged state.

History reads are normalized as well, so an old or partially corrupted `sync-history.json` cannot break the status page or heartbeat. Diagnostic logs are redacted on write and read before `GET /api/logs` returns them. The settings drawer can also download `GET /api/diagnostics/export` as a JSON diagnostic bundle containing a top-level support summary, status, protocols/build information, jobs, scheduler, heartbeat, sync history, runtime environment, release manifest summary, binary/state/log-file summaries, and recent Electron/sing-box/rclone logs with existence, size, modified time, and truncation metadata; `environment.stateFiles` includes `claimRecovery` for `data/claim-recovery.json` alongside profile, jobs, secrets, and sync history. The bundle is recursively redacted before it leaves the local runtime. The default export is support-safe: client names, server URLs, bucket names, storage prefixes, endpoints, device/profile-derived IDs, and local paths are hidden while preserving version, release manifest version/build time, imported-profile presence, missing bundled binaries, corrupt local state, missing vault refs, heartbeat failure, latest sync error, conflict count, and missing/truncated log evidence.

Startup failures are local API errors, not sync history records: missing bundled sing-box/rclone returns `missing_singbox_binary` or `missing_rclone_binary` directly from the start/preview/run entrypoint, sing-box config/write/start failures return `singbox_start_failed`, and rclone remote config failures return `rclone_config_failed` before the sync process starts. Sync run writes the app-scoped rclone config before starting a new sing-box process, so a config failure does not leave a newly-started tunnel process behind; it also leaves sync metrics idle and does not append history. `GET /api/client/status.binaries` exposes `ok/errorCode/message` for bundled sing-box and rclone presence, using the same missing-binary codes when a packaged component is absent, so support can diagnose a bad unzip/package before the user starts a sync. The manual `POST /api/binaries/check` endpoint additionally runs each component's version command; the top-level `ok` is true only when all bundled components pass, each component's `ok` only stays true when the file exists and the version command succeeds, and present-but-unhealthy components use `binary_version_check_failed`. The settings drawer surfaces this aggregate result as a component-check pass/fail pill before listing individual sing-box/rclone details. When the user stops an active sync, the runtime sets `processes.sync.metrics.syncState: "stopping"`, sends the stop signal, and waits briefly for rclone to exit. Stop responses expose `stopSignal` and `stopTimedOut` when relevant; a completed user stop records `status: "stopped"` without `rclone_sync_failed`, and a timed-out stop remains visible for status polling and diagnostics.

Import validation returns stable local API error codes for the UI: malformed SyncKey/profile payloads use `import_code_invalid`, unsupported versions use `unsupported_profile_version`, missing tunnel URIs use `profile_tunnel_required`, missing server-issued heartbeat credentials use `profile_heartbeat_required`, missing server-issued storage credentials use `profile_storage_required`, and malformed VLESS links use `invalid_vless_uri`. Server-issued includes both SyncKey redeem profiles and offline full profiles that carry `source.server`; those offline profiles are checked before compatibility defaults can fill storage fields, so a missing storage secret cannot become `CHANGE_ME_CLIENT_SECRET`. Historical offline profiles without `source.server` remain local-execution compatible and do not send unsigned heartbeat. Remote SyncKey redemption requests use a default 15 second timeout, configurable with `SFSC_CLAIM_REDEEM_TIMEOUT_MS`; resolver errors keep only registered redeem `errorCode` values (`claim_not_found`, `claim_already_used`, `claim_expired`, `claim_redeem_rate_limited`, `server_state_write_failed`, `validation_failed`). Unregistered, unstructured, timed-out, and malformed successful responses become `claim_redeem_failed`; this includes HTTP 2xx responses that are not JSON, are not objects, return `ok:false`, or omit a profile object. Responses with an HTTP status preserve that status, while network failures without a response use 502.

The import screen uses dedicated SyncKey error guidance rather than only the generic `formatError()` copy. `claim_not_found`, `claim_already_used`, `claim_expired`, and `validation_failed` are terminal import errors with `retryable: false`; the UI says "不可重试当前 SyncKey" or "不可重试当前内容" and points the user to check the input, copy the complete SyncKey again, or generate a fresh SyncKey on the server. `claim_redeem_rate_limited`, `server_state_write_failed`, and `claim_redeem_failed` are retryable import errors with `retryable: true`; the UI says "可重试" and tells the user to wait for the rate-limit window when applicable, then check server data directory permissions, disk space, network, server address, and the server process before using the same SyncKey again. `profile_heartbeat_required`, `profile_storage_required`, and `profile_tunnel_required` mean the server-issued profile is missing required material; the UI names the missing heartbeat key, storage credentials, or tunnel info and tells the user to check server configuration before generating a new SyncKey.

Heartbeat transport failures are local status fields, not sync failures. Heartbeat requests use a default 10 second timeout. New profiles include `profile.heartbeat.secret`; the client calls `createHeartbeatAuth` to attach fresh `auth` using the `sfsc-hmac-sha256-v1` scheme before posting to `/api/devices/heartbeat`. The server rejects a repeated nonce inside the accepted timestamp window, so retries must create a new auth object rather than replaying the previous signed body. When the client cannot report to the server, times out, or receives a non-2xx heartbeat response, `GET /api/client/status` exposes `heartbeat.ok: false` with `heartbeat.errorCode: "heartbeat_failed"`; any server-side structured code, including `heartbeat_auth_required` or `heartbeat_auth_invalid`, is preserved as `heartbeat.remoteErrorCode` for diagnosis. The top status bar shows a compact heartbeat state, and the settings drawer shows the latest heartbeat time or failure reason. If the server returns `device_not_found` or another stable `remoteErrorCode`, the UI maps that code to a Chinese server-side cause instead of showing the raw code.

If the latest successful heartbeat includes `compatibility.policy.syncRun: "warn"`, the client UI asks for explicit confirmation before saving a sync job or starting a sync and sends `confirmCompatibilityWarning: true` to the local API. The local `/api/jobs/save` and `/api/sync/run` endpoints enforce the same confirmation for non-UI callers and return `danger_confirmation_required` when it is missing. Read-only preview remains available without confirmation. This confirmation does not block status reporting and is separate from destructive mirror-sync confirmation.

The imported-profile pill also considers the latest heartbeat server reason. A locally imported profile with `remoteErrorCode: "device_disabled"` is shown as disabled, and `remoteErrorCode: "device_not_found"` is shown as unregistered, so users do not mistake a stale local profile for an active server-side device. The main task panel shows a recovery notice for those two states: disabled devices point users to the server console re-enable action, while unregistered devices point users to generate and import a fresh SyncKey.

`GET /api/health` is the local lightweight readiness endpoint used by the portable launchers to reuse an already running runtime without reading local state files. Launchers and occupied-port recovery must parse the JSON response and require `ok: true`, `mode: "client-exe-runtime"`, and `diagnostics.role: "client"`; an arbitrary HTTP 200 on port `5188` is treated as a non-SFSC process and surfaces `client_port_in_use`. It returns only `ok`, `mode`, `version`/`clientVersion`, and `diagnostics`. `GET /api/client/status` exposes both `appVersion` and `clientVersion`, and the settings diagnostics panel displays the value. It also exposes a `diagnostics` block with the client role, runtime version, optional build id/time, and protocol versions; the settings drawer shows those protocol/build fields next to the local runtime paths. The same status response includes a lightweight `releaseManifest` summary so the drawer can show whether the packaged manifest is present/valid, the package version, and package build time without downloading the full diagnostic bundle. After a successful heartbeat, the drawer also shows the server protocol versions returned by the heartbeat response, the server-computed compatibility status, and the current compatibility policy. The runtime reads this from `SFSC_CLIENT_VERSION` when explicitly set, otherwise from package metadata generated from the root `package.json` version. This lets support compare the local client build with the server `/api/health.diagnostics` during N1 or field troubleshooting.

The client UI API wrapper has a default 15 second timeout. The UI wrapper call to `/api/profile/import` uses a 60 second timeout; `/api/sync/safety-plan` and `/api/sync/run` use 120 seconds; `/api/sync/bisync/initialize` uses 240 seconds. These budgets let the local runtime return stage-specific errors before the browser reports `request_timeout`. A sync-start UI timeout means the result is still unknown, so the UI refreshes local status and logs instead of declaring a server timeout or a definite sync failure. Browser/network failures become `network_error`, while aborted timed-out requests become `request_timeout`, so the UI does not depend on browser-specific exception text.

In the Electron desktop app, local folder selection uses a narrow preload bridge:

- main process: `dialog.showOpenDialog` with `openDirectory`
- preload: exposes `window.sfscDesktop.pickFolder()`
- renderer: falls back to `webkitdirectory` only when the Electron bridge is unavailable

The text input remains editable so advanced users can paste a path manually.

Electron startup must not fail invisibly. If the local client API cannot start before the main UI loads, the desktop shell opens a local startup-failure window instead of immediately quitting. The window shows a stable error code, the intended client port, the Electron main log path, and a copyable detail block. Port conflicts are normalized to `client_port_in_use`; package smoke keeps failing fast with a non-zero exit so packaging checks still catch startup regressions.

## rclone Defaults

Initial defaults:

- `copy`, not `sync`
- dry-run enabled in preview
- destructive delete disabled
- `--transfers 4`
- `--checkers 8`
- `--multi-thread-streams 8`
- `--multi-thread-cutoff 16M`
- `--s3-upload-concurrency 8`
- `--s3-chunk-size 16M`
- no `--bwlimit` unless the advanced bandwidth limit control is enabled

These defaults preserve multiple independent connections so large transfers can bypass the observed single-flow limit.

After a server profile is imported, these values come from `profile.defaults`. The client UI may hide low-level fields such as checkers, chunk size, retry counts, and local SOCKS port, but the local API must inherit them when saving, previewing, and running a job.

When a new profile is imported over an existing one, saved jobs are refreshed against the new profile. The runtime preserves user-entered task fields such as local path, direction, remote folder, server space, schedule, bandwidth, and visible concurrency controls, but replaces profile-derived storage, secret, bucket, execution prefix, hidden defaults, and local proxy fields. `remoteFolder` remains the user's relative folder choice; `remotePrefix` is recalculated from the new profile prefix plus that folder, or from `shared/` plus that folder for shared-space jobs. This prevents stale jobs from carrying an old server secret, bucket, or prefix after a SyncKey reimport.

Bidirectional jobs always run through `rclone bisync`. If a caller submits `destructiveSync: true` with `direction: "bidirectional"`, the local API and preview layer normalize it back to non-destructive state so the UI safety model cannot be bypassed by direct API calls.

Preview output may show the generated rclone commands, but display commands must mask S3 `secret_access_key`. The internal argument array still carries the real value so the runtime can write the rclone remote config.

## Packaging Direction

The Windows portable package bundles:

- `Syncraft.exe`
- client UI runtime through `runtime/node.exe`
- `sing-box.exe`
- `rclone.exe`
- config/profile store
- log directory

The local store writes profile/job files with `{ "secretRef": "..." }` objects in the original secret fields instead of inline S3 or heartbeat secrets. For example, persisted `profile.storage.secretAccessKey`, `profile.heartbeat.secret`, and `job.secretAccessKey` are references, while `readProfile()` and `readJobs()` return hydrated runtime objects inside the local process. HTTP display responses are intentionally different: `GET /api/profile`, `POST /api/profile/import`, `GET /api/client/status.jobs`, `GET /api/jobs`, and `POST /api/jobs/save.job` return display-safe summaries for UI, diagnostics, and local compatibility tooling, without storage access keys, storage secrets, heartbeat secrets/internal nonce state, raw VLESS URIs, SyncKeys, claim codes, tokens, or full profiles. `profile.json` must not save the heartbeat secret in plaintext; the hydrated value is only used at runtime to sign heartbeat `auth`. The current vault backend is `data/secrets.json`, so it is still part of the local data directory and must be protected as sensitive runtime state; on Windows the file backend reapplies a current-user ACL after writes and reports `safeguards.secretVault.protected` plus a `protection` summary in `/api/client/status`. The storage API is isolated so a later Windows Credential Manager backend can replace the file backend without changing profile, job, preview, heartbeat, or sync contracts.

Process startup is treated as readiness, not just spawn success. Before launching sing-box, the client writes the scoped `sing-box-client.json`, runs `sing-box check -c` against that file, then starts `sing-box run` and waits for the local loopback proxy port to accept TCP connections. Shutdown and explicit stop paths send termination signals and wait briefly for sing-box/rclone to exit so normal desktop/package smoke runs do not leave background processes behind.
