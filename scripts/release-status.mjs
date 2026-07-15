import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assertReportSafe } from "./lib/reportSecrets.mjs";
import { releaseBundlePaths } from "./lib/releasePaths.mjs";

const defaultProjectRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const projectRoot = resolve(readArg("--repo-root") || defaultProjectRoot);
const asJson = hasArg("--json");
const failOnNotReady = hasArg("--fail-on-not-ready");

try {
  const report = buildReleaseStatus();
  assertReportSafe(report, "release status summary");
  if (asJson) {
    console.log(`${JSON.stringify(report, null, 2)}`);
  } else {
    printTextSummary(report);
  }
  if (!report.ok && failOnNotReady) {
    process.exitCode = 1;
  }
} catch (error) {
  console.error(`Release status failed: ${error.message || error}`);
  process.exitCode = 1;
}

function buildReleaseStatus() {
  const release = releaseBundlePaths(projectRoot);
  const bundleManifestPath = release.manifest;
  const bundleZipPath = release.zip;
  const bundleShaPath = release.sha256;
  const n1LatestPath = "reports/n1/latest-post-deploy.json";
  const bundledPreflightPath = rel(resolve(dirname(repoPath(bundleManifestPath)), "reports", "release-bundle", "preflight.json"));
  const preflightPath = existsSync(repoPath(bundledPreflightPath)) ? bundledPreflightPath : "reports/release/preflight.json";

  const preflight = readOptionalJson(preflightPath);
  const bundleManifest = readOptionalJson(bundleManifestPath);
  const n1Latest = readOptionalJson(n1LatestPath);
  const n1Summary = readOptionalJson(n1Latest?.summaryJson || "");
  const bundleSha256 = readSha256Sidecar(bundleShaPath);
  const currentSource = currentSourceFingerprint();
  const hashAgreement = sourceHashAgreement(preflight, bundleManifest, n1Summary, currentSource);
  if (currentSource.checked) {
    currentSource.ok = hashAgreement.ok;
  }
  const ok = Boolean(
    preflight?.releaseOk === true
      && preflight?.summary?.failed === 0
      && preflight?.summary?.skipped === 0
      && bundleManifest?.preflightVerified === true
      && existsSync(repoPath(bundleZipPath))
      && bundleSha256
      && n1Latest?.ok === true
      && n1Summary?.ok === true
      && n1Summary?.acceptance?.releaseAcceptance?.ok === true
      && n1Summary?.acceptance?.releaseAcceptance?.finalRestartClear === true
      && currentSource.ok !== false
      && hashAgreement.ok
  );

  return {
    schemaVersion: 1,
    app: "singbox-folder-sync",
    type: "release-status-summary",
    ok,
    generatedAt: new Date().toISOString(),
    preflight: {
      path: preflightPath,
      exists: preflight !== null,
      releaseOk: preflight?.releaseOk === true,
      summary: preflight?.summary || null,
      buildId: preflight?.context?.BuildId || "",
      sourceTreeHash: preflight?.context?.SourceTreeHash || preflight?.context?.SourceFingerprint?.hash || ""
    },
    releaseBundle: {
      version: release.version,
      manifestPath: bundleManifestPath,
      zipPath: bundleZipPath,
      exists: existsSync(repoPath(bundleZipPath)),
      sha256: bundleSha256,
      buildId: bundleManifest?.buildId || "",
      sourceTreeHash: bundleManifest?.sourceTreeHash || bundleManifest?.sourceFingerprint?.hash || "",
      generatedAt: bundleManifest?.generatedAt || "",
      preflightVerified: bundleManifest?.preflightVerified === true,
      preflightSummary: bundleManifest?.preflightVerification?.summary || bundleManifest?.preflight?.summary || null
    },
    n1: {
      latestPath: n1LatestPath,
      latestOk: n1Latest?.ok === true,
      runId: n1Latest?.runId || n1Summary?.runId || "",
      summaryPath: n1Latest?.summaryJson ? rel(n1Latest.summaryJson) : "",
      summaryOk: n1Summary?.ok === true,
      releaseAcceptanceOk: n1Summary?.acceptance?.releaseAcceptance?.ok === true,
      releaseBundleVerified: n1Summary?.acceptance?.releaseAcceptance?.releaseBundleVerified === true,
      finalRestartClear: n1Summary?.acceptance?.releaseAcceptance?.finalRestartClear === true,
      restartRequired: n1Summary?.acceptance?.releaseAcceptance?.restartRequired === false ? false : n1Summary?.acceptance?.releaseAcceptance?.restartRequired,
      targetHostsMatch: n1Summary?.acceptance?.target?.targetHostsMatch === true,
      buildId: n1Summary?.acceptance?.delivery?.releaseBundle?.buildId || "",
      sourceTreeHash: n1Summary?.acceptance?.delivery?.releaseBundle?.sourceTreeHash || ""
    },
    currentSource,
    sourceAlignment: hashAgreement,
    safety: {
      containsSecrets: false,
      note: "This summary is built from report status, hashes, paths, and stable release fields only."
    },
    nextAction: ok
      ? "Release evidence is ready for internal-trial or pilot support notes."
      : "Refresh client packages, strict preflight, release bundle, and N1 post-deploy latest until all gates are aligned."
  };
}

