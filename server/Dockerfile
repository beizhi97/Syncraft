FROM quay.io/minio/mc:RELEASE.2025-08-13T08-35-41Z AS minio-mc

FROM node:22-alpine

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
