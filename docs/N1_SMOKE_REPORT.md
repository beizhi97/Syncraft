# N1 Smoke Report

Date: 2026-07-04

Status: historical observation. This report records the N1 state observed on the date above; it is not proof of the current N1 state. Before using N1 for beta/productized baseline acceptance, redeploy or verify the current local build and rerun the post-deploy evidence flow for the exact delivery bundle under review.

Target:

- Host: `192.168.1.254`
- Server path: `/opt/sfsc-test/server`
- Base URL: `http://192.168.1.254:5177`

## Authoritative Current Evidence

For current N1 acceptance, treat only the latest post-deploy evidence set as authoritative:

- `reports/n1/latest-post-deploy.json`, or the pointed `reports/n1/<UTC-run-id>/post-deploy-summary.json`.
- The matching `reports/n1/<UTC-run-id>/server-smoke.json` from the same run.
- `post-deploy-summary.json` must be `ok: true`.
- `server-smoke.json` must be `ok: true` and record `context.adminAuthProvided: true`.
- `server-smoke.json` must record `summary.restartRequired: false`; if it is `true`, run `apply-n1-singbox.ps1 -Apply` and use the final apply smoke as the acceptance evidence.
- `post-deploy-summary.json` must record `acceptance.target.targetHostsMatch: true`.
- Formal beta release evidence should run `post-deploy-n1.ps1` with `-ReleaseAcceptance`; that mode requires a verified release bundle, claim lifecycle evidence, a packaged-client real-sync report, SSD object verification, final test-data cleanup, and `restartRequired=false`.

Historical N1 reports are reference material only. They can explain what changed or why a previous run failed, but they do not release the current build. Before publishing a beta delivery, rerun post-deploy with the release bundle manifest so the summary binds N1, server smoke, version alignment, and desktop/portable ZIP artifacts:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/post-deploy-n1.ps1 -DeployJsonPath <deploy.json> -SmokeJsonPath <lifecycle-smoke.json> -FinalSmokeJsonPath <final-smoke.json> -ReleaseBundleManifestPath dist/release-bundles/<bundle>/release-bundle-manifest.json -ClientRealSyncJsonPath <client-real-sync.json> -SsdObjectVerificationJsonPath <ssd-object-verification.json> -TestDataCleanupJsonPath <test-data-cleanup.json> -ReleaseAcceptance
```

If the latest post-deploy run was created without `-ReleaseBundleManifestPath`, it may be useful for environment smoke, but it is not sufficient as release acceptance evidence for the beta delivery package.

## Historical Result

At the time of this report, the N1 test deployment was running, but did not yet match the then-current local product contract.

Verified over SSH:

- `sync-server`, `sing-box`, and `minio` containers are running.
- `GET /api/health` returns `ok: true`.
- `GET /api/admin/state` returns state JSON.
- `GET /api/admin/singbox/config` returns a config preview.

Observed contract gaps:

- `.env` does not define `SFSC_ADMIN_TOKEN`.
- `GET /api/health` does not expose `adminAuth`.
- `GET /api/admin/auth/check` returns `404 Not found`.
- `scripts/smoke-server.mjs` therefore fails against N1 once it checks the full management contract.

## Revalidation Action

Before using N1 as the productization acceptance environment for this beta/productized baseline, deploy or verify the current local server build at `/opt/sfsc-test`, set `SFSC_ADMIN_TOKEN`, restart `sync-server`, and rerun post-deploy with server smoke. Treat the latest smoke output as authoritative alongside the post-deploy summary, not this historical report or any older report directory.

Dry-run the source upgrade plan first:

```powershell
pnpm run preflight:release
```

Use the final `Preflight report` section as the revalidation summary; it records generation time, repo path, Node path, `SkipTests`, and each gate as passed, skipped, or failed, with timing and skip/failure details. To keep a handoff artifact, run the script form with `-ReportPath reports/preflight.txt`; add `-JsonReportPath reports/preflight.json` when another agent or CI needs a machine-readable `ok`/`summary`/`steps` result. Reports are written even when a later gate fails.

In restricted sandboxes, use the no-test variant and run tests separately:

```powershell
pnpm run preflight:release:quick
pnpm test
```

This quick path is only a development self-check. It is not release or N1 acceptance evidence because it can skip client package smoke and strict release gates; formal beta release evidence must come from strict preflight with `skipped: 0`, a verified release bundle, and the latest N1 post-deploy/apply evidence set.

Build and inspect the local source archive without connecting to N1:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/deploy-n1.ps1 -BuildArchive
```

This command also validates the archive contract: required server source paths must be present, and runtime or delivery artifacts such as `.env`, `server/data`, `server/sing-box`, `node_modules`, `dist`, `.tmp`, client packages, tests, and docs must be excluded.

Apply the source upgrade only when ready:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/deploy-n1.ps1 -Apply
```

The deploy script preserves these runtime paths on N1:

- `/opt/sfsc-test/server/.env`
- `/opt/sfsc-test/server/data`
- `/opt/sfsc-test/server/sing-box`

It refreshes `/opt/sfsc-test/server/.env.example`, but does not overwrite the real `.env`. After `-Apply`, the deploy script runs a local deploy health check against `http://127.0.0.1:5177/api/health` and requires `ok: true`, `diagnostics.protocols`, and `adminAuth.enabled: true`; this is only the post-deploy health gate, not the full management contract smoke.

Set or rotate `SFSC_ADMIN_TOKEN` directly in `/opt/sfsc-test/server/.env`; do not pass the real token as a command-line argument.

```bash
SFSC_SMOKE_BASE_URL=http://192.168.1.254:5177 \
SFSC_ADMIN_TOKEN=... \
node scripts/smoke-server.mjs
```

Do not publish or copy the real token into reports or logs.