function printTextSummary(report) {
  const lines = [
    "SFSC release status",
    `ok=${report.ok}`,
    `preflight=${report.preflight.releaseOk ? "ok" : "not-ready"} passed=${report.preflight.summary?.passed ?? "n/a"} failed=${report.preflight.summary?.failed ?? "n/a"} skipped=${report.preflight.summary?.skipped ?? "n/a"}`,
    `bundle=${report.releaseBundle.preflightVerified ? "verified" : "not-verified"} buildId=${value(report.releaseBundle.buildId)} sha256=${value(report.releaseBundle.sha256)}`,
    `n1=${report.n1.latestOk && report.n1.summaryOk ? "ok" : "not-ready"} runId=${value(report.n1.runId)} releaseAcceptance=${report.n1.releaseAcceptanceOk ? "ok" : "not-ready"} finalRestartClear=${report.n1.finalRestartClear}`,
    `currentSource=${report.currentSource.checked ? (report.currentSource.ok ? "ok" : "mismatch") : "not-checked"} buildId=${value(report.currentSource.buildId)}`,
    `sourceAlignment=${report.sourceAlignment.ok ? "ok" : "mismatch"} buildId=${value(report.sourceAlignment.buildId)}`,
    `nextAction=${report.nextAction}`
  ];
  assertReportSafe(lines.join("\n"), "release status text");
  console.log(lines.join("\n"));
}

function sourceHashAgreement(preflight, bundleManifest, n1Summary, currentSource) {
  const entries = [
    ["preflight", preflight?.context?.SourceTreeHash || preflight?.context?.SourceFingerprint?.hash || ""],
    ["bundle", bundleManifest?.sourceTreeHash || bundleManifest?.sourceFingerprint?.hash || ""],
    ["n1", n1Summary?.acceptance?.delivery?.releaseBundle?.sourceTreeHash || ""],
    ["current", currentSource?.sourceTreeHash || ""]
  ].filter(([, hash]) => hash);
  const uniqueHashes = [...new Set(entries.map(([, hash]) => hash))];
  const buildEntries = [
    ["preflight", preflight?.context?.BuildId || ""],
    ["bundle", bundleManifest?.buildId || ""],
    ["n1", n1Summary?.acceptance?.delivery?.releaseBundle?.buildId || ""],
    ["current", currentSource?.buildId || ""]
  ].filter(([, buildId]) => buildId);
  const uniqueBuildIds = [...new Set(buildEntries.map(([, buildId]) => buildId))];
  return {
    ok: entries.length >= 3 && uniqueHashes.length === 1 && buildEntries.length >= 3 && uniqueBuildIds.length === 1,
    sourceTreeHash: uniqueHashes.length === 1 ? uniqueHashes[0] : "",
    buildId: uniqueBuildIds.length === 1 ? uniqueBuildIds[0] : "",
    entries: Object.fromEntries(entries),
    buildIds: Object.fromEntries(buildEntries)
  };
}

function currentSourceFingerprint() {
  const powershellFingerprint = currentSourceFingerprintFromPowerShell();
  if (powershellFingerprint) {
    return powershellFingerprint;
  }
  const files = sourceFingerprintFiles();
  if (!files.length) {
    return {
      checked: false,
      ok: null,
      sourceTreeHash: "",
      buildId: "",
      fileCount: 0
    };
  }
  const entries = files.map((path) => {
    const stats = statSync(path);
    return {
      path: rel(path),
      size: stats.size,
      sha256: sha256Buffer(readFileSync(path))
    };
  });
  const hashInput = entries.map((entry) => `${entry.path}\t${entry.size}\t${entry.sha256}`).join("\n");
  const sourceTreeHash = sha256Text(hashInput);
  return {
    checked: true,
    ok: true,
    algorithm: "sfsc-source-tree-sha256-v1",
    sourceTreeHash,
    buildId: `sfsc-${sourceTreeHash.slice(0, 12)}`,
    fileCount: entries.length
  };
}

