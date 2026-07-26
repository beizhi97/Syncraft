ARG SING_BOX_IMAGE_TAG=v1.13.14
# D-5: digest-pinned; override both args together when upgrading.
ARG SING_BOX_IMAGE_DIGEST=sha256:c8b67944345dc84a226b648a71f854818606eae0813c4e6a452f192ef821b5b8
FROM ghcr.io/sagernet/sing-box:${SING_BOX_IMAGE_TAG}@${SING_BOX_IMAGE_DIGEST}

COPY server/sing-box-supervisor.sh /usr/local/bin/sfsc-sing-box-supervisor
RUN chmod 0755 /usr/local/bin/sfsc-sing-box-supervisor

ENV SINGBOX_CONFIG_PATH=/etc/sing-box/config.json
ENV SINGBOX_CONTROL_DIR=/sfsc-control

ENTRYPOINT ["/usr/local/bin/sfsc-sing-box-supervisor"]
