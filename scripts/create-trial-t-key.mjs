import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { writeJsonReportSync } from "./lib/reportSecrets.mjs";

const projectRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const baseUrl = normalizeBaseUrl(readArg("--base-url") || process.env.SFSC_TRIAL_SERVER_BASE_URL || "http://192.168.1.254:5177");
const adminToken = readArg("--admin-token") || process.env.SFSC_ADMIN_TOKEN || process.env.ADMIN_TOKEN || "";
const clientName = readArg("--client-name") || process.env.SFSC_TRIAL_CLIENT_NAME || `internal-trial-${timestampSlug()}`;
const expiresInHours = readNumberArg("--expires-in-hours", process.env.SFSC_TRIAL_T_KEY_EXPIRES_IN_HOURS, 2);
const jsonReportPath = repoPath(readArg("--json-report") || "reports/internal-trial/trial-t-key-report.json");
const printTKey = hasArg("--print-t-key");

try {
  const result = await createTrialTKey();
  mkdirSync(dirname(jsonReportPath), { recursive: true });
  writeJsonReportSync(jsonReportPath, result.report, "trial SyncKey report");

  console.log(`Trial SyncKey report written: ${jsonReportPath}`);
  console.log(`- clientName: ${result.report.claim.clientName}`);
  console.log(`- claimCode: ${result.report.claim.code}`);
  console.log(`- tKeySha256: ${result.report.tKey.sha256}`);
  console.log(`- tKeyPlaintextStored: ${result.report.safety.tKeyPlaintextStored}`);
  if (printTKey) {
    console.log("");
    console.log("ONE-TIME PLAINTEXT SyncKey. Copy it now; it was not written to the JSON report.");
    console.log(result.tKey);
  } else {
    console.log("- plaintext SyncKey not printed; rerun with --print-t-key only when a human is ready to copy it.");
  }
} catch (error) {
  console.error(`Trial SyncKey creation failed: ${error.message || error}`);
  process.exitCode = 1;
}

async function createTrialTKey() {
  if (!adminToken.trim()) {
    throw new Error("Missing admin token. Set SFSC_ADMIN_TOKEN or ADMIN_TOKEN, or pass --admin-token.");
  }
  if (!Number.isFinite(expiresInHours) || expiresInHours <= 0) {
    throw new Error("--expires-in-hours must be a positive number.");
  }

  const response = await fetch(`${baseUrl}/api/claims/create`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${adminToken.trim()}`
    },
    body: JSON.stringify({
      clientName,
      server: baseUrl,
      expiresInHours
    })
  });
  const payload = await readJsonResponse(response);
  if (!response.ok || payload?.ok === false) {
    const code = payload?.errorCode || payload?.error || `http_${response.status}`;
    const message = payload?.message || response.statusText || "claim create request failed";
    throw new Error(`${code}: ${message}`);
  }
  validateClaimCreatePayload(payload);

  const tKey = payload.tKey;
  const tKeyUri = payload.tKeyUri;
  const report = {
    schemaVersion: 1,
    app: "singbox-folder-sync",
    type: "trial-t-key-report",
    generatedAt: new Date().toISOString(),
    server: {
      baseUrl
    },
    request: {
      clientName,
      expiresInHours
    },
    claim: {
      code: payload.code,
      clientName: payload.claim.clientName,
      bucketName: payload.claim.bucketName || "",
      profileId: payload.claim.profileId || "",
      createdAt: payload.claim.createdAt || "",
      expiresAt: payload.claim.expiresAt || null,
      server: payload.claim.server || baseUrl,
      used: payload.claim.used === true
    },
    tKey: {
      sha256: sha256(tKey),
      length: tKey.length,
      uriSha256: sha256(tKeyUri),
      uriLength: tKeyUri.length,
      printedToStdout: printTKey
    },
    nextCommands: {
      setTKeyEnv: "$env:SFSC_TRIAL_T_KEY=\"<完整 SyncKey>\"",
      prepare: "pnpm run trial:prepare",
      profilePreview: "pnpm run trial:client-runner",
      realSync: "pnpm run trial:client-runner -- --run-sync --i-understand-real-sync",
      recordTKeyProfile: `pnpm run trial:record:update -- --section t-key-profile --status passed --notes "SyncKey generated for ${clientName}; report ${rel(jsonReportPath)}; sha256 ${sha256(tKey).slice(0, 12)}..."`
    },
    safety: {
      adminTokenStored: false,
      tKeyPlaintextStored: false,
      tKeyUriPlaintextStored: false,
      note: "The JSON report stores only hashes and lengths; plaintext SyncKey and sfsc:// import URI are never written to this file."
    }
  };

  assertReportDoesNotContainSecrets(report, [adminToken, tKey, tKeyUri]);
  return {
    tKey,
    report
  };
}

async function readJsonResponse(response) {
  const text = await response.text();
  if (!text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Server returned non-JSON response (HTTP ${response.status}).`);
  }
}

function validateClaimCreatePayload(payload) {
  if (!payload || typeof payload !== "object") {
    throw new Error("Claim create response must be a JSON object.");
  }
  if (!/^SFSC1-/.test(String(payload.tKey || ""))) {
    throw new Error("Claim create response is missing a full SFSC1 SyncKey.");
  }
  if (!/^sfsc:\/\/import\/v1#/.test(String(payload.tKeyUri || ""))) {
    throw new Error("Claim create response is missing a full sfsc:// import URI.");
  }
  if (!/^[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(String(payload.code || ""))) {
    throw new Error("Claim create response is missing an AAAA-AAAA claim code.");
  }
  if (!payload.claim || typeof payload.claim !== "object") {
    throw new Error("Claim create response is missing a safe claim summary.");
  }
}

function assertReportDoesNotContainSecrets(report, sensitiveValues) {
  const text = JSON.stringify(report);
  for (const value of sensitiveValues) {
    const secret = String(value || "").trim();
    if (secret && text.includes(secret)) {
      throw new Error("Refusing to write trial SyncKey report because it contains sensitive plaintext.");
    }
  }
  if (/SFSC1-[A-Za-z0-9_-]+/.test(text) || /sfsc:\/\/import\/v1#/i.test(text)) {
    throw new Error("Refusing to write trial SyncKey report because it contains a SyncKey or import URI.");
  }
}

function normalizeBaseUrl(value) {
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error("--base-url must be an http(s) URL.");
  }
  url.pathname = url.pathname.replace(/\/+$/, "");
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}

function readNumberArg(name, envValue, fallback) {
  const value = readArg(name) || envValue || String(fallback);
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`${name} must be a number.`);
  }
  return parsed;
}

function sha256(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}

function repoPath(path) {
  return resolve(projectRoot, path || "");
}

function rel(path) {
  return relative(projectRoot, resolve(path)).replaceAll("\\", "/");
}

function timestampSlug() {
  return new Date().toISOString().replace(/[-:T.Z]/g, "").slice(0, 14);
}

function readArg(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? "" : process.argv[index + 1] || "";
}

function hasArg(name) {
  return process.argv.includes(name);
}
