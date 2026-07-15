import { parseVlessUri } from "./vless.js";
import { normalizeTcpPort } from "./numbers.js";

export function buildClientSingboxConfig(uriOrProfile, options = {}) {
  const profile = typeof uriOrProfile === "string" ? parseVlessUri(uriOrProfile) : uriOrProfile;
  const localProxyPort = normalizeTcpPort(options.localProxyPort, {
    field: "localProxyPort",
    defaultValue: 18081
  });
  const localProxyHost = options.localProxyHost || "127.0.0.1";

  const outbound = {
    type: "vless",
    tag: "vless-out",
    server: profile.server,
    server_port: profile.port,
    uuid: profile.uuid,
    packet_encoding: "",
    multiplex: {
      enabled: false
    }
  };

  if (profile.flow) {
    outbound.flow = profile.flow;
  }

  const tls = buildTlsConfig(profile);
  if (tls) {
    outbound.tls = tls;
  }

  if (profile.transport && profile.transport !== "tcp") {
    outbound.transport = buildTransportConfig(profile);
  }

  return {
    log: {
      level: options.logLevel || "info",
      timestamp: true
    },
    inbounds: [
      {
        type: "mixed",
        tag: "local-rclone-proxy",
        listen: localProxyHost,
        listen_port: localProxyPort,
        sniff: false
      }
    ],
    outbounds: [
      outbound,
      {
        type: "direct",
        tag: "direct"
      }
    ],
    route: {
      final: "vless-out"
    }
  };
}

function buildTlsConfig(profile) {
  if (!profile.security || profile.security === "none") {
    return null;
  }

  const tls = {
    enabled: true,
    server_name: profile.sni || profile.server
  };

  if (profile.fingerprint) {
    tls.utls = {
      enabled: true,
      fingerprint: profile.fingerprint
    };
  }

  if (profile.security === "reality") {
    tls.reality = {
      enabled: true,
      public_key: profile.publicKey,
      short_id: profile.shortId
    };
  }

  if (profile.alpn.length) {
    tls.alpn = profile.alpn;
  }

  return tls;
}

function buildTransportConfig(profile) {
  if (profile.transport === "ws") {
    return {
      type: "ws",
      path: profile.path || "/",
      headers: profile.host ? { Host: profile.host } : {}
    };
  }

  if (profile.transport === "http" || profile.transport === "h2") {
    return {
      type: "http",
      host: profile.host ? [profile.host] : [],
      path: profile.path || "/"
    };
  }

  return {
    type: profile.transport
  };
}
