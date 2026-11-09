import { createServer } from "node:http";

import { createHttpError, normalizeHttpError } from "../core/errors.js";

const REQUEST_PATH = "/api/enrollment/v1/requests";
const CONSUME_PATH = "/api/enrollment/v1/consume";
const DATA_AUTHORIZATION_PATH = "/api/enrollment/v1/data-authorization";
const CHANNEL_RENEWAL_PATH = "/api/enrollment/v1/channel-renewal";
const TRANSPORT_PROBE_PATH = "/api/enrollment/v1/transport-probe";
const DEFAULT_MAX_BODY_BYTES = 2 * 1024 * 1024;
const START_TIMEOUT_MS = 10_000;
const CLOSE_TIMEOUT_MS = 10_000;

function writeJson(response, value, status = 200) {
  if (response.destroyed || response.writableEnded) return;
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff"
  });
  response.end(JSON.stringify(value, null, 2));
}

function writeJsonError(response, error) {
  const normalized = normalizeHttpError(error, "server_error");
  writeJson(response, {
    ok: false,
    error: normalized.code,
    errorCode: normalized.code,
    message: normalized.message
  }, normalized.status);
}

async function readJsonBytes(request, maxBodyBytes) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > maxBodyBytes) {
      throw createHttpError("request_body_too_large", 413, "Request body too large");
    }
    chunks.push(bytes);
  }
  const bodyBytes = Buffer.concat(chunks, size);
  let body;
  try {
    body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bodyBytes));
  } catch {
    throw createHttpError("invalid_json", 400, "Invalid JSON");
  }
  return { body, bodyBytes };
}

function withTimeout(promise, timeoutMs, message) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      timer.unref?.();
    })
  ]).finally(() => clearTimeout(timer));
}

/**
 * A loopback-only HTTP surface for device enrollment bootstrap. It intentionally
 * has no proxy/fallback route: only the two exact raw POST targets reach the
 * enrollment service.
 */
export function createEnrollmentBootstrapGateway({
  enrollmentService,
  host = "127.0.0.1",
  port = 0,
  maxBodyBytes = DEFAULT_MAX_BODY_BYTES
} = {}) {
  if (!enrollmentService || typeof enrollmentService.createRequest !== "function"
    || typeof enrollmentService.consume !== "function") {
    throw new TypeError("enrollmentService must provide createRequest and consume");
  }
  if (host !== "127.0.0.1") throw new TypeError("bootstrap gateway must bind exactly to 127.0.0.1");
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new TypeError("port must be a valid TCP port");
  if (!Number.isSafeInteger(maxBodyBytes) || maxBodyBytes < 1) throw new TypeError("maxBodyBytes must be a positive safe integer");

  let server = null;
  let starting = null;
  let closing = null;

  const handler = async (request, response) => {
    try {
      const rawTarget = request.url;
      if (request.method === "GET") {
        let target;
        try { target = new URL(rawTarget, "http://127.0.0.1"); } catch { target = null; }
        const challenge = target?.searchParams.get("challenge") || "";
        if (target?.pathname === TRANSPORT_PROBE_PATH
          && /^([a-f0-9]{48})$/.test(challenge)
          && target.searchParams.getAll("challenge").length === 1
          && [...target.searchParams.keys()].length === 1) {
          writeJson(response, { ok: true, service: "sfsc-enrollment-bootstrap", challenge });
          return;
        }
      }
      if (request.method !== "POST" || ![REQUEST_PATH, CONSUME_PATH, DATA_AUTHORIZATION_PATH, CHANNEL_RENEWAL_PATH].includes(rawTarget)) {
        throw createHttpError("not_found", 404, "Not found");
      }
      const { body, bodyBytes } = await readJsonBytes(request, maxBodyBytes);
      if (rawTarget === REQUEST_PATH) {
        const result = await enrollmentService.createRequest({
          input: body,
          bodyBytes,
          rawTarget,
          proofHeader: request.headers["x-sfsc-enrollment-request"]
        });
        writeJson(response, result, 202);
        return;
      }
      if (rawTarget === DATA_AUTHORIZATION_PATH) {
        if (typeof enrollmentService.issueDataAuthorization !== "function") {
          throw createHttpError("enrollment_data_authorization_denied", 503, "Data authorization is unavailable");
        }
        const result = await enrollmentService.issueDataAuthorization({
          body,
          bodyBytes,
          rawTarget,
          authorizationHeader: request.headers["x-sfsc-authorization"]
        });
        writeJson(response, result);
        return;
      }
      if (rawTarget === CHANNEL_RENEWAL_PATH) {
        if (typeof enrollmentService.issueChannelRenewal !== "function") {
          throw createHttpError("enrollment_channel_not_ready", 503, "Channel renewal is unavailable");
        }
        const result = await enrollmentService.issueChannelRenewal({
          body,
          bodyBytes,
          rawTarget,
          authorizationHeader: request.headers["x-sfsc-authorization"]
        });
        writeJson(response, result);
        return;
      }
      const result = await enrollmentService.consume({
        body,
        bodyBytes,
        rawTarget,
        authorizationHeader: request.headers["x-sfsc-authorization"]
      });
      writeJson(response, result);
    } catch (error) {
      writeJsonError(response, error);
    }
  };

  function address() {
    const value = server?.address();
    return value && typeof value === "object" ? { address: value.address, family: value.family, port: value.port } : null;
  }

  async function start() {
    if (server?.listening) return address();
    if (starting) return starting;
    if (closing) await closing;
    server = createServer({ maxHeaderSize: 16 * 1024 }, handler);
    starting = withTimeout(new Promise((resolve, reject) => {
      const onError = (error) => {
        server.off("listening", onListening);
        reject(error);
      };
      const onListening = () => {
        server.off("error", onError);
        const bound = address();
        if (!bound || bound.address !== "127.0.0.1") {
          reject(new Error("bootstrap gateway did not bind to loopback"));
          return;
        }
        resolve(bound);
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen({ host, port, exclusive: true });
    }), START_TIMEOUT_MS, "bootstrap gateway start timed out").finally(() => { starting = null; });
    return starting;
  }

  async function close() {
    if (closing) return closing;
    if (starting) await starting.catch(() => {});
    if (!server?.listening) return;
    closing = withTimeout(new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
      server.closeAllConnections?.();
    }), CLOSE_TIMEOUT_MS, "bootstrap gateway close timed out").finally(() => {
      server = null;
      closing = null;
    });
    return closing;
  }

  return Object.freeze({ start, close, address });
}
