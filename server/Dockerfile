# D-5: base images are pinned by digest. Tags are mutable on every
# registry; a republished tag would silently change the runtime. When
# upgrading, update the tag AND the digest together (docker buildx
# imagetools inspect <image:tag> prints the manifest-list digest).
FROM quay.io/minio/mc:RELEASE.2025-08-13T08-35-41Z@sha256:a7fe349ef4bd8521fb8497f55c6042871b2ae640607cf99d9bede5e9bdf11727 AS minio-mc

FROM node:22-alpine@sha256:16e22a550f3863206a3f701448c45f7912c6896a62de43add43bb9c86130c3e2

WORKDIR /app

COPY package.json ./
COPY src ./src
COPY public ./public
COPY --from=minio-mc /usr/bin/mc /usr/local/bin/mc

ENV HOST=0.0.0.0
ENV PORT=5177
ENV SERVER_DATA_ROOT=/app-data
ENV SINGBOX_CONFIG_PATH=/server-singbox/config.json

EXPOSE 5177
VOLUME ["/app-data"]

CMD ["node", "src/server.js"]
