# Docker Server Shape

The server side is intended to run in Docker Compose.

It contains:

- `sync-server`: the management web shell/API.
- `sing-box`: the VLESS/REALITY inbound.
- `minio`: S3-compatible object storage.
- `minio-init`: one-shot bucket bootstrap.
- `caddy`: the public HTTPS reverse proxy for the management UI/API.

Copy the environment template before first run:

```bash
cp .env.example .env
```

Then edit `.env` and change at least:

```text
SFSC_ADMIN_TOKEN=...
MINIO_ROOT_PASSWORD=...
SFSC_PUBLIC_HOST=sync.example.com
```

Docker compose runs the server with `SFSC_REQUIRE_ADMIN_TOKEN=1`, so startup fails when `SFSC_ADMIN_TOKEN` is missing or still set to the placeholder value.

Run:

```bash
docker compose up --build -d
```

Operator commands are available through `sh ./sfscctl`: `health`, `backup`, `upgrade`, and `restore <archive>`. Backups contain `.env`, MinIO/app state, and sing-box configuration with mode `0600`; restore first writes a fresh pre-restore backup and accepts only those paths from the archive. Set `SFSC_HEALTH_URL=https://sync.example.com` before `sh ./sfscctl health` to include an HTTPS health request.

The client should not choose arbitrary absolute server filesystem paths. It should choose:

- server space: `device` or `shared`
- client name: for example `company-pc1`
- bucket: for example `home-sync`
- remote folder: for example `projects`

The app then derives the S3 path:

```text
home-minio:home-sync/devices/company-pc1/projects
```

Ports:

- `${VLESS_PORT:-45678}/tcp`: expose this for clients.
- `80/tcp` and `443/tcp`: Caddy HTTPS redirect and management UI/API. Caddy obtains and renews TLS certificates for `SFSC_PUBLIC_HOST`; DNS for that hostname must point to this server and both ports must be reachable from the Internet.
- `sync-server:5177/tcp`: Docker-internal only. Do not publish it directly in the self-hosted Beta shape.
- `${MINIO_API_PORT:-9000}/tcp`: localhost-bound by default.
- `${MINIO_CONSOLE_PORT:-9001}/tcp`: localhost-bound by default.

Storage endpoints:

- `S3_ENDPOINT` is the service-side endpoint used by `sync-server` inside Docker.
- `S3_CLIENT_ENDPOINT` is written into issued SyncKey profiles as `profile.storage.endpoint`; Windows clients pass it to rclone.
- Default local compose uses `http://minio:9000`, which is meant to be reached through the VLESS proxy where sing-box resolves `minio` inside the Docker network.
- The N1 compose overlay keeps `S3_ENDPOINT=http://minio:9000` for service-side MinIO management and sets `S3_CLIENT_ENDPOINT=http://n1-minio.sfsc:9000` for issued profiles. `sing-box` maps `n1-minio.sfsc` to `127.0.0.1`, so Windows clients receive an endpoint that remains reachable through the tunnel.

This Docker slice uses a placeholder `server/sing-box/config.json`. Generate real VLESS/REALITY settings from the admin console, keep production `server/sing-box/config.json` out of source handover packages, and set a non-placeholder `SFSC_ADMIN_TOKEN` before exposing the web UI.
