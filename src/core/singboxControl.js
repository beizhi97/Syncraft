import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createHttpError } from "./errors.js";

export async function requestSingboxRestart(options = {}) {
  const controlDir = String(options.controlDir || "").trim();
  const expectedConfigSha256 = String(options.expectedConfigSha256 || "").trim().toLowerCase();
  if (!controlDir) {
    throw createHttpError("singbox_restart_unavailable", 503, "sing-box restart supervisor is not configured");
  }
  if (!/^[a-f0-9]{64}$/.test(expectedConfigSha256)) {
    throw createHttpError("singbox_restart_unavailable", 503, "sing-box restart requires an expected config SHA-256");
  }

  const timeoutMs = positiveNumber(options.timeoutMs, 20000);
  const pollIntervalMs = positiveNumber(options.pollIntervalMs, 100);
  const requestId = randomBytes(12).toString("hex");
  const requestPath = join(controlDir, `restart-request-${requestId}-${expectedConfigSha256}.json`);
  const requestTempPath = `${requestPath}.tmp`;
  const resultPath = join(controlDir, `restart-result-${requestId}.json`);
  await mkdir(controlDir, { recursive: true });
  await writeFile(requestTempPath, JSON.stringify({
    requestId,
    expectedConfigSha256,
    requestedAt: new Date().toISOString()
  }), "utf8");
  await rename(requestTempPath, requestPath);

  const deadline = Date.now() + timeoutMs;
  try {
    while (Date.now() < deadline) {
      const result = await readResult(resultPath);
      if (result) {
        if (result.requestId !== requestId) {
          throw createHttpError("singbox_restart_failed", 502, "sing-box supervisor returned a mismatched request id");
        }
        if (result.configSha256 !== expectedConfigSha256) {
          throw createHttpError("singbox_restart_failed", 502, "sing-box supervisor applied an unexpected config version");
        }
        if (result.ok !== true) {
          throw createHttpError("singbox_restart_failed", 502, result.message || "sing-box restart failed");
        }
        return {
          ok: true,
          message: String(result.message || "sing-box restarted"),
          restartedAt: result.restartedAt || null,
          configSha256: expectedConfigSha256
        };
      }
      await delay(pollIntervalMs);
    }
    throw createHttpError("singbox_restart_timeout", 504, "Timed out waiting for the sing-box restart supervisor");
  } finally {
    await Promise.all([
      rm(requestPath, { force: true }),
      rm(requestTempPath, { force: true }),
      rm(resultPath, { force: true })
    ]);
  }
}

async function readResult(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    if (error instanceof SyntaxError) {
      throw createHttpError("singbox_restart_failed", 502, "sing-box supervisor returned invalid JSON");
    }
    throw error;
  }
}

function positiveNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
