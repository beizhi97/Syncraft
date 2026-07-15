import { createHttpError } from "./errors.js";

export const MAX_JSON_BODY_BYTES = 2 * 1024 * 1024;

export function assertJsonWriteContentType(req) {
  const contentTypeHeader = String(req.headers["content-type"] || "").trim().toLowerCase();
  if (contentTypeHeader) {
    if (contentTypeHeader.split(";")[0].trim() !== "application/json") {
      throw createHttpError("unsupported_media_type", 415, "POST requests with a body must use application/json");
    }
    return;
  }

  const contentLength = Number(req.headers["content-length"] || 0);
  if (contentLength > 0 || req.headers["transfer-encoding"]) {
    throw createHttpError("unsupported_media_type", 415, "POST requests with a body must use application/json");
  }
}

export async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    if (size + bytes.length > MAX_JSON_BODY_BYTES) {
      throw createHttpError("request_body_too_large", 413, "Request body too large");
    }
    size += bytes.length;
    chunks.push(bytes);
  }
  if (size === 0) return {};
  const raw = Buffer.concat(chunks, size).toString("utf8");
  try {
    return JSON.parse(raw);
  } catch {
    throw createHttpError("invalid_json", 400, "Invalid JSON");
  }
}
