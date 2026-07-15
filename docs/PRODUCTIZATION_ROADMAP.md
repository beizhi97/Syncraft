# Productization Roadmap

This roadmap tracks the path from the current beta/productized baseline to an internal trial, a 5-10 person pilot, and a maintained deployable product. It is intentionally evidence-driven: each stage must point to current reports, manifests, and smoke results rather than memory of a previous run.

## Current Baseline

As of 2026-07-09, the authoritative release evidence is:

- Strict preflight: `reports/release/preflight.json`
- N1 latest acceptance: `reports/n1/latest-post-deploy.json`
- Release bundle: `dist/release-bundles/singbox-folder-sync-0.2.0-beta.2-release.zip`
- Safe operator summary: `pnpm run release:status`

Current verified gates:

- Full Node test suite passes through strict preflight; use `reports/release/preflight.json` as the current count authority.
- Release audit passes.
- Desktop and portable client package smoke pass.
- Release bundle manifest, client package manifests, and N1 acceptance agree on `sourceTreeHash` and `buildId`.
- N1 release acceptance passes with `ok=true`, `releaseOk=true`, `sourceAlignment=true`, and `finalRestartClear=true`.

## Stage Gates

### Internal Trial Ready

Required before a clean Windows internal beta run:

- `reports/release/preflight.json` has `releaseOk=true`, `failed=0`, and `skipped=0`.
- `reports/n1/latest-post-deploy.json` points to an N1 summary with `acceptance.ok=true`.
- Desktop package is the default participant package; portable package remains a compatibility fallback.
- Trial operator follows `docs/INTERNAL_TRIAL_CHECKLIST.md`.
- Trial records are written through `pnpm run trial:record:update`, not by hand-editing JSON.
- Real sync is only run with `--run-sync --i-understand-real-sync`.

Exit criteria:

- SyncKey import, folder selection, preview, first small-file sync, stop/restart, diagnostic export, and package SHA verification are all manually recorded.
- Any failure has a stable error code, a sanitized diagnostic artifact, and a concrete fix/retire decision.

### Pilot Ready

Required before a 5-10 person pilot:

- Internal trial is complete with no blocking manual sections.
- `pnpm run pilot:prepare` has generated the cohort records and per-participant command sheets.
- Support owner, rollback owner, and daily check window are assigned.
- Pilot participants use non-sensitive sample data and isolated remote prefixes.
- Rollback drill fields are complete enough for `pnpm run pilot:summary`.

Exit criteria:

- Install/import/first-sync success rate meets `docs/PILOT_ACCEPTANCE_CRITERIA.md`.
- No P0 issues, no unresolved P1 issues, and P2 count is within pilot criteria.
- Three complete daily health records pass N1 health, restart-clear, heartbeat, support, and diagnostic privacy checks.

### Maintained Product Baseline

Required after pilot:

- A repeatable upgrade/rollback story is proven for both server and client packages.
- Diagnostic collection is sufficient for support to triage without secrets or raw user data.
- A decision is made on installer packaging versus continuing with ZIP-based beta delivery.
- Client data storage and backup/restore expectations are documented for non-technical users.

## Workstreams

### Protocol And Safety

Status: mostly stable.

Completed:

- Client/server API contract and API matrix exist.
- SyncKey redeem failure windows are persisted and fail closed when audit state cannot be written.
- Legacy profile import compatibility is documented while the formal server success response remains a bare profile.
- Storage partial-success semantics are documented for `storage_request_failed`.

Next slices:

- Implement the security boundary in `docs/SYNC_ID_SECURITY_IMPLEMENTATION_PLAN.md` before advertising multi-device sync IDs: the sync ID identifies content, while a device-bound SyncKey and revocable membership authorize access. Guessing an ID must never grant or reveal access.
- Redesign the user-facing storage model around a shared sync ID. The confirmed product requirement is recorded in `docs/SYNC_ID_PRODUCT_REQUIREMENT.md`; it intentionally does not change the current Protocol v1 contract.
- Add a small contract check that all public docs refer to `reports/release/preflight.json` instead of hard-coding stale test counts as release gates.
- Keep API matrix updates mandatory for any new local or server route.
- Decide whether future server responses should reject legacy wrapped claim redeem success in a major protocol bump.

