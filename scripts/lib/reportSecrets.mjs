import { writeFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";

const SENSITIVE_REPORT_PATTERNS = [
  ["SyncKey", /SFSC1-[A-Za-z0-9_-]+/],
  ["sfsc import URI", /sfsc:\/\/import\/v1#/i],
  ["VLESS URI", /vless:\/\//i],
  ["SSH private key", /-----BEGIN OPENSSH PRIVATE KEY-----|BEGIN OPENSSH PRIVATE KEY/i],
  ["private key", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ["admin token assignment", /\b(?:SFSC_ADMIN_TOKEN|ADMIN_TOKEN)\s*[:=]\s*["']?[^"',\s*.<>][^"',\s]*/i],
  ["S3 secret assignment", /\b(?:S3_SECRET_ACCESS_KEY|MINIO_ROOT_PASSWORD)\s*[:=]\s*["']?[^"',\s*.<>][^"',\s]*/i],
  ["secretAccessKey field", /["']?secretAccessKey["']?\s*[:=]\s*["'](?!\*{2,}|redacted|\[redacted\]|<redacted>|safe-|example|secretRef\b)[^"']{4,}["']/i],
  ["heartbeatSecret field", /["']?heartbeatSecret["']?\s*[:=]\s*["'](?!\*{2,}|redacted|\[redacted\]|<redacted>|safe-|example|secretRef\b)[^"']{4,}["']/i],
  ["heartbeat secret field", /["']?heartbeat\.secret["']?\s*[:=]\s*["'](?!\*{2,}|redacted|\[redacted\]|<redacted>|safe-|example|secretRef\b)[^"']{4,}["']/i]
];

export function assertReportSafe(value, label = "report") {
  const text = typeof value === "string" ? value : JSON.stringify(value) || "";
  for (const [name, pattern] of SENSITIVE_REPORT_PATTERNS) {
    if (pattern.test(text)) {
      throw new Error(`${label} contains sensitive-looking ${name}; refusing to write report.`);
    }
  }
}

export function stringifyReportJson(value, label = "JSON report") {
  assertReportSafe(value, label);
  return `${JSON.stringify(value, null, 2)}\n`;
}

export function writeJsonReportSync(path, value, label = path) {
  const body = stringifyReportJson(value, label);
  writeFileSync(path, body, "utf8");
}

export async function writeJsonReport(path, value, label = path) {
  const body = stringifyReportJson(value, label);
  await writeFile(path, body, "utf8");
}

export function writeTextReportSync(path, value, label = path) {
  assertReportSafe(value, label);
  writeFileSync(path, value, "utf8");
}

export async function writeTextReport(path, value, label = path) {
  assertReportSafe(value, label);
  await writeFile(path, value, "utf8");
}
