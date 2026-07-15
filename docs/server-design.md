# Server Design

## Goal

The server is a Docker Compose deployment on N1 or another Linux host. It integrates three modules:

- `sing-box`: VLESS/REALITY inbound tunnel.
- `MinIO`: S3-compatible object storage.
- `sync-server`: our web shell/API for management, profile generation, health, and safe defaults.

The server does not implement a custom sync protocol. It provides a storage target and a tunnel, and the Windows client runs `rclone` through that tunnel.

## Docker Shape

```text
internet/company PC
  -> VLESS tcp port
  -> sing-box container
  -> direct outbound inside compose network
  -> minio:9000
```

The MinIO API and console are bound to `127.0.0.1` on the host by default. Remote clients should reach MinIO through the VLESS tunnel, not by exposing the MinIO port to the internet.

## Compose Services

`sync-server`

- Web UI and management API.
- Stores generated profiles and job metadata under `./data/app`.
- Reads the default S3 endpoint as `http://minio:9000`.
- Future responsibility: create/revoke clients and write sing-box/MinIO credentials.

`sing-box`

- Runs `ghcr.io/sagernet/sing-box` with the fixed default tag from `SING_BOX_IMAGE_TAG`.
- Listens on `${VLESS_PORT:-45678}/tcp`.
- Routes proxied client requests directly to internal services such as `minio:9000`.
- Uses VLESS/REALITY in the first template.

`minio`

- Runs `quay.io/minio/minio` with the fixed default tag from `MINIO_IMAGE_TAG`; the init client uses `MINIO_MC_IMAGE_TAG`.
- Stores object data under `./data/minio`.
- Creates bucket `${S3_BUCKET:-home-sync}` through `minio-init`.
- API and console are localhost-bound for admin use.

## Storage Model

Clients never type arbitrary server filesystem paths. They select:

- bucket: `home-sync`
- space: device private or shared
- client name: `company-pc1`
- remote folder: `projects`

The derived rclone path is:

```text
home-minio:home-sync/devices/company-pc1/projects
```

Shared folders use:

```text
home-minio:home-sync/shared/projects
```

## Open Ports

- `45678/tcp`: VLESS inbound, intended to be exposed.
- `5177/tcp`: sync-server web UI, ideally LAN-only or reverse-proxied with auth.
- `9000/tcp`: MinIO API, localhost-bound by default.
- `9001/tcp`: MinIO console, localhost-bound by default.

## Current Product Boundaries

- The sample sing-box config contains placeholder REALITY keys and must not be used as a live secret source.
- Device creation/revocation is managed through the server state and generated sing-box config; operators still need to apply the generated config to the running sing-box service.
- The management console now treats sync conflicts as an operator attention state: devices with `sync.conflicts` or `sync.lastRun.conflicts` are highlighted in the list, included in the attention count, and can be filtered by "有冲突".
- The SyncKey creation screen formats generation failures with dedicated retry guidance. State write, network, timeout, storage, and unknown server failures are `retryable: true` and tell the operator to check `sfsc-state.json` permissions, disk space, sync-server reachability/logs, N1 load, or MinIO/S3 before generating the SyncKey again. Compatibility confirmation, disabled devices, disabled/missing buckets, missing devices, and validation errors are `retryable: false` and tell the operator to fix that precondition before generating a new SyncKey.
- The SyncKey redeem preview screen formats failed test redemptions with dedicated safety guidance. Missing, already used, expired, invalid, or malformed SyncKeys are `retryable: false` and tell the operator to copy the full SyncKey again or generate a new one. State write failures are `retryable: true` and explain that the SyncKey should not be considered consumed until the redeem state is persisted. Network, timeout, generic server, and `claim_redeem_failed` outcomes are `retryable: false` because the result is unknown; the operator must refresh admin state, inspect whether the claim is `used` / `redeemedAt`, avoid handing that SyncKey to a client, and generate a replacement when unsure.
- Before each server state save, the runtime compacts stale lifecycle state: used SyncKey claims keep their audit summary, expired unused claims are pruned after the retention window, expired replay bindings drop client binding identifiers, heartbeat auth nonces are pruned to the authentication window, and old soft-deleted users can be removed once no retained claim references them.
- MinIO/S3 credentials are still shared for the configured storage backend; per-client object-store policies are a later hardening step.
