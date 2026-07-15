# Windows Client

This is the Windows portable client for Syncraft. It follows the shared interface contract in `../docs/INTERFACE_CONTRACT.md` for SyncKey import, local jobs, diagnostics, heartbeat reporting, and sync execution.

The desktop build is packaged as a portable folder containing:

```text
Syncraft.exe
release-manifest.json
resources/app/...
resources/bin/win32/sing-box.exe
resources/bin/win32/rclone.exe
```

The runtime creates `data/` next to the executable after launch. Release packages must not ship with `data/`, because it may contain local profile, job, log, and secret-vault state.

`Syncraft.exe` is an Electron desktop app. It opens its own window and runs only the bundled `sing-box.exe` and `rclone.exe`.

The desktop window uses a restricted preload bridge for native folder picking. The renderer can call `window.sfscDesktop.pickFolder()`, but Node.js integration remains disabled.

## Build

Install build dependency:

```powershell
pnpm install
```

Download bundled binaries:

```powershell
pnpm run client:download-binaries
```

Package the client:

```powershell
pnpm run client:desktop-package
```

The packaging script runs the client package smoke check automatically. It verifies the packaged app layout, bundled binaries, version metadata, native folder picker bridge, Electron renderer security flags, and absence of runtime `data/`. It also starts the packaged `Syncraft.exe` on a random loopback port with a temporary data root, verifies `/api/health` and `/api/client/status`, then calls `/api/client/shutdown`. To re-check an existing package:

```powershell
pnpm run smoke:client-package
```

The legacy Node portable directory package is still available with `pnpm run client:package`. It writes `dist/SyncraftClient`, emits its own `release-manifest.json`, ZIP, SHA256 sidecar, and runs the same smoke check with the portable layout rules. To re-check a non-default package root, set `SFSC_CLIENT_PACKAGE_DIR` before running `pnpm run smoke:client-package`.

Output:

```text
dist/SyncraftDesktop/Syncraft.exe
dist/SyncraftDesktop/release-manifest.json
dist/SyncraftDesktop.zip
dist/SyncraftDesktop.zip.sha256
dist/SyncraftClient/release-manifest.json
dist/SyncraftClient.zip
dist/SyncraftClient.zip.sha256
```

`release-manifest.json` records the package version, build time, SHA256 for key files, and the shipped `resources/app/docs/INTERFACE_CONTRACT.md` / `resources/app/docs/API_MATRIX.md` support docs. The client settings drawer and diagnostic export surface this manifest summary so support can confirm the package batch without opening the package folder manually.

## Run In Development

```powershell
pnpm run client:start
```

Desktop development run:

```powershell
pnpm run client:desktop
```

Then open:

```text
http://127.0.0.1:5188/
```

After the local runtime is up, run the read-only runtime smoke check:

```powershell
pnpm run smoke:client
```

For a custom endpoint or machine-readable report:

```powershell
node scripts/smoke-client.mjs --base-url http://127.0.0.1:5188 --json-report reports/client-smoke.json
```

`smoke:client` verifies the already-running local runtime through `/api/health`, `/api/client/status`, `/api/profile`, `/api/jobs`, `/api/sync/history`, `/api/logs`, and `/api/diagnostics/export`. It also checks protocol map alignment, release manifest and binary/process summaries, heartbeat contracts, and that profile/job/history read APIs match `/api/client/status`. `smoke:client-package` verifies a built release package directory.

## Runtime Rules

- Uses bundled `resources/bin/win32/sing-box.exe`.
- Uses bundled `resources/bin/win32/rclone.exe`.
- Writes rclone config to `data/runtime/rclone.conf`.
- Starts sing-box as a local-only proxy on `127.0.0.1`.
- Passes proxy variables only to the rclone process.
- Uses the native Windows folder picker in the Electron desktop app, with manual path paste still available.
- Does not change system proxy, routes, DNS, firewall, or TUN.