function currentSourceFingerprintFromPowerShell() {
  const scriptPath = repoPath("scripts/lib/build-fingerprint.ps1");
  if (!existsSync(scriptPath)) {
    return null;
  }
  try {
    const command = [
      `. ${psQuote(scriptPath)}`,
      `$fp = Get-SourceTreeFingerprint ${psQuote(projectRoot)}`,
      "[pscustomobject]@{algorithm=$fp.algorithm;sourceTreeHash=$fp.hash;buildId=$fp.buildId;fileCount=$fp.fileCount} | ConvertTo-Json -Compress"
    ].join("; ");
    const stdout = execFileSync("powershell", ["-NoProfile", "-Command", command], {
      cwd: projectRoot,
      encoding: "utf8",
      windowsHide: true
    });
    const parsed = JSON.parse(stdout);
    return {
      checked: true,
      ok: true,
      algorithm: parsed.algorithm || "sfsc-source-tree-sha256-v1",
      sourceTreeHash: parsed.sourceTreeHash || "",
      buildId: parsed.buildId || "",
      fileCount: Number(parsed.fileCount) || 0
    };
  } catch {
    return null;
  }
}

function sourceFingerprintFiles() {
  const roots = [
    "package.json",
    "pnpm-lock.yaml",
    "pnpm-workspace.yaml",
    "README.md",
    "src",
    "public",
    "server/Dockerfile",
    "server/sing-box.Dockerfile",
    "server/sing-box-supervisor.sh",
    "server/.env.example",
    "server/docker-compose.yml",
    "server/docker-compose.n1.yml",
    "server/sing-box/config.example.json",
    "client/src",
    "client/public",
    "client/electron",
    "client/scripts",
    "docs",
    "scripts",
    "tests"
  ];
  const files = [];
  for (const rootEntry of roots) {
    const resolved = repoPath(rootEntry);
    if (!existsSync(resolved)) continue;
    collectFingerprintFiles(resolved, files);
  }
  return [...new Set(files.filter((path) => !isFingerprintBlockedPath(rel(path))))]
    .sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
}

function collectFingerprintFiles(path, files) {
  const stats = statSync(path);
  if (stats.isDirectory()) {
    for (const entry of readdirSync(path)) {
      collectFingerprintFiles(resolve(path, entry), files);
    }
    return;
  }
  if (stats.isFile()) {
    files.push(path);
  }
}

function isFingerprintBlockedPath(path) {
  const normalized = path.replaceAll("\\", "/");
  return [
    /(^|\/)\.git(\/|$)/,
    /(^|\/)node_modules(\/|$)/,
    /(^|\/)\.tmp(\/|$)/,
    /(^|\/)dist(\/|$)/,
    /(^|\/)reports(\/|$)/,
    /(^|\/)\.env$/,
    /(^|\/)[^/]+\.env\.local$/,
    /^server\/\.env$/,
    /^server\/data(\/|$)/,
    /^server\/sing-box\/config\.json$/,
    /^server\/sing-box\/.*\.(key|pem)$/,
    /^client\/data(\/|$)/,
    /^client\/resources\/bin(\/|$)/
  ].some((pattern) => pattern.test(normalized));
}

function sha256Buffer(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

function sha256Text(text) {
  return createHash("sha256").update(String(text), "utf8").digest("hex");
}

function psQuote(input) {
  return `'${String(input).replaceAll("'", "''")}'`;
}

function readOptionalJson(path) {
  if (!path) return null;
  const resolved = repoPath(path);
  if (!existsSync(resolved)) return null;
  const parsed = JSON.parse(readFileSync(resolved, "utf8"));
  assertReportSafe(parsed, `release status input ${rel(resolved)}`);
  return parsed;
}

function readSha256Sidecar(path) {
  const resolved = repoPath(path);
  if (!existsSync(resolved)) return "";
  const text = readFileSync(resolved, "utf8").trim();
  assertReportSafe(text, `release status checksum ${rel(resolved)}`);
  const hash = text.split(/\s+/)[0]?.toLowerCase() || "";
  return /^[a-f0-9]{64}$/.test(hash) ? hash : "";
}

function repoPath(path) {
  if (!path) return "";
  return resolve(projectRoot, path);
}

function rel(path) {
  const resolved = resolve(path);
  return resolved.startsWith(projectRoot) ? resolved.slice(projectRoot.length + 1).replaceAll("\\", "/") : path;
}

function readArg(name) {
  const index = process.argv.indexOf(name);
  if (index === -1) return "";
  return process.argv[index + 1] || "";
}

function hasArg(name) {
  return process.argv.includes(name);
}

function value(input) {
  return input || "n/a";
}
