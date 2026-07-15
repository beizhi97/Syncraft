ARG SING_BOX_IMAGE_TAG=v1.13.14
FROM ghcr.io/sagernet/sing-box:${SING_BOX_IMAGE_TAG}

COPY server/sing-box-supervisor.sh /usr/local/bin/sfsc-sing-box-supervisor
RUN chmod 0755 /usr/local/bin/sfsc-sing-box-supervisor

ENV SINGBOX_CONFIG_PATH=/etc/sing-box/config.json
ENV SINGBOX_CONTROL_DIR=/sfsc-control

ENTRYPOINT ["/usr/local/bin/sfsc-sing-box-supervisor"]
