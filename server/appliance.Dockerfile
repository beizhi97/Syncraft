ARG SING_BOX_IMAGE_TAG=v1.13.14
# D-5: every base image is pinned tag@digest (tags are mutable; override both
# args together when upgrading). rclone is aligned with the Windows client's
# binaries.lock.json (1.74.3) so both ends run the same sync engine.
ARG SING_BOX_IMAGE_DIGEST=sha256:c8b67944345dc84a226b648a71f854818606eae0813c4e6a452f192ef821b5b8
ARG RCLONE_IMAGE_TAG=1.74.3
ARG RCLONE_IMAGE_DIGEST=sha256:623378ad0ff3ebd5cebf77720843c0e02edfe46e2d5b5ac6bed54c6371780dfb
ARG MINIO_MC_IMAGE_TAG=RELEASE.2025-08-13T08-35-41Z
ARG MINIO_MC_IMAGE_DIGEST=sha256:a7fe349ef4bd8521fb8497f55c6042871b2ae640607cf99d9bede5e9bdf11727

FROM ghcr.io/sagernet/sing-box:${SING_BOX_IMAGE_TAG}@${SING_BOX_IMAGE_DIGEST} AS singbox
FROM rclone/rclone:${RCLONE_IMAGE_TAG}@${RCLONE_IMAGE_DIGEST} AS rclone
FROM quay.io/minio/mc:${MINIO_MC_IMAGE_TAG}@${MINIO_MC_IMAGE_DIGEST} AS minio-mc

FROM ghcr.io/linuxserver/baseimage-alpine:3.22@sha256:7451d313a8b95bd2b9ed798887e6b560ef5065e9ba6ef126a9e792d8b692df9c

RUN apk add --no-cache ca-certificates curl netcat-openbsd nodejs

WORKDIR /app
COPY package.json ./
COPY src ./src
COPY public ./public
COPY server/sing-box-supervisor.sh /usr/local/bin/sfsc-sing-box-supervisor
COPY server/rootfs /
COPY --from=singbox /usr/local/bin/sing-box /usr/local/bin/sing-box
COPY --from=rclone /usr/local/bin/rclone /usr/local/bin/rclone
COPY --from=minio-mc /usr/bin/mc /usr/local/bin/mc

RUN chmod 0755 \
      /usr/local/bin/sfsc-sing-box-supervisor \
      /etc/s6-overlay/s6-rc.d/sfsc-node/run \
      /etc/s6-overlay/s6-rc.d/sfsc-singbox/run \
    && sing-box version \
    && rclone version \
    && node --version

ENV HOST=0.0.0.0 \
    PORT=5177 \
    SERVER_DATA_ROOT=/data/app \
    SINGBOX_CONFIG_PATH=/data/sing-box/config.json \
    SINGBOX_CONTROL_DIR=/data/control \
    SINGBOX_LISTEN_PORT=45678 \
    RCLONE_BIN=/usr/local/bin/rclone \
    S3_ENDPOINT=http://127.0.0.1:9000

EXPOSE 5177 45678
VOLUME ["/data"]

HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=4 \
  CMD curl --fail --silent --show-error http://127.0.0.1:5177/healthz >/dev/null || exit 1