### Release Evidence And Deployment

Status: strong baseline.

Completed:

- `sourceTreeHash`, `buildId`, and `sourceFingerprint` are carried through client packages, preflight, release bundle, and N1 acceptance.
- N1 release acceptance verifies version alignment, source alignment, release bundle evidence, lifecycle smoke, cleanup, and final restart clear.
- `pnpm run release:status` prints a safe operator summary covering preflight, bundle SHA, N1 latest, final restart clear, and source alignment.

Next slices:

- Add retention guidance for old `reports/n1/*` and old release bundles.
- Document exactly when N1 deploy must be rerun versus when existing runtime evidence can be reused.

### Client Trial Experience

Status: usable beta, still support-heavy.

Completed:

- Desktop and portable packages are smoke-tested.
- UI exposes manifest, protocol compatibility, local state, secret vault, logs, diagnostics, sync history, and stable error messages.
- Electron smoke covers real window startup and a fake-binary UI sync path.

Next slices:

- Fix `SFSC-BETA-PROGRESS-001` before broadening the Beta: add an explicit scan phase, establish the transfer total before data transfer starts, and stop presenting rclone's growing discovered-byte count as a final total. See `docs/BETA_BUGFIX_PLAN.md`.
- Fix `SFSC-BETA-CONFLICT-001` before broadening the Beta: only classify verified bidirectional events as conflicts, deduplicate repeated events, and keep the real rclone failure as the primary error. See `docs/BETA_BUGFIX_PLAN.md`.
- Deliver the compatibility-first migration in `SFSC-BETA-ENDPOINT-001`: remove N1-specific storage hostnames from new SyncKeys and normal UI, separate internal storage from client transport, and retain a rollback window for existing profiles. See `docs/BETA_BUGFIX_PLAN.md`.
- Make the settings diagnostics area show the package `buildId` and source fingerprint summary when available.
- Add an in-app "support copy" summary with only safe fields: version, build ID, package type, protocol status, local state health, last sync status, and diagnostic export hint.
- Improve first-run empty state around "what to do next" without adding marketing copy.

### Server Operations

Status: good N1 automation, not yet generalized for arbitrary deployments.

Completed:

- N1 deploy, rollback, post-deploy smoke, sing-box apply, and release acceptance are automated.
- Runtime paths and secrets are preserved/excluded during deploy and bundle creation.
- Compose image tags are pinned and audited.

Next slices:

- Resolve `SFSC-BETA-STORAGE-001`: move N1 MinIO data from the undersized system partition to the mounted SSD, expose capacity health, and map MinIO HTTP 507 to an actionable stable client error.
- Separate N1-specific runbook from generic self-hosted deployment instructions.
- Add an operator command for "health + restartRequired + latest release evidence" that is safe to paste in support notes.
- Add backup/restore instructions for `server/data` and `server/sing-box` before non-N1 deployments.

### Pilot Operations

Status: documented and partially tooled.

Completed:

- Pilot runbook, acceptance criteria, support guide, prepare tool, and summary tool exist.
- Records are designed to avoid SyncKey, URI, token, S3 secret, heartbeat secret, and SSH key leakage.

Next slices:

- Run a dry pilot fixture through `pilot:prepare` and `pilot:summary` with synthetic participants, then record the expected failure/pass conditions in docs.
- Add a pilot daily-health example file with safe placeholder values.
- Add support issue taxonomy for repeated stable error codes.

## Immediate Priority Order

1. Keep release evidence current after every code or doc change.
2. Remove stale fixed test-count wording from release gates and point humans to strict preflight as the authority.
3. Add retention and rerun guidance for N1/release evidence.
4. Improve server-side support summaries and daily health operations.
5. Dry-run pilot tooling with synthetic records.
