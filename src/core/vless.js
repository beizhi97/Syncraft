import { createHttpError } from "./errors.js";

export function parseVlessUri(input) {
  const raw = String(input || "").trim();
  if (!raw) {
    throw createHttpError("invalid_vless_uri", 400, "VLESS URI is required");
  }

  let url;
  try {
    url = new URL(raw);
  } catch {
    throw createHttpError("invalid_vless_uri", 400, "Invalid VLESS URI");
  }

  if (url.protocol !== "vless:") {
    throw createHttpError("invalid_vless_uri", 400, "URI must start with vless://");
  }

  const uuid = decodeURIComponent(url.username || "");
  if (!isUuid(uuid)) {
    throw createHttpError("invalid_vless_uri", 400, "VLESS URI must contain a valid UUID user");
  }

  const server = url.hostname;
  const port = Number(url.port || 443);
  if (!server) {
    throw createHttpError("invalid_vless_uri", 400, "VLESS URI must contain a server host");
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw createHttpError("invalid_vless_uri", 400, "VLESS URI must contain a valid port");
  }

  const params = Object.fromEntries(url.searchParams.entries());
  const security = params.security || "none";
  const transport = params.type || "tcp";
  const name = decodeURIComponent((url.hash || "").replace(/^#/, "")) || server;

  return {
    name,
    raw,
    uuid,
    server,
    port,
    security,
    transport,
    flow: params.flow || "",
    sni: params.sni || params.peer || "",
    fingerprint: params.fp || "",
    publicKey: params.pbk || "",
    shortId: params.sid || "",
    path: params.path || "",
    host: params.host || "",
    alpn: params.alpn ? params.alpn.split(",").filter(Boolean) : [],
    params
  };
}

export function isUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
