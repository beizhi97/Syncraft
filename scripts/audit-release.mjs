import { createHash } from "node:crypto";
import { readdir, readFile as readFileRaw, stat } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { inflateRawSync } from "node:zlib";
import { auditComposeConfig } from "./lib/composeAudit.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const issues = [];
const nonProductLanguagePattern = /\bMVP\b|\bdemo\b|\bprototype\b|proof of concept|\bPOC\b|演示版|样例版|试用版/i;

async function readFile(path, options) {
  const value = await readFileRaw(path, options);
  return typeof value === "string" ? value.replace(/\r\n?/g, "\n") : value;
}

const blockedPaths = [
  ".env",
  "server/.env",
  "server/data",
  "dist/SyncraftDesktop/data",
  "dist/SyncraftClient/data"
];

const allowedSecretFixtures = [
  "change-this-admin-token",
  "change-this-minio-root-password",
  "replace-with-strong-admin-token",
  "replace-with-strong-password",
  "CHANGE_ME_CLIENT_SECRET",
  "secret-for-test",
  "top-secret-value",
  "another-secret",
  "json-secret",
  "spaced-secret",
  "super-secret-management-key",
  "global-storage-secret"
];

for (const path of blockedPaths) {
  if (await exists(join(root, path))) {
    issues.push(`Blocked runtime path exists: ${path}`);
  }
}

await auditSingboxPlaceholderConfig();
await auditComposeConfig(root).then((composeIssues) => issues.push(...composeIssues));
await auditClientPackageChecksum();
await auditReleaseBundleChecksum();
await auditClientPackageManifestContractConsistency();
await auditProductContractDocs();
await auditProductIdentity();
await auditSmokeContractDocs();
await auditOperationalRecoveryDocs();
await auditInternalTrialChecklist();
await auditPilotDocs();
await auditStableErrorCodeContract();
await auditStableErrorCodeUiMessages();
await auditClaimCreateUiGuidanceContract();
await auditClaimRedeemPreviewUiGuidanceContract();
await auditValidationFailedHttpCoverage();
await auditRuntimeDiagnosticsContract();
await auditProtocolV1Baseline();
await auditHttpRuntimeProtocolDocs();
await auditLegacyAdminUserMigrationContract();
await auditHeartbeatAuthContract();
await auditHeartbeatSchedulerContract();
await auditHeartbeatRemoteErrorCodeContract();
await auditHeartbeatSuccessContractValidation();
await auditHeartbeatDiagnosticProtocolDocs();
await auditClaimProfileProtocolDocs();
await auditSyncRunTriggerContract();
await auditCompatibilityWarningContract();
await auditServerDeviceFilterContract();
await auditDestructiveSyncConfirmationContract();
await auditLocalStateCorruptionContract();
await auditClaimRedeemRecoveryContract();
await auditInterfaceRouteContract();
await auditApiMatrixContract();
await auditServerWriteInterfaceMap();
await auditClientLocalInterfaceMap();
await auditProtocolRequestSchemaCoverage();
await auditProductizedLanguage();

for await (const file of walk(root)) {
  const rel = normalizePath(relative(root, file));
  if (shouldSkip(rel)) continue;
  const text = await readFile(file, "utf8").catch(() => "");
  if (!text) continue;
  auditText(rel, text);
}

if (issues.length) {
  console.error("Release audit failed:");
  for (const issue of issues) {
    console.error(`- ${issue}`);
  }
  process.exitCode = 1;
} else {
  console.log("Release audit passed.");
}

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function* walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    const rel = normalizePath(relative(root, path));
    if (shouldSkip(rel)) continue;
    if (entry.isDirectory()) {
      yield* walk(path);
    } else if (entry.isFile()) {
      yield path;
    }
  }
}

function shouldSkip(rel) {
  const parts = rel.split("/");
  return (
    rel === "" ||
    parts.includes("node_modules") ||
    parts.includes(".git") ||
    parts.includes(".tmp") ||
    parts.includes("dist") ||
    rel === "pnpm-lock.yaml" ||
    rel.endsWith(".exe") ||
    rel.endsWith(".zip") ||
    rel.endsWith(".tgz") ||
    rel.endsWith(".png") ||
    rel.endsWith(".jpg") ||
    rel.endsWith(".jpeg")
  );
}

function auditText(rel, text) {
  const lines = text.split(/\r?\n/);
  lines.forEach((line, index) => {
    if (allowedSecretFixtures.some((fixture) => line.includes(fixture))) {
      return;
    }
    if (/SFSC_ADMIN_TOKEN\s*=\s*[^.\s#][^\s#]{12,}/.test(line)) {
      issues.push(`${rel}:${index + 1} looks like a real admin token`);
    }
    if (/MINIO_ROOT_PASSWORD\s*=\s*[^.\s#][^\s#]{12,}/.test(line)) {
      issues.push(`${rel}:${index + 1} looks like a real MinIO password`);
    }
    if (/(private[_-]?key|secret[_-]?access[_-]?key)["']?\s*[:=]\s*["']?[A-Za-z0-9_/-]{24,}/i.test(line)) {
      issues.push(`${rel}:${index + 1} looks like a real private/storage secret`);
    }
  });
}

async function auditSingboxPlaceholderConfig() {
  const configPath = join(root, "server/sing-box/config.json");
  if (!await exists(configPath)) {
    return;
  }
  const text = await readFile(configPath, "utf8");
  if (/private_key/i.test(text)) {
    issues.push("server/sing-box/config.json contains a REALITY private_key");
  }
  const uuids = [...text.matchAll(/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/gi)]
    .map((match) => match[0].toLowerCase());
  const allowedUuid = "00000000-0000-4000-8000-000000000000";
  for (const uuid of uuids) {
    if (uuid !== allowedUuid) {
      issues.push("server/sing-box/config.json contains a non-placeholder UUID");
    }
  }
}

async function auditClientPackageChecksum() {
  await auditZipChecksum("SyncraftDesktop");
  await auditZipChecksum("SyncraftClient");
}

async function auditReleaseBundleChecksum() {
  const bundleDir = join(root, "dist", "release-bundles");
  if (!await exists(bundleDir)) {
    return;
  }
  let entries = [];
  try {
    entries = await readdir(bundleDir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".zip")) {
      continue;
    }
    await auditReleaseBundleZip(entry.name.slice(0, -4));
  }
}

async function auditReleaseBundleZip(bundleName) {
  const zipPath = join(root, "dist", "release-bundles", `${bundleName}.zip`);
  const checksumPath = join(root, "dist", "release-bundles", `${bundleName}.zip.sha256`);
  const relZip = `dist/release-bundles/${bundleName}.zip`;
  const relChecksum = `dist/release-bundles/${bundleName}.zip.sha256`;
  if (!await exists(checksumPath)) {
    issues.push(`${relZip} is missing ${relChecksum}`);
    return;
  }
  const checksum = (await readFile(checksumPath, "utf8")).trim().split(/\s+/)[0]?.toLowerCase() || "";
  if (!/^[a-f0-9]{64}$/.test(checksum)) {
    issues.push(`${relChecksum} does not start with a SHA256 hash`);
    return;
  }
  const zipData = await readFile(zipPath);
  const actual = createHash("sha256").update(zipData).digest("hex");
  if (checksum !== actual) {
    issues.push(`${relChecksum} does not match ${relZip}`);
    return;
  }

  let zipEntries;
  try {
    zipEntries = readZipEntries(zipData);
  } catch (error) {
    issues.push(`${relZip} could not be inspected: ${error.message}`);
    return;
  }
  auditReleaseBundleZipEntries(bundleName, relZip, zipEntries);
}

function auditReleaseBundleZipEntries(bundleName, relZip, zipEntries) {
  const requiredEntries = [
    "release-bundle-manifest.json",
    "scripts/lib/build-fingerprint.ps1",
    "scripts/lib/runtimeContracts.mjs",
    "scripts/smoke-client.mjs",
    "scripts/smoke-client-package.mjs",
    "scripts/smoke-electron-e2e.mjs",
    "scripts/release-status.mjs",
    "scripts/record-internal-trial.mjs",
    "scripts/prepare-internal-trial.mjs",
    "scripts/create-trial-t-key.mjs",
    "scripts/internal-trial-assistant.mjs",
    "scripts/client-trial-runner.mjs",
    "scripts/prepare-pilot-wave.mjs",
    "scripts/pilot-summary.mjs",
    "docs/DEPLOYMENT_AND_MIGRATION_GUIDE.md",
    "docs/INTERNAL_TRIAL_CHECKLIST.md",
    "docs/PILOT_RUNBOOK.md",
    "docs/PILOT_ACCEPTANCE_CRITERIA.md",
    "docs/PILOT_SUPPORT_GUIDE.md",
    "docs/INTERFACE_CONTRACT.md",
    "docs/API_MATRIX.md"
  ];
  for (const entry of requiredEntries) {
    if (!zipEntries.has(`${bundleName}/${entry}`)) {
      issues.push(`${relZip} is missing release bundle entry ${bundleName}/${entry}`);
    }
  }
  auditPilotDocZipContent(zipEntries, relZip, `${bundleName}/docs`);
  for (const blocked of [
    `${bundleName}/.env`,
    `${bundleName}/server/.env`,
    `${bundleName}/server/data/`,
    `${bundleName}/server/sing-box/config.json`,
    `${bundleName}/client/data/`,
    `${bundleName}/.tmp/`,
    `${bundleName}/node_modules/`
  ]) {
    if (zipEntriesIncludeBlockedPath([...zipEntries.keys()], blocked)) {
      issues.push(`${relZip} contains blocked runtime entry ${blocked}`);
    }
  }

  const manifestEntry = `${bundleName}/release-bundle-manifest.json`;
  const manifestData = zipEntries.get(manifestEntry);
  if (!manifestData) {
    return;
  }
  let manifest;
  try {
    manifest = JSON.parse(manifestData.toString("utf8"));
  } catch (error) {
    issues.push(`${relZip} release-bundle-manifest.json could not be parsed: ${error.message}`);
    return;
  }
  if (manifest.type !== "release-bundle-manifest") {
    issues.push(`${relZip} release-bundle-manifest.json has unexpected type`);
  }
  if (!/^[a-f0-9]{64}$/.test(manifest.sourceTreeHash || "")) {
    issues.push(`${relZip} release-bundle-manifest.json must include sourceTreeHash`);
  }
  if (manifest.buildId !== `sfsc-${String(manifest.sourceTreeHash || "").slice(0, 12)}`) {
    issues.push(`${relZip} release-bundle-manifest.json buildId must match sourceTreeHash`);
  }
  if (!manifest.clientPackages?.desktop || !manifest.clientPackages?.portable) {
    issues.push(`${relZip} release-bundle-manifest.json must include clientPackages desktop and portable summaries`);
  } else {
    for (const packageName of [manifest.clientPackages.desktop.package, manifest.clientPackages.portable.package]) {
      if (!/^[A-Za-z0-9]+$/.test(String(packageName || ""))) {
        issues.push(`${relZip} release-bundle-manifest.json has an invalid client package name`);
        continue;
      }
      for (const suffix of [".zip", ".zip.sha256", ".release-manifest.json"]) {
        const artifact = `release-artifacts/windows-client/${packageName}${suffix}`;
        if (!zipEntries.has(`${bundleName}/${artifact}`)) {
          issues.push(`${relZip} is missing release bundle entry ${bundleName}/${artifact}`);
        }
      }
    }
    for (const [name, clientPackage] of Object.entries(manifest.clientPackages)) {
      if (clientPackage.sourceTreeHash !== manifest.sourceTreeHash) {
        issues.push(`${relZip} release-bundle-manifest.json ${name} sourceTreeHash must match bundle sourceTreeHash`);
      }
      if (clientPackage.buildId !== manifest.buildId) {
        issues.push(`${relZip} release-bundle-manifest.json ${name} buildId must match bundle buildId`);
      }
    }
  }
  if (manifest.preflightVerified === true) {
    const bundledReports = Array.isArray(manifest.preflight?.bundledReports)
      ? manifest.preflight.bundledReports
      : [];
    for (const reportName of [
      "reports/release-bundle/preflight.json",
      "reports/release-bundle/client-package-smoke-desktop.json",
      "reports/release-bundle/client-package-smoke-portable.json"
    ]) {
      const report = bundledReports.find((item) => item?.path === reportName);
      if (!report) {
        issues.push(`${relZip} release bundle manifest must record bundled report ${reportName}`);
        continue;
      }
      const reportEntry = `${bundleName}/${reportName}`;
      const reportData = zipEntries.get(reportEntry);
      if (!reportData) {
        issues.push(`${relZip} is missing release bundle preflight report ${reportEntry}`);
        continue;
      }
      const actualHash = createHash("sha256").update(reportData).digest("hex");
      if (report.sha256 !== actualHash) {
        issues.push(`${relZip} bundled report ${reportName} does not match release-bundle-manifest.json SHA256`);
      }
    }
  }
}

async function auditZipChecksum(packageName) {
  const zipPath = join(root, "dist", `${packageName}.zip`);
  const checksumPath = join(root, "dist", `${packageName}.zip.sha256`);
  const relZip = `dist/${packageName}.zip`;
  const relChecksum = `dist/${packageName}.zip.sha256`;
  const zipExists = await exists(zipPath);
  const checksumExists = await exists(checksumPath);
  if (!zipExists && !checksumExists) {
    return;
  }
  if (!zipExists && checksumExists) {
    issues.push(`${relChecksum} exists without ${relZip}`);
    return;
  }
  if (zipExists && !checksumExists) {
    issues.push(`${relZip} is missing ${relChecksum}`);
    return;
  }

  const checksum = (await readFile(checksumPath, "utf8")).trim().split(/\s+/)[0]?.toLowerCase() || "";
  if (!/^[a-f0-9]{64}$/.test(checksum)) {
    issues.push(`${relChecksum} does not start with a SHA256 hash`);
    return;
  }
  const zipData = await readFile(zipPath);
  const actual = createHash("sha256").update(zipData).digest("hex");
  if (checksum !== actual) {
    issues.push(`${relChecksum} does not match ${relZip}`);
    return;
  }

  auditClientPackageZipEntries(packageName, relZip, zipData);
}

function auditClientPackageZipEntries(packageName, relZip, zipData) {
  let zipEntries;
  try {
    zipEntries = readZipEntries(zipData);
  } catch (error) {
    issues.push(`${relZip} could not be inspected: ${error.message}`);
    return;
  }
  const entries = [...zipEntries.keys()];
  const names = new Set(entries);
  const requiredEntries = packageName === "SyncraftClient" ? [
    `${packageName}/Syncraft.exe`,
    `${packageName}/release-manifest.json`,
    `${packageName}/app/package.json`,
    `${packageName}/app/client/src/clientServer.js`,
    `${packageName}/app/client/src/paths.js`,
    `${packageName}/app/client/src/store.js`,
    `${packageName}/app/client/src/diagnosticBundle.js`,
    `${packageName}/app/client/src/processRunner.js`,
    `${packageName}/app/client/src/rcloneStats.js`,
    `${packageName}/app/client/src/profileImport.js`,
    `${packageName}/app/client/src/launcher.cjs`,
    `${packageName}/app/client/src/Launcher.cs`,
    `${packageName}/app/client/public/index.html`,
    `${packageName}/app/client/public/app.js`,
    `${packageName}/app/client/public/styles.css`,
    `${packageName}/app/src/core/index.js`,
    `${packageName}/runtime/node.exe`,
    `${packageName}/resources/app/docs/INTERFACE_CONTRACT.md`,
    `${packageName}/resources/app/docs/API_MATRIX.md`,
    `${packageName}/resources/app/docs/DEPLOYMENT_AND_MIGRATION_GUIDE.md`,
    `${packageName}/resources/app/docs/INTERNAL_TRIAL_CHECKLIST.md`,
    `${packageName}/resources/app/docs/PILOT_RUNBOOK.md`,
    `${packageName}/resources/app/docs/PILOT_ACCEPTANCE_CRITERIA.md`,
    `${packageName}/resources/app/docs/PILOT_SUPPORT_GUIDE.md`,
    `${packageName}/resources/bin/win32/binaries.lock.json`,
    `${packageName}/resources/bin/win32/sing-box.exe`,
    `${packageName}/resources/bin/win32/rclone.exe`
  ] : [
    `${packageName}/Syncraft.exe`,
    `${packageName}/release-manifest.json`,
    `${packageName}/resources/app/package.json`,
    `${packageName}/resources/app/client/electron/main.cjs`,
    `${packageName}/resources/app/client/electron/preload.cjs`,
    `${packageName}/resources/app/client/src/clientServer.js`,
    `${packageName}/resources/app/client/src/paths.js`,
    `${packageName}/resources/app/client/src/store.js`,
    `${packageName}/resources/app/client/src/diagnosticBundle.js`,
    `${packageName}/resources/app/client/src/processRunner.js`,
    `${packageName}/resources/app/client/src/rcloneStats.js`,
    `${packageName}/resources/app/client/src/profileImport.js`,
    `${packageName}/resources/app/client/src/launcher.cjs`,
    `${packageName}/resources/app/client/src/Launcher.cs`,
    `${packageName}/resources/app/client/public/index.html`,
    `${packageName}/resources/app/client/public/app.js`,
    `${packageName}/resources/app/client/public/styles.css`,
    `${packageName}/resources/app/src/core/index.js`,
    `${packageName}/resources/app/docs/INTERFACE_CONTRACT.md`,
    `${packageName}/resources/app/docs/API_MATRIX.md`,
    `${packageName}/resources/app/docs/DEPLOYMENT_AND_MIGRATION_GUIDE.md`,
    `${packageName}/resources/app/docs/INTERNAL_TRIAL_CHECKLIST.md`,
    `${packageName}/resources/app/docs/PILOT_RUNBOOK.md`,
    `${packageName}/resources/app/docs/PILOT_ACCEPTANCE_CRITERIA.md`,
    `${packageName}/resources/app/docs/PILOT_SUPPORT_GUIDE.md`,
    `${packageName}/resources/bin/win32/binaries.lock.json`,
    `${packageName}/resources/bin/win32/sing-box.exe`,
    `${packageName}/resources/bin/win32/rclone.exe`
  ];
  for (const entry of requiredEntries) {
    if (!names.has(entry)) {
      issues.push(`${relZip} is missing packaged entry ${entry}`);
    }
  }
  auditPilotDocZipContent(zipEntries, relZip, `${packageName}/resources/app/docs`);
  for (const blocked of [
    `${packageName}/data/`,
    `${packageName}/resources/app/data/`,
    `${packageName}/resources/app/client/data/`,
    `${packageName}/resources/app/server/data/`,
    `${packageName}/resources/app/server/.env`,
    `${packageName}/resources/app/.env`
  ]) {
    if (zipEntriesIncludeBlockedPath(entries, blocked)) {
      issues.push(`${relZip} contains blocked runtime entry ${blocked}`);
    }
  }
  const manifestData = zipEntries.get(`${packageName}/release-manifest.json`);
  if (!manifestData) {
    return;
  }
  let manifest;
  try {
    manifest = JSON.parse(manifestData.toString("utf8"));
  } catch (error) {
    issues.push(`${relZip} release-manifest.json could not be parsed: ${error.message}`);
    return;
  }
  if (!/^[a-f0-9]{64}$/.test(manifest.sourceTreeHash || "")) {
    issues.push(`${relZip} release-manifest.json must include sourceTreeHash`);
  }
  if (manifest.buildId !== `sfsc-${String(manifest.sourceTreeHash || "").slice(0, 12)}`) {
    issues.push(`${relZip} release-manifest.json buildId must match sourceTreeHash`);
  }
  if (!manifest.sourceFingerprint || manifest.sourceFingerprint.hash !== manifest.sourceTreeHash || manifest.sourceFingerprint.buildId !== manifest.buildId) {
    issues.push(`${relZip} release-manifest.json sourceFingerprint must match sourceTreeHash and buildId`);
  }
}

function auditPilotDocZipContent(zipEntries, relZip, docPrefix) {
  const docs = [
    {
      path: `${docPrefix}/PILOT_RUNBOOK.md`,
      phrases: ["5-10 人小范围试点 Runbook", "参与者名册字段", "分批 rollout", "每日检查", "试点结束清理"]
    },
    {
      path: `${docPrefix}/PILOT_ACCEPTANCE_CRITERIA.md`,
      phrases: ["5-10 人小范围试点验收标准", "量化通过指标", ">= 90%", "P0", "P1"]
    },
    {
      path: `${docPrefix}/PILOT_SUPPORT_GUIDE.md`,
      phrases: ["5-10 人小范围试点支持指南", "支持入口", "首问脚本", "支持包内容", "关闭标准"]
    }
  ];
  for (const doc of docs) {
    const data = zipEntries.get(doc.path);
    if (!data) {
      continue;
    }
    const text = data.toString("utf8");
    for (const phrase of doc.phrases) {
      if (!text.includes(phrase)) {
        issues.push(`${relZip} packaged pilot doc ${doc.path} must mention ${phrase}`);
      }
    }
  }
}

function listZipEntries(zipData) {
  return [...readZipEntries(zipData).keys()];
}

function readZipEntries(zipData) {
  const eocdOffset = findEndOfCentralDirectory(zipData);
  if (eocdOffset < 0) {
    throw new Error("ZIP end of central directory not found");
  }
  const entryCount = zipData.readUInt16LE(eocdOffset + 10);
  const centralDirectorySize = zipData.readUInt32LE(eocdOffset + 12);
  const centralDirectoryOffset = zipData.readUInt32LE(eocdOffset + 16);
  const centralDirectoryEnd = centralDirectoryOffset + centralDirectorySize;
  if (centralDirectoryOffset < 0 || centralDirectoryEnd > zipData.length || centralDirectoryOffset > centralDirectoryEnd) {
    throw new Error("ZIP central directory is outside the archive");
  }

  const entries = new Map();
  let offset = centralDirectoryOffset;
  for (let index = 0; index < entryCount; index += 1) {
    if (offset + 46 > centralDirectoryEnd || zipData.readUInt32LE(offset) !== 0x02014b50) {
      throw new Error("ZIP central directory entry is invalid");
    }
    const nameLength = zipData.readUInt16LE(offset + 28);
    const extraLength = zipData.readUInt16LE(offset + 30);
    const commentLength = zipData.readUInt16LE(offset + 32);
    const nameStart = offset + 46;
    const nameEnd = nameStart + nameLength;
    const nextOffset = nameEnd + extraLength + commentLength;
    if (nameEnd > centralDirectoryEnd || nextOffset > centralDirectoryEnd) {
      throw new Error("ZIP central directory entry exceeds archive bounds");
    }
    const compressionMethod = zipData.readUInt16LE(offset + 10);
    const compressedSize = zipData.readUInt32LE(offset + 20);
    const uncompressedSize = zipData.readUInt32LE(offset + 24);
    const localHeaderOffset = zipData.readUInt32LE(offset + 42);
    const name = zipData.subarray(nameStart, nameEnd).toString("utf8").replaceAll("\\", "/");
    if (name) {
      entries.set(name, readZipEntryData(zipData, {
        name,
        compressionMethod,
        compressedSize,
        uncompressedSize,
        localHeaderOffset
      }));
    }
    offset = nextOffset;
  }
  return entries;
}

function readZipEntryData(zipData, entry) {
  if (entry.localHeaderOffset + 30 > zipData.length || zipData.readUInt32LE(entry.localHeaderOffset) !== 0x04034b50) {
    throw new Error(`ZIP local header is invalid for ${entry.name}`);
  }
  const localNameLength = zipData.readUInt16LE(entry.localHeaderOffset + 26);
  const localExtraLength = zipData.readUInt16LE(entry.localHeaderOffset + 28);
  const dataStart = entry.localHeaderOffset + 30 + localNameLength + localExtraLength;
  const dataEnd = dataStart + entry.compressedSize;
  if (dataStart > zipData.length || dataEnd > zipData.length || dataStart > dataEnd) {
    throw new Error(`ZIP entry data exceeds archive bounds for ${entry.name}`);
  }
  const data = zipData.subarray(dataStart, dataEnd);
  if (entry.compressionMethod === 0) {
    return data;
  }
  if (entry.compressionMethod === 8) {
    const inflated = inflateRawSync(data);
    if (entry.uncompressedSize !== inflated.length) {
      throw new Error(`ZIP entry size mismatch for ${entry.name}`);
    }
    return inflated;
  }
  throw new Error(`Unsupported ZIP compression method ${entry.compressionMethod} for ${entry.name}`);
}

function findEndOfCentralDirectory(zipData) {
  if (zipData.length < 22) {
    return -1;
  }
  const minOffset = Math.max(0, zipData.length - 22 - 0xffff);
  for (let offset = zipData.length - 22; offset >= minOffset; offset -= 1) {
    if (zipData.readUInt32LE(offset) === 0x06054b50) {
      return offset;
    }
  }
  return -1;
}

function zipEntriesIncludeBlockedPath(entries, blocked) {
  const normalized = blocked.replaceAll("\\", "/");
  if (normalized.endsWith("/")) {
    return entries.some((entry) => entry === normalized.slice(0, -1) || entry.startsWith(normalized));
  }
  return entries.includes(normalized);
}

async function auditClientPackageManifestContractConsistency() {
  const [
    clientServerSource,
    packageSmokeSource,
    buildDesktopSource,
    buildPortableSource,
    auditSource
  ] = await Promise.all([
    readFile(join(root, "client", "src", "clientServer.js"), "utf8").catch(() => ""),
    readFile(join(root, "scripts", "smoke-client-package.mjs"), "utf8").catch(() => ""),
    readFile(join(root, "client", "scripts", "build-desktop.ps1"), "utf8").catch(() => ""),
    readFile(join(root, "client", "scripts", "build-client.ps1"), "utf8").catch(() => ""),
    readFile(join(root, "scripts", "audit-release.mjs"), "utf8").catch(() => "")
  ]);

  for (const [label, text] of [
    ["client/src/clientServer.js", clientServerSource],
    ["scripts/smoke-client-package.mjs", packageSmokeSource],
    ["client/scripts/build-desktop.ps1", buildDesktopSource],
    ["client/scripts/build-client.ps1", buildPortableSource],
    ["scripts/audit-release.mjs", auditSource]
  ]) {
    if (!text) {
      issues.push(`${label} is missing for client package manifest contract audit`);
    }
  }
  if (!clientServerSource || !packageSmokeSource || !buildDesktopSource || !buildPortableSource || !auditSource) {
    return;
  }

  const runtimeDesktop = extractRuntimeRequiredManifestPaths(clientServerSource, "SyncraftDesktop");
  const runtimePortable = extractRuntimeRequiredManifestPaths(clientServerSource, "SyncraftClient");
  const smoke = extractPackageSmokeRequiredManifestPaths(packageSmokeSource);
  const buildDesktop = extractPowerShellManifestPaths(buildDesktopSource);
  const buildPortable = extractPowerShellManifestPaths(buildPortableSource);
  const zip = extractZipAuditRequiredEntries(auditSource);

  comparePathSets("client/scripts/build-desktop.ps1 manifest files", buildDesktop, runtimeDesktop);
  comparePathSets("client/scripts/build-client.ps1 manifest files", buildPortable, runtimePortable);
  comparePathSets("scripts/smoke-client-package.mjs desktop manifest files", smoke.desktop, runtimeDesktop);
  comparePathSets("scripts/smoke-client-package.mjs portable manifest files", smoke.portable, runtimePortable);
  comparePathSets("scripts/audit-release.mjs desktop ZIP entries", zip.desktop, ["release-manifest.json", ...runtimeDesktop]);
  comparePathSets("scripts/audit-release.mjs portable ZIP entries", zip.portable, ["release-manifest.json", ...runtimePortable, "runtime/node.exe"]);
}

function extractRuntimeRequiredManifestPaths(source, packageName) {
  const marker = `${packageName}: [`;
  const start = source.indexOf(marker);
  if (start < 0) {
    issues.push(`client/src/clientServer.js must define requiredManifestFilesByPackage.${packageName}`);
    return [];
  }
  const blockStart = start + marker.length;
  const blockEnd = source.indexOf("\n  ]", blockStart);
  if (blockEnd < 0) {
    issues.push(`client/src/clientServer.js requiredManifestFilesByPackage.${packageName} could not be parsed`);
    return [];
  }
  return uniqueSorted([...source.slice(blockStart, blockEnd).matchAll(/\["[^"]+",\s*"([^"]+)"\]/g)].map((match) => match[1]));
}

function extractPackageSmokeRequiredManifestPaths(source) {
  const marker = "const requiredFiles = manifest.package === \"SyncraftClient\" ? [";
  const start = source.indexOf(marker);
  if (start < 0) {
    issues.push("scripts/smoke-client-package.mjs requiredFiles ternary could not be found");
    return { portable: [], desktop: [] };
  }
  const portableStart = source.indexOf("[", start);
  const separator = source.indexOf("] : [", portableStart);
  const desktopEnd = source.indexOf("\n  ];", separator);
  if (portableStart < 0 || separator < 0 || desktopEnd < 0) {
    issues.push("scripts/smoke-client-package.mjs requiredFiles ternary could not be parsed");
    return { portable: [], desktop: [] };
  }
  return {
    portable: extractQuotedStrings(source.slice(portableStart, separator)),
    desktop: extractQuotedStrings(source.slice(separator, desktopEnd))
  };
}

function extractPowerShellManifestPaths(source) {
  return uniqueSorted([...source.matchAll(/@\{\s*name\s*=\s*"([^"]+)"/g)].map((match) => match[1]));
}

function extractZipAuditRequiredEntries(source) {
  const marker = "const requiredEntries = packageName === \"SyncraftClient\" ? [";
  const start = source.indexOf(marker);
  if (start < 0) {
    issues.push("scripts/audit-release.mjs requiredEntries ternary could not be found");
    return { portable: [], desktop: [] };
  }
  const portableStart = source.indexOf("[", start);
  const separator = source.indexOf("] : [", portableStart);
  const desktopEnd = source.indexOf("\n  ];", separator);
  if (portableStart < 0 || separator < 0 || desktopEnd < 0) {
    issues.push("scripts/audit-release.mjs requiredEntries ternary could not be parsed");
    return { portable: [], desktop: [] };
  }
  return {
    portable: extractZipTemplatePaths(source.slice(portableStart, separator)),
    desktop: extractZipTemplatePaths(source.slice(separator, desktopEnd))
  };
}

function extractQuotedStrings(source) {
  return uniqueSorted([...source.matchAll(/"([^"]+)"/g)].map((match) => match[1]));
}

function extractZipTemplatePaths(source) {
  return uniqueSorted([...source.matchAll(/`\$\{packageName\}\/([^`]+)`/g)].map((match) => match[1]));
}

function comparePathSets(label, actual, expected) {
  const actualSet = new Set(actual);
  const expectedSet = new Set(expected);
  for (const path of expectedSet) {
    if (!actualSet.has(path)) {
      issues.push(`${label} is missing required manifest path ${path}`);
    }
  }
  for (const path of actualSet) {
    if (!expectedSet.has(path)) {
      issues.push(`${label} contains unexpected manifest path ${path}`);
    }
  }
}

function uniqueSorted(values) {
  return [...new Set(values.filter(Boolean))].sort();
}

async function auditProductContractDocs() {
  const readme = await readFile(join(root, "README.md"), "utf8").catch(() => "");
  const clientReadme = await readFile(join(root, "client", "README.md"), "utf8").catch(() => "");
  const packageJson = await readFile(join(root, "package.json"), "utf8").catch(() => "");

  requireText(readme, "README.md", "产品化基线");
  requireText(readme, "README.md", "docs/INTERFACE_CONTRACT.md");
  requireText(readme, "README.md", "docs/API_MATRIX.md");
  requireText(readme, "README.md", "必须同步更新");
  requireText(clientReadme, "client/README.md", "../docs/INTERFACE_CONTRACT.md");
  requireText(clientReadme, "client/README.md", "/api/profile");
  requireText(clientReadme, "client/README.md", "/api/jobs");
  requireText(clientReadme, "client/README.md", "/api/sync/history");
  requireText(clientReadme, "client/README.md", "protocol map alignment");
  requireText(clientReadme, "client/README.md", "match `/api/client/status`");

  try {
    const pkg = JSON.parse(packageJson);
    const name = String(pkg.name || "");
    const description = String(pkg.description || "");
    if (nonProductLanguagePattern.test(name)) {
      issues.push("package.json name must use productized wording instead of MVP/demo language");
    }
    if (!description.includes("stable interface contract")) {
      issues.push("package.json description must mention the stable interface contract");
    }
    if (nonProductLanguagePattern.test(description)) {
      issues.push("package.json description must not describe the product as an MVP/demo");
    }
  } catch {
    issues.push("package.json is not valid JSON");
  }
}

async function auditProductizedLanguage() {
  const checked = [
    "README.md",
    "client/README.md",
    "docs/INTERFACE_CONTRACT.md",
    "docs/API_MATRIX.md",
    "docs/SOFTWARE_DESIGN_SPEC.md",
    "docs/client-design.md",
    "docs/server-design.md",
    "src",
    "client/src",
    "public",
    "client/public"
  ];
  for (const rel of checked) {
    const fullPath = join(root, rel);
    if (!await exists(fullPath)) continue;
    const files = [];
    const info = await stat(fullPath);
    if (info.isDirectory()) {
      for await (const file of walk(fullPath)) {
        files.push(file);
      }
    } else {
      files.push(fullPath);
    }
    for (const file of files) {
      const fileRel = normalizePath(relative(root, file));
      if (shouldSkip(fileRel)) continue;
      const text = await readFile(file, "utf8").catch(() => "");
      text.split(/\r?\n/).forEach((line, index) => {
        if (nonProductLanguagePattern.test(line)) {
          issues.push(`${fileRel}:${index + 1} must use productized wording instead of MVP/demo language`);
        }
      });
    }
  }
}

async function auditProductIdentity() {
  const [
    packageJson,
    diagnosticsSource
  ] = await Promise.all([
    readFile(join(root, "package.json"), "utf8").catch(() => ""),
    readFile(join(root, "src", "core", "diagnostics.js"), "utf8").catch(() => "")
  ]);

  if (!packageJson) {
    issues.push("package.json is missing for product identity audit");
    return;
  }
  if (!diagnosticsSource) {
    issues.push("src/core/diagnostics.js is missing for product identity audit");
    return;
  }

  let packageName = "";
  try {
    packageName = String(JSON.parse(packageJson).name || "");
  } catch {
    issues.push("package.json is not valid JSON");
    return;
  }

  const appId = extractStringConstant(diagnosticsSource, "APP_ID");
  if (!appId) {
    issues.push("src/core/diagnostics.js APP_ID could not be parsed");
    return;
  }
  if (packageName !== appId) {
    issues.push(`package.json name must match src/core/diagnostics.js APP_ID ${appId}`);
  }

  const appIdFiles = [
    ["src/server.js", /app:\s*"([^"]+)"/],
    ["client/src/diagnosticBundle.js", /app:\s*"([^"]+)"/],
    ["scripts/smoke-server.mjs", /app:\s*"([^"]+)"/],
    ["scripts/smoke-client.mjs", /app:\s*"([^"]+)"/],
    ["scripts/smoke-client-package.mjs", /app:\s*"([^"]+)"/],
    ["scripts/build-release-bundle.ps1", /app\s*=\s*"([^"]+)"/],
    ["scripts/deploy-n1.ps1", /app\s*=\s*"([^"]+)"/],
    ["scripts/apply-n1-singbox.ps1", /app\s*=\s*"([^"]+)"/],
    ["scripts/post-deploy-n1.ps1", /app\s*=\s*"([^"]+)"/],
    ["scripts/preflight-release.ps1", /app\s*=\s*"([^"]+)"/],
    ["client/scripts/build-client.ps1", /app\s*=\s*"([^"]+)"/],
    ["client/scripts/build-desktop.ps1", /app\s*=\s*"([^"]+)"/]
  ];

  for (const [rel, pattern] of appIdFiles) {
    const text = await readFile(join(root, ...rel.split("/")), "utf8").catch(() => "");
    if (!text) {
      issues.push(`${rel} is missing for product identity audit`);
      continue;
    }
    const values = [...text.matchAll(new RegExp(pattern, "g"))].map((match) => match[1]);
    if (!values.length) {
      issues.push(`${rel} must emit app id ${appId}`);
      continue;
    }
    for (const value of values) {
      if (value !== appId) {
        issues.push(`${rel} app id ${value} must match ${appId}`);
      }
    }
  }
}

async function auditOperationalRecoveryDocs() {
  const guide = await readFile(join(root, "docs", "DEPLOYMENT_AND_MIGRATION_GUIDE.md"), "utf8").catch(() => "");
  if (!guide) {
    issues.push("docs/DEPLOYMENT_AND_MIGRATION_GUIDE.md is missing");
    return;
  }

  for (const expected of [
    "server_state_corrupt",
    "server_state_locked",
    "server_state_write_failed",
    "server_singbox_config_write_failed",
    "sfsc-state.json",
    "SINGBOX_CONFIG_PATH",
    "不得覆盖",
    "重试 SyncKey 创建、兑换或心跳",
    "Windows 客户端本地状态恢复",
    "profile.json",
    "jobs.json",
    "secrets.json",
    "sync-history.json",
    "claim-recovery.json",
    "local_state_corrupt",
    "secret_vault_missing",
    "safeguards.localState.files[]",
    "GET /api/diagnostics/export",
    "不要在损坏状态上继续保存任务、导入 profile 或运行同步",
    "apply-n1-singbox.ps1",
    "restartRequired=false"
  ]) {
    requireText(guide, "docs/DEPLOYMENT_AND_MIGRATION_GUIDE.md", expected);
  }
}

async function auditInternalTrialChecklist() {
  const checklist = await readFile(join(root, "docs", "INTERNAL_TRIAL_CHECKLIST.md"), "utf8").catch(() => "");
  const guide = await readFile(join(root, "docs", "DEPLOYMENT_AND_MIGRATION_GUIDE.md"), "utf8").catch(() => "");
  const handoff = await readFile(join(root, "docs", "PROJECT_HANDOFF.md"), "utf8").catch(() => "");
  const packageJson = await readFile(join(root, "package.json"), "utf8").catch(() => "");
  const electronSmoke = await readFile(join(root, "scripts", "smoke-electron-window.mjs"), "utf8").catch(() => "");
  const electronE2eSmoke = await readFile(join(root, "scripts", "smoke-electron-e2e.mjs"), "utf8").catch(() => "");
  const trialRecord = await readFile(join(root, "scripts", "record-internal-trial.mjs"), "utf8").catch(() => "");
  const trialPrepare = await readFile(join(root, "scripts", "prepare-internal-trial.mjs"), "utf8").catch(() => "");
  const trialTKey = await readFile(join(root, "scripts", "create-trial-t-key.mjs"), "utf8").catch(() => "");
  const trialAssistant = await readFile(join(root, "scripts", "internal-trial-assistant.mjs"), "utf8").catch(() => "");
  const clientTrialRunner = await readFile(join(root, "scripts", "client-trial-runner.mjs"), "utf8").catch(() => "");
  const pilotPrepare = await readFile(join(root, "scripts", "prepare-pilot-wave.mjs"), "utf8").catch(() => "");
  const pilotSummary = await readFile(join(root, "scripts", "pilot-summary.mjs"), "utf8").catch(() => "");
  const releaseStatus = await readFile(join(root, "scripts", "release-status.mjs"), "utf8").catch(() => "");

  if (!checklist) {
    issues.push("docs/INTERNAL_TRIAL_CHECKLIST.md is missing");
    return;
  }

  for (const expected of [
    "内部 beta E2E 检查清单",
    "pnpm run preflight:release",
    "reports/release/preflight.json",
    "post-deploy-summary.json",
    "SyncraftDesktop.zip",
    "SyncraftClient.zip",
    "Get-FileHash <zip> -Algorithm SHA256",
    "/api/client/status",
    "releaseManifest.ok: true",
    "导入 SyncKey",
    "兼容性 warning",
    "破坏性同步确认",
    "预览不会写入远端",
    "同步过程中页面显示速度、进度和当前文件",
    "fake sing-box/rclone",
    "退出失败会显示明确反馈",
    "safeguards.localState.ok: true",
    "诊断包不包含原始 SyncKey、完整 VLESS URI、S3 secret、heartbeat secret 或管理 token",
    "未知客户端 status 字段不会进入外发诊断包",
    "pnpm run smoke:electron-window",
    "pnpm run smoke:electron-e2e",
    "pnpm run trial:record",
    "pnpm run trial:record:update",
    "pnpm run trial:prepare",
    "pnpm run trial:assist",
    "pnpm run trial:client-runner",
    "pnpm run trial:record:verify",
    "pnpm run pilot:prepare",
    "pnpm run pilot:summary",
    "window.sfscDesktop.pickFolder",
    "N1 `post-deploy-summary.json` 路径和 `runId`"
  ]) {
    requireText(checklist, "docs/INTERNAL_TRIAL_CHECKLIST.md", expected);
  }

  requireText(guide, "docs/DEPLOYMENT_AND_MIGRATION_GUIDE.md", "docs/INTERNAL_TRIAL_CHECKLIST.md");
  requireText(guide, "docs/DEPLOYMENT_AND_MIGRATION_GUIDE.md", "pnpm run trial:record:update");
  requireText(guide, "docs/DEPLOYMENT_AND_MIGRATION_GUIDE.md", "疑似 SyncKey、完整 VLESS URI、S3 secret、heartbeat secret、管理 token 或私钥内容");
  requireText(guide, "docs/DEPLOYMENT_AND_MIGRATION_GUIDE.md", "pnpm run smoke:electron-window");
  requireText(guide, "docs/DEPLOYMENT_AND_MIGRATION_GUIDE.md", "pnpm run smoke:electron-e2e");
  requireText(handoff, "docs/PROJECT_HANDOFF.md", "docs/INTERNAL_TRIAL_CHECKLIST.md");
  requireText(handoff, "docs/PROJECT_HANDOFF.md", "pnpm run smoke:electron-window");
  requireText(handoff, "docs/PROJECT_HANDOFF.md", "pnpm run smoke:electron-e2e");
  requireText(handoff, "docs/PROJECT_HANDOFF.md", "pnpm run trial:record");
  requireText(handoff, "docs/PROJECT_HANDOFF.md", "pnpm run trial:record:update");
  requireText(handoff, "docs/PROJECT_HANDOFF.md", "pnpm run trial:prepare");
  requireText(handoff, "docs/PROJECT_HANDOFF.md", "pnpm run trial:assist");
  requireText(handoff, "docs/PROJECT_HANDOFF.md", "pnpm run trial:client-runner");
  requireText(handoff, "docs/PROJECT_HANDOFF.md", "pnpm run pilot:prepare");
  requireText(handoff, "docs/PROJECT_HANDOFF.md", "pnpm run pilot:summary");
  requireText(packageJson, "package.json", "\"smoke:electron-window\": \"node scripts/smoke-electron-window.mjs\"");
  requireText(packageJson, "package.json", "\"smoke:electron-e2e\": \"node scripts/smoke-electron-e2e.mjs\"");
  requireText(packageJson, "package.json", "\"trial:record\": \"node scripts/record-internal-trial.mjs\"");
  requireText(packageJson, "package.json", "\"trial:record:verify\": \"node scripts/record-internal-trial.mjs --verify\"");
  requireText(packageJson, "package.json", "\"trial:record:update\": \"node scripts/record-internal-trial.mjs --update --allow-pending\"");
  requireText(packageJson, "package.json", "\"trial:prepare\": \"node scripts/prepare-internal-trial.mjs\"");
  requireText(packageJson, "package.json", "\"trial:create-t-key\": \"node scripts/create-trial-t-key.mjs\"");
  requireText(packageJson, "package.json", "\"trial:assist\": \"node scripts/internal-trial-assistant.mjs\"");
  requireText(packageJson, "package.json", "\"trial:client-runner\": \"node scripts/client-trial-runner.mjs\"");
  requireText(packageJson, "package.json", "\"pilot:prepare\": \"node scripts/prepare-pilot-wave.mjs\"");
  requireText(packageJson, "package.json", "\"pilot:summary\": \"node scripts/pilot-summary.mjs\"");
  requireText(packageJson, "package.json", "\"release:status\": \"node scripts/release-status.mjs\"");
  requireText(electronSmoke, "scripts/smoke-electron-window.mjs", "window.sfscDesktop?.pickFolder");
  requireText(electronSmoke, "scripts/smoke-electron-window.mjs", "exportDiagnosticsBtn");
  requireText(electronSmoke, "scripts/smoke-electron-window.mjs", "settingsPanel");
  requireText(electronE2eSmoke, "scripts/smoke-electron-e2e.mjs", "encodeImportProfile");
  requireText(electronE2eSmoke, "scripts/smoke-electron-e2e.mjs", "profile imported through UI");
  requireText(electronE2eSmoke, "scripts/smoke-electron-e2e.mjs", "job saved through UI");
  requireText(electronE2eSmoke, "scripts/smoke-electron-e2e.mjs", "sync preview generated through UI");
  requireText(electronE2eSmoke, "scripts/smoke-electron-e2e.mjs", "prepareTemporaryPackage");
  requireText(electronE2eSmoke, "scripts/smoke-electron-e2e.mjs", "rclone-sync");
  requireText(electronE2eSmoke, "scripts/smoke-electron-e2e.mjs", "sync run/stop/history verified through UI");
  requireText(electronE2eSmoke, "scripts/smoke-electron-e2e.mjs", "diagnostic JSON exported and parsed");
  requireText(electronE2eSmoke, "scripts/smoke-electron-e2e.mjs", "assertDoesNotContainSecrets");
  requireText(trialRecord, "scripts/record-internal-trial.mjs", "internal-trial-record");
  requireText(trialRecord, "scripts/record-internal-trial.mjs", "releaseBundleVerified");
  requireText(trialRecord, "scripts/record-internal-trial.mjs", "restartRequired");
  requireText(trialRecord, "scripts/record-internal-trial.mjs", "targetHostsMatch");
  requireText(trialRecord, "scripts/record-internal-trial.mjs", "preview-small-sync");
  requireText(trialRecord, "scripts/record-internal-trial.mjs", "--update");
  requireText(trialRecord, "scripts/record-internal-trial.mjs", "Refusing to mark a section passed without --notes or --artifact evidence.");
  requireText(trialRecord, "scripts/record-internal-trial.mjs", "contains sensitive-looking");
  requireText(trialRecord, "scripts/record-internal-trial.mjs", "SFSC1-[A-Za-z0-9_-]+");
  requireText(trialPrepare, "scripts/prepare-internal-trial.mjs", "internal-trial-command-sheet");
  requireText(trialPrepare, "scripts/prepare-internal-trial.mjs", "This preparation step never asks for, stores, or writes the real SyncKey.");
  requireText(trialPrepare, "scripts/prepare-internal-trial.mjs", "SFSC 测试");
  requireText(trialPrepare, "scripts/prepare-internal-trial.mjs", "trial:create-t-key");
  requireText(trialPrepare, "scripts/prepare-internal-trial.mjs", "--i-understand-real-sync");
  requireText(trialPrepare, "scripts/prepare-internal-trial.mjs", "pnpm run trial:record:update");
  requireText(trialTKey, "scripts/create-trial-t-key.mjs", "trial-t-key-report");
  requireText(trialTKey, "scripts/create-trial-t-key.mjs", "Missing admin token. Set SFSC_ADMIN_TOKEN or ADMIN_TOKEN, or pass --admin-token.");
  requireText(trialTKey, "scripts/create-trial-t-key.mjs", "ONE-TIME PLAINTEXT SyncKey");
  requireText(trialTKey, "scripts/create-trial-t-key.mjs", "tKeyPlaintextStored: false");
  requireText(trialTKey, "scripts/create-trial-t-key.mjs", "Refusing to write trial SyncKey report because it contains sensitive plaintext.");
  requireText(trialTKey, "scripts/create-trial-t-key.mjs", "SFSC1-[A-Za-z0-9_-]+");
  requireText(trialTKey, "scripts/create-trial-t-key.mjs", "sfsc:// import URI are never written");
  requireText(trialAssistant, "scripts/internal-trial-assistant.mjs", "internal-trial-assistant-report");
  requireText(trialAssistant, "scripts/internal-trial-assistant.mjs", "assist-only");
  requireText(trialAssistant, "scripts/internal-trial-assistant.mjs", "Human tester must update internal-trial-record.json section statuses.");
  requireText(trialAssistant, "scripts/internal-trial-assistant.mjs", "The assistant must not mark internal trial sections as passed.");
  requireText(trialAssistant, "scripts/internal-trial-assistant.mjs", "requiredHumanActions");
  requireText(trialAssistant, "scripts/internal-trial-assistant.mjs", "sectionHints");
  requireText(trialAssistant, "scripts/internal-trial-assistant.mjs", "manual-diagnostics-scan");
  requireText(trialAssistant, "scripts/internal-trial-assistant.mjs", "client-trial-runner");
  requireText(clientTrialRunner, "scripts/client-trial-runner.mjs", "client-trial-runner-report");
  requireText(clientTrialRunner, "scripts/client-trial-runner.mjs", "--i-understand-real-sync");
  requireText(clientTrialRunner, "scripts/client-trial-runner.mjs", "Refusing to run real sync without --i-understand-real-sync.");
  requireText(clientTrialRunner, "scripts/client-trial-runner.mjs", "manualVerificationRequired");
  requireText(clientTrialRunner, "scripts/client-trial-runner.mjs", "Confirm uploaded or synchronized test files");
  requireText(clientTrialRunner, "scripts/client-trial-runner.mjs", "assertNoSensitiveTrialValues");
  requireText(clientTrialRunner, "scripts/client-trial-runner.mjs", "--client-package-manifest");
  requireText(clientTrialRunner, "scripts/client-trial-runner.mjs", "executableSha256");
  requireText(pilotPrepare, "scripts/prepare-pilot-wave.mjs", "pilot-wave");
  requireText(pilotPrepare, "scripts/prepare-pilot-wave.mjs", "participant-record.json");
  requireText(pilotPrepare, "scripts/prepare-pilot-wave.mjs", "plaintext SyncKey and import URIs are not stored");
  requireText(pilotPrepare, "scripts/prepare-pilot-wave.mjs", "SFSC1-[A-Za-z0-9_-]+");
  requireText(pilotSummary, "scripts/pilot-summary.mjs", "pilot-summary");
  requireText(pilotSummary, "scripts/pilot-summary.mjs", "ready-for-pilot-signoff");
  requireText(pilotSummary, "scripts/pilot-summary.mjs", "install success rate must be >= 90%");
  requireText(pilotSummary, "scripts/pilot-summary.mjs", "assertReportSafe");
  requireText(pilotSummary, "scripts/pilot-summary.mjs", "./lib/reportSecrets.mjs");
  requireText(releaseStatus, "scripts/release-status.mjs", "release-status-summary");
  requireText(releaseStatus, "scripts/release-status.mjs", "assertReportSafe");
  requireText(releaseStatus, "scripts/release-status.mjs", "--fail-on-not-ready");
  requireText(releaseStatus, "scripts/release-status.mjs", "currentSource");
  requireText(releaseStatus, "scripts/release-status.mjs", "sourceAlignment");
  requireText(releaseStatus, "scripts/release-status.mjs", "latest-post-deploy.json");
}

async function auditPilotDocs() {
  const docs = [
    {
      rel: "docs/PILOT_RUNBOOK.md",
      required: [
        "5-10 人小范围试点 Runbook",
        "准入门禁",
        "参与者名册字段",
        "分批 rollout",
        "每日检查",
        "升级、回滚和暂停规则",
        "支持包",
        "隐私",
        "试点结束清理",
        "不得在本文或试点记录中写入真实 SyncKey、sfsc URI、VLESS URI、token、S3 secret 或 SSH key"
      ]
    },
    {
      rel: "docs/PILOT_ACCEPTANCE_CRITERIA.md",
      required: [
        "5-10 人小范围试点验收标准",
        "量化通过指标",
        ">= 90%",
        "P0",
        "P1",
        "expand",
        "pause",
        "rollback",
        "不得在验收记录中写入真实 SyncKey、sfsc URI、VLESS URI、token、S3 secret 或 SSH key"
      ]
    },
    {
      rel: "docs/PILOT_SUPPORT_GUIDE.md",
      required: [
        "5-10 人小范围试点支持指南",
        "支持入口",
        "首问脚本",
        "分流处理",
        "升级、回滚、暂停",
        "支持包内容",
        "关闭标准",
        "不得写入真实 SyncKey、sfsc URI、VLESS URI、token、S3 secret 或 SSH key"
      ]
    }
  ];

  for (const doc of docs) {
    const text = await readFile(join(root, ...doc.rel.split("/")), "utf8").catch(() => "");
    if (!text) {
      issues.push(`${doc.rel} is missing`);
      continue;
    }
    for (const expected of doc.required) {
      requireText(text, doc.rel, expected);
    }
  }

  const guide = await readFile(join(root, "docs", "DEPLOYMENT_AND_MIGRATION_GUIDE.md"), "utf8").catch(() => "");
  const checklist = await readFile(join(root, "docs", "INTERNAL_TRIAL_CHECKLIST.md"), "utf8").catch(() => "");
  const handoff = await readFile(join(root, "docs", "PROJECT_HANDOFF.md"), "utf8").catch(() => "");
  const buildDesktop = await readFile(join(root, "client", "scripts", "build-desktop.ps1"), "utf8").catch(() => "");
  const buildPortable = await readFile(join(root, "client", "scripts", "build-client.ps1"), "utf8").catch(() => "");
  const packageSmoke = await readFile(join(root, "scripts", "smoke-client-package.mjs"), "utf8").catch(() => "");
  const clientServer = await readFile(join(root, "client", "src", "clientServer.js"), "utf8").catch(() => "");

  for (const rel of [
    "docs/PILOT_RUNBOOK.md",
    "docs/PILOT_ACCEPTANCE_CRITERIA.md",
    "docs/PILOT_SUPPORT_GUIDE.md"
  ]) {
    requireText(guide, "docs/DEPLOYMENT_AND_MIGRATION_GUIDE.md", rel);
    requireText(checklist, "docs/INTERNAL_TRIAL_CHECKLIST.md", rel);
    requireText(handoff, "docs/PROJECT_HANDOFF.md", rel);
  }
  for (const filename of [
    "PILOT_RUNBOOK.md",
    "PILOT_ACCEPTANCE_CRITERIA.md",
    "PILOT_SUPPORT_GUIDE.md"
  ]) {
    requireText(buildDesktop, "client/scripts/build-desktop.ps1", `docs\\${filename}`);
    requireText(buildDesktop, "client/scripts/build-desktop.ps1", `resources/app/docs/${filename}`);
    requireText(buildPortable, "client/scripts/build-client.ps1", `docs\\${filename}`);
    requireText(buildPortable, "client/scripts/build-client.ps1", `resources/app/docs/${filename}`);
    requireText(packageSmoke, "scripts/smoke-client-package.mjs", `resources/app/docs/${filename}`);
    requireText(clientServer, "client/src/clientServer.js", `resources/app/docs/${filename}`);
  }
}

async function auditSmokeContractDocs() {
  const [
    contract,
    guide,
    runtimeContracts,
    reportSecrets,
    psReportSecrets,
    helperContracts,
    serverSource,
    serverSmoke,
    n1Deploy,
    n1Apply,
    n1PostDeploy,
    preflight,
    releaseBundle,
    clientSmoke,
    clientPackageSmoke
  ] = await Promise.all([
    readFile(join(root, "docs", "INTERFACE_CONTRACT.md"), "utf8").catch(() => ""),
    readFile(join(root, "docs", "DEPLOYMENT_AND_MIGRATION_GUIDE.md"), "utf8").catch(() => ""),
    readFile(join(root, "scripts", "lib", "runtimeContracts.mjs"), "utf8").catch(() => ""),
    readFile(join(root, "scripts", "lib", "reportSecrets.mjs"), "utf8").catch(() => ""),
    readFile(join(root, "scripts", "lib", "report-secrets.ps1"), "utf8").catch(() => ""),
    readFile(join(root, "tests", "helpers", "contracts.js"), "utf8").catch(() => ""),
    readFile(join(root, "src", "server.js"), "utf8").catch(() => ""),
    readFile(join(root, "scripts", "smoke-server.mjs"), "utf8").catch(() => ""),
    readFile(join(root, "scripts", "deploy-n1.ps1"), "utf8").catch(() => ""),
    readFile(join(root, "scripts", "apply-n1-singbox.ps1"), "utf8").catch(() => ""),
    readFile(join(root, "scripts", "post-deploy-n1.ps1"), "utf8").catch(() => ""),
    readFile(join(root, "scripts", "preflight-release.ps1"), "utf8").catch(() => ""),
    readFile(join(root, "scripts", "build-release-bundle.ps1"), "utf8").catch(() => ""),
    readFile(join(root, "scripts", "smoke-client.mjs"), "utf8").catch(() => ""),
    readFile(join(root, "scripts", "smoke-client-package.mjs"), "utf8").catch(() => "")
  ]);

  for (const [label, text] of [
    ["docs/INTERFACE_CONTRACT.md", contract],
    ["docs/DEPLOYMENT_AND_MIGRATION_GUIDE.md", guide],
    ["scripts/lib/runtimeContracts.mjs", runtimeContracts],
    ["scripts/lib/reportSecrets.mjs", reportSecrets],
    ["scripts/lib/report-secrets.ps1", psReportSecrets],
    ["tests/helpers/contracts.js", helperContracts],
    ["src/server.js", serverSource],
    ["scripts/smoke-server.mjs", serverSmoke],
    ["scripts/deploy-n1.ps1", n1Deploy],
    ["scripts/apply-n1-singbox.ps1", n1Apply],
    ["scripts/post-deploy-n1.ps1", n1PostDeploy],
    ["scripts/preflight-release.ps1", preflight],
    ["scripts/build-release-bundle.ps1", releaseBundle],
    ["scripts/smoke-client.mjs", clientSmoke],
    ["scripts/smoke-client-package.mjs", clientPackageSmoke]
  ]) {
    if (!text) {
      issues.push(`${label} is missing for smoke contract audit`);
    }
  }
  if (!contract || !guide || !runtimeContracts || !reportSecrets || !psReportSecrets || !helperContracts || !serverSource || !serverSmoke || !n1Deploy || !n1Apply || !n1PostDeploy || !preflight || !releaseBundle || !clientSmoke || !clientPackageSmoke) {
    return;
  }
  requireText(contract, "docs/INTERFACE_CONTRACT.md", "共享报告敏感信息扫描器");
  requireText(guide, "docs/DEPLOYMENT_AND_MIGRATION_GUIDE.md", "写盘、复制或压缩前都会经过共享敏感信息扫描器");
  requireText(reportSecrets, "scripts/lib/reportSecrets.mjs", "assertReportSafe");
  requireText(reportSecrets, "scripts/lib/reportSecrets.mjs", "writeJsonReportSync");
  requireText(psReportSecrets, "scripts/lib/report-secrets.ps1", "Assert-ReportTextSafe");
  requireText(psReportSecrets, "scripts/lib/report-secrets.ps1", "Write-SafeJsonReport");
  requireText(serverSmoke, "scripts/smoke-server.mjs", "./lib/reportSecrets.mjs");
  requireText(clientSmoke, "scripts/smoke-client.mjs", "./lib/reportSecrets.mjs");
  requireText(clientPackageSmoke, "scripts/smoke-client-package.mjs", "./lib/reportSecrets.mjs");
  requireText(n1Deploy, "scripts/deploy-n1.ps1", "lib\\report-secrets.ps1");
  requireText(n1Deploy, "scripts/deploy-n1.ps1", "Write-SafeJsonReport");
  requireText(n1Deploy, "scripts/deploy-n1.ps1", "Assert-ReportFileSafe $smokeJsonReport");
  requireText(n1Apply, "scripts/apply-n1-singbox.ps1", "lib\\report-secrets.ps1");
  requireText(n1Apply, "scripts/apply-n1-singbox.ps1", "Write-SafeJsonReport");
  requireText(n1Apply, "scripts/apply-n1-singbox.ps1", "Assert-ReportFileSafe $smokeJsonReport");
  requireText(n1PostDeploy, "scripts/post-deploy-n1.ps1", "Copy-SafeReport");
  requireText(n1PostDeploy, "scripts/post-deploy-n1.ps1", "ClientRealSyncJsonPath");
  requireText(n1PostDeploy, "scripts/post-deploy-n1.ps1", "SsdObjectVerificationJsonPath");
  requireText(n1PostDeploy, "scripts/post-deploy-n1.ps1", "TestDataCleanupJsonPath");
  requireText(n1PostDeploy, "scripts/post-deploy-n1.ps1", "clientRealSyncVerified");
  requireText(n1PostDeploy, "scripts/post-deploy-n1.ps1", "n1BuildMatches");
  requireText(preflight, "scripts/preflight-release.ps1", "Write-SafeJsonReport");
  requireText(preflight, "scripts/preflight-release.ps1", "Assert-ReportFileSafe $path");
  requireText(releaseBundle, "scripts/build-release-bundle.ps1", "Assert-StagedReportsSafe");
  requireText(releaseBundle, "scripts/build-release-bundle.ps1", "Write-SafeJsonReport $bundleManifestPath");

  requireText(contract, "docs/INTERFACE_CONTRACT.md", "/api/health.diagnostics.protocols");
  requireText(contract, "docs/INTERFACE_CONTRACT.md", "/api/admin/state.diagnostics.protocols");
  requireText(contract, "docs/INTERFACE_CONTRACT.md", "/api/client/status.diagnostics.protocols");
  requireText(contract, "docs/INTERFACE_CONTRACT.md", "protocols=aligned");
  requireText(contract, "docs/INTERFACE_CONTRACT.md", "协议漂移失败");
  requireText(contract, "docs/INTERFACE_CONTRACT.md", "admin state summary contract");
  requireText(contract, "docs/INTERFACE_CONTRACT.md", "admin write state response contract");
  requireText(contract, "docs/INTERFACE_CONTRACT.md", "admin auth check response contract");
  requireText(contract, "docs/INTERFACE_CONTRACT.md", "admin tunnel autofill response contract");
  requireText(contract, "docs/INTERFACE_CONTRACT.md", "admin tunnel generate response contract");
  requireText(contract, "docs/INTERFACE_CONTRACT.md", "admin sing-box config preview contract");
  requireText(contract, "docs/INTERFACE_CONTRACT.md", "admin sing-box write response contract");
  requireText(contract, "docs/INTERFACE_CONTRACT.md", "admin sing-box mark-applied response contract");
  requireText(contract, "docs/INTERFACE_CONTRACT.md", "恢复本次请求前的 sing-box config 文件内容");
  requireText(contract, "docs/INTERFACE_CONTRACT.md", "删除本次新写出的 config 文件");
  requireText(contract, "docs/INTERFACE_CONTRACT.md", "幽灵设备或幽灵 SyncKey 配置");
  requireText(contract, "docs/INTERFACE_CONTRACT.md", "回滚请求体 `server` 对 `settings.publicServerUrl` 的临时更新");
  requireText(contract, "docs/INTERFACE_CONTRACT.md", "被未持久化请求污染的 SyncKey 服务地址");
  requireText(contract, "docs/INTERFACE_CONTRACT.md", "sing-box config 文件写入必须使用临时文件和原子 rename");
  requireText(serverSource, "src/server.js", "async function saveAdminStateWithSingboxConfig()");
  requireText(serverSource, "src/server.js", "const previousConfig = await readExistingSingboxConfigFile();");
  requireText(serverSource, "src/server.js", "restoreSingboxConfigFile(previousConfig)");
  requireText(serverSource, "src/server.js", "async function writeFileAtomic(file, body, encoding)");
  requireText(serverSource, "src/server.js", "await rename(tempFile, file);");
  requireText(contract, "docs/INTERFACE_CONTRACT.md", "admin user write response contract");
  requireText(contract, "docs/INTERFACE_CONTRACT.md", "admin user delete response contract");
  requireText(contract, "docs/INTERFACE_CONTRACT.md", "`POST /api/admin/users/create` 是低层调试/运维入口");
  requireText(contract, "docs/INTERFACE_CONTRACT.md", "当前服务端控制台的产品化创建设备入口是 `POST /api/claims/create`");
  requireText(contract, "docs/INTERFACE_CONTRACT.md", "避免出现“已登记但没有可导入 SyncKey”的半成品设备");
  requireText(contract, "docs/INTERFACE_CONTRACT.md", "admin storage buckets refresh response contract");
  requireText(contract, "docs/INTERFACE_CONTRACT.md", "admin storage bucket create response contract");
  requireText(contract, "docs/INTERFACE_CONTRACT.md", "admin storage bucket toggle response contract");
  requireText(contract, "docs/INTERFACE_CONTRACT.md", "admin storage bucket clear response contract");
  requireText(contract, "docs/INTERFACE_CONTRACT.md", "admin storage bucket delete-empty response contract");
  requireText(contract, "docs/INTERFACE_CONTRACT.md", "admin storage save response contract");
  requireText(contract, "docs/INTERFACE_CONTRACT.md", "http error response contract");
  requireText(contract, "docs/INTERFACE_CONTRACT.md", "assertHttpErrorResponseContract");
  requireText(contract, "docs/INTERFACE_CONTRACT.md", "claim redeem response contract");
  requireText(contract, "docs/INTERFACE_CONTRACT.md", "server health response contract");
  requireText(contract, "docs/INTERFACE_CONTRACT.md", "client health response contract");
  requireText(contract, "docs/INTERFACE_CONTRACT.md", "client shutdown response contract");
  requireText(contract, "docs/INTERFACE_CONTRACT.md", "client binaries check response contract");
  requireText(contract, "docs/INTERFACE_CONTRACT.md", "client profile import response contract");
  requireText(contract, "docs/INTERFACE_CONTRACT.md", "client job save response contract");
  requireText(contract, "docs/INTERFACE_CONTRACT.md", "client singbox process response contract");
  requireText(contract, "docs/INTERFACE_CONTRACT.md", "client sync history contract");
  requireText(contract, "docs/INTERFACE_CONTRACT.md", "client sync run response contract");
  requireText(contract, "docs/INTERFACE_CONTRACT.md", "vless parse response contract");
  requireText(contract, "docs/INTERFACE_CONTRACT.md", "singbox client config response contract");
  requireText(contract, "docs/INTERFACE_CONTRACT.md", "jobs preview response contract");
  requireText(contract, "docs/INTERFACE_CONTRACT.md", "server heartbeat response contract");
  requireText(contract, "docs/INTERFACE_CONTRACT.md", "服务端 heartbeat 成功响应不得返回 `vlessUri`");
  requireText(contract, "docs/INTERFACE_CONTRACT.md", "`/api/vless/parse` 必须遵守 vless parse response contract");
  requireText(contract, "docs/INTERFACE_CONTRACT.md", "`/api/singbox/client-config` 必须遵守 singbox client config response contract");
  requireText(contract, "docs/INTERFACE_CONTRACT.md", "`vlessParse.*`、`singboxClientConfig.*` 或 `jobsPreview.*` 字段路径");
  requireText(contract, "docs/INTERFACE_CONTRACT.md", "客户端 smoke 还必须覆盖 `/api/logs` 的 client logs contract 和 `/api/diagnostics/export` 的 diagnostic export contract");
  requireText(guide, "docs/DEPLOYMENT_AND_MIGRATION_GUIDE.md", "/api/health.diagnostics.protocols");
  requireText(guide, "docs/DEPLOYMENT_AND_MIGRATION_GUIDE.md", "/api/admin/state.diagnostics.protocols");
  requireText(guide, "docs/DEPLOYMENT_AND_MIGRATION_GUIDE.md", "/api/client/status.diagnostics.protocols");
  requireText(guide, "docs/DEPLOYMENT_AND_MIGRATION_GUIDE.md", "/api/logs");
  requireText(guide, "docs/DEPLOYMENT_AND_MIGRATION_GUIDE.md", "/api/diagnostics/export");
  requireText(guide, "docs/DEPLOYMENT_AND_MIGRATION_GUIDE.md", "protocols=aligned");
  requireText(guide, "docs/DEPLOYMENT_AND_MIGRATION_GUIDE.md", "claim-lifecycle-bound-replay");
  requireText(guide, "docs/DEPLOYMENT_AND_MIGRATION_GUIDE.md", "claim-lifecycle-different-binding-redeem");
  requireText(guide, "docs/DEPLOYMENT_AND_MIGRATION_GUIDE.md", "同一客户端绑定短时重放成功");
  requireText(guide, "docs/DEPLOYMENT_AND_MIGRATION_GUIDE.md", "不同客户端绑定的重复 redeem 返回 `409 claim_already_used`");
  requireText(guide, "docs/DEPLOYMENT_AND_MIGRATION_GUIDE.md", "apply-n1-singbox.ps1");
  requireText(guide, "docs/DEPLOYMENT_AND_MIGRATION_GUIDE.md", "restartRequired=false");
  requireText(runtimeContracts, "scripts/lib/runtimeContracts.mjs", "export function assertRuntimeDiagnosticsContract");
  requireText(runtimeContracts, "scripts/lib/runtimeContracts.mjs", "export function assertAdminClaimSummaryContract");
  requireText(runtimeContracts, "scripts/lib/runtimeContracts.mjs", "export function assertAdminDefaultsSummaryContract");
  requireText(runtimeContracts, "scripts/lib/runtimeContracts.mjs", "export function assertAdminSettingsSummaryContract");
  requireText(runtimeContracts, "scripts/lib/runtimeContracts.mjs", "export function assertAdminStateSummaryContract");
  requireText(runtimeContracts, "scripts/lib/runtimeContracts.mjs", "export function assertAdminStorageSummaryContract");
  requireText(runtimeContracts, "scripts/lib/runtimeContracts.mjs", "export function assertAdminTunnelAutofillResponseContract");
  requireText(runtimeContracts, "scripts/lib/runtimeContracts.mjs", "export function assertAdminTunnelGenerateResponseContract");
  requireText(runtimeContracts, "scripts/lib/runtimeContracts.mjs", "export function assertAdminTunnelSummaryContract");
  requireText(runtimeContracts, "scripts/lib/runtimeContracts.mjs", "export function assertAdminUserDeleteResponseContract");
  requireText(runtimeContracts, "scripts/lib/runtimeContracts.mjs", "export function assertAdminUserWriteResponseContract");
  requireText(runtimeContracts, "scripts/lib/runtimeContracts.mjs", "export function assertAdminUserSummaryContract");
  requireText(runtimeContracts, "scripts/lib/runtimeContracts.mjs", "export function assertAdminWriteStateResponseContract");
  requireText(runtimeContracts, "scripts/lib/runtimeContracts.mjs", "export function assertAdminAuthCheckResponseContract");
  requireText(runtimeContracts, "scripts/lib/runtimeContracts.mjs", "export function assertAdminSingboxMarkAppliedResponseContract");
  requireText(runtimeContracts, "scripts/lib/runtimeContracts.mjs", "export function assertAdminSingboxConfigPreviewContract");
  requireText(runtimeContracts, "scripts/lib/runtimeContracts.mjs", "export function assertAdminSingboxWriteResponseContract");
  requireText(runtimeContracts, "scripts/lib/runtimeContracts.mjs", "export function assertAdminStorageSaveResponseContract");
  requireText(runtimeContracts, "scripts/lib/runtimeContracts.mjs", "export function assertAdminStorageBucketsRefreshResponseContract");
  requireText(runtimeContracts, "scripts/lib/runtimeContracts.mjs", "export function assertAdminStorageBucketCreateResponseContract");
  requireText(runtimeContracts, "scripts/lib/runtimeContracts.mjs", "export function assertAdminStorageBucketToggleResponseContract");
  requireText(runtimeContracts, "scripts/lib/runtimeContracts.mjs", "export function assertAdminStorageBucketClearResponseContract");
  requireText(runtimeContracts, "scripts/lib/runtimeContracts.mjs", "export function assertAdminStorageBucketDeleteEmptyResponseContract");
  requireText(runtimeContracts, "scripts/lib/runtimeContracts.mjs", "export function assertHttpErrorResponseContract");
  requireText(helperContracts, "tests/helpers/contracts.js", "assertAdminStorageBucketsRefreshResponseContract");
  requireText(helperContracts, "tests/helpers/contracts.js", "assertAdminStorageSaveResponseContract");
  requireText(helperContracts, "tests/helpers/contracts.js", "assertAdminStorageBucketCreateResponseContract");
  requireText(helperContracts, "tests/helpers/contracts.js", "assertAdminStorageBucketToggleResponseContract");
  requireText(helperContracts, "tests/helpers/contracts.js", "assertAdminStorageBucketClearResponseContract");
  requireText(helperContracts, "tests/helpers/contracts.js", "assertAdminStorageBucketDeleteEmptyResponseContract");
  requireText(helperContracts, "tests/helpers/contracts.js", "assertAdminTunnelAutofillResponseContract");
  requireText(helperContracts, "tests/helpers/contracts.js", "assertAdminTunnelGenerateResponseContract");
  requireText(helperContracts, "tests/helpers/contracts.js", "assertAdminSingboxWriteResponseContract");
  requireText(helperContracts, "tests/helpers/contracts.js", "assertAdminSingboxMarkAppliedResponseContract");
  requireText(helperContracts, "tests/helpers/contracts.js", "assertAdminUserWriteResponseContract");
  requireText(helperContracts, "tests/helpers/contracts.js", "assertAdminUserDeleteResponseContract");
  requireText(helperContracts, "tests/helpers/contracts.js", "assertHttpErrorResponseContract");
  requireText(runtimeContracts, "scripts/lib/runtimeContracts.mjs", "export function assertClientLogsContract");
  requireText(runtimeContracts, "scripts/lib/runtimeContracts.mjs", "export function assertClientHealthContract");
  requireText(runtimeContracts, "scripts/lib/runtimeContracts.mjs", "export function assertClientShutdownResponseContract");
  requireText(runtimeContracts, "scripts/lib/runtimeContracts.mjs", "export function assertClientProfileImportResponseContract");
  requireText(runtimeContracts, "scripts/lib/runtimeContracts.mjs", "export function assertClientProfileReadContract");
  requireText(runtimeContracts, "scripts/lib/runtimeContracts.mjs", "export function assertClientBinariesCheckContract");
  requireText(runtimeContracts, "scripts/lib/runtimeContracts.mjs", "export function assertClientJobsReadContract");
  requireText(runtimeContracts, "scripts/lib/runtimeContracts.mjs", "export function assertClientJobSaveResponseContract");
  requireText(runtimeContracts, "scripts/lib/runtimeContracts.mjs", "export function assertClientJobSummaryContract");
  requireText(runtimeContracts, "scripts/lib/runtimeContracts.mjs", "export function assertClientStatusContract");
  requireText(runtimeContracts, "scripts/lib/runtimeContracts.mjs", "export function assertClientSingboxProcessResponseContract");
  requireText(runtimeContracts, "scripts/lib/runtimeContracts.mjs", "export function assertClientSyncHistoryContract");
  requireText(runtimeContracts, "scripts/lib/runtimeContracts.mjs", "export function assertClientSyncRunResponseContract");
  requireText(runtimeContracts, "scripts/lib/runtimeContracts.mjs", "export function assertClaimCreateResponseContract");
  requireText(runtimeContracts, "scripts/lib/runtimeContracts.mjs", "export function assertClaimRedeemResponseContract");
  requireText(runtimeContracts, "scripts/lib/runtimeContracts.mjs", "export function assertDiagnosticExportContract");
  requireText(runtimeContracts, "scripts/lib/runtimeContracts.mjs", "export function assertDiagnosticLogMetaContract");
  requireText(runtimeContracts, "scripts/lib/runtimeContracts.mjs", "function assertNoLocalDiagnosticPaths");
  requireText(runtimeContracts, "scripts/lib/runtimeContracts.mjs", "contains a Windows local path");
  requireText(runtimeContracts, "scripts/lib/runtimeContracts.mjs", "contains an unredacted local path field");
  requireText(runtimeContracts, "scripts/lib/runtimeContracts.mjs", "export function assertProfileEncodeResponseContract");
  requireText(runtimeContracts, "scripts/lib/runtimeContracts.mjs", "export function assertClientHeartbeatDeviceSummaryContract");
  requireText(runtimeContracts, "scripts/lib/runtimeContracts.mjs", "export function assertHeartbeatContract");
  requireText(runtimeContracts, "scripts/lib/runtimeContracts.mjs", "export function assertServerDeviceSummaryContract");
  requireText(runtimeContracts, "scripts/lib/runtimeContracts.mjs", "export function assertServerHeartbeatResponseContract");
  requireText(runtimeContracts, "scripts/lib/runtimeContracts.mjs", "export function assertServerHealthResponseContract");
  requireText(runtimeContracts, "scripts/lib/runtimeContracts.mjs", "export function assertServerIssuedProfileContract");
  requireText(runtimeContracts, "scripts/lib/runtimeContracts.mjs", "export function assertVlessParseResponseContract");
  requireText(runtimeContracts, "scripts/lib/runtimeContracts.mjs", "export function assertSingboxClientConfigResponseContract");
  requireText(runtimeContracts, "scripts/lib/runtimeContracts.mjs", "export function assertJobsPreviewResponseContract");
  requireText(runtimeContracts, "scripts/lib/runtimeContracts.mjs", "function assertClaimCreateConfigWriteState");
  requireText(runtimeContracts, "scripts/lib/runtimeContracts.mjs", "assertClaimCreateConfigWriteState(response, label);");
  requireText(runtimeContracts, "scripts/lib/runtimeContracts.mjs", "const expectedKeys = [\"claim\", \"claimCode\", \"code\", \"compatibility\", \"profile\", \"state\", \"tKey\", \"tKeyUri\", \"uri\"];");
  requireText(runtimeContracts, "scripts/lib/runtimeContracts.mjs", "assertCompatibilityContract(response.compatibility, `${label}.compatibility`);");
  if (runtimeContracts.includes("response.compatibility !== undefined")) {
    issues.push("scripts/lib/runtimeContracts.mjs must require claim create compatibility instead of treating it as optional");
  }
  requireText(runtimeContracts, "scripts/lib/runtimeContracts.mjs", "assertExactKeys(response, [\"device\", \"diagnostics\", \"ok\"], label)");
  requireText(runtimeContracts, "scripts/lib/runtimeContracts.mjs", "assertExactKeys(response, [\"error\", \"errorCode\", \"message\", \"ok\"], label)");
  requireText(runtimeContracts, "scripts/lib/runtimeContracts.mjs", "assertEqual(response.ok, false, `${label}.ok`)");
  requireText(runtimeContracts, "scripts/lib/runtimeContracts.mjs", "assertStableErrorCode(response.errorCode, `${label}.errorCode`)");
  requireText(runtimeContracts, "scripts/lib/runtimeContracts.mjs", "assertEqual(response.error, response.errorCode, `${label}.error`)");
  requireText(runtimeContracts, "scripts/lib/runtimeContracts.mjs", "assertNonEmptyString(response.message, `${label}.message`)");
  requireText(runtimeContracts, "scripts/lib/runtimeContracts.mjs", "assertExactKeys(response, [\"profile\", \"rclone\", \"schedule\", \"singbox\"], label)");
  requireText(runtimeContracts, "scripts/lib/runtimeContracts.mjs", "forbidVlessUri");
  requireText(runtimeContracts, "scripts/lib/runtimeContracts.mjs", "leaked raw vlessUri");
  requireText(runtimeContracts, "scripts/lib/runtimeContracts.mjs", "leaked SyncKey URI");
  requireText(runtimeContracts, "scripts/lib/runtimeContracts.mjs", "secretAccessKey");
  requireText(runtimeContracts, "scripts/lib/runtimeContracts.mjs", "tKeyUri");
  requireText(runtimeContracts, "scripts/lib/runtimeContracts.mjs", "assertNoRawClientJobSecrets");
  requireText(runtimeContracts, "scripts/lib/runtimeContracts.mjs", "assertExactKeys(response, [\"job\", \"scheduler\"], label)");
  requireText(runtimeContracts, "scripts/lib/runtimeContracts.mjs", "assertExactKeys(response, [\"sync\"], label)");
  requireText(runtimeContracts, "scripts/lib/runtimeContracts.mjs", "safeguards.localState.files");
  requireText(runtimeContracts, "scripts/lib/runtimeContracts.mjs", "local_state_corrupt");
  requireText(runtimeContracts, "scripts/lib/runtimeContracts.mjs", "assertObject(job.schedule, `${jobLabel}.schedule`)");
  requireText(runtimeContracts, "scripts/lib/runtimeContracts.mjs", "assert(Object.hasOwn(sync, \"lastRun\"), `${label}.lastRun`)");
  requireText(runtimeContracts, "scripts/lib/runtimeContracts.mjs", "assert(Object.hasOwn(sync, \"scheduler\"), `${label}.scheduler`)");
  requireText(runtimeContracts, "scripts/lib/runtimeContracts.mjs", "assert(Object.hasOwn(run, \"job\"), `${label}.job`)");
  requireText(runtimeContracts, "scripts/lib/runtimeContracts.mjs", "assertNonEmptyString(preview.schedule.text, `${label}.schedule.text`)");
  requireText(runtimeContracts, "scripts/lib/runtimeContracts.mjs", "assertNonEmptyString(rclone.displayCommand, `${label}.displayCommand`)");
  requireText(runtimeContracts, "scripts/lib/runtimeContracts.mjs", "assertNonEmptyString(rclone.remoteConfig.displayCommand, `${label}.remoteConfig.displayCommand`)");
  requireText(runtimeContracts, "scripts/lib/runtimeContracts.mjs", "assertNonEmptyString(rclone.remotePath, `${label}.remotePath`)");
  requireText(serverSource, "src/server.js", "summarizeDevice(adminState, user, { includeVlessUri: false })");
  requireText(serverSmoke, "scripts/smoke-server.mjs", "function requireProtocolMapMatch");
  requireText(serverSmoke, "scripts/smoke-server.mjs", "Server health/state diagnostics protocol mismatch");
  requireText(serverSmoke, "scripts/smoke-server.mjs", "assertServerHealthResponseContract(health)");
  requireText(serverSmoke, "scripts/smoke-server.mjs", "assertAdminAuthCheckResponseContract(auth)");
  requireText(serverSmoke, "scripts/smoke-server.mjs", "assertAdminStateSummaryContract(state, \"adminState\")");
  requireText(serverSmoke, "scripts/smoke-server.mjs", "assertAdminSingboxConfigPreviewContract(config, state, \"singboxConfig\")");
  requireText(serverSmoke, "scripts/smoke-server.mjs", "assertAdminWriteStateResponseContract(cleaned, \"claimLifecycle.cleanup\")");
  requireText(serverSmoke, "scripts/smoke-server.mjs", "assertProfileEncodeResponseContract(encodedProfile, \"profileEncode\"");
  requireText(serverSmoke, "scripts/smoke-server.mjs", "assertVlessParseResponseContract(parsedVless, \"vlessParse\")");
  requireText(serverSmoke, "scripts/smoke-server.mjs", "assertJobsPreviewResponseContract(jobsPreview, \"jobsPreview\"");
  requireText(serverSmoke, "scripts/smoke-server.mjs", "assertSingboxClientConfigResponseContract(clientConfig, \"singboxClientConfig\"");
  requireText(serverSmoke, "scripts/smoke-server.mjs", "assertClaimCreateResponseContract(created, \"claimLifecycle.create\"");
  requireText(serverSmoke, "scripts/smoke-server.mjs", "assertClaimRedeemResponseContract(redeemed, \"claimLifecycle.redeemedProfile\"");
  requireText(serverSmoke, "scripts/smoke-server.mjs", "assertClaimRedeemResponseContract(replayed, \"claimLifecycle.replayedProfile\"");
  requireText(serverSmoke, "scripts/smoke-server.mjs", "assertServerHeartbeatResponseContract(value, \"claimLifecycle.heartbeat\")");
  requireText(serverSmoke, "scripts/smoke-server.mjs", "assertServerDeviceSummaryContract(device, \"claimLifecycle.adminState.device\")");
  requireText(serverSmoke, "scripts/smoke-server.mjs", "assertAdminClaimSummaryContract(claim, \"claimLifecycle.adminState.claim\")");
  requireText(serverSmoke, "scripts/smoke-server.mjs", "protocols=aligned");
  requireText(serverSmoke, "scripts/smoke-server.mjs", "--exercise-claim-lifecycle");
  requireText(serverSmoke, "scripts/smoke-server.mjs", "claim-lifecycle-bound-replay");
  requireText(serverSmoke, "scripts/smoke-server.mjs", "claim-lifecycle-duplicate-redeem");
  requireText(serverSmoke, "scripts/smoke-server.mjs", "claim-lifecycle-different-binding-redeem");
  requireText(serverSmoke, "scripts/smoke-server.mjs", "clientRedeemId");
  requireText(serverSmoke, "scripts/smoke-server.mjs", "clientInstallId");
  requireText(serverSmoke, "scripts/smoke-server.mjs", "createHeartbeatAuth(payload, secret)");
  requireText(n1Apply, "scripts/apply-n1-singbox.ps1", "docker compose -f docker-compose.n1.yml restart sing-box");
  requireText(n1Apply, "scripts/apply-n1-singbox.ps1", "/api/admin/singbox/mark-applied");
  requireText(n1Apply, "scripts/apply-n1-singbox.ps1", "confirmMarkApplied = $true");
  requireText(n1Apply, "scripts/apply-n1-singbox.ps1", "server smoke still reports restartRequired=true after mark-applied");
  requireText(n1Apply, "scripts/apply-n1-singbox.ps1", "n1-singbox-apply-report");
  requireText(clientSmoke, "scripts/smoke-client.mjs", "function requireProtocolMapMatch");
  requireText(clientSmoke, "scripts/smoke-client.mjs", "Client health/status diagnostics protocol mismatch");
  requireText(clientSmoke, "scripts/smoke-client.mjs", "protocols=aligned");
  requireText(clientSmoke, "scripts/smoke-client.mjs", "assertClientHealthContract(health)");
  requireText(clientSmoke, "scripts/smoke-client.mjs", "assertClientStatusContract(status)");
  requireText(clientSmoke, "scripts/smoke-client.mjs", "assertClientProfileReadContract(profileRead, \"clientProfile\")");
  requireText(clientSmoke, "scripts/smoke-client.mjs", "assertClientJobsReadContract(jobsRead, \"clientJobs\")");
  requireText(clientSmoke, "scripts/smoke-client.mjs", "assertClientSyncHistoryContract(syncHistory, \"syncHistory\")");
  requireText(clientSmoke, "scripts/smoke-client.mjs", "assertHeartbeatContract(status.heartbeat)");
  requireText(clientSmoke, "scripts/smoke-client.mjs", "assertClientLogsContract(logs, \"clientLogs\")");
  requireText(clientSmoke, "scripts/smoke-client.mjs", "assertDiagnosticExportContract(diagnosticExport, \"diagnosticExport\")");
  requireText(clientSmoke, "scripts/smoke-client.mjs", "client-profile");
  requireText(clientSmoke, "scripts/smoke-client.mjs", "client-jobs");
  requireText(clientSmoke, "scripts/smoke-client.mjs", "client-sync-history");
  requireText(clientSmoke, "scripts/smoke-client.mjs", "client-logs");
  requireText(clientSmoke, "scripts/smoke-client.mjs", "diagnostic-export");
  const clientHttpTest = await readFile(join(root, "tests", "client-http.test.js"), "utf8").catch(() => "");
  if (!clientHttpTest) {
    issues.push("tests/client-http.test.js is missing for client local response contract audit");
  } else {
    requireText(clientHttpTest, "tests/client-http.test.js", "assertClientBinariesCheckContract(missingBinaryCheckPayload, \"missingBinaryCheck\")");
    requireText(clientHttpTest, "tests/client-http.test.js", "assertClientBinariesCheckContract(placeholderBinaryCheckPayload, \"placeholderBinaryCheck\")");
    requireText(clientHttpTest, "tests/client-http.test.js", "assertHttpErrorResponseContract(payload, \"clientMissingRoute\"");
    requireText(clientHttpTest, "tests/client-http.test.js", "assertHttpErrorResponseContract(await escapedStatic.json(), \"clientEscapedStatic\"");
    requireText(clientHttpTest, "tests/client-http.test.js", "assertHttpErrorResponseContract(emptyImportPayload, \"emptyImport\"");
    requireText(clientHttpTest, "tests/client-http.test.js", "assertHttpErrorResponseContract(await missingVaultPreview.json(), \"missingVaultPreview\"");
    requireText(clientHttpTest, "tests/client-http.test.js", "assertHttpErrorResponseContract(await corruptHistoryRun.json(), \"corruptHistoryRun\"");
    requireText(clientHttpTest, "tests/client-http.test.js", "assertHttpErrorResponseContract(await run.json(), \"spawnFailRun\"");
    requireText(clientHttpTest, "tests/client-http.test.js", "assertHttpErrorResponseContract(await firstImport.json(), \"firstImport\"");
    requireText(clientHttpTest, "tests/client-http.test.js", "assertHttpErrorResponseContract(await runDestructiveWithoutConfirmation.json(), \"runDestructiveWithoutConfirmation\"");
    requireText(clientHttpTest, "tests/client-http.test.js", "assertHttpErrorResponseContract(oversizedImportPayload, \"clientOversizedImport\"");
    requireText(clientHttpTest, "tests/client-http.test.js", "assertHttpErrorResponseContract(await invalidJsonImport.json(), \"clientInvalidJsonImport\"");
    requireText(clientHttpTest, "tests/client-http.test.js", "assertClientShutdownResponseContract(await shutdown.json(), \"clientShutdown\")");
    requireText(clientHttpTest, "tests/client-http.test.js", "assertClientSingboxProcessResponseContract(stoppedSingboxPayload, \"stoppedSingbox\")");
  }
  const contractHttpTest = await readFile(join(root, "tests", "contract-http.test.js"), "utf8").catch(() => "");
  if (!contractHttpTest) {
    issues.push("tests/contract-http.test.js is missing for server response contract audit");
  } else {
    requireText(contractHttpTest, "tests/contract-http.test.js", "assertServerHealthResponseContract(health, \"health\")");
    requireText(contractHttpTest, "tests/contract-http.test.js", "assertAdminAuthCheckResponseContract(authenticatedCheck, \"authenticatedCheck\")");
    requireText(contractHttpTest, "tests/contract-http.test.js", "assertAdminSingboxConfigPreviewContract(configPreview, autofill.state, \"configPreview\")");
    requireText(contractHttpTest, "tests/contract-http.test.js", "assertAdminSingboxWriteResponseContract(directWritten, \"directWritten\")");
    requireText(contractHttpTest, "tests/contract-http.test.js", "assertAdminSingboxMarkAppliedResponseContract(directMarkedApplied, \"directMarkedApplied\")");
    requireText(contractHttpTest, "tests/contract-http.test.js", "assertAdminTunnelAutofillResponseContract(autofill, \"autofill\")");
    requireText(contractHttpTest, "tests/contract-http.test.js", "assertAdminTunnelGenerateResponseContract(generated, \"generated\")");
    requireText(contractHttpTest, "tests/contract-http.test.js", "assertAdminSingboxWriteResponseContract(written, \"written\")");
    requireText(contractHttpTest, "tests/contract-http.test.js", "assertAdminSingboxMarkAppliedResponseContract(markedApplied, \"markedApplied\")");
    requireText(contractHttpTest, "tests/contract-http.test.js", "assertAdminStorageSaveResponseContract(storageSave, \"storageSave\"");
    requireText(contractHttpTest, "tests/contract-http.test.js", "assertAdminUserWriteResponseContract(userCreate, \"userCreate\"");
    requireText(contractHttpTest, "tests/contract-http.test.js", "assertAdminUserWriteResponseContract(disabledUser, \"disabledUser\")");
    requireText(contractHttpTest, "tests/contract-http.test.js", "assertAdminUserWriteResponseContract(disabledAgain, \"disabledAgain\")");
    requireText(contractHttpTest, "tests/contract-http.test.js", "assertAdminUserWriteResponseContract(enabledAgain, \"enabledAgain\")");
    requireText(contractHttpTest, "tests/contract-http.test.js", "assertAdminUserDeleteResponseContract(deletedUser, \"deletedUser\")");
    requireText(contractHttpTest, "tests/contract-http.test.js", "assertAdminUserWriteResponseContract(disabledIncompatible, \"disabledIncompatible\")");
    requireText(contractHttpTest, "tests/contract-http.test.js", "assertAdminUserWriteResponseContract(enabledIncompatible, \"enabledIncompatible\")");
    requireText(contractHttpTest, "tests/contract-http.test.js", "assertAdminStorageBucketCreateResponseContract(archiveBucket, \"archiveBucket\")");
    requireText(contractHttpTest, "tests/contract-http.test.js", "assertAdminStorageBucketCreateResponseContract(createdBucket, \"nonEmptyBucket.createdBucket\")");
    requireText(contractHttpTest, "tests/contract-http.test.js", "assertAdminStorageBucketToggleResponseContract(disabledArchiveBucket, \"disabledArchiveBucket\")");
    requireText(contractHttpTest, "tests/contract-http.test.js", "assertAdminStorageBucketToggleResponseContract(enabledArchiveBucket, \"enabledArchiveBucket\")");
    requireText(contractHttpTest, "tests/contract-http.test.js", "assertAdminStorageBucketsRefreshResponseContract(refreshedBuckets, \"refreshedBuckets\")");
    requireText(contractHttpTest, "tests/contract-http.test.js", "assertAdminStorageBucketClearResponseContract(clearedBucket, \"nonEmptyBucket.clearedBucket\")");
    requireText(contractHttpTest, "tests/contract-http.test.js", "assertAdminStorageBucketDeleteEmptyResponseContract(deletedEmptyBucket, \"nonEmptyBucket.deletedEmptyBucket\")");
    requireText(contractHttpTest, "tests/contract-http.test.js", "assertClaimCreateResponseContract(created, \"created\"");
    requireText(contractHttpTest, "tests/contract-http.test.js", "assertClaimRedeemResponseContract(rawRedeemed, \"rawRedeemed\"");
    requireText(contractHttpTest, "tests/contract-http.test.js", "assertServerHeartbeatResponseContract(heartbeat, \"heartbeat\")");
    requireText(contractHttpTest, "tests/contract-http.test.js", "assertHttpErrorResponseContract(await failedGenerate.json(), \"failedGenerate\"");
    requireText(contractHttpTest, "tests/contract-http.test.js", "assertHttpErrorResponseContract(await failedSave.json(), \"failedSave\"");
    requireText(contractHttpTest, "tests/contract-http.test.js", "assertHttpErrorResponseContract(await invalidJson.json(), \"serverInvalidJson\"");
    requireText(contractHttpTest, "tests/contract-http.test.js", "assertHttpErrorResponseContract(await oversizedJson.json(), \"serverOversizedJson\"");
    requireText(contractHttpTest, "tests/contract-http.test.js", "assertHttpErrorResponseContract(await unknownApi.json(), \"serverUnknownApi\"");
    requireText(contractHttpTest, "tests/contract-http.test.js", "assertHttpErrorResponseContract(await missingStatic.json(), \"serverMissingStatic\"");
    requireText(contractHttpTest, "tests/contract-http.test.js", "assertHttpErrorResponseContract(await escapedStatic.json(), \"serverEscapedStatic\"");
    requireText(contractHttpTest, "tests/contract-http.test.js", "assertHttpErrorResponseContract(await unauthenticatedState.json(), \"unauthenticatedState\"");
    requireText(contractHttpTest, "tests/contract-http.test.js", "assertHttpErrorResponseContract(await deleteMissingBucket.json(), \"deleteMissingBucket\"");
    requireText(contractHttpTest, "tests/contract-http.test.js", "assertHttpErrorResponseContract(await invalidVlessParse.json(), \"invalidVlessParse\"");
    requireText(contractHttpTest, "tests/contract-http.test.js", "assertHttpErrorResponseContract(await response.json(), \"validationFailedResponse\"");
  }
  requireText(clientPackageSmoke, "scripts/smoke-client-package.mjs", "Failed check:");
  requireText(clientPackageSmoke, "scripts/smoke-client-package.mjs", "health-readiness");
  requireText(clientPackageSmoke, "scripts/smoke-client-package.mjs", "package-launch");
  requireText(clientPackageSmoke, "scripts/smoke-client-package.mjs", "function requirePackageLaunch");
  requireText(clientPackageSmoke, "scripts/smoke-client-package.mjs", "getRandomPort");
  requireText(clientPackageSmoke, "scripts/smoke-client-package.mjs", "SFSC_CLIENT_DATA_ROOT");
  requireText(clientPackageSmoke, "scripts/smoke-client-package.mjs", "SFSC_PACKAGE_SMOKE");
  requireText(clientPackageSmoke, "scripts/smoke-client-package.mjs", "/api/client/status");
  requireText(clientPackageSmoke, "scripts/smoke-client-package.mjs", "/api/client/shutdown");
  requireText(clientPackageSmoke, "scripts/smoke-client-package.mjs", "function requireBinaryLockContract");
  requireText(clientPackageSmoke, "scripts/smoke-client-package.mjs", "binary lock hashes verified");
  requireText(clientPackageSmoke, "scripts/smoke-client-package.mjs", "does not match binaries.lock.json SHA256.");
}

async function auditStableErrorCodeContract() {
  const [contract, errorsSource, protocolReadme, errorCodeDoc, errorCodeSchemaSource] = await Promise.all([
    readFile(join(root, "docs", "INTERFACE_CONTRACT.md"), "utf8").catch(() => ""),
    readFile(join(root, "src", "core", "errors.js"), "utf8").catch(() => ""),
    readFile(join(root, "docs", "protocol", "README.md"), "utf8").catch(() => ""),
    readFile(join(root, "docs", "protocol", "01-error-codes.md"), "utf8").catch(() => ""),
    readFile(join(root, "docs", "protocol", "schemas", "error-codes.json"), "utf8").catch(() => "")
  ]);

  if (!contract) {
    issues.push("docs/INTERFACE_CONTRACT.md is missing");
    return;
  }
  if (!errorsSource) {
    issues.push("src/core/errors.js is missing");
    return;
  }

  const codes = extractDefaultStatusCodes(errorsSource);
  if (!codes.length) {
    issues.push("src/core/errors.js DEFAULT_STATUS_BY_CODE could not be parsed");
    return;
  }

  for (const { code, status } of codes) {
    const row = new RegExp(`\\|\\s*\`${escapeRegExp(code)}\`\\s*\\|\\s*${status}\\s*\\|`);
    if (!row.test(contract)) {
      issues.push(`docs/INTERFACE_CONTRACT.md must document stable errorCode ${code} with HTTP ${status}`);
    }
  }

  requireText(protocolReadme, "docs/protocol/README.md", "schemas/error-codes.json");
  requireText(protocolReadme, "docs/protocol/README.md", "DEFAULT_STATUS_BY_CODE");
  requireText(errorCodeDoc, "docs/protocol/01-error-codes.md", "HTTP Stable Codes");
  requireText(errorCodeDoc, "docs/protocol/01-error-codes.md", "2xx `ok:false`");
  requireText(errorCodeDoc, "docs/protocol/01-error-codes.md", "POST /api/binaries/check");
  if (!errorCodeSchemaSource) {
    issues.push("docs/protocol/schemas/error-codes.json is missing");
    return;
  }

  let schema;
  try {
    schema = JSON.parse(errorCodeSchemaSource);
  } catch (error) {
    issues.push(`docs/protocol/schemas/error-codes.json could not be parsed: ${error.message}`);
    return;
  }

  if (schema?.schemaVersion !== 1) {
    issues.push("docs/protocol/schemas/error-codes.json schemaVersion must be 1");
  }
  if (schema?.kind !== "sfsc-error-codes") {
    issues.push("docs/protocol/schemas/error-codes.json kind must be sfsc-error-codes");
  }
  const schemaCodes = Array.isArray(schema?.stableHttpCodes) ? schema.stableHttpCodes : [];
  const expectedCodeJson = JSON.stringify(codes);
  const actualCodeJson = JSON.stringify(schemaCodes);
  if (actualCodeJson !== expectedCodeJson) {
    issues.push("docs/protocol/schemas/error-codes.json stableHttpCodes must match src/core/errors.js DEFAULT_STATUS_BY_CODE exactly");
  }

  const expectedClaimRedeemCodes = extractClaimRedeemErrorCodes(errorsSource);
  const actualClaimRedeemCodes = Array.isArray(schema?.claimRedeemPassthroughCodes) ? schema.claimRedeemPassthroughCodes : [];
  if (!expectedClaimRedeemCodes.length) {
    issues.push("src/core/errors.js CLAIM_REDEEM_ERROR_CODES could not be parsed");
  } else if (JSON.stringify(actualClaimRedeemCodes) !== JSON.stringify(expectedClaimRedeemCodes)) {
    issues.push("docs/protocol/schemas/error-codes.json claimRedeemPassthroughCodes must match src/core/errors.js CLAIM_REDEEM_ERROR_CODES exactly");
  }

  for (const code of ["heartbeat_failed", "network_error", "request_timeout", "release_manifest_invalid"]) {
    if (!Array.isArray(schema?.runtimeSynthesizedCodes) || !schema.runtimeSynthesizedCodes.includes(code)) {
      issues.push(`docs/protocol/schemas/error-codes.json runtimeSynthesizedCodes must include ${code}`);
    }
  }
}

async function auditStableErrorCodeUiMessages() {
  const [
    errorsSource,
    serverUiSource,
    clientUiSource
  ] = await Promise.all([
    readFile(join(root, "src", "core", "errors.js"), "utf8").catch(() => ""),
    readFile(join(root, "public", "app.js"), "utf8").catch(() => ""),
    readFile(join(root, "client", "public", "app.js"), "utf8").catch(() => "")
  ]);

  if (!errorsSource) {
    issues.push("src/core/errors.js is missing for UI error message audit");
    return;
  }
  if (!serverUiSource) {
    issues.push("public/app.js is missing for UI error message audit");
    return;
  }
  if (!clientUiSource) {
    issues.push("client/public/app.js is missing for UI error message audit");
    return;
  }

  const codes = extractDefaultStatusCodes(errorsSource).map((item) => item.code);
  if (!codes.length) {
    issues.push("src/core/errors.js DEFAULT_STATUS_BY_CODE could not be parsed for UI error message audit");
    return;
  }

  for (const [label, source] of [
    ["public/app.js", serverUiSource],
    ["client/public/app.js", clientUiSource]
  ]) {
    if (/(["'])request_failed\1/.test(source)) {
      issues.push(`${label} must not synthesize undocumented request_failed`);
    }
    const uiCodes = extractFormatErrorCodes(source);
    if (!uiCodes.length) {
      issues.push(`${label} formatError copy could not be parsed`);
      continue;
    }
    for (const code of codes) {
      if (!uiCodes.includes(code)) {
        issues.push(`${label} formatError must map stable errorCode ${code}`);
      }
    }
  }
}

async function auditClaimCreateUiGuidanceContract() {
  const [
    serverUiSource,
    contract,
    matrix,
    serverDesign,
    coreTest
  ] = await Promise.all([
    readFile(join(root, "public", "app.js"), "utf8").catch(() => ""),
    readFile(join(root, "docs", "INTERFACE_CONTRACT.md"), "utf8").catch(() => ""),
    readFile(join(root, "docs", "API_MATRIX.md"), "utf8").catch(() => ""),
    readFile(join(root, "docs", "server-design.md"), "utf8").catch(() => ""),
    readFile(join(root, "tests", "core.test.js"), "utf8").catch(() => "")
  ]);

  for (const [label, text] of [
    ["public/app.js", serverUiSource],
    ["docs/INTERFACE_CONTRACT.md", contract],
    ["docs/API_MATRIX.md", matrix],
    ["docs/server-design.md", serverDesign],
    ["tests/core.test.js", coreTest]
  ]) {
    if (!text) {
      issues.push(`${label} is missing for claim create UI guidance audit`);
    }
  }
  if (!serverUiSource || !contract || !matrix || !serverDesign || !coreTest) {
    return;
  }

  for (const expected of [
    "function formatClaimCreateError(error)",
    "function claimCreateErrorGuidance(code)",
    "{ errorFormatter: formatClaimCreateError }",
    "return `SyncKey 未生成：${item.message} ${item.action}`;",
    "retryable: true",
    "retryable: false",
    "可重试：请检查 sfsc-state.json 数据目录权限和磁盘空间",
    "确认 sync-server 容器、反代和端口可访问",
    "检查 N1 负载和 sync-server 日志",
    "检查 MinIO/S3 endpoint、密钥和 bucket 权限",
    "请按弹窗确认兼容性风险后再生成 SyncKey",
    "请先在设备列表中重新启用并应用 sing-box 配置",
    "选择其他启用的同步仓库后重新生成 SyncKey",
    "刷新仓库列表并选择仍存在的仓库后重新生成 SyncKey",
    "检查设备名、SyncKey 服务地址、有效期、同步参数和仓库选择"
  ]) {
    requireText(serverUiSource, "public/app.js", expected);
  }

  for (const code of [
    "server_state_write_failed",
    "network_error",
    "request_timeout",
    "storage_request_failed",
    "server_error"
  ]) {
    requireClaimCreateGuidance(serverUiSource, code, true);
  }
  for (const code of [
    "danger_confirmation_required",
    "device_disabled",
    "bucket_disabled",
    "bucket_not_found",
    "user_not_found",
    "validation_failed"
  ]) {
    requireClaimCreateGuidance(serverUiSource, code, false);
  }

  for (const expected of [
    "服务端控制台 SyncKey 生成失败 UI 建议合同",
    "SyncKey 生成可重试错误",
    "`retryable: true`",
    "SyncKey 未生成",
    "检查 `sfsc-state.json` 数据目录权限和磁盘空间",
    "sync-server 容器/反代/端口",
    "MinIO/S3 endpoint、密钥和 bucket 权限",
    "SyncKey 生成前置条件或输入错误",
    "`retryable: false`",
    "确认兼容性风险",
    "重新启用设备并应用 sing-box 配置",
    "检查设备名、SyncKey 服务地址、有效期、同步参数和仓库选择"
  ]) {
    requireText(contract, "docs/INTERFACE_CONTRACT.md", expected);
  }
  for (const expected of [
    "服务端控制台对 `/api/claims/create` 失败必须给出动作建议",
    "retryable: true",
    "retryable: false",
    "SyncKey 未生成",
    "sync-server 容器/反代/端口",
    "刷新设备/仓库列表"
  ]) {
    requireText(matrix, "docs/API_MATRIX.md", expected);
  }
  for (const expected of [
    "SyncKey creation screen formats generation failures with dedicated retry guidance",
    "retryable: true",
    "retryable: false",
    "check `sfsc-state.json` permissions",
    "sync-server reachability/logs",
    "MinIO/S3"
  ]) {
    requireText(serverDesign, "docs/server-design.md", expected);
  }
  requireText(coreTest, "tests/core.test.js", "server console SyncKey generation errors show retry guidance");
  requireText(coreTest, "tests/core.test.js", "claimCreateErrorGuidance");
  requireText(coreTest, "tests/core.test.js", "retryable: true");
  requireText(coreTest, "tests/core.test.js", "retryable: false");
}

async function auditClaimRedeemPreviewUiGuidanceContract() {
  const [
    serverUiSource,
    contract,
    matrix,
    serverDesign,
    coreTest
  ] = await Promise.all([
    readFile(join(root, "public", "app.js"), "utf8").catch(() => ""),
    readFile(join(root, "docs", "INTERFACE_CONTRACT.md"), "utf8").catch(() => ""),
    readFile(join(root, "docs", "API_MATRIX.md"), "utf8").catch(() => ""),
    readFile(join(root, "docs", "server-design.md"), "utf8").catch(() => ""),
    readFile(join(root, "tests", "core.test.js"), "utf8").catch(() => "")
  ]);

  for (const [label, text] of [
    ["public/app.js", serverUiSource],
    ["docs/INTERFACE_CONTRACT.md", contract],
    ["docs/API_MATRIX.md", matrix],
    ["docs/server-design.md", serverDesign],
    ["tests/core.test.js", coreTest]
  ]) {
    if (!text) {
      issues.push(`${label} is missing for claim redeem preview UI guidance audit`);
    }
  }
  if (!serverUiSource || !contract || !matrix || !serverDesign || !coreTest) {
    return;
  }

  for (const expected of [
    "function formatClaimRedeemPreviewError(error)",
    "function claimRedeemPreviewErrorGuidance(code)",
    "{ errorFormatter: formatClaimRedeemPreviewError }",
    "return `SyncKey 测试兑换失败：${item.message} ${item.action}`;",
    "不可重试当前 SyncKey",
    "重新复制完整 SyncKey",
    "兑换状态未成功持久化",
    "SyncKey 不应视为已消耗",
    "修复后用同一个 SyncKey 再试",
    "结果未知：请先刷新管理状态查看 claim 是否已 used/redeemedAt",
    "不要把这个 SyncKey 交给客户端",
    "无法确认时重新生成 SyncKey"
  ]) {
    requireText(serverUiSource, "public/app.js", expected);
  }

  for (const code of [
    "claim_not_found",
    "claim_already_used",
    "claim_expired",
    "validation_failed",
    "import_code_invalid"
  ]) {
    requireClaimRedeemPreviewGuidance(serverUiSource, code, false);
  }
  requireClaimRedeemPreviewGuidance(serverUiSource, "server_state_write_failed", true);
  for (const code of [
    "network_error",
    "request_timeout",
    "server_error",
    "claim_redeem_failed"
  ]) {
    requireClaimRedeemPreviewGuidance(serverUiSource, code, false);
  }

  for (const expected of [
    "服务端控制台 SyncKey 测试兑换失败 UI 建议合同",
    "测试兑换终态或输入错误",
    "`retryable: false`",
    "不可重试当前 SyncKey",
    "重新复制完整 SyncKey",
    "`server_state_write_failed` 是测试兑换可重试错误",
    "`retryable: true`",
    "SyncKey 不应视为已消耗",
    "修复后用同一个 SyncKey 再试",
    "测试兑换结果未知错误",
    "不要把这个 SyncKey 交给客户端",
    "无法确认时重新生成 SyncKey"
  ]) {
    requireText(contract, "docs/INTERFACE_CONTRACT.md", expected);
  }
  for (const expected of [
    "服务端控制台对 `/api/claims/redeem` 测试兑换失败必须给出动作建议",
    "SyncKey 测试兑换失败",
    "不可重试当前 SyncKey/当前内容",
    "server_state_write_failed",
    "SyncKey 不应视为已消耗",
    "用同一个 SyncKey 再试",
    "结果未知",
    "不要把这个 SyncKey 交给客户端"
  ]) {
    requireText(matrix, "docs/API_MATRIX.md", expected);
  }
  for (const expected of [
    "SyncKey redeem preview screen formats failed test redemptions with dedicated safety guidance",
    "retryable: true",
    "retryable: false",
    "should not be considered consumed",
    "the result is unknown",
    "avoid handing that SyncKey to a client"
  ]) {
    requireText(serverDesign, "docs/server-design.md", expected);
  }
  requireText(coreTest, "tests/core.test.js", "server console SyncKey redeem preview errors show safety guidance");
  requireText(coreTest, "tests/core.test.js", "claimRedeemPreviewErrorGuidance");
  requireText(coreTest, "tests/core.test.js", "retryable: true");
  requireText(coreTest, "tests/core.test.js", "retryable: false");
}

async function auditValidationFailedHttpCoverage() {
  const [contract, contractHttpTest, serverAdminSource, coreTest] = await Promise.all([
    readFile(join(root, "docs", "INTERFACE_CONTRACT.md"), "utf8").catch(() => ""),
    readFile(join(root, "tests", "contract-http.test.js"), "utf8").catch(() => ""),
    readFile(join(root, "src", "core", "serverAdmin.js"), "utf8").catch(() => ""),
    readFile(join(root, "tests", "core.test.js"), "utf8").catch(() => "")
  ]);

  if (!contract) {
    issues.push("docs/INTERFACE_CONTRACT.md is missing for validation_failed HTTP audit");
    return;
  }
  if (!contractHttpTest) {
    issues.push("tests/contract-http.test.js is missing for validation_failed HTTP audit");
    return;
  }
  if (!serverAdminSource) {
    issues.push("src/core/serverAdmin.js is missing for validation_failed HTTP audit");
    return;
  }
  if (!coreTest) {
    issues.push("tests/core.test.js is missing for validation_failed HTTP audit");
    return;
  }

  for (const expected of [
    "覆盖 clientName、bucket、remoteName、URL、host、端口、REALITY SNI、REALITY public/private key、REALITY shortId、存储 prefix、profile defaults、job preview 数值字段、计划和带宽限制等字段",
    "显式传入的空字符串、0、非法 URL/host/port 或空存储字段必须按非法输入处理",
    "不得当作“未传”并回退到默认值或既有状态",
    "`400 validation_failed`",
    "bucket 名、endpoint、prefix 等字段校验失败返回 `400 validation_failed`",
    "`defaults.localProxyPort` 必须是 1..65535 的整数",
    "`job.transfers`、`job.streams`、`job.checkers`、`job.retries`、`job.lowLevelRetries` 和 `job.s3UploadConcurrency` 必须是正整数"
  ]) {
    requireText(contract, "docs/INTERFACE_CONTRACT.md", expected);
  }

  for (const expected of [
    "https://www.microsoft.com",
    "publicPort: \"70000\"",
    "prefixRoot: \"../devices\"",
    "sharedPrefix: \"C:\\\\shared\"",
    "publicKey: \"SERVER_PUBLIC_KEY\"",
    "shortId: \"not-hex\"",
    "[\"localProxyPort\", \"abc\"]",
    "[\"localProxyPort\", 70000]",
    "[\"transfers\", \"many\"]",
    "[\"s3UploadConcurrency\", 0]",
    "decodeImportProfile(encodedNestedDefaultsProfile.code).defaults",
    "schedule: { mode: \"interval\", intervalMinutes: 0 }",
    "bandwidthLimit: \"fast\"",
    "remoteFolder: \"../escape\"",
    "async function assertValidationFailedResponse"
  ]) {
    requireText(contractHttpTest, "tests/contract-http.test.js", expected);
  }

  requireText(serverAdminSource, "src/core/serverAdmin.js", "function hasInputField(input, field)");
  requireText(serverAdminSource, "src/core/serverAdmin.js", "return Object.hasOwn(input, field);");
  requireText(serverAdminSource, "src/core/serverAdmin.js", "return hasInputField(input, field) ? input[field] : fallback;");
  requireText(serverAdminSource, "src/core/serverAdmin.js", "firstInputFieldOrDefault(input, fields, fallback)");
  requireText(coreTest, "tests/core.test.js", "server admin write APIs reject explicit invalid falsy fields without fallback side effects");
  for (const expected of [
    "updateTunnelConfig(state, { publicPort: 0 })",
    "updateTunnelConfig(state, { listenPort: 0 })",
    "updateStorageConfig(state, { endpoint: \"\" })",
    "updateStorageConfig(state, { remoteName: \"\" })",
    "updateStorageConfig(state, { prefixRoot: \"\" })",
    "createManagedUser(state, { clientName: \"\" })",
    "createClaim(state, { clientName: \"\" })"
  ]) {
    requireText(coreTest, "tests/core.test.js", expected);
  }
  if (/input\.publicPort\s*\|\|\s*state\.tunnel\.publicPort/.test(serverAdminSource)
    || /input\.listenPort\s*\|\|\s*state\.tunnel\.listenPort/.test(serverAdminSource)
    || /input\.remoteName\s*\|\|\s*state\.storage\.remoteName/.test(serverAdminSource)
    || /input\.clientName\s*\|\|\s*"company-pc1"/.test(serverAdminSource)) {
    issues.push("src/core/serverAdmin.js must not treat explicit falsy admin write inputs as missing");
  }
}

async function auditRuntimeDiagnosticsContract() {
  const [
    contract,
    diagnosticsSource,
    claimSource,
    profileSource,
    serverAdminSource,
    clientUiSource,
    serverUiSource,
    coreTest
  ] = await Promise.all([
    readFile(join(root, "docs", "INTERFACE_CONTRACT.md"), "utf8").catch(() => ""),
    readFile(join(root, "src", "core", "diagnostics.js"), "utf8").catch(() => ""),
    readFile(join(root, "src", "core", "claimProtocol.js"), "utf8").catch(() => ""),
    readFile(join(root, "src", "core", "profileProtocol.js"), "utf8").catch(() => ""),
    readFile(join(root, "src", "core", "serverAdmin.js"), "utf8").catch(() => ""),
    readFile(join(root, "client", "public", "app.js"), "utf8").catch(() => ""),
    readFile(join(root, "public", "app.js"), "utf8").catch(() => ""),
    readFile(join(root, "tests", "core.test.js"), "utf8").catch(() => "")
  ]);

  if (!contract) {
    issues.push("docs/INTERFACE_CONTRACT.md is missing");
    return;
  }
  if (!diagnosticsSource || !claimSource || !profileSource || !serverAdminSource || !clientUiSource || !serverUiSource || !coreTest) {
    issues.push("runtime diagnostics protocol sources are missing");
    return;
  }

  const appId = extractStringConstant(diagnosticsSource, "APP_ID");
  const protocols = {
    claim: extractNumberConstant(claimSource, "CLAIM_VERSION"),
    profile: extractNumberConstant(profileSource, "PROFILE_VERSION"),
    adminState: extractNumberConstant(diagnosticsSource, "ADMIN_STATE_VERSION"),
    clientStatus: extractNumberConstant(diagnosticsSource, "CLIENT_STATUS_VERSION"),
    heartbeat: extractNumberConstant(diagnosticsSource, "HEARTBEAT_VERSION")
  };

  if (!appId) {
    issues.push("src/core/diagnostics.js APP_ID could not be parsed");
  } else if (!contract.includes(`"app": "${appId}"`)) {
    issues.push(`docs/INTERFACE_CONTRACT.md must document diagnostics app ${appId}`);
  }

  for (const [field, version] of Object.entries(protocols)) {
    if (!Number.isInteger(version)) {
      issues.push(`runtime diagnostics protocol ${field} version could not be parsed`);
      continue;
    }
    const pattern = new RegExp(`"${escapeRegExp(field)}"\\s*:\\s*${version}\\b`);
    if (!pattern.test(contract)) {
      issues.push(`docs/INTERFACE_CONTRACT.md must document diagnostics.protocols.${field} version ${version}`);
    }
  }

  requireText(coreTest, "tests/core.test.js", "runtime diagnostics treat partial protocol diagnostics as missing");
  requireText(coreTest, "tests/core.test.js", "partialLegacyClient");
  requireText(coreTest, "tests/core.test.js", "compatibility.policy.syncRun, \"warn\"");
  requireText(diagnosticsSource, "src/core/diagnostics.js", "[\"claim\", \"profile\", \"adminState\", \"clientStatus\", \"heartbeat\"]");
  requireText(contract, "docs/INTERFACE_CONTRACT.md", "双端兼容性判断以 `diagnostics.protocols.claim`、`profile`、`adminState`、`clientStatus`、`heartbeat` 为准");
  requireText(contract, "docs/INTERFACE_CONTRACT.md", "若某次设备 heartbeat 未上报 `diagnostics`");
  requireText(contract, "docs/INTERFACE_CONTRACT.md", "不得沿用该设备较早 heartbeat 的 diagnostics 或兼容性结果");
  requireText(serverAdminSource, "src/core/serverAdmin.js", "user.diagnostics = input.diagnostics ? normalizeRuntimeDiagnostics(input.diagnostics, \"client\") : null;");
  requireText(coreTest, "tests/core.test.js", "device heartbeat without diagnostics clears stale compatibility");
  requireText(coreTest, "tests/core.test.js", "assert.equal(state.users[0].diagnostics, null)");
  requireText(coreTest, "tests/core.test.js", "summary.devices[0].compatibility.action, \"diagnostics_missing\"");
  requireText(coreTest, "tests/core.test.js", "[\"adminState\", \"remote_missing\", null]");
  requireText(coreTest, "tests/core.test.js", "[\"clientStatus\", \"remote_missing\", null]");
  requireText(coreTest, "tests/core.test.js", "[\"heartbeat\", \"remote_missing\", null]");
  requireText(coreTest, "tests/core.test.js", "admin summary treats missing adminState protocol as incomplete diagnostics");
  requireText(contract, "docs/INTERFACE_CONTRACT.md", "协议展示必须覆盖 `claim`、`profile`、`adminState`、`clientStatus` 和 `heartbeat`");
  for (const [label, snippet] of [
    ["claim", "[\"SyncKey\", protocols.claim]"],
    ["profile", "[\"profile\", protocols.profile]"],
    ["adminState", "[\"admin\", protocols.adminState]"],
    ["clientStatus", "[\"status\", protocols.clientStatus]"],
    ["heartbeat", "[\"heartbeat\", protocols.heartbeat]"]
  ]) {
    requireText(clientUiSource, "client/public/app.js", snippet);
    requireText(serverUiSource, "public/app.js", snippet);
  }
  requireText(coreTest, "tests/core.test.js", "/\\[\"admin\", protocols\\.adminState\\]/");
}

async function auditProtocolV1Baseline() {
  const [baselineSource, baselineDoc, diagnosticsSource, claimSource, profileSource] = await Promise.all([
    readFile(join(root, "docs", "protocol", "schemas", "protocol-v1-baseline.json"), "utf8").catch(() => ""),
    readFile(join(root, "docs", "protocol", "PROTOCOL_V1_BASELINE.md"), "utf8").catch(() => ""),
    readFile(join(root, "src", "core", "diagnostics.js"), "utf8").catch(() => ""),
    readFile(join(root, "src", "core", "claimProtocol.js"), "utf8").catch(() => ""),
    readFile(join(root, "src", "core", "profileProtocol.js"), "utf8").catch(() => "")
  ]);
  if (!baselineSource || !baselineDoc || !diagnosticsSource || !claimSource || !profileSource) {
    issues.push("Protocol v1 baseline sources are missing");
    return;
  }

  let baseline;
  try {
    baseline = JSON.parse(baselineSource);
  } catch {
    issues.push("docs/protocol/schemas/protocol-v1-baseline.json is not valid JSON");
    return;
  }
  const expectedProtocols = {
    claim: extractNumberConstant(claimSource, "CLAIM_VERSION"),
    profile: extractNumberConstant(profileSource, "PROFILE_VERSION"),
    adminState: extractNumberConstant(diagnosticsSource, "ADMIN_STATE_VERSION"),
    clientStatus: extractNumberConstant(diagnosticsSource, "CLIENT_STATUS_VERSION"),
    heartbeat: extractNumberConstant(diagnosticsSource, "HEARTBEAT_VERSION")
  };
  if (baseline.schemaVersion !== 1 || baseline.kind !== "sfsc-protocol-baseline" || baseline.protocolBaseline !== "SFSC Protocol v1" || baseline.status !== "frozen") {
    issues.push("Protocol v1 baseline identity must remain frozen and versioned");
  }
  for (const [field, version] of Object.entries(expectedProtocols)) {
    if (baseline.protocols?.[field] !== version) {
      issues.push(`Protocol v1 baseline ${field} version must match runtime version ${version}`);
    }
  }
  if (baseline.compatibility?.onMismatch !== "warn_and_confirm" || baseline.compatibility?.heartbeat !== "allow" || baseline.compatibility?.profileIssue !== "warn" || baseline.compatibility?.syncRun !== "warn" || baseline.compatibility?.silentAllow !== false) {
    issues.push("Protocol v1 baseline compatibility policy must require confirmation without silent allow");
  }
  if (baseline.breakingChangePolicy !== "increment_protocol_version") {
    issues.push("Protocol v1 baseline must require a protocol version increment for breaking changes");
  }
  const requiredEvidence = ["full-contract-tests", "release-audit", "strict-preflight-without-skips", "desktop-and-portable-package-smoke", "release-bundle-sha256", "n1-claim-lifecycle-smoke", "n1-final-restart-clear", "source-fingerprint-alignment"];
  for (const item of requiredEvidence) {
    if (!baseline.requiredEvidence?.includes(item)) {
      issues.push(`Protocol v1 baseline requiredEvidence is missing ${item}`);
    }
  }
  for (const text of ["Status: frozen contract baseline.", "must introduce a later protocol version", "source fingerprint and build ID", "restartRequired=false"]) {
    requireText(baselineDoc, "docs/protocol/PROTOCOL_V1_BASELINE.md", text);
  }
}

async function auditHttpRuntimeProtocolDocs() {
  const [
    protocolReadme,
    httpDoc,
    diagnosticsDoc,
    httpSchemaSource,
    diagnosticsSchemaSource,
    serverSource,
    clientSource,
    sharedHttpSource,
    serverAdminSource,
    profileImportSource,
    errorsSource,
    diagnosticsSource,
    claimSource,
    profileSource,
    runtimeContracts,
    coreTest,
    clientHttpTest
  ] = await Promise.all([
    readFile(join(root, "docs", "protocol", "README.md"), "utf8").catch(() => ""),
    readFile(join(root, "docs", "protocol", "00-http-basics.md"), "utf8").catch(() => ""),
    readFile(join(root, "docs", "protocol", "06-runtime-diagnostics.md"), "utf8").catch(() => ""),
    readFile(join(root, "docs", "protocol", "schemas", "http-basics.json"), "utf8").catch(() => ""),
    readFile(join(root, "docs", "protocol", "schemas", "runtime-diagnostics.json"), "utf8").catch(() => ""),
    readFile(join(root, "src", "server.js"), "utf8").catch(() => ""),
    readFile(join(root, "client", "src", "clientServer.js"), "utf8").catch(() => ""),
    readFile(join(root, "src", "core", "httpJson.js"), "utf8").catch(() => ""),
    readFile(join(root, "src", "core", "serverAdmin.js"), "utf8").catch(() => ""),
    readFile(join(root, "client", "src", "profileImport.js"), "utf8").catch(() => ""),
    readFile(join(root, "src", "core", "errors.js"), "utf8").catch(() => ""),
    readFile(join(root, "src", "core", "diagnostics.js"), "utf8").catch(() => ""),
    readFile(join(root, "src", "core", "claimProtocol.js"), "utf8").catch(() => ""),
    readFile(join(root, "src", "core", "profileProtocol.js"), "utf8").catch(() => ""),
    readFile(join(root, "scripts", "lib", "runtimeContracts.mjs"), "utf8").catch(() => ""),
    readFile(join(root, "tests", "core.test.js"), "utf8").catch(() => ""),
    readFile(join(root, "tests", "client-http.test.js"), "utf8").catch(() => "")
  ]);

  for (const [label, text] of [
    ["docs/protocol/README.md", protocolReadme],
    ["docs/protocol/00-http-basics.md", httpDoc],
    ["docs/protocol/06-runtime-diagnostics.md", diagnosticsDoc],
    ["docs/protocol/schemas/http-basics.json", httpSchemaSource],
    ["docs/protocol/schemas/runtime-diagnostics.json", diagnosticsSchemaSource],
    ["src/server.js", serverSource],
    ["client/src/clientServer.js", clientSource],
    ["src/core/httpJson.js", sharedHttpSource],
    ["src/core/serverAdmin.js", serverAdminSource],
    ["client/src/profileImport.js", profileImportSource],
    ["src/core/errors.js", errorsSource],
    ["src/core/diagnostics.js", diagnosticsSource],
    ["src/core/claimProtocol.js", claimSource],
    ["src/core/profileProtocol.js", profileSource],
    ["scripts/lib/runtimeContracts.mjs", runtimeContracts],
    ["tests/core.test.js", coreTest],
    ["tests/client-http.test.js", clientHttpTest]
  ]) {
    if (!text) {
      issues.push(`${label} is missing for HTTP/runtime protocol audit`);
    }
  }
  if (!protocolReadme || !httpDoc || !diagnosticsDoc || !httpSchemaSource || !diagnosticsSchemaSource || !serverSource || !clientSource || !sharedHttpSource || !serverAdminSource || !profileImportSource || !errorsSource || !diagnosticsSource || !claimSource || !profileSource || !runtimeContracts || !coreTest || !clientHttpTest) {
    return;
  }

  for (const expected of ["00-http-basics.md", "06-runtime-diagnostics.md", "schemas/http-basics.json", "schemas/runtime-diagnostics.json"]) {
    requireText(protocolReadme, "docs/protocol/README.md", expected);
  }

  for (const expected of [
    "2097152` bytes (2 MiB)",
    "A missing `Origin` is accepted",
    "a cross-site request is rejected with `local_write_forbidden` before media-type or endpoint validation",
    "protected or unmatched `POST` carrying a non-JSON body returns `unsupported_media_type` before authentication or route-not-found handling",
    "A zero-byte chunked request still requires `application/json`.",
    "its scheme is not `http:`",
    "Their raw exception messages must not cross the HTTP boundary.",
    "`error`, `errorCode`, `message`, `ok`"
  ]) {
    requireText(httpDoc, "docs/protocol/00-http-basics.md", expected);
  }
  for (const expected of [
    "These protocol versions, not the product version string alone, decide double-end compatibility.",
    "Partial legacy diagnostics are not treated as compatible.",
    "mixed older and newer directions: `manual_check`",
    "Current policy always allows heartbeat and admin actions",
    "the server clears stale diagnostics",
    "A shaped but forged `action: \"none\"` or `syncRun: \"allow\"` must never bypass confirmation.",
    "`ADMIN_STATE_VERSION` and `PROFILE_VERSION` are the single implementation sources"
  ]) {
    requireText(diagnosticsDoc, "docs/protocol/06-runtime-diagnostics.md", expected);
  }

  const httpSchema = parseProtocolJsonSchema(httpSchemaSource, "docs/protocol/schemas/http-basics.json");
  const diagnosticsSchema = parseProtocolJsonSchema(diagnosticsSchemaSource, "docs/protocol/schemas/runtime-diagnostics.json");
  if (!httpSchema || !diagnosticsSchema) {
    return;
  }
  if (httpSchema.schemaVersion !== 1 || httpSchema.kind !== "sfsc-http-basics") {
    issues.push("docs/protocol/schemas/http-basics.json must use schemaVersion 1 and kind sfsc-http-basics");
  }
  if (diagnosticsSchema.schemaVersion !== 1 || diagnosticsSchema.kind !== "sfsc-runtime-diagnostics") {
    issues.push("docs/protocol/schemas/runtime-diagnostics.json must use schemaVersion 1 and kind sfsc-runtime-diagnostics");
  }

  if (httpSchema.writeMethod !== "POST" || httpSchema.requestMediaType !== "application/json" || httpSchema.mediaTypeParametersAllowed !== true) {
    issues.push("docs/protocol/schemas/http-basics.json must describe POST application/json writes with media type parameters allowed");
  }
  if (JSON.stringify(httpSchema.emptyBodyValue) !== "{}") {
    issues.push("docs/protocol/schemas/http-basics.json emptyBodyValue must be an empty object");
  }
  if (httpSchema.maxJsonBodyBytes !== 2 * 1024 * 1024) {
    issues.push("docs/protocol/schemas/http-basics.json maxJsonBodyBytes must be 2097152");
  }
  if (httpSchema.responseMediaType !== "application/json; charset=utf-8" || httpSchema.responseCacheControl !== "no-store") {
    issues.push("docs/protocol/schemas/http-basics.json must match JSON response media type and cache policy");
  }
  requireSchemaArray(httpSchema, "docs/protocol/schemas/http-basics.json", "errorEnvelopeKeys", ["error", "errorCode", "message", "ok"]);
  requireSchemaArray(httpSchema, "docs/protocol/schemas/http-basics.json", "serverWriteGuardOrder", ["contentType", "adminAuthorization", "requestSchema", "handler"]);
  requireSchemaArray(httpSchema, "docs/protocol/schemas/http-basics.json", "clientWriteGuardOrder", ["browserOrigin", "contentType", "requestSchema", "handler"]);
  requireSchemaArray(httpSchema, "docs/protocol/schemas/http-basics.json", "clientAllowedOriginHosts", ["localhost", "127.0.0.1", "::1"]);
  requireSchemaArray(httpSchema, "docs/protocol/schemas/http-basics.json", "clientAllowedOriginSchemes", ["http:"]);
  if (httpSchema.clientOriginPortMustMatch !== true || httpSchema.missingOriginAllowed !== true || httpSchema.emptyBodyRequiresNoTransferEncoding !== true) {
    issues.push("docs/protocol/schemas/http-basics.json must require a matching local origin port while allowing missing Origin");
  }
  if (JSON.stringify(httpSchema.fallbackMessages) !== JSON.stringify({ client_error: "Client request failed", server_error: "Internal server error" })) {
    issues.push("docs/protocol/schemas/http-basics.json fallbackMessages must use stable public messages");
  }
  const expectedTransportErrors = {
    invalidJson: { code: "invalid_json", status: 400 },
    localWriteForbidden: { code: "local_write_forbidden", status: 403 },
    requestBodyTooLarge: { code: "request_body_too_large", status: 413 },
    unsupportedMediaType: { code: "unsupported_media_type", status: 415 }
  };
  if (JSON.stringify(httpSchema.transportErrorCodes) !== JSON.stringify(expectedTransportErrors)) {
    issues.push("docs/protocol/schemas/http-basics.json transportErrorCodes must match the shared stable HTTP error mapping");
  }
  const statusByCode = Object.fromEntries(extractDefaultStatusCodes(errorsSource).map(({ code, status }) => [code, status]));
  for (const { code, status } of Object.values(expectedTransportErrors)) {
    if (statusByCode[code] !== status) {
      issues.push(`src/core/errors.js must map ${code} to HTTP ${status}`);
    }
  }
  for (const [label, source] of [["src/server.js", serverSource], ["client/src/clientServer.js", clientSource]]) {
    requireText(source, label, "assertJsonWriteContentType");
    requireText(source, label, "readJson");
    requireText(source, label, "\"content-type\": \"application/json; charset=utf-8\"");
    requireText(source, label, "\"cache-control\": \"no-store\"");
  }
  for (const expected of [
    "export const MAX_JSON_BODY_BYTES = 2 * 1024 * 1024;",
    "if (size + bytes.length > MAX_JSON_BODY_BYTES)",
    "chunks.push(bytes);",
    "if (size === 0) return {};",
    "Buffer.concat(chunks, size).toString(\"utf8\")",
    "throw createHttpError(\"request_body_too_large\", 413, \"Request body too large\")"
  ]) {
    requireText(sharedHttpSource, "src/core/httpJson.js", expected);
  }
  if (/raw\s*\+=\s*chunk/.test(serverSource) || /raw\s*\+=\s*chunk/.test(clientSource) || /raw\s*\+=\s*chunk/.test(sharedHttpSource)) {
    issues.push("shared JSON body parsing must not decode UTF-8 per network chunk");
  }
  requireTextOrder(serverSource, "src/server.js", [
    "assertJsonWriteContentType(req);",
    "assertAdminAuthorized(req);",
    "parseProtocolRequest(PROTOCOL_REQUESTS.SERVER_ADMIN_TUNNEL_GENERATE, await readJson(req))"
  ], "server write guard order");
  requireText(clientSource, "client/src/clientServer.js", "function assertLocalWriteRequest(req) {\n  assertBrowserWriteOrigin(req);\n  assertJsonWriteContentType(req);\n}");
  requireText(clientSource, "client/src/clientServer.js", "parsed.protocol !== \"http:\"");
  requireTextOrder(clientSource, "client/src/clientServer.js", [
    "assertLocalWriteRequest(req);",
    "parseProtocolRequest(PROTOCOL_REQUESTS.CLIENT_SHUTDOWN, await readJson(req))"
  ], "client write guard order");
  requireText(runtimeContracts, "scripts/lib/runtimeContracts.mjs", "assertExactKeys(response, [\"error\", \"errorCode\", \"message\", \"ok\"], label)");
  requireText(errorsSource, "src/core/errors.js", "code === \"client_error\" ? \"Client request failed\" : \"Internal server error\"");
  for (const expected of [
    "shared JSON body reader preserves split UTF-8 and enforces the byte limit",
    "runtime diagnostics reject coerced versions and invalid roles",
    "device heartbeat treats malformed diagnostics as missing"
  ]) {
    requireText(coreTest, "tests/core.test.js", expected);
  }
  for (const expected of [
    "client local write APIs reject cross-site and non-JSON browser writes",
    "client heartbeat treats malformed successful responses as heartbeat_failed",
    "R200-HEARTBEAT-FORGED-ALLOW-POLICY"
  ]) {
    requireText(clientHttpTest, "tests/client-http.test.js", expected);
  }

  const expectedProtocols = {
    claim: extractNumberConstant(claimSource, "CLAIM_VERSION"),
    profile: extractNumberConstant(profileSource, "PROFILE_VERSION"),
    adminState: extractNumberConstant(diagnosticsSource, "ADMIN_STATE_VERSION"),
    clientStatus: extractNumberConstant(diagnosticsSource, "CLIENT_STATUS_VERSION"),
    heartbeat: extractNumberConstant(diagnosticsSource, "HEARTBEAT_VERSION")
  };
  if (diagnosticsSchema.appId !== extractStringConstant(diagnosticsSource, "APP_ID")) {
    issues.push("docs/protocol/schemas/runtime-diagnostics.json appId must match src/core/diagnostics.js APP_ID");
  }
  if (JSON.stringify(diagnosticsSchema.protocolVersions) !== JSON.stringify(expectedProtocols)) {
    issues.push("docs/protocol/schemas/runtime-diagnostics.json protocolVersions must match runtime protocol constants exactly");
  }
  requireSchemaArray(diagnosticsSchema, "docs/protocol/schemas/runtime-diagnostics.json", "diagnosticsKeys", ["app", "buildId", "buildTime", "protocols", "role", "version"]);
  requireSchemaArray(diagnosticsSchema, "docs/protocol/schemas/runtime-diagnostics.json", "protocolFields", ["claim", "profile", "adminState", "clientStatus", "heartbeat"]);
  requireSchemaArray(diagnosticsSchema, "docs/protocol/schemas/runtime-diagnostics.json", "compatibilityKeys", ["action", "issues", "localRole", "ok", "policy", "remoteRole", "severity", "status"]);
  requireSchemaArray(diagnosticsSchema, "docs/protocol/schemas/runtime-diagnostics.json", "compatibilityPolicyKeys", ["adminActions", "heartbeat", "profileIssue", "reason", "syncRun"]);
  requireSchemaArray(diagnosticsSchema, "docs/protocol/schemas/runtime-diagnostics.json", "compatibilityIssueKeys", ["field", "local", "message", "remote", "type"]);
  requireSchemaArray(diagnosticsSchema, "docs/protocol/schemas/runtime-diagnostics.json", "compatibilityIssueFields", ["claim", "profile", "adminState", "clientStatus", "heartbeat"]);
  requireSchemaArray(diagnosticsSchema, "docs/protocol/schemas/runtime-diagnostics.json", "compatibilityStatuses", ["compatible", "mismatch"]);
  requireSchemaArray(diagnosticsSchema, "docs/protocol/schemas/runtime-diagnostics.json", "compatibilityActions", ["diagnostics_missing", "manual_check", "none", "upgrade_local", "upgrade_remote"]);
  requireSchemaArray(diagnosticsSchema, "docs/protocol/schemas/runtime-diagnostics.json", "compatibilitySeverities", ["ok", "warning"]);
  requireSchemaArray(diagnosticsSchema, "docs/protocol/schemas/runtime-diagnostics.json", "compatibilityPolicyValues", ["allow", "warn"]);
  requireSchemaArray(diagnosticsSchema, "docs/protocol/schemas/runtime-diagnostics.json", "compatibilityIssueTypes", ["local_missing", "remote_missing", "remote_newer", "remote_older"]);
  if (JSON.stringify(diagnosticsSchema.compatiblePolicy) !== JSON.stringify({ adminActions: "allow", heartbeat: "allow", profileIssue: "allow", syncRun: "allow" })) {
    issues.push("docs/protocol/schemas/runtime-diagnostics.json compatiblePolicy must match buildCompatibilityPolicy");
  }
  if (JSON.stringify(diagnosticsSchema.mismatchPolicy) !== JSON.stringify({ adminActions: "allow", heartbeat: "allow", profileIssue: "warn", syncRun: "warn" })) {
    issues.push("docs/protocol/schemas/runtime-diagnostics.json mismatchPolicy must match buildCompatibilityPolicy");
  }
  if (diagnosticsSchema.strictDiagnosticsKeys !== true || diagnosticsSchema.compatibilityDerivedFromDiagnostics !== true) {
    issues.push("docs/protocol/schemas/runtime-diagnostics.json must require strict diagnostics and derived compatibility");
  }
  for (const expected of [
    "export function normalizeRuntimeDiagnostics",
    "hasExactKeys(input, [\"app\", \"buildId\", \"buildTime\", \"protocols\", \"role\", \"version\"])",
    "return Number.isInteger(value) && value >= 1 ? value : null;",
    "const remoteProtocols = isRuntimeDiagnosticsEnvelope(remote, expectedRemoteRole) ? remote.protocols : {};"
  ]) {
    requireText(diagnosticsSource, "src/core/diagnostics.js", expected);
  }
  for (const [label, source, expected] of [
    ["src/core/serverAdmin.js", serverAdminSource, "version: ADMIN_STATE_VERSION"],
    ["src/core/serverAdmin.js", serverAdminSource, "version: PROFILE_VERSION"],
    ["src/server.js", serverSource, "version: PROFILE_VERSION"],
    ["client/src/profileImport.js", profileImportSource, "version: PROFILE_VERSION"],
    ["scripts/lib/runtimeContracts.mjs", runtimeContracts, "assertEqual(profile.version, PROFILE_VERSION"],
    ["scripts/lib/runtimeContracts.mjs", runtimeContracts, "assertEqual(state.version, ADMIN_STATE_VERSION"]
  ]) {
    requireText(source, label, expected);
  }
  requireText(serverAdminSource, "src/core/serverAdmin.js", "inputVersion > ADMIN_STATE_VERSION");
  requireText(clientSource, "client/src/clientServer.js", "compareRuntimeDiagnostics(diagnosticsValidation.diagnostics, diagnostics");
  requireText(clientSource, "client/src/clientServer.js", "isDeepStrictEqual(compatibility, expectedCompatibility)");
  requireText(runtimeContracts, "scripts/lib/runtimeContracts.mjs", "const expectedAction = summarizeCompatibilityAction(compatibility.issues);");
  requireText(runtimeContracts, "scripts/lib/runtimeContracts.mjs", "assertEqual(compatibility.policy.syncRun, mismatch ? \"warn\" : \"allow\"");
  for (const expected of [
    "const COMPATIBILITY_STATUSES = [\"compatible\", \"mismatch\"]",
    "const COMPATIBILITY_ACTIONS = [\"diagnostics_missing\", \"manual_check\", \"none\", \"upgrade_local\", \"upgrade_remote\"]",
    "const COMPATIBILITY_SEVERITIES = [\"ok\", \"warning\"]",
    "const COMPATIBILITY_POLICY_VALUES = [\"allow\", \"warn\"]",
    "const COMPATIBILITY_ISSUE_FIELDS = [\"adminState\", \"claim\", \"clientStatus\", \"heartbeat\", \"profile\"]",
    "const COMPATIBILITY_ISSUE_TYPES = [\"local_missing\", \"remote_missing\", \"remote_newer\", \"remote_older\"]"
  ]) {
    requireText(runtimeContracts, "scripts/lib/runtimeContracts.mjs", expected);
  }
}

async function auditLegacyAdminUserMigrationContract() {
  const [
    contract,
    serverAdminSource,
    coreTest
  ] = await Promise.all([
    readFile(join(root, "docs", "INTERFACE_CONTRACT.md"), "utf8").catch(() => ""),
    readFile(join(root, "src", "core", "serverAdmin.js"), "utf8").catch(() => ""),
    readFile(join(root, "tests", "core.test.js"), "utf8").catch(() => "")
  ]);

  for (const [label, text] of [
    ["docs/INTERFACE_CONTRACT.md", contract],
    ["src/core/serverAdmin.js", serverAdminSource],
    ["tests/core.test.js", coreTest]
  ]) {
    if (!text) {
      issues.push(`${label} is missing for legacy admin user migration audit`);
    }
  }
  if (!contract || !serverAdminSource || !coreTest) {
    return;
  }

  requireText(contract, "docs/INTERFACE_CONTRACT.md", "读取历史 `sfsc-state.json` 时，服务端必须把 legacy user 迁移为当前设备模型");
  requireText(contract, "docs/INTERFACE_CONTRACT.md", "补齐 `storage`、`heartbeatSecret`、`heartbeatAuthNonces`、`enabled`、`createdAt` 和 `updatedAt` 默认值");
  requireText(contract, "docs/INTERFACE_CONTRACT.md", "legacy diagnostics 只有满足完整客户端运行时诊断合同时才能保留");
  requireText(serverAdminSource, "src/core/serverAdmin.js", "state.users = normalizeAdminUsers(state.users, state);");
  requireText(serverAdminSource, "src/core/serverAdmin.js", "function normalizeAdminUsers(users, state)");
  requireText(serverAdminSource, "src/core/serverAdmin.js", "function normalizeLegacyUserDiagnostics(input)");
  requireText(serverAdminSource, "src/core/serverAdmin.js", "return normalizeRuntimeDiagnostics(input, \"client\");");
  requireText(serverAdminSource, "src/core/serverAdmin.js", "function cleanLegacyUserPrefix(input, state, clientName)");
  requireText(coreTest, "tests/core.test.js", "admin state normalization migrates legacy users into device shape");
  requireText(coreTest, "tests/core.test.js", "assert.equal(state.users[0].diagnostics, null)");
  requireText(coreTest, "tests/core.test.js", "assert.equal(summary.devices[0].diagnostics, null)");
  requireText(coreTest, "tests/core.test.js", "summary.devices[0].compatibility.action, \"diagnostics_missing\"");
  requireText(coreTest, "tests/core.test.js", "assertAdminStateSummaryContract(summary, \"legacySummary\")");
  requireText(coreTest, "tests/core.test.js", "createClaim(state, {\n    userId: \"legacy-user-1\"");
  requireText(coreTest, "tests/core.test.js", "issued.profile.heartbeat.secret, state.users[0].heartbeatSecret");
}

async function auditHeartbeatSchedulerContract() {
  const [
    contract,
    serverSyncSource,
    clientServerSource,
    diagnosticBundleSource,
    runtimeContracts,
    clientHttpTest
  ] = await Promise.all([
    readFile(join(root, "docs", "INTERFACE_CONTRACT.md"), "utf8").catch(() => ""),
    readFile(join(root, "src", "core", "syncRun.js"), "utf8").catch(() => ""),
    readFile(join(root, "client", "src", "clientServer.js"), "utf8").catch(() => ""),
    readFile(join(root, "client", "src", "diagnosticBundle.js"), "utf8").catch(() => ""),
    readFile(join(root, "scripts", "lib", "runtimeContracts.mjs"), "utf8").catch(() => ""),
    readFile(join(root, "tests", "client-http.test.js"), "utf8").catch(() => "")
  ]);

  if (!contract) {
    issues.push("docs/INTERFACE_CONTRACT.md is missing for heartbeat scheduler audit");
    return;
  }
  if (!serverSyncSource) {
    issues.push("src/core/syncRun.js is missing for heartbeat scheduler audit");
    return;
  }
  if (!clientServerSource) {
    issues.push("client/src/clientServer.js is missing for heartbeat scheduler audit");
    return;
  }
  if (!diagnosticBundleSource) {
    issues.push("client/src/diagnosticBundle.js is missing for heartbeat scheduler audit");
    return;
  }
  if (!runtimeContracts) {
    issues.push("scripts/lib/runtimeContracts.mjs is missing for heartbeat scheduler audit");
    return;
  }
  if (!clientHttpTest) {
    issues.push("tests/client-http.test.js is missing for heartbeat scheduler audit");
    return;
  }

  for (const expected of [
    "`sync.scheduler`",
    "jobs[]` 中每项必须保留对象 `schedule`",
    "客户端保存 `heartbeat.device.sync.scheduler` 时也必须保留 `intervalMs`、`lastTriggeredAt` 和 `jobs[]`"
  ]) {
    requireText(contract, "docs/INTERFACE_CONTRACT.md", expected);
  }
  requireText(serverSyncSource, "src/core/syncRun.js", "schedule: normalizeScheduledJobSchedule(input.schedule)");
  requireText(clientServerSource, "client/src/clientServer.js", "schedule: summarizeHeartbeatSchedule(job.schedule)");
  requireText(diagnosticBundleSource, "client/src/diagnosticBundle.js", "jobs: Array.isArray(scheduler.jobs) ? scheduler.jobs.map(summarizeDiagnosticSchedulerJob) : []");
  requireText(diagnosticBundleSource, "client/src/diagnosticBundle.js", "schedule: summarizeDiagnosticSchedule(job?.schedule) || {}");
  requireText(runtimeContracts, "scripts/lib/runtimeContracts.mjs", "assertExactKeys(scheduler, [\"enabled\", \"intervalMs\", \"jobs\", \"lastError\", \"lastTriggeredAt\", \"nextRun\"], label)");
  requireText(runtimeContracts, "scripts/lib/runtimeContracts.mjs", "assertExactKeys(job, [\"id\", \"lastError\", \"lastTriggeredAt\", \"name\", \"nextRun\", \"schedule\", \"scheduleText\"], jobLabel)");
  requireText(clientHttpTest, "tests/client-http.test.js", "diagnostics.bundle.status.heartbeat.device.sync.scheduler.intervalMs, 15000");
  requireText(clientHttpTest, "tests/client-http.test.js", "diagnostics.bundle.status.heartbeat.device.sync.scheduler.jobs[0].scheduleText, \"Every 15 minutes\"");
}

async function auditHeartbeatRemoteErrorCodeContract() {
  const [
    contract,
    clientServerSource,
    diagnosticBundleSource,
    runtimeContracts,
    clientHttpTest,
    clientTest
  ] = await Promise.all([
    readFile(join(root, "docs", "INTERFACE_CONTRACT.md"), "utf8").catch(() => ""),
    readFile(join(root, "client", "src", "clientServer.js"), "utf8").catch(() => ""),
    readFile(join(root, "client", "src", "diagnosticBundle.js"), "utf8").catch(() => ""),
    readFile(join(root, "scripts", "lib", "runtimeContracts.mjs"), "utf8").catch(() => ""),
    readFile(join(root, "tests", "client-http.test.js"), "utf8").catch(() => ""),
    readFile(join(root, "tests", "client.test.js"), "utf8").catch(() => "")
  ]);

  for (const [label, text] of [
    ["docs/INTERFACE_CONTRACT.md", contract],
    ["client/src/clientServer.js", clientServerSource],
    ["client/src/diagnosticBundle.js", diagnosticBundleSource],
    ["scripts/lib/runtimeContracts.mjs", runtimeContracts],
    ["tests/client-http.test.js", clientHttpTest],
    ["tests/client.test.js", clientTest]
  ]) {
    if (!text) {
      issues.push(`${label} is missing for heartbeat remote error code audit`);
    }
  }
  if (!contract || !clientServerSource || !diagnosticBundleSource || !runtimeContracts || !clientHttpTest || !clientTest) {
    return;
  }

  requireText(contract, "docs/INTERFACE_CONTRACT.md", "若服务端返回了共享稳定错误码表登记的错误码");
  requireText(contract, "docs/INTERFACE_CONTRACT.md", "客户端不得保存 `remoteErrorCode`");
  requireText(contract, "docs/INTERFACE_CONTRACT.md", "可选 `remoteErrorCode` 必须是共享稳定错误码");
  requireText(contract, "docs/INTERFACE_CONTRACT.md", "诊断包 summary 的 `heartbeatOk`、`heartbeatErrorCode` 和 `heartbeatRemoteErrorCode` 必须来自当前 heartbeat");
  requireText(contract, "docs/INTERFACE_CONTRACT.md", "心跳设备状态、服务端协议和兼容性字段必须读取“当前成功 heartbeat，否则最近一次成功 heartbeat”的快照");
  requireText(contract, "docs/INTERFACE_CONTRACT.md", "诊断包 summary 必须显式包含 `heartbeatCompatibilityStatus`、`heartbeatCompatibilitySeverity` 和 `heartbeatCompatibilitySyncRunPolicy`");
  requireText(clientServerSource, "client/src/clientServer.js", "function normalizeHeartbeatRemoteErrorCode(value)");
  requireText(clientServerSource, "client/src/clientServer.js", "isStableErrorCode(code)");
  requireText(clientServerSource, "client/src/clientServer.js", "...(remoteError.errorCode ? { remoteErrorCode: remoteError.errorCode } : {})");
  requireText(clientServerSource, "client/src/clientServer.js", "errorCode: normalizeHeartbeatRemoteErrorCode(rawErrorCode)");
  requireText(diagnosticBundleSource, "client/src/diagnosticBundle.js", "const successfulHeartbeat = currentSuccessfulHeartbeat(status);");
  requireText(diagnosticBundleSource, "client/src/diagnosticBundle.js", "heartbeatServerProtocols: heartbeatServerDiagnostics?.protocols || null");
  requireText(diagnosticBundleSource, "client/src/diagnosticBundle.js", "heartbeatCompatibilitySeverity: heartbeatCompatibility?.severity || \"\"");
  requireText(diagnosticBundleSource, "client/src/diagnosticBundle.js", "heartbeatCompatibilitySyncRunPolicy: heartbeatCompatibility?.policy?.syncRun || \"\"");
  requireText(runtimeContracts, "scripts/lib/runtimeContracts.mjs", "assertStableErrorCode(heartbeat.remoteErrorCode, `${label}.remoteErrorCode`)");
  requireText(runtimeContracts, "scripts/lib/runtimeContracts.mjs", "assert(heartbeat.remoteErrorCode !== \"\", `${label}.remoteErrorCode`)");
  requireText(runtimeContracts, "scripts/lib/runtimeContracts.mjs", "\"heartbeatCompatibilitySeverity\"");
  requireText(runtimeContracts, "scripts/lib/runtimeContracts.mjs", "summary.heartbeatServerProtocols");
  requireText(clientHttpTest, "tests/client-http.test.js", "client status omits non-stable remote heartbeat error codes");
  requireText(clientHttpTest, "tests/client-http.test.js", "waitForHeartbeatFailure(baseUrl, { requireRemoteErrorCode: false })");
  requireText(clientHttpTest, "tests/client-http.test.js", "assert.equal(Object.hasOwn(status.heartbeat, \"remoteErrorCode\"), false)");
  requireText(clientHttpTest, "tests/client-http.test.js", "assert.equal(diagnostics.bundle.summary.heartbeatRemoteErrorCode, \"\")");
  requireText(clientHttpTest, "tests/client-http.test.js", "fallbackDiagnostics.bundle.summary.heartbeatDeviceCurrentFile, \"redacted\"");
  requireText(clientHttpTest, "tests/client-http.test.js", "fallbackDiagnostics.bundle.summary.heartbeatServerProtocols.heartbeat, 1");
  requireText(clientTest, "tests/client.test.js", "heartbeatCompatibilitySeverity, \"warning\"");
  requireText(clientTest, "tests/client.test.js", "heartbeatCompatibilitySyncRunPolicy, \"warn\"");
  requireText(clientTest, "tests/client.test.js", "function normalizeHeartbeatRemoteErrorCode");
}

async function auditHeartbeatSuccessContractValidation() {
  const [
    contract,
    matrix,
    clientServerSource,
    runtimeContracts,
    clientHttpTest
  ] = await Promise.all([
    readFile(join(root, "docs", "INTERFACE_CONTRACT.md"), "utf8").catch(() => ""),
    readFile(join(root, "docs", "API_MATRIX.md"), "utf8").catch(() => ""),
    readFile(join(root, "client", "src", "clientServer.js"), "utf8").catch(() => ""),
    readFile(join(root, "scripts", "lib", "runtimeContracts.mjs"), "utf8").catch(() => ""),
    readFile(join(root, "tests", "client-http.test.js"), "utf8").catch(() => "")
  ]);

  for (const [label, text] of [
    ["docs/INTERFACE_CONTRACT.md", contract],
    ["docs/API_MATRIX.md", matrix],
    ["client/src/clientServer.js", clientServerSource],
    ["scripts/lib/runtimeContracts.mjs", runtimeContracts],
    ["tests/client-http.test.js", clientHttpTest]
  ]) {
    if (!text) {
      issues.push(`${label} is missing for heartbeat success contract validation audit`);
    }
  }
  if (!contract || !matrix || !clientServerSource || !runtimeContracts || !clientHttpTest) {
    return;
  }

  for (const expected of [
    "HTTP 2xx 只有在响应是 JSON object 且满足该成功契约时才算成功",
    "若 2xx 响应不是 JSON、为空 body、缺少 `ok: true`、顶层 `diagnostics`、`device.compatibility`、`device.sync`",
    "客户端必须把本次结果记录为 `heartbeat_failed`",
    "不得写入或覆盖 `lastSuccessfulHeartbeat`",
    "`heartbeat.serverDiagnostics.role` 必须为 `server`",
    "`heartbeat.compatibility` 必须遵守 compatibility contract",
    "顶层必须且只包含 `action`、`issues`、`localRole`、`ok`、`policy`、`remoteRole`、`severity` 和 `status`",
    "`policy` 必须且只包含 `adminActions`、`heartbeat`、`profileIssue`、`reason` 和 `syncRun`",
    "`issues[]` 每项必须且只包含 `field`、`local`、`message`、`remote` 和 `type`",
    "`device.compatibility.ok/status/action/severity/localRole/remoteRole`",
    "`heartbeat.device.syncState` 必须与 `heartbeat.device.sync.state` 完全一致",
    "`heartbeat.device.speedMbps` 必须与 `heartbeat.device.sync.speedMbps` 保持一致"
  ]) {
    requireText(contract, "docs/INTERFACE_CONTRACT.md", expected);
  }
  requireText(
    matrix,
    "docs/API_MATRIX.md",
    "HTTP 2xx 但非 JSON、空 body、缺少成功契约字段、`diagnostics.role/protocols` 非服务端协议"
  );
  requireText(matrix, "docs/API_MATRIX.md", "`syncState` 与 `sync.state` 不一致或 `speedMbps` 与 `sync.speedMbps` 不一致");

  requireText(clientServerSource, "client/src/clientServer.js", "function validateHeartbeatSuccessResponse");
  requireText(clientServerSource, "client/src/clientServer.js", "function validateHeartbeatCompatibility");
  requireText(clientServerSource, "client/src/clientServer.js", "validateHeartbeatSuccessResponse(responseBody)");
  requireText(clientServerSource, "client/src/clientServer.js", "diagnostics must match the server runtime diagnostics contract");
  requireText(clientServerSource, "client/src/clientServer.js", "device.compatibility must match runtime diagnostics");
  requireText(clientServerSource, "client/src/clientServer.js", "const COMPATIBILITY_STATUSES = new Set([\"compatible\", \"mismatch\"])");
  requireText(clientServerSource, "client/src/clientServer.js", "const COMPATIBILITY_ACTIONS = new Set([\"diagnostics_missing\", \"manual_check\", \"none\", \"upgrade_local\", \"upgrade_remote\"])");
  requireText(clientServerSource, "client/src/clientServer.js", "const COMPATIBILITY_SEVERITIES = new Set([\"ok\", \"warning\"])");
  requireText(clientServerSource, "client/src/clientServer.js", "const COMPATIBILITY_POLICY_VALUES = new Set([\"allow\", \"warn\"])");
  requireText(clientServerSource, "client/src/clientServer.js", "const COMPATIBILITY_ISSUE_FIELDS = new Set([\"adminState\", \"claim\", \"clientStatus\", \"heartbeat\", \"profile\"])");
  requireText(clientServerSource, "client/src/clientServer.js", "const COMPATIBILITY_ISSUE_TYPES = new Set([\"local_missing\", \"remote_missing\", \"remote_newer\", \"remote_older\"])");
  requireText(clientServerSource, "client/src/clientServer.js", "device.compatibility.ok must be a boolean");
  requireText(clientServerSource, "client/src/clientServer.js", "device.compatibility.status must be compatible or mismatch");
  requireText(clientServerSource, "client/src/clientServer.js", "device.compatibility.action must be a known action");
  requireText(clientServerSource, "client/src/clientServer.js", "device.compatibility.severity must be ok or warning");
  requireText(clientServerSource, "client/src/clientServer.js", "device.compatibility.localRole must be a string");
  requireText(clientServerSource, "client/src/clientServer.js", "device.compatibility.remoteRole must be a string");
  requireText(clientServerSource, "client/src/clientServer.js", "device.compatibility.policy must be an object");
  requireText(clientServerSource, "client/src/clientServer.js", "device.compatibility.policy.${field} must be allow or warn");
  requireText(clientServerSource, "client/src/clientServer.js", "device.compatibility.policy.reason must match action");
  requireText(clientServerSource, "client/src/clientServer.js", "device.compatibility.issues must be an array");
  requireText(clientServerSource, "client/src/clientServer.js", "device.compatibility.ok must match issues");
  requireText(clientServerSource, "client/src/clientServer.js", "device.compatibility.status must match ok");
  requireText(clientServerSource, "client/src/clientServer.js", "device.compatibility.severity must match ok");
  requireText(clientServerSource, "client/src/clientServer.js", "device.compatibility.issues[${index}].field must be a known protocol");
  requireText(clientServerSource, "client/src/clientServer.js", "device.compatibility.issues[${index}].type must be a known type");
  requireText(clientServerSource, "client/src/clientServer.js", "device.compatibility.issues[${index}].local must be a positive integer or null");
  requireText(clientServerSource, "client/src/clientServer.js", "device.compatibility.issues[${index}].remote must be a positive integer or null");
  requireText(clientServerSource, "client/src/clientServer.js", "device.compatibility.issues[${index}].message must be a non-empty string");
  requireText(clientServerSource, "client/src/clientServer.js", "device.sync must be an object");
  requireText(clientServerSource, "client/src/clientServer.js", "device.syncState must match device.sync.state");
  requireText(clientServerSource, "client/src/clientServer.js", "device.speedMbps must match device.sync.speedMbps");
  requireText(clientServerSource, "client/src/clientServer.js", "errorCode: \"heartbeat_failed\"");
  requireText(clientServerSource, "client/src/clientServer.js", "lastSuccessfulHeartbeat = lastHeartbeat;");
  requireTextOrder(clientServerSource, "client/src/clientServer.js", [
    "const responseBody = await readHeartbeatBody(response);",
    "validateHeartbeatSuccessResponse(responseBody)",
    "lastSuccessfulHeartbeat = lastHeartbeat;"
  ], "heartbeat HTTP 2xx success contract validation before updating lastSuccessfulHeartbeat");
  if (clientServerSource.includes("serverDiagnostics: responseBody?.diagnostics || null")) {
    issues.push("client/src/clientServer.js must not coerce missing heartbeat success diagnostics to null on HTTP 2xx");
  }
  if (clientServerSource.includes("compatibility: responseBody?.device?.compatibility || null")) {
    issues.push("client/src/clientServer.js must not coerce missing heartbeat success compatibility to null on HTTP 2xx");
  }

  requireText(runtimeContracts, "scripts/lib/runtimeContracts.mjs", "const COMPATIBILITY_STATUSES = [\"compatible\", \"mismatch\"]");
  requireText(runtimeContracts, "scripts/lib/runtimeContracts.mjs", "const COMPATIBILITY_ACTIONS = [\"diagnostics_missing\", \"manual_check\", \"none\", \"upgrade_local\", \"upgrade_remote\"]");
  requireText(runtimeContracts, "scripts/lib/runtimeContracts.mjs", "const COMPATIBILITY_SEVERITIES = [\"ok\", \"warning\"]");
  requireText(runtimeContracts, "scripts/lib/runtimeContracts.mjs", "const COMPATIBILITY_POLICY_VALUES = [\"allow\", \"warn\"]");
  requireText(runtimeContracts, "scripts/lib/runtimeContracts.mjs", "const COMPATIBILITY_ISSUE_FIELDS = [\"adminState\", \"claim\", \"clientStatus\", \"heartbeat\", \"profile\"]");
  requireText(runtimeContracts, "scripts/lib/runtimeContracts.mjs", "const COMPATIBILITY_ISSUE_TYPES = [\"local_missing\", \"remote_missing\", \"remote_newer\", \"remote_older\"]");
  requireText(runtimeContracts, "scripts/lib/runtimeContracts.mjs", "assertExactKeys(compatibility, [\"action\", \"issues\", \"localRole\", \"ok\", \"policy\", \"remoteRole\", \"severity\", \"status\"], label)");
  requireText(runtimeContracts, "scripts/lib/runtimeContracts.mjs", "assertExactKeys(compatibility.policy, [\"adminActions\", \"heartbeat\", \"profileIssue\", \"reason\", \"syncRun\"], `${label}.policy`)");
  requireText(runtimeContracts, "scripts/lib/runtimeContracts.mjs", "assertExactKeys(issue, [\"field\", \"local\", \"message\", \"remote\", \"type\"], issueLabel)");
  requireText(runtimeContracts, "scripts/lib/runtimeContracts.mjs", "assertEqual(compatibility.policy.reason, compatibility.action, `${label}.policy.reason`)");
  requireText(runtimeContracts, "scripts/lib/runtimeContracts.mjs", "assertCompatibilityIssueVersion(issue.local, `${issueLabel}.local`)");
  requireText(runtimeContracts, "scripts/lib/runtimeContracts.mjs", "assertCompatibilityIssueVersion(issue.remote, `${issueLabel}.remote`)");

  requireText(clientHttpTest, "tests/client-http.test.js", "client heartbeat treats malformed successful responses as heartbeat_failed");
  requireText(clientHttpTest, "tests/client-http.test.js", "client heartbeat does not replace lastSuccessfulHeartbeat after malformed successful responses");
  requireText(clientHttpTest, "tests/client-http.test.js", "R200-HEARTBEAT-HTML");
  requireText(clientHttpTest, "tests/client-http.test.js", "R200-HEARTBEAT-EMPTY");
  requireText(clientHttpTest, "tests/client-http.test.js", "R200-HEARTBEAT-MISSING-CONTRACT");
  requireText(clientHttpTest, "tests/client-http.test.js", "R200-HEARTBEAT-MISSING-CONTRACT-DIAGNOSTICS");
  requireText(clientHttpTest, "tests/client-http.test.js", "R200-HEARTBEAT-MISSING-CONTRACT-DEVICE");
  requireText(clientHttpTest, "tests/client-http.test.js", "R200-HEARTBEAT-MISSING-CONTRACT-COMPATIBILITY");
  requireText(clientHttpTest, "tests/client-http.test.js", "R200-HEARTBEAT-OK-FALSE");
  requireText(clientHttpTest, "tests/client-http.test.js", "R200-HEARTBEAT-BAD-DIAGNOSTICS-ROLE");
  requireText(clientHttpTest, "tests/client-http.test.js", "R200-HEARTBEAT-BAD-DIAGNOSTICS-PROTOCOL");
  requireText(clientHttpTest, "tests/client-http.test.js", "R200-HEARTBEAT-MISSING-COMPATIBILITY-STATUS");
  requireText(clientHttpTest, "tests/client-http.test.js", "R200-HEARTBEAT-MISSING-COMPATIBILITY-SEVERITY");
  requireText(clientHttpTest, "tests/client-http.test.js", "R200-HEARTBEAT-BAD-COMPATIBILITY-STATUS");
  requireText(clientHttpTest, "tests/client-http.test.js", "R200-HEARTBEAT-BAD-COMPATIBILITY-ACTION");
  requireText(clientHttpTest, "tests/client-http.test.js", "R200-HEARTBEAT-BAD-COMPATIBILITY-SEVERITY");
  requireText(clientHttpTest, "tests/client-http.test.js", "R200-HEARTBEAT-BAD-COMPATIBILITY-POLICY");
  requireText(clientHttpTest, "tests/client-http.test.js", "R200-HEARTBEAT-COMPATIBILITY-REASON-MISMATCH");
  requireText(clientHttpTest, "tests/client-http.test.js", "R200-HEARTBEAT-BAD-COMPATIBILITY-ISSUE");
  requireText(clientHttpTest, "tests/client-http.test.js", "R200-HEARTBEAT-MISSING-SYNC");
  requireText(clientHttpTest, "tests/client-http.test.js", "R200-HEARTBEAT-SYNCSTATE-MISMATCH");
  requireText(clientHttpTest, "tests/client-http.test.js", "R200-HEARTBEAT-SPEED-MISMATCH");
  requireText(clientHttpTest, "tests/client-http.test.js", "assert.equal(status.heartbeat.status, 200)");
  requireText(clientHttpTest, "tests/client-http.test.js", "assert.equal(status.heartbeat.errorCode, \"heartbeat_failed\")");
  requireText(clientHttpTest, "tests/client-http.test.js", "assert.equal(status.lastSuccessfulHeartbeat, null)");
  requireText(clientHttpTest, "tests/client-http.test.js", "assertHeartbeatContract(status.lastSuccessfulHeartbeat, \"lastSuccessfulHeartbeat\")");
}

async function auditHeartbeatDiagnosticProtocolDocs() {
  const [
    protocolReadme,
    heartbeatDoc,
    diagnosticDoc,
    heartbeatSchemaSource,
    diagnosticSchemaSource,
    runtimeContracts
  ] = await Promise.all([
    readFile(join(root, "docs", "protocol", "README.md"), "utf8").catch(() => ""),
    readFile(join(root, "docs", "protocol", "02-heartbeat-device-sync.md"), "utf8").catch(() => ""),
    readFile(join(root, "docs", "protocol", "03-diagnostic-bundle.md"), "utf8").catch(() => ""),
    readFile(join(root, "docs", "protocol", "schemas", "heartbeat-device-sync.json"), "utf8").catch(() => ""),
    readFile(join(root, "docs", "protocol", "schemas", "diagnostic-bundle.json"), "utf8").catch(() => ""),
    readFile(join(root, "scripts", "lib", "runtimeContracts.mjs"), "utf8").catch(() => "")
  ]);

  for (const [label, text] of [
    ["docs/protocol/README.md", protocolReadme],
    ["docs/protocol/02-heartbeat-device-sync.md", heartbeatDoc],
    ["docs/protocol/03-diagnostic-bundle.md", diagnosticDoc],
    ["docs/protocol/schemas/heartbeat-device-sync.json", heartbeatSchemaSource],
    ["docs/protocol/schemas/diagnostic-bundle.json", diagnosticSchemaSource],
    ["scripts/lib/runtimeContracts.mjs", runtimeContracts]
  ]) {
    if (!text) {
      issues.push(`${label} is missing for heartbeat/diagnostic protocol audit`);
    }
  }
  if (!protocolReadme || !heartbeatDoc || !diagnosticDoc || !heartbeatSchemaSource || !diagnosticSchemaSource || !runtimeContracts) {
    return;
  }

  requireText(protocolReadme, "docs/protocol/README.md", "schemas/heartbeat-device-sync.json");
  requireText(protocolReadme, "docs/protocol/README.md", "schemas/diagnostic-bundle.json");
  requireText(heartbeatDoc, "docs/protocol/02-heartbeat-device-sync.md", "device.syncState === device.sync.state");
  requireText(heartbeatDoc, "docs/protocol/02-heartbeat-device-sync.md", "`id`, `lastError`, `lastTriggeredAt`, `name`, `nextRun`, `schedule`, `scheduleText`");
  requireText(diagnosticDoc, "docs/protocol/03-diagnostic-bundle.md", "`app`, `environment`, `generatedAt`, `logs`, `role`, `schemaVersion`, `status`, `summary`");
  requireText(diagnosticDoc, "docs/protocol/03-diagnostic-bundle.md", "`currentFile`, `lastRun`, `scheduler`, `speedMbps`, `state`, `syncState`");
  requireText(diagnosticDoc, "docs/protocol/03-diagnostic-bundle.md", "current successful heartbeat if available; otherwise they fall back to `lastSuccessfulHeartbeat`");

  const heartbeatSchema = parseProtocolJsonSchema(heartbeatSchemaSource, "docs/protocol/schemas/heartbeat-device-sync.json");
  const diagnosticSchema = parseProtocolJsonSchema(diagnosticSchemaSource, "docs/protocol/schemas/diagnostic-bundle.json");
  if (!heartbeatSchema || !diagnosticSchema) {
    return;
  }
  if (heartbeatSchema.schemaVersion !== 1 || heartbeatSchema.kind !== "sfsc-heartbeat-device-sync") {
    issues.push("docs/protocol/schemas/heartbeat-device-sync.json must use schemaVersion 1 and kind sfsc-heartbeat-device-sync");
  }
  if (diagnosticSchema.schemaVersion !== 1 || diagnosticSchema.kind !== "sfsc-diagnostic-bundle") {
    issues.push("docs/protocol/schemas/diagnostic-bundle.json must use schemaVersion 1 and kind sfsc-diagnostic-bundle");
  }

  requireSchemaArray(heartbeatSchema, "docs/protocol/schemas/heartbeat-device-sync.json", "serverHeartbeatResponseKeys", ["device", "diagnostics", "ok"]);
  requireSchemaArray(heartbeatSchema, "docs/protocol/schemas/heartbeat-device-sync.json", "compatibilityKeys", ["action", "issues", "localRole", "ok", "policy", "remoteRole", "severity", "status"]);
  requireSchemaArray(heartbeatSchema, "docs/protocol/schemas/heartbeat-device-sync.json", "compatibilityPolicyKeys", ["adminActions", "heartbeat", "profileIssue", "reason", "syncRun"]);
  requireSchemaArray(heartbeatSchema, "docs/protocol/schemas/heartbeat-device-sync.json", "compatibilityIssueKeys", ["field", "local", "message", "remote", "type"]);
  requireSchemaArray(heartbeatSchema, "docs/protocol/schemas/heartbeat-device-sync.json", "syncRunKeys", ["conflicts", "currentFile", "error", "errorCode", "exitCode", "finishedAt", "id", "job", "localPath", "progressPercent", "rawSpeed", "speedMbps", "startedAt", "status", "transferredSizeText", "trigger"]);
  requireSchemaArray(heartbeatSchema, "docs/protocol/schemas/heartbeat-device-sync.json", "schedulerKeys", ["enabled", "intervalMs", "jobs", "lastError", "lastTriggeredAt", "nextRun"]);
  requireSchemaArray(heartbeatSchema, "docs/protocol/schemas/heartbeat-device-sync.json", "schedulerJobKeys", ["id", "lastError", "lastTriggeredAt", "name", "nextRun", "schedule", "scheduleText"]);
  requireSchemaArray(diagnosticSchema, "docs/protocol/schemas/diagnostic-bundle.json", "exportResponseKeys", ["bundle", "filename", "ok"]);
  requireSchemaArray(diagnosticSchema, "docs/protocol/schemas/diagnostic-bundle.json", "bundleKeys", ["app", "environment", "generatedAt", "logs", "role", "schemaVersion", "status", "summary"]);
  requireSchemaArray(diagnosticSchema, "docs/protocol/schemas/diagnostic-bundle.json", "statusKeys", ["appVersion", "binaries", "diagnostics", "heartbeat", "jobs", "lastSuccessfulHeartbeat", "lastSync", "profileImported", "profileSummary", "safeguards"]);
  requireSchemaArray(diagnosticSchema, "docs/protocol/schemas/diagnostic-bundle.json", "heartbeatKeys", ["compatibility", "device", "errorCode", "ok", "remoteErrorCode", "sentAt", "server", "serverDiagnostics", "status"]);
  requireSchemaArray(diagnosticSchema, "docs/protocol/schemas/diagnostic-bundle.json", "diagnosticHeartbeatDeviceKeys", ["bucket", "enabled", "online", "prefix", "status", "sync"]);
  requireSchemaArray(diagnosticSchema, "docs/protocol/schemas/diagnostic-bundle.json", "diagnosticDeviceSyncKeys", ["currentFile", "lastRun", "scheduler", "speedMbps", "state", "syncState"]);
  requireSchemaArray(diagnosticSchema, "docs/protocol/schemas/diagnostic-bundle.json", "diagnosticSchedulerKeys", ["enabled", "intervalMs", "jobs", "lastError", "lastTriggeredAt", "nextRun"]);
  requireSchemaArray(diagnosticSchema, "docs/protocol/schemas/diagnostic-bundle.json", "diagnosticSchedulerJobKeys", ["id", "lastError", "lastTriggeredAt", "name", "nextRun", "schedule", "scheduleText"]);
  requireSchemaArray(diagnosticSchema, "docs/protocol/schemas/diagnostic-bundle.json", "logsKeys", ["electron", "rclone", "singbox"]);
  requireSchemaArray(diagnosticSchema, "docs/protocol/schemas/diagnostic-bundle.json", "logMetaKeys", ["exists", "maxChars", "modifiedAt", "path", "size", "text", "truncated"]);

  for (const expected of [
    "assertExactKeys(response, [\"device\", \"diagnostics\", \"ok\"], label)",
    "assertExactKeys(compatibility, [\"action\", \"issues\", \"localRole\", \"ok\", \"policy\", \"remoteRole\", \"severity\", \"status\"], label)",
    "assertExactKeys(compatibility.policy, [\"adminActions\", \"heartbeat\", \"profileIssue\", \"reason\", \"syncRun\"], `${label}.policy`)",
    "assertExactKeys(issue, [\"field\", \"local\", \"message\", \"remote\", \"type\"], issueLabel)",
    "assertExactKeys(bundle, [\"app\", \"environment\", \"generatedAt\", \"logs\", \"role\", \"schemaVersion\", \"status\", \"summary\"], label)",
    "assertExactKeys(device, [\"bucket\", \"enabled\", \"online\", \"prefix\", \"status\", \"sync\"], label)",
    "assertExactKeys(sync, [\"currentFile\", \"lastRun\", \"scheduler\", \"speedMbps\", \"state\", \"syncState\"], label)",
    "assertExactKeys(scheduler, [\"enabled\", \"intervalMs\", \"jobs\", \"lastError\", \"lastTriggeredAt\", \"nextRun\"], label)",
    "assertExactKeys(job, [\"id\", \"lastError\", \"lastTriggeredAt\", \"name\", \"nextRun\", \"schedule\", \"scheduleText\"], jobLabel)"
  ]) {
    requireText(runtimeContracts, "scripts/lib/runtimeContracts.mjs", expected);
  }
}

async function auditClaimProfileProtocolDocs() {
  const [
    protocolReadme,
    claimDoc,
    profileDoc,
    claimSchemaSource,
    profileSchemaSource,
    claimProtocolSource,
    profileProtocolSource,
    protocolSchemasSource,
    runtimeContracts
  ] = await Promise.all([
    readFile(join(root, "docs", "protocol", "README.md"), "utf8").catch(() => ""),
    readFile(join(root, "docs", "protocol", "04-claim-lifecycle.md"), "utf8").catch(() => ""),
    readFile(join(root, "docs", "protocol", "05-profile-import.md"), "utf8").catch(() => ""),
    readFile(join(root, "docs", "protocol", "schemas", "claim-lifecycle.json"), "utf8").catch(() => ""),
    readFile(join(root, "docs", "protocol", "schemas", "profile-import.json"), "utf8").catch(() => ""),
    readFile(join(root, "src", "core", "claimProtocol.js"), "utf8").catch(() => ""),
    readFile(join(root, "src", "core", "profileProtocol.js"), "utf8").catch(() => ""),
    readFile(join(root, "src", "core", "protocolSchemas.js"), "utf8").catch(() => ""),
    readFile(join(root, "scripts", "lib", "runtimeContracts.mjs"), "utf8").catch(() => "")
  ]);

  for (const [label, text] of [
    ["docs/protocol/README.md", protocolReadme],
    ["docs/protocol/04-claim-lifecycle.md", claimDoc],
    ["docs/protocol/05-profile-import.md", profileDoc],
    ["docs/protocol/schemas/claim-lifecycle.json", claimSchemaSource],
    ["docs/protocol/schemas/profile-import.json", profileSchemaSource],
    ["src/core/claimProtocol.js", claimProtocolSource],
    ["src/core/profileProtocol.js", profileProtocolSource],
    ["src/core/protocolSchemas.js", protocolSchemasSource],
    ["scripts/lib/runtimeContracts.mjs", runtimeContracts]
  ]) {
    if (!text) {
      issues.push(`${label} is missing for claim/profile protocol audit`);
    }
  }
  if (!protocolReadme || !claimDoc || !profileDoc || !claimSchemaSource || !profileSchemaSource || !claimProtocolSource || !profileProtocolSource || !protocolSchemasSource || !runtimeContracts) {
    return;
  }

  requireText(protocolReadme, "docs/protocol/README.md", "04-claim-lifecycle.md");
  requireText(protocolReadme, "docs/protocol/README.md", "05-profile-import.md");
  requireText(protocolReadme, "docs/protocol/README.md", "schemas/claim-lifecycle.json");
  requireText(protocolReadme, "docs/protocol/README.md", "schemas/profile-import.json");

  requireText(claimDoc, "docs/protocol/04-claim-lifecycle.md", "`version`, `type`, `server`, `code`");
  requireText(claimDoc, "docs/protocol/04-claim-lifecycle.md", "`claim`, `claimCode`, `code`, `compatibility`, `profile`, `state`, `tKey`, `tKeyUri`, `uri`");
  requireText(claimDoc, "docs/protocol/04-claim-lifecycle.md", "A repeated redeem from the same client binding is accepted within `claim.replayUntil`.");
  requireText(claimDoc, "docs/protocol/04-claim-lifecycle.md", "A repeated redeem from a different binding returns `claim_already_used`.");
  requireText(claimDoc, "docs/protocol/04-claim-lifecycle.md", "A repeated redeem with missing binding also returns `claim_already_used`.");
  requireText(claimDoc, "docs/protocol/04-claim-lifecycle.md", "legacy `{ profile: ... }` wrapper only as an inbound compatibility path");
  requireText(claimDoc, "docs/protocol/04-claim-lifecycle.md", "Terminal errors clear recovery");
  requireText(claimDoc, "docs/protocol/04-claim-lifecycle.md", "Server-issued profile material errors also clear recovery");
  requireText(claimDoc, "docs/protocol/04-claim-lifecycle.md", "Retryable or unknown outcomes retain recovery");

  requireText(profileDoc, "docs/protocol/05-profile-import.md", "It does not accept a raw `{ \"profile\": { ... } }` object.");
  requireText(profileDoc, "docs/protocol/05-profile-import.md", "`source` is required for server-issued offline profile codes");
  requireText(profileDoc, "docs/protocol/05-profile-import.md", "`clientName`, `defaults`, `expiresAt`, `heartbeat`, `issuedAt`, `profileId`, `storage`, `tunnel`, `version`");
  requireText(profileDoc, "docs/protocol/05-profile-import.md", "`bandwidthLimit`, `checkers`, `chunkSize`, `localProxyPort`, `lowLevelRetries`, `retries`, `schedule`, `streams`, `transfers`");
  requireText(profileDoc, "docs/protocol/05-profile-import.md", "`profile`.");
  requireText(profileDoc, "docs/protocol/05-profile-import.md", "These material errors clear pending claim recovery");
  requireText(profileDoc, "docs/protocol/05-profile-import.md", "The import commit is all-or-nothing.");

  const claimSchema = parseProtocolJsonSchema(claimSchemaSource, "docs/protocol/schemas/claim-lifecycle.json");
  const profileSchema = parseProtocolJsonSchema(profileSchemaSource, "docs/protocol/schemas/profile-import.json");
  if (!claimSchema || !profileSchema) {
    return;
  }

  if (claimSchema.schemaVersion !== 1 || claimSchema.kind !== "sfsc-claim-lifecycle") {
    issues.push("docs/protocol/schemas/claim-lifecycle.json must use schemaVersion 1 and kind sfsc-claim-lifecycle");
  }
  if (profileSchema.schemaVersion !== 1 || profileSchema.kind !== "sfsc-profile-import") {
    issues.push("docs/protocol/schemas/profile-import.json must use schemaVersion 1 and kind sfsc-profile-import");
  }

  if (claimSchema.claimVersion !== extractNumberConstant(claimProtocolSource, "CLAIM_VERSION")) {
    issues.push("docs/protocol/schemas/claim-lifecycle.json claimVersion must match src/core/claimProtocol.js CLAIM_VERSION");
  }
  if (claimSchema.claimCodePrefix !== extractStringConstant(claimProtocolSource, "CLAIM_CODE_PREFIX")) {
    issues.push("docs/protocol/schemas/claim-lifecycle.json claimCodePrefix must match src/core/claimProtocol.js CLAIM_CODE_PREFIX");
  }
  if (claimSchema.claimUriPrefix !== extractStringConstant(claimProtocolSource, "CLAIM_URI_PREFIX")) {
    issues.push("docs/protocol/schemas/claim-lifecycle.json claimUriPrefix must match src/core/claimProtocol.js CLAIM_URI_PREFIX");
  }
  if (claimSchema.claimCodeAlphabet !== extractStringConstant(claimProtocolSource, "CLAIM_CODE_ALPHABET")) {
    issues.push("docs/protocol/schemas/claim-lifecycle.json claimCodeAlphabet must match src/core/claimProtocol.js CLAIM_CODE_ALPHABET");
  }
  requireText(claimProtocolSource, "src/core/claimProtocol.js", "return {\n    version: CLAIM_VERSION,\n    type: \"claim\",\n    server,\n    code\n  };");
  requireSchemaArray(claimSchema, "docs/protocol/schemas/claim-lifecycle.json", "claimPayloadKeys", ["version", "type", "server", "code"]);
  if (claimSchema.claimPayloadType !== "claim") {
    issues.push("docs/protocol/schemas/claim-lifecycle.json claimPayloadType must be claim");
  }
  requireSchemaArray(claimSchema, "docs/protocol/schemas/claim-lifecycle.json", "claimCreateResponseKeys", ["claim", "claimCode", "code", "compatibility", "profile", "state", "tKey", "tKeyUri", "uri"]);
  requireSchemaArray(claimSchema, "docs/protocol/schemas/claim-lifecycle.json", "terminalRecoveryClearCodes", ["claim_not_found", "claim_already_used", "claim_expired", "validation_failed"]);
  requireSchemaArray(claimSchema, "docs/protocol/schemas/claim-lifecycle.json", "retryableRecoveryKeepCodes", ["claim_redeem_rate_limited", "server_state_write_failed", "claim_redeem_failed"]);

  if (profileSchema.profileVersion !== extractNumberConstant(profileProtocolSource, "PROFILE_VERSION")) {
    issues.push("docs/protocol/schemas/profile-import.json profileVersion must match src/core/profileProtocol.js PROFILE_VERSION");
  }
  if (profileSchema.profileCodePrefix !== extractStringConstant(profileProtocolSource, "PROFILE_CODE_PREFIX")) {
    issues.push("docs/protocol/schemas/profile-import.json profileCodePrefix must match src/core/profileProtocol.js PROFILE_CODE_PREFIX");
  }
  if (profileSchema.profileUriPrefix !== extractStringConstant(profileProtocolSource, "PROFILE_URI_PREFIX")) {
    issues.push("docs/protocol/schemas/profile-import.json profileUriPrefix must match src/core/profileProtocol.js PROFILE_URI_PREFIX");
  }
  requireSchemaArray(profileSchema, "docs/protocol/schemas/profile-import.json", "clientProfileImportRequestStringFields", ["claimCode", "code", "clientName", "tKey", "tkey", "token", "uri"]);
  requireSchemaArray(profileSchema, "docs/protocol/schemas/profile-import.json", "clientProfileImportResponseKeys", ["profile"]);
  requireSchemaArray(profileSchema, "docs/protocol/schemas/profile-import.json", "profileEncodeResponseKeys", ["code", "profile", "summary", "uri"]);
  requireSchemaArray(profileSchema, "docs/protocol/schemas/profile-import.json", "serverIssuedProfileKeys", ["clientName", "defaults", "expiresAt", "heartbeat", "issuedAt", "profileId", "storage", "tunnel", "version"]);
  requireSchemaArray(profileSchema, "docs/protocol/schemas/profile-import.json", "serverIssuedOfflineProfileRequiredKeys", ["source"]);
  requireSchemaArray(profileSchema, "docs/protocol/schemas/profile-import.json", "serverIssuedProfileDefaultsKeys", ["bandwidthLimit", "checkers", "chunkSize", "localProxyPort", "lowLevelRetries", "retries", "schedule", "streams", "transfers"]);
  requireSchemaArray(profileSchema, "docs/protocol/schemas/profile-import.json", "serverIssuedProfileHeartbeatKeys", ["scheme", "secret"]);
  requireSchemaArray(profileSchema, "docs/protocol/schemas/profile-import.json", "serverIssuedProfileStorageKeys", ["accessKeyId", "bucket", "endpoint", "prefix", "remoteName", "secretAccessKey", "type"]);
  requireSchemaArray(profileSchema, "docs/protocol/schemas/profile-import.json", "legacyVlessOptionsKeys", ["localProxyPort"]);

  for (const expected of [
    "const expectedKeys = [\"clientName\", \"defaults\", \"expiresAt\", \"heartbeat\", \"issuedAt\", \"profileId\", \"storage\", \"tunnel\", \"version\"];",
    "assertExactKeys(profile.heartbeat, [\"scheme\", \"secret\"], `${label}.heartbeat`)",
    "assertExactKeys(profile.storage, [\"accessKeyId\", \"bucket\", \"endpoint\", \"prefix\", \"remoteName\", \"secretAccessKey\", \"type\"], `${label}.storage`)",
    "assertExactKeys(response, expectedKeys, label);",
    "const expectedKeys = [\"claim\", \"claimCode\", \"code\", \"compatibility\", \"profile\", \"state\", \"tKey\", \"tKeyUri\", \"uri\"];",
    "assertExactKeys(response, [\"code\", \"profile\", \"summary\", \"uri\"], label);",
    "assertExactKeys(response, [\"profile\"], label);"
  ]) {
    requireText(runtimeContracts, "scripts/lib/runtimeContracts.mjs", expected);
  }
  for (const field of ["localProxyPort", "transfers", "streams", "checkers", "chunkSize", "retries", "lowLevelRetries", "bandwidthLimit", "schedule"]) {
    requireText(profileProtocolSource, "src/core/profileProtocol.js", `${field}:`);
  }
  requireText(protocolSchemasSource, "src/core/protocolSchemas.js", "copyOptionalStringFields(input, output, [...CLAIM_REDEEM_FIELDS, \"uri\", \"clientName\"]);");
  requireText(protocolSchemasSource, "src/core/protocolSchemas.js", "output.localProxyPort = readPort(input.localProxyPort, \"options.localProxyPort\");");
  if (/Object\.hasOwn\(input,\s*["']profile["']\)/.test(protocolSchemasSource)) {
    issues.push("src/core/protocolSchemas.js client profile import request must not accept raw profile objects");
  }
}

async function auditSyncRunTriggerContract() {
  const [
    contract,
    syncRunSource,
    clientServerSource,
    processRunnerSource,
    clientStoreSource,
    runtimeContracts,
    clientHttpTest,
    contractHttpTest,
    clientTest,
    coreTest,
    clientUiHtml,
    clientUiSource,
    serverUiSource
  ] = await Promise.all([
    readFile(join(root, "docs", "INTERFACE_CONTRACT.md"), "utf8").catch(() => ""),
    readFile(join(root, "src", "core", "syncRun.js"), "utf8").catch(() => ""),
    readFile(join(root, "client", "src", "clientServer.js"), "utf8").catch(() => ""),
    readFile(join(root, "client", "src", "processRunner.js"), "utf8").catch(() => ""),
    readFile(join(root, "client", "src", "store.js"), "utf8").catch(() => ""),
    readFile(join(root, "scripts", "lib", "runtimeContracts.mjs"), "utf8").catch(() => ""),
    readFile(join(root, "tests", "client-http.test.js"), "utf8").catch(() => ""),
    readFile(join(root, "tests", "contract-http.test.js"), "utf8").catch(() => ""),
    readFile(join(root, "tests", "client.test.js"), "utf8").catch(() => ""),
    readFile(join(root, "tests", "core.test.js"), "utf8").catch(() => ""),
    readFile(join(root, "client", "public", "index.html"), "utf8").catch(() => ""),
    readFile(join(root, "client", "public", "app.js"), "utf8").catch(() => ""),
    readFile(join(root, "public", "app.js"), "utf8").catch(() => "")
  ]);

  for (const [label, text] of [
    ["docs/INTERFACE_CONTRACT.md", contract],
    ["src/core/syncRun.js", syncRunSource],
    ["client/src/clientServer.js", clientServerSource],
    ["client/src/processRunner.js", processRunnerSource],
    ["client/src/store.js", clientStoreSource],
    ["scripts/lib/runtimeContracts.mjs", runtimeContracts],
    ["tests/client-http.test.js", clientHttpTest],
    ["tests/contract-http.test.js", contractHttpTest],
    ["tests/client.test.js", clientTest],
    ["tests/core.test.js", coreTest],
    ["client/public/index.html", clientUiHtml],
    ["client/public/app.js", clientUiSource],
    ["public/app.js", serverUiSource]
  ]) {
    if (!text) {
      issues.push(`${label} is missing for sync run trigger audit`);
    }
  }
  if (!contract || !syncRunSource || !clientServerSource || !processRunnerSource || !clientStoreSource || !runtimeContracts || !clientHttpTest || !contractHttpTest || !clientTest || !coreTest || !clientUiHtml || !clientUiSource || !serverUiSource) {
    return;
  }

  requireText(contract, "docs/INTERFACE_CONTRACT.md", "`trigger` 取值为 `manual` 或 `scheduler`");
  requireText(contract, "docs/INTERFACE_CONTRACT.md", "不得从 `schedule.mode` 反推来源");
  requireText(contract, "docs/INTERFACE_CONTRACT.md", "客户端页面顶部状态、body 状态 class、进度区和停止中样式必须以 `processes.sync.metrics.syncState` 为当前状态来源");
  requireText(contract, "docs/INTERFACE_CONTRACT.md", "`processes.sync.running` 只能辅助判断同步中，不能覆盖 `stopping` 或 `error`");
  requireText(syncRunSource, "src/core/syncRun.js", "trigger: normalizeSyncRunTrigger(input.trigger)");
  requireText(syncRunSource, "src/core/syncRun.js", "function normalizeSyncRunTrigger(input)");
  requireText(clientServerSource, "client/src/clientServer.js", "runSync(body.job || {}, { trigger: \"manual\" })");
  requireText(clientServerSource, "client/src/clientServer.js", "runSync(due.job, { trigger: \"scheduler\" })");
  requireText(clientServerSource, "client/src/clientServer.js", "createSyncRunStart(normalizedJob, options)");
  requireText(clientServerSource, "client/src/clientServer.js", "trigger: normalizeSyncRunTrigger(options.trigger)");
  requireText(clientServerSource, "client/src/clientServer.js", "trigger: normalizeSyncRunTrigger(run.trigger)");
  requireText(clientStoreSource, "client/src/store.js", "trigger: run.trigger === \"scheduler\" ? \"scheduler\" : \"manual\"");
  requireText(processRunnerSource, "client/src/processRunner.js", "this.child && this.child.exitCode == null && this.child.signalCode == null");
  if (/this\.child\.exitCode == null && !this\.child\.killed/.test(processRunnerSource)) {
    issues.push("client/src/processRunner.js must treat a killed-but-not-closed child process as active");
  }
  requireText(processRunnerSource, "client/src/processRunner.js", "this.child.on(\"close\", (exitCode, signalCode) => {");
  requireText(processRunnerSource, "client/src/processRunner.js", "signalCode: signalCode || null");
  requireText(processRunnerSource, "client/src/processRunner.js", "this.child = null;");
  requireText(clientServerSource, "client/src/clientServer.js", "const lastExit = exit && typeof exit === \"object\"");
  requireText(clientServerSource, "client/src/clientServer.js", "? { ...exit, errorCode, error }");
  requireText(syncRunSource, "src/core/syncRun.js", "const status = normalizeSyncRunStatus(input.status);");
  requireText(syncRunSource, "src/core/syncRun.js", "const errorCode = status === \"error\" ? normalizeErrorCode(input.errorCode) : \"\";");
  requireText(clientStoreSource, "client/src/store.js", "return normalized;");
  if (/\.\.\.run,\s*\.\.\.normalized/s.test(clientStoreSource)) {
    issues.push("client/src/store.js must not expose raw sync-history extension fields");
  }
  requireText(runtimeContracts, "scripts/lib/runtimeContracts.mjs", "assertExactKeys(response, [\"history\"], label);");
  requireText(runtimeContracts, "scripts/lib/runtimeContracts.mjs", "assertExactKeys(run, [");
  requireText(runtimeContracts, "scripts/lib/runtimeContracts.mjs", "if (run.status !== \"error\")");
  requireText(runtimeContracts, "scripts/lib/runtimeContracts.mjs", "assertNoRawDiagnosticSecrets(response, label);");
  requireText(runtimeContracts, "scripts/lib/runtimeContracts.mjs", "assert([\"manual\", \"scheduler\"].includes(run.trigger), `${label}.trigger`)");
  requireText(clientHttpTest, "tests/client-http.test.js", "history.history[0].trigger, \"manual\"");
  requireText(clientHttpTest, "tests/client-http.test.js", "history.history[0].trigger, \"scheduler\"");
  requireText(clientHttpTest, "tests/client-http.test.js", "client sync stop waits through delayed rclone exit before accepting a new run");
  requireText(clientHttpTest, "tests/client-http.test.js", "stopActive.secondRunAfterStop");
  requireText(clientHttpTest, "tests/client-http.test.js", "JSON.stringify(history.history[0]).includes(\"rclone_sync_failed\"), false");
  requireText(contract, "docs/INTERFACE_CONTRACT.md", "只返回该合同登记的展示安全字段");
  requireText(contract, "docs/INTERFACE_CONTRACT.md", "未知扩展字段、`lastExit` 运行细节、`secretAccessKey`、SyncKey、导入 URI、VLESS URI、profile 或调试对象不得透传");
  requireText(contract, "docs/INTERFACE_CONTRACT.md", "只有 `status: \"error\"` 可以携带非空 `errorCode` 和 `error`");
  requireText(contract, "docs/INTERFACE_CONTRACT.md", "`stopped` 记录不得在顶层或嵌套字段中暴露 `rclone_sync_failed`");
  requireText(contract, "docs/INTERFACE_CONTRACT.md", "客户端同步历史筛选器必须暴露全部同步运行状态 `running`、`success`、`error`、`stopped`、`unknown`，并额外保留 `conflict` 冲突筛选");
  requireText(contract, "docs/INTERFACE_CONTRACT.md", "客户端 UI 必须以展示安全 job 摘要为 draft 基线");
  requireText(contract, "docs/INTERFACE_CONTRACT.md", "不得因为页面未展示某字段而丢失该字段或创建重复任务");
  requireText(contract, "docs/INTERFACE_CONTRACT.md", "不得把空值、0、小数或非数字静默替换成默认值");
  for (const expected of [
    '<option value="running">运行中</option>',
    '<option value="success">成功</option>',
    '<option value="error">失败</option>',
    '<option value="conflict">有冲突</option>',
    '<option value="stopped">已停止</option>',
    '<option value="unknown">未知</option>'
  ]) {
    requireText(clientUiHtml, "client/public/index.html", expected);
    requireText(clientTest, "tests/client.test.js", expected);
  }
  requireText(clientHttpTest, "tests/client-http.test.js", "status.heartbeat.device.sync.lastRun.trigger, \"scheduler\"");
  requireText(contractHttpTest, "tests/contract-http.test.js", "heartbeat.device.sync.lastRun.trigger, \"scheduler\"");
  requireText(contractHttpTest, "tests/contract-http.test.js", "adminDevice.sync.lastRun.trigger, \"scheduler\"");
  requireText(contractHttpTest, "tests/contract-http.test.js", "heartbeatWithInvalidPaths.device.sync.lastRun.trigger, \"manual\"");
  requireText(clientTest, "tests/client.test.js", "formatSyncRunTrigger(run.trigger)");
  requireText(coreTest, "tests/core.test.js", "normalized.trigger, \"scheduler\"");
  requireText(coreTest, "tests/core.test.js", "unknown.trigger, \"manual\"");
  requireText(clientUiSource, "client/public/app.js", "function formatSyncRunTrigger(trigger)");
  requireText(clientUiSource, "client/public/app.js", "function currentProcessSyncState(sync = {})");
  requireText(clientUiSource, "client/public/app.js", "let currentJobDraft = null;");
  requireText(clientUiSource, "client/public/app.js", "function toClientJobDraft(job = {})");
  requireText(clientUiSource, "client/public/app.js", "function readPositiveIntegerField(input, label, max)");
  requireText(clientUiSource, "client/public/app.js", "throw new Error(`${label}必须是 1 到 ${max} 之间的整数。`)");
  if (clientUiSource.includes("function numberField") || clientUiSource.includes("numberField(fields.transfers")) {
    issues.push("client/public/app.js must reject invalid sync numeric fields instead of falling back to defaults");
  }
  requireText(clientUiSource, "client/public/app.js", "currentJobDraft = toClientJobDraft(job);");
  requireText(clientUiSource, "client/public/app.js", "...base,");
  requireText(clientServerSource, "client/src/clientServer.js", "const normalized = buildJobFromProfile(profile, job);");
  requireText(clientServerSource, "client/src/clientServer.js", "normalized.id = job.id.trim();");
  requireText(clientTest, "tests/client.test.js", "client UI preserves loaded job fields when reading the edit form");
  requireText(clientTest, "tests/client.test.js", "client UI rejects invalid sync numeric fields instead of falling back");
  requireText(clientHttpTest, "tests/client-http.test.js", "updatedJobPayload.job.id, savedJobPayload.job.id");
  requireText(clientUiSource, "client/public/app.js", "const state = currentProcessSyncState(sync);");
  requireText(clientUiSource, "client/public/app.js", "const syncState = currentProcessSyncState(sync);");
  requireText(clientUiSource, "client/public/app.js", "if (sync.running || state === \"syncing\")");
  requireText(clientTest, "tests/client.test.js", "function currentProcessSyncState\\(sync = \\{\\}\\)");
  requireText(serverUiSource, "public/app.js", "function formatSyncTrigger(trigger)");
}

async function auditHeartbeatAuthContract() {
  const [
    contract,
    matrix,
    heartbeatAuthSource,
    serverAdminSource,
    contractHttpTest,
    coreTest
  ] = await Promise.all([
    readFile(join(root, "docs", "INTERFACE_CONTRACT.md"), "utf8").catch(() => ""),
    readFile(join(root, "docs", "API_MATRIX.md"), "utf8").catch(() => ""),
    readFile(join(root, "src", "core", "heartbeatAuth.js"), "utf8").catch(() => ""),
    readFile(join(root, "src", "core", "serverAdmin.js"), "utf8").catch(() => ""),
    readFile(join(root, "tests", "contract-http.test.js"), "utf8").catch(() => ""),
    readFile(join(root, "tests", "core.test.js"), "utf8").catch(() => "")
  ]);

  for (const [label, text] of [
    ["docs/INTERFACE_CONTRACT.md", contract],
    ["docs/API_MATRIX.md", matrix],
    ["src/core/heartbeatAuth.js", heartbeatAuthSource],
    ["src/core/serverAdmin.js", serverAdminSource],
    ["tests/contract-http.test.js", contractHttpTest],
    ["tests/core.test.js", coreTest]
  ]) {
    if (!text) {
      issues.push(`${label} is missing for heartbeat auth audit`);
    }
  }
  if (!contract || !matrix || !heartbeatAuthSource || !serverAdminSource || !contractHttpTest || !coreTest) {
    return;
  }

  for (const expected of [
    "createHeartbeatAuth(payloadWithoutAuth, profile.heartbeat.secret)",
    "签名输入为去掉 `auth` 字段后的稳定 JSON 请求体",
    "服务端必须忽略传输层派生的 `remoteAddress` 后再验签",
    "`401 heartbeat_auth_required`",
    "`401 heartbeat_auth_invalid`",
    "拒绝重复 nonce",
    "nonce 窗口属于服务端内部状态，不得出现在 `/api/admin/state`"
  ]) {
    requireText(contract, "docs/INTERFACE_CONTRACT.md", expected);
  }
  for (const expected of [
    "Profile heartbeat HMAC",
    "profile.heartbeat.secret",
    "sfsc-hmac-sha256-v1",
    "重复 nonce",
    "heartbeat_auth_required",
    "heartbeat_auth_invalid"
  ]) {
    requireText(matrix, "docs/API_MATRIX.md", expected);
  }

  requireText(heartbeatAuthSource, "src/core/heartbeatAuth.js", "export const HEARTBEAT_AUTH_SCHEME = \"sfsc-hmac-sha256-v1\"");
  requireText(heartbeatAuthSource, "src/core/heartbeatAuth.js", "export const HEARTBEAT_AUTH_MAX_SKEW_MS = 5 * 60 * 1000");
  requireText(heartbeatAuthSource, "src/core/heartbeatAuth.js", "stableStringify(toJsonValue(stripHeartbeatAuth(payload)))");
  requireText(heartbeatAuthSource, "src/core/heartbeatAuth.js", "createHmac(\"sha256\"");
  requireText(heartbeatAuthSource, "src/core/heartbeatAuth.js", "auth.timestamp");
  requireText(heartbeatAuthSource, "src/core/heartbeatAuth.js", "auth.nonce");
  requireText(heartbeatAuthSource, "src/core/heartbeatAuth.js", "timingSafeEqual");
  requireText(heartbeatAuthSource, "src/core/heartbeatAuth.js", "heartbeat_auth_required");
  requireText(heartbeatAuthSource, "src/core/heartbeatAuth.js", "heartbeat_auth_invalid");

  requireText(serverAdminSource, "src/core/serverAdmin.js", "const { remoteAddress: _remoteAddress, ...authPayload } = input;");
  requireText(serverAdminSource, "src/core/serverAdmin.js", "verifyHeartbeatAuth(authPayload, user.heartbeatSecret);");
  requireText(serverAdminSource, "src/core/serverAdmin.js", "rememberHeartbeatAuthNonce(user, authPayload.auth);");
  requireTextOrder(serverAdminSource, "src/core/serverAdmin.js", [
    "verifyHeartbeatAuth(authPayload, user.heartbeatSecret);",
    "rememberHeartbeatAuthNonce(user, authPayload.auth);",
    "user.lastSeenAt = now;"
  ], "heartbeat auth must be verified and nonce recorded before device state mutation");
  requireText(serverAdminSource, "src/core/serverAdmin.js", "function rememberHeartbeatAuthNonce");
  requireText(serverAdminSource, "src/core/serverAdmin.js", "Heartbeat authentication nonce was already used");
  requireText(serverAdminSource, "src/core/serverAdmin.js", "heartbeatAuthNonces");

  requireText(coreTest, "tests/core.test.js", "heartbeat auth signs the JSON heartbeat payload");
  requireText(coreTest, "tests/core.test.js", "device heartbeat rejects replayed auth nonce");
  requireText(coreTest, "tests/core.test.js", "summarizeAdminState(state).users[0].heartbeatAuthNonces, undefined");
  requireText(contractHttpTest, "tests/contract-http.test.js", "assertHttpErrorResponseContract(unauthenticatedHeartbeatError, \"unauthenticatedHeartbeat\"");
  requireText(contractHttpTest, "tests/contract-http.test.js", "errorCode: \"heartbeat_auth_required\"");
  requireText(contractHttpTest, "tests/contract-http.test.js", "const replayedHeartbeat = await fetch(`${baseUrl}/api/devices/heartbeat`");
  requireText(contractHttpTest, "tests/contract-http.test.js", "assertHttpErrorResponseContract(replayedHeartbeatError, \"replayedHeartbeat\"");
  requireText(contractHttpTest, "tests/contract-http.test.js", "errorCode: \"heartbeat_auth_invalid\"");
}

async function auditCompatibilityWarningContract() {
  const [
    contract,
    serverAdminSource,
    serverUiHtml,
    serverUiSource,
    clientServerSource,
    clientUiSource,
    clientHttpTest,
    protocolSchemasSource,
    coreTest
  ] = await Promise.all([
    readFile(join(root, "docs", "INTERFACE_CONTRACT.md"), "utf8").catch(() => ""),
    readFile(join(root, "src", "core", "serverAdmin.js"), "utf8").catch(() => ""),
    readFile(join(root, "public", "index.html"), "utf8").catch(() => ""),
    readFile(join(root, "public", "app.js"), "utf8").catch(() => ""),
    readFile(join(root, "client", "src", "clientServer.js"), "utf8").catch(() => ""),
    readFile(join(root, "client", "public", "app.js"), "utf8").catch(() => ""),
    readFile(join(root, "tests", "client-http.test.js"), "utf8").catch(() => ""),
    readFile(join(root, "src", "core", "protocolSchemas.js"), "utf8").catch(() => ""),
    readFile(join(root, "tests", "core.test.js"), "utf8").catch(() => "")
  ]);

  for (const [label, text] of [
    ["docs/INTERFACE_CONTRACT.md", contract],
    ["src/core/serverAdmin.js", serverAdminSource],
    ["public/index.html", serverUiHtml],
    ["public/app.js", serverUiSource],
    ["client/src/clientServer.js", clientServerSource],
    ["client/public/app.js", clientUiSource],
    ["tests/client-http.test.js", clientHttpTest],
    ["src/core/protocolSchemas.js", protocolSchemasSource],
    ["tests/core.test.js", coreTest]
  ]) {
    if (!text) {
      issues.push(`${label} is missing for compatibility warning audit`);
    }
  }
  if (!contract || !serverAdminSource || !serverUiHtml || !serverUiSource || !clientServerSource || !clientUiSource || !clientHttpTest || !protocolSchemasSource || !coreTest) {
    return;
  }

  for (const expected of [
    "confirmCompatibilityWarning: true",
    "compatibility.policy.profileIssue === \"warn\"",
    "heartbeat.compatibility.policy.syncRun: \"warn\"",
    "lastSuccessfulHeartbeat.compatibility.policy.syncRun",
    "当前成功 heartbeat，否则最近一次成功 heartbeat"
  ]) {
    requireText(contract, "docs/INTERFACE_CONTRACT.md", expected);
  }

  requireText(serverAdminSource, "src/core/serverAdmin.js", "compatibility?.policy?.profileIssue === \"warn\" && input.confirmCompatibilityWarning !== true");
  requireText(serverAdminSource, "src/core/serverAdmin.js", "policy.profileIssue === \"warn\" || policy.syncRun === \"warn\"");
  requireText(serverAdminSource, "src/core/serverAdmin.js", "throwDangerConfirmationRequired");
  requireText(serverUiHtml, "public/index.html", "<option value=\"mismatch\">不兼容</option>");
  requireText(serverUiSource, "public/app.js", "confirmCompatibilityWarning: Boolean(compatibilityConfirmation)");
  requireText(serverUiSource, "public/app.js", "确认向不兼容设备下发 SyncKey");
  requireText(serverUiSource, "public/app.js", "确认启用不兼容设备");
  requireText(serverUiSource, "public/app.js", "if (compat === \"compatible\") return device.compatibility?.status === \"compatible\";");
  requireText(serverUiSource, "public/app.js", "if (compat === \"mismatch\") return device.compatibility?.status === \"mismatch\";");
  if (serverUiSource.includes("compat === \"warning\"")) {
    issues.push("public/app.js must not treat compatibility warning as a status filter; use status=mismatch and severity=warning separately");
  }
  requireText(clientServerSource, "client/src/clientServer.js", "let lastSuccessfulHeartbeat = await readLastSuccessfulHeartbeat(paths)");
  requireText(clientServerSource, "client/src/clientServer.js", "let heartbeatGeneration = 0;");
  requireText(clientServerSource, "client/src/clientServer.js", "async function resetHeartbeatState()");
  requireText(clientServerSource, "client/src/clientServer.js", "await resetHeartbeatState();");
  requireText(clientServerSource, "client/src/clientServer.js", "sendHeartbeat().catch(() => {});");
  requireText(clientServerSource, "client/src/clientServer.js", "if (generation !== heartbeatGeneration) {\n      return null;\n    }");
  requireText(clientServerSource, "client/src/clientServer.js", "lastSuccessfulHeartbeat = lastHeartbeat;");
  requireText(clientServerSource, "client/src/clientServer.js", "await saveLastSuccessfulHeartbeat(lastSuccessfulHeartbeat, paths);");
  requireText(clientServerSource, "client/src/clientServer.js", "await clearLastSuccessfulHeartbeat(paths);");
  requireText(clientServerSource, "client/src/clientServer.js", "heartbeat: lastHeartbeat,\n    lastSuccessfulHeartbeat,");
  requireText(clientServerSource, "client/src/clientServer.js", "lastSuccessfulHeartbeat?.ok && lastSuccessfulHeartbeat?.compatibility?.policy?.syncRun === \"warn\" && body.confirmCompatibilityWarning !== true");
  requireText(clientServerSource, "client/src/clientServer.js", "Confirm protocol compatibility warning before saving or running sync.");
  requireText(protocolSchemasSource, "src/core/protocolSchemas.js", "function parseClientJobPayload(body, label)");
  requireText(protocolSchemasSource, "src/core/protocolSchemas.js", "copyOptionalStringFields(input, output, CLIENT_JOB_STRING_FIELDS)");
  requireText(protocolSchemasSource, "src/core/protocolSchemas.js", "copyOptionalJsonFields(input, output, CLIENT_JOB_JSON_FIELDS)");
  requireText(clientServerSource, "client/src/clientServer.js", "const payload = await withClientStateLock(paths, async () => {");
  requireTextOrder(clientServerSource, "client/src/clientServer.js", [
    "const payload = await withClientStateLock(paths, async () => {",
    "const job = await saveJob(await normalizeJob(body.job || {}), paths);",
    "await refreshScheduler();",
    "return json(res, payload);"
  ], "Client job save must normalize profile-derived fields and persist under one state lock");
  requireText(clientUiSource, "client/public/app.js", "function currentSyncCompatibility()");
  requireText(clientUiSource, "client/public/app.js", "function currentSuccessfulHeartbeat(status = latestStatus)");
  requireText(clientUiSource, "client/public/app.js", "const successfulHeartbeat = currentSuccessfulHeartbeat(status);");
  requireText(clientUiSource, "client/public/app.js", "formatProtocols(successfulHeartbeat?.serverDiagnostics?.protocols)");
  requireText(clientUiSource, "client/public/app.js", "formatCompatibility(successfulHeartbeat?.compatibility)");
  requireText(clientUiSource, "client/public/app.js", "const compatibility = currentSyncCompatibility();");
  requireText(clientUiSource, "client/public/app.js", "return currentSuccessfulHeartbeat()?.compatibility || null;");
  requireText(clientUiSource, "client/public/app.js", "confirmCompatibilityWarning: confirmed.confirmCompatibilityWarning");
  requireText(clientUiSource, "client/public/app.js", "确认协议兼容性风险");
  requireText(clientUiSource, "client/public/app.js", "formatSyncCompatibilityWarning(compatibility)");
  requireText(clientHttpTest, "tests/client-http.test.js", "const failedHeartbeatStatus = await waitForHeartbeatFailure(baseUrl);");
  requireText(clientHttpTest, "tests/client-http.test.js", "assertHeartbeatContract(failedHeartbeatStatus.lastSuccessfulHeartbeat, \"lastSuccessfulHeartbeat\")");
  requireText(clientHttpTest, "tests/client-http.test.js", "failedHeartbeatStatus.lastSuccessfulHeartbeat.compatibility.policy.syncRun, \"warn\"");
  requireText(clientHttpTest, "tests/client-http.test.js", "client restores lastSuccessfulHeartbeat after restart for compatibility confirmation");
  requireText(clientHttpTest, "tests/client-http.test.js", "const saveAfterFailedHeartbeat = await fetch(`${baseUrl}/api/jobs/save`");
  requireText(clientHttpTest, "tests/client-http.test.js", "assertHttpErrorResponseContract(await saveAfterFailedHeartbeat.json(), \"saveAfterFailedHeartbeat\"");
  requireText(clientHttpTest, "tests/client-http.test.js", "const runAfterFailedHeartbeat = await fetch(`${baseUrl}/api/sync/run`");
  requireText(clientHttpTest, "tests/client-http.test.js", "assertHttpErrorResponseContract(await runAfterFailedHeartbeat.json(), \"runAfterFailedHeartbeat\"");
  requireText(clientHttpTest, "tests/client-http.test.js", "heartbeatMode = \"allow\";");
  requireText(clientHttpTest, "tests/client-http.test.js", "waitForHeartbeatCompatibility(baseUrl, \"allow\")");
  requireText(clientHttpTest, "tests/client-http.test.js", "assertClientJobSaveResponseContract(saveAfterAllowHeartbeatPayload, \"saveAfterAllowHeartbeat\")");
  requireText(clientHttpTest, "tests/client-http.test.js", "client profile import clears stale heartbeat snapshots");
  requireText(clientHttpTest, "tests/client-http.test.js", "assert.equal(newStatus.lastSuccessfulHeartbeat, null)");
  requireText(contract, "docs/INTERFACE_CONTRACT.md", "job 请求体中的 `clientName`、`remoteName`、`bucketName`、`bucket`、`remotePrefix`、`s3Endpoint`、`endpoint`、`accessKeyId`、`secretAccessKey`、`s3SecretAccessKey`、`storageBackend`、`uri` 和 `vlessUri` 必须视为展示摘要残留或恶意覆盖输入");
  requireText(contract, "docs/INTERFACE_CONTRACT.md", "客户端 job 请求 schema 必须对白名单字段归一化");
  requireText(coreTest, "tests/core.test.js", "clientName: \"evil-pc\"");
  requireText(coreTest, "tests/core.test.js", "secretAccessKey: \"evil-secret\"");
  requireText(clientHttpTest, "tests/client-http.test.js", "function maliciousProfileDerivedJobFields()");
  requireText(clientHttpTest, "tests/client-http.test.js", "assert.equal(savedJobPayload.job.clientName, \"company-pc1\")");
  requireText(clientHttpTest, "tests/client-http.test.js", "assert.equal(previewFromMinimalJobPayload.rclone.remoteConfig.args.includes(\"evil-secret-value\"), false)");
  requireText(clientHttpTest, "tests/client-http.test.js", "assert.equal(configEvent.argv.includes(\"evil-secret-value\"), false)");
  requireText(clientHttpTest, "tests/client-http.test.js", "assert.equal(syncEvent.argv.some((arg) => String(arg).includes(\"evil-minio\")), false)");
}

async function auditServerDeviceFilterContract() {
  const [
    contract,
    serverUiHtml,
    serverUiSource,
    coreTest
  ] = await Promise.all([
    readFile(join(root, "docs", "INTERFACE_CONTRACT.md"), "utf8").catch(() => ""),
    readFile(join(root, "public", "index.html"), "utf8").catch(() => ""),
    readFile(join(root, "public", "app.js"), "utf8").catch(() => ""),
    readFile(join(root, "tests", "core.test.js"), "utf8").catch(() => "")
  ]);

  for (const [label, text] of [
    ["docs/INTERFACE_CONTRACT.md", contract],
    ["public/index.html", serverUiHtml],
    ["public/app.js", serverUiSource],
    ["tests/core.test.js", coreTest]
  ]) {
    if (!text) {
      issues.push(`${label} is missing for server device filter audit`);
    }
  }
  if (!contract || !serverUiHtml || !serverUiSource || !coreTest) {
    return;
  }

  requireText(contract, "docs/INTERFACE_CONTRACT.md", "服务端控制台设备列表的“同步中 / 空闲 / 出错”筛选必须使用当前 `device.sync.state` / `device.syncState`");
  requireText(contract, "docs/INTERFACE_CONTRACT.md", "不得用 `sync.lastRun.status` 替代当前同步状态");
  requireText(serverUiHtml, "public/index.html", "<option value=\"syncing\">同步中</option>");
  requireText(serverUiHtml, "public/index.html", "<option value=\"idle\">空闲</option>");
  requireText(serverUiHtml, "public/index.html", "<option value=\"error\">出错</option>");
  requireText(serverUiSource, "public/app.js", "function currentDeviceSyncState(device = {})");
  requireText(serverUiSource, "public/app.js", "const syncState = currentDeviceSyncState(device);");
  requireText(serverUiSource, "public/app.js", "if (sync === \"syncing\" || sync === \"running\") return syncState === \"syncing\" || lastRunStatus === \"running\";");
  requireText(serverUiSource, "public/app.js", "if (sync === \"idle\") return syncState === \"idle\";");
  requireText(serverUiSource, "public/app.js", "if (sync === \"error\") return syncState === \"error\" || lastRunStatus === \"error\";");
  requireText(coreTest, "tests/core.test.js", "value=\"syncing\"");
  requireText(coreTest, "tests/core.test.js", "function currentDeviceSyncState\\(device = \\{\\}\\)");
  if (serverUiSource.includes("return lastRun.status === sync;")) {
    issues.push("public/app.js deviceMatchesSync must not treat sync.lastRun.status as the default current-state filter");
  }
}

async function auditDestructiveSyncConfirmationContract() {
  const [
    contract,
    clientServerSource,
    clientUiSource
  ] = await Promise.all([
    readFile(join(root, "docs", "INTERFACE_CONTRACT.md"), "utf8").catch(() => ""),
    readFile(join(root, "client", "src", "clientServer.js"), "utf8").catch(() => ""),
    readFile(join(root, "client", "public", "app.js"), "utf8").catch(() => "")
  ]);

  for (const [label, text] of [
    ["docs/INTERFACE_CONTRACT.md", contract],
    ["client/src/clientServer.js", clientServerSource],
    ["client/public/app.js", clientUiSource]
  ]) {
    if (!text) {
      issues.push(`${label} is missing for destructive sync confirmation audit`);
    }
  }
  if (!contract || !clientServerSource || !clientUiSource) {
    return;
  }

  for (const expected of [
    "confirmDestructiveSync: true",
    "destructiveSync: true",
    "`POST /api/sync/preview` 是只读预览，不要求这些确认"
  ]) {
    requireText(contract, "docs/INTERFACE_CONTRACT.md", expected);
  }

  requireText(clientServerSource, "client/src/clientServer.js", "direction !== \"bidirectional\" && Boolean(job.destructiveSync) && body.confirmDestructiveSync !== true");
  requireText(clientServerSource, "client/src/clientServer.js", "Confirm mirror sync before saving or running sync.");
  requireText(clientUiSource, "client/public/app.js", "confirmDestructiveSync: confirmed.confirmDestructiveSync");
  requireText(clientUiSource, "client/public/app.js", "镜像同步会删除目标端多余文件");
}

async function auditLocalStateCorruptionContract() {
  const [
    contract,
    matrix,
    clientDesign,
    pathsSource,
    storeSource,
    clientServerSource,
    processRunnerSource,
    runtimeContracts,
    clientHttpTest
  ] = await Promise.all([
    readFile(join(root, "docs", "INTERFACE_CONTRACT.md"), "utf8").catch(() => ""),
    readFile(join(root, "docs", "API_MATRIX.md"), "utf8").catch(() => ""),
    readFile(join(root, "docs", "client-design.md"), "utf8").catch(() => ""),
    readFile(join(root, "client", "src", "paths.js"), "utf8").catch(() => ""),
    readFile(join(root, "client", "src", "store.js"), "utf8").catch(() => ""),
    readFile(join(root, "client", "src", "clientServer.js"), "utf8").catch(() => ""),
    readFile(join(root, "client", "src", "processRunner.js"), "utf8").catch(() => ""),
    readFile(join(root, "scripts", "lib", "runtimeContracts.mjs"), "utf8").catch(() => ""),
    readFile(join(root, "tests", "client-http.test.js"), "utf8").catch(() => "")
  ]);

  for (const [label, text] of [
    ["docs/INTERFACE_CONTRACT.md", contract],
    ["docs/API_MATRIX.md", matrix],
    ["docs/client-design.md", clientDesign],
    ["client/src/paths.js", pathsSource],
    ["client/src/store.js", storeSource],
    ["client/src/clientServer.js", clientServerSource],
    ["client/src/processRunner.js", processRunnerSource],
    ["scripts/lib/runtimeContracts.mjs", runtimeContracts],
    ["tests/client-http.test.js", clientHttpTest]
  ]) {
    if (!text) {
      issues.push(`${label} is missing for local state corruption audit`);
    }
  }
  if (!contract || !matrix || !clientDesign || !pathsSource || !storeSource || !clientServerSource || !processRunnerSource || !runtimeContracts || !clientHttpTest) {
    return;
  }

  for (const expected of [
    "safeguards.localState",
    "claim-recovery.json",
    "claimRecovery",
    "local_state_corrupt",
    "/api/profile/import",
    "/api/jobs/save",
    "/api/sync/run",
    "409 local_state_corrupt"
  ]) {
    requireText(contract, "docs/INTERFACE_CONTRACT.md", expected);
  }

  requireText(storeSource, "client/src/store.js", "createHttpError(\"local_state_corrupt\", 409");
  requireText(storeSource, "client/src/store.js", "export async function inspectLocalState");
  requireText(storeSource, "client/src/store.js", "export async function readStoredProfile");
  requireText(storeSource, "client/src/store.js", "export async function readStoredJobs");
  requireText(storeSource, "client/src/store.js", "async function inspectJsonStateFile");
  requireText(storeSource, "client/src/store.js", "inspectJsonStateFile(\"claimRecovery\", claimRecoveryStoreFile(paths))");
  requireText(storeSource, "client/src/store.js", "errorCode: \"local_state_corrupt\"");
  requireText(storeSource, "client/src/store.js", "export async function readSyncHistory");
  requireText(storeSource, "client/src/store.js", "if (error?.code === \"local_state_corrupt\")");
  requireText(storeSource, "client/src/store.js", "async function readSyncHistoryForWrite");
  requireText(clientServerSource, "client/src/clientServer.js", "const localState = await inspectLocalState(paths);");
  requireText(clientServerSource, "client/src/clientServer.js", "if (error?.code === \"local_state_corrupt\")");
  requireText(clientServerSource, "client/src/clientServer.js", "const profile = await readStoredProfile(paths).catch((error) => {");
  requireText(clientServerSource, "client/src/clientServer.js", "const jobs = await readStoredJobs(paths).catch((error) => {");
  requireText(clientServerSource, "client/src/clientServer.js", "if (req.method === \"GET\" && url.pathname === \"/api/profile\") {\n      const profile = await readStoredProfile(paths);");
  requireText(clientServerSource, "client/src/clientServer.js", "if (req.method === \"GET\" && url.pathname === \"/api/jobs\") {\n      const jobs = await readStoredJobs(paths);");
  requireText(clientServerSource, "client/src/clientServer.js", "async function ensureLocalStateWritable()");
  requireText(clientServerSource, "client/src/clientServer.js", "throw createHttpError(\n    \"local_state_corrupt\",\n    409,");
  requireText(clientServerSource, "client/src/clientServer.js", "async function ensureSecretVaultReady()");
  requireText(clientServerSource, "client/src/clientServer.js", "const secretVault = await inspectSecretVault(paths);");
  requireText(clientServerSource, "client/src/clientServer.js", "\"secret_vault_missing\",\n    409,");
  requireText(clientServerSource, "client/src/clientServer.js", "runBuffered(paths.singboxExe, [\"check\", \"-c\", paths.singboxConfigFile]");
  requireText(clientServerSource, "client/src/clientServer.js", "readyProbe: () => isTcpPortOpen(\"127.0.0.1\", config.inbounds[0].listen_port)");
  requireText(clientServerSource, "client/src/clientServer.js", "function isTcpPortOpen");
  requireText(clientServerSource, "client/src/clientServer.js", "singboxProcess.stopAndWait");
  requireText(clientServerSource, "client/src/clientServer.js", "syncProcess.stopAndWait");
  requireText(processRunnerSource, "client/src/processRunner.js", "readyProbe");
  requireText(processRunnerSource, "client/src/processRunner.js", "async stopAndWait");
  requireText(processRunnerSource, "client/src/processRunner.js", "waitForExit");
  requireText(contract, "docs/INTERFACE_CONTRACT.md", "sing-box check -c <config>");
  requireText(contract, "docs/INTERFACE_CONTRACT.md", "必须等待本地 loopback 代理端口监听成功");
  requireText(contract, "docs/INTERFACE_CONTRACT.md", "发送停止信号并短暂等待退出");
  requireText(clientHttpTest, "tests/client-http.test.js", "singbox-check");
  requireText(clientHttpTest, "tests/client-http.test.js", "SFSC_FAKE_SINGBOX_CHECK_EXIT_CODE");
  requireText(pathsSource, "client/src/paths.js", "process.env.SFSC_CLIENT_DATA_ROOT || process.env.SFSC_DATA_ROOT");
  requireText(pathsSource, "client/src/paths.js", "Syncraft");
  requireText(pathsSource, "client/src/paths.js", "async function ensureWritableDataRoot");
  requireText(pathsSource, "client/src/paths.js", "function applyDataRoot");
  requireText(storeSource, "client/src/store.js", "async function protectSecretVaultFile");
  requireText(storeSource, "client/src/store.js", "icacls.exe");
  requireText(storeSource, "client/src/store.js", "async function inspectSecretVaultProtection");
  requireText(storeSource, "client/src/store.js", "protected: protection.protected");
  requireText(runtimeContracts, "scripts/lib/runtimeContracts.mjs", "status.safeguards.secretVault.protected");
  requireText(contract, "docs/INTERFACE_CONTRACT.md", "SFSC_CLIENT_DATA_ROOT");
  requireText(contract, "docs/INTERFACE_CONTRACT.md", "SFSC_DATA_ROOT");
  requireText(contract, "docs/INTERFACE_CONTRACT.md", "%LOCALAPPDATA%\\Syncraft\\data");
  requireText(contract, "docs/INTERFACE_CONTRACT.md", "`protected` 布尔值");
  requireText(clientDesign, "docs/client-design.md", "safeguards.secretVault.protected");
  requireText(clientHttpTest, "tests/client-http.test.js", "safeguards.secretVault.protected");
  requireText(clientServerSource, "client/src/clientServer.js", "async function importProfile(body = {}) {\n  return withClientStateLock(paths, async () => {\n    await ensureLocalStateWritable();");
  const saveJobRouteSource = sourceWindow(
    clientServerSource,
    "if (req.method === \"POST\" && url.pathname === \"/api/jobs/save\") {",
    "if (req.method === \"POST\" && url.pathname === \"/api/singbox/start\") {"
  );
  requireTextOrder(saveJobRouteSource, "client/src/clientServer.js /api/jobs/save", [
    "if (req.method === \"POST\" && url.pathname === \"/api/jobs/save\") {",
    "const body = parseProtocolRequest(PROTOCOL_REQUESTS.CLIENT_JOB_SAVE, await readJson(req));",
    "requireSyncCompatibilityConfirmation(body);",
    "requireDestructiveSyncConfirmation(body);",
    "const payload = await withClientStateLock(paths, async () => {",
    "await ensureLocalStateWritable();"
  ], "/api/jobs/save must validate the shared protocol schema and confirmations before writing local state");
  requireText(clientServerSource, "client/src/clientServer.js", "let syncRunInFlight = null;");
  requireText(clientServerSource, "client/src/clientServer.js", "let syncRunInFlightJobFingerprint = \"\";");
  requireText(clientServerSource, "client/src/clientServer.js", "let activeSyncJobFingerprint = \"\";");
  requireText(clientServerSource, "client/src/clientServer.js", "const STOPPING_SYNC_REPLAY_MS = 2000;");
  requireText(clientServerSource, "client/src/clientServer.js", "let stoppingSyncReplay = null;");
  requireText(clientServerSource, "client/src/clientServer.js", "const runPlan = await buildSyncRunPlan(job);");
  requireText(clientServerSource, "client/src/clientServer.js", "const jobFingerprint = syncJobFingerprint(runPlan.normalizedJob);");
  requireText(clientServerSource, "client/src/clientServer.js", "async function buildSyncRunPlan(job = {})");
  requireText(clientServerSource, "client/src/clientServer.js", "const tunnelUri = getTunnelUri(profile);");
  requireText(clientServerSource, "client/src/clientServer.js", "const normalizedJob = buildJobFromProfile(profile, job);");
  requireText(clientServerSource, "client/src/clientServer.js", "normalizedJob.localPath = await validateSyncLocalPath(normalizedJob.localPath);");
  requireText(clientServerSource, "client/src/clientServer.js", "tunnelUri");
  requireText(clientServerSource, "client/src/clientServer.js", "return buildSyncPreviewFromNormalizedJob(normalized);");
  requireText(clientServerSource, "client/src/clientServer.js", "async function buildSyncPreviewFromNormalizedJob(normalized, options = {})");
  requireText(clientServerSource, "client/src/clientServer.js", "if (syncRunInFlightJobFingerprint !== jobFingerprint) {\n      throw syncAlreadyRunningError();\n    }");
  requireText(clientServerSource, "client/src/clientServer.js", "const stoppingReplay = currentStoppingSyncReplay();");
  requireText(clientServerSource, "client/src/clientServer.js", "if (stoppingReplay.jobFingerprint === jobFingerprint)");
  requireText(clientServerSource, "client/src/clientServer.js", "async function stopSync()");
  requireText(clientServerSource, "client/src/clientServer.js", "function currentStoppingSyncReplay");
  requireText(clientServerSource, "client/src/clientServer.js", "function currentSyncProcessStatus()");
  requireText(clientServerSource, "client/src/clientServer.js", "syncRunInFlight = runSyncExclusive(runPlan, options);");
  requireText(clientServerSource, "client/src/clientServer.js", "syncRunInFlight = null;\n    syncRunInFlightJobFingerprint = \"\";");
  requireText(clientServerSource, "client/src/clientServer.js", "function syncAlreadyRunningError()");
  requireText(clientServerSource, "client/src/clientServer.js", "function syncJobFingerprint(job = {})");
  requireText(clientServerSource, "client/src/clientServer.js", "async function runSyncExclusive(runPlan, options = {}) {\n  const { normalizedJob, tunnelUri } = runPlan;");
  if (clientServerSource.includes("runSync(await normalizeJob(body.job || {}), { trigger: \"manual\" })")) {
    issues.push("client/src/clientServer.js must pass the raw manual sync job into runSync so runSync owns the single normalized snapshot");
  }
  const runSyncExclusiveSource = sourceWindow(
    clientServerSource,
    "async function runSyncExclusive(runPlan, options = {})",
    "async function ensureSyncRunBinaries()"
  );
  if (/normalizeJob\(/.test(runSyncExclusiveSource)) {
    issues.push("client/src/clientServer.js must not normalize again inside runSyncExclusive");
  }
  if (/read(?:Stored)?Profile\(/.test(runSyncExclusiveSource)) {
    issues.push("client/src/clientServer.js must not read profile again inside runSyncExclusive");
  }
  if (/buildSyncPreview\(normalizedJob\)/.test(runSyncExclusiveSource)) {
    issues.push("client/src/clientServer.js must build sync preview from the existing normalized job snapshot");
  }
  requireText(clientServerSource, "client/src/clientServer.js", "async function ensureSyncRunBinaries()");
  requireText(clientServerSource, "client/src/clientServer.js", "throw missingBinaryError(\"sing-box\", paths.singboxExe, \"missing_singbox_binary\");");
  requireText(clientServerSource, "client/src/clientServer.js", "function redactRcloneConfigFailureDetail");
  requireText(clientServerSource, "client/src/clientServer.js", "function collectRcloneConfigSecrets");
  requireText(clientServerSource, "client/src/clientServer.js", "function redactKnownSecretValues");
  requireTextOrder(clientServerSource, "client/src/clientServer.js", [
    "async function runSyncExclusive(runPlan, options = {}) {\n  const { normalizedJob, tunnelUri } = runPlan;",
    "await ensureSecretVaultReady();",
    "await ensureSyncRunBinaries();",
    "const recovery = getSyncRecoveryPaths(normalizedJob);",
    "const preview = (await buildSyncPreviewFromNormalizedJob(normalizedJob, {",
    "const remoteConfig = await runBuffered(paths.rcloneExe, preview.remoteConfig.args,",
    "if (!remoteConfig.ok) {",
    "if (!singboxProcess.isRunning())",
    "await startSingbox({\n      uri: tunnelUri,\n      localProxyPort: normalizedJob.localProxyPort || 18081\n    });",
    "return await syncProcess.start(paths.rcloneExe, preview.args,"
  ], "sync startup must validate state and binaries, normalize the job, write rclone config, then start sing-box before rclone sync");
  requireText(clientServerSource, "client/src/clientServer.js", "const detail = redactRcloneConfigFailureDetail(remoteConfig, normalizedJob, preview);");
  requireTextOrder(clientServerSource, "client/src/clientServer.js", [
    "onStarted: async () => {",
    "const run = createSyncRunStart(normalizedJob, options);",
    "markSyncStarting(normalizedJob, run);",
    "await recordSyncRunStarted(run, paths);"
  ], "sync startup must initialize runtime metrics before awaiting history persistence");
  if (clientServerSource.includes("job.localProxyPort || 18081")) {
    issues.push("client/src/clientServer.js must not start sing-box from raw job.localProxyPort || 18081 during sync runs");
  }
  requireText(clientServerSource, "client/src/clientServer.js", "pruneSyncRecovery(preview, recovery, normalizedJob.safety.recoveryRetentionDays)");
  requireText(clientServerSource, "client/src/clientServer.js", "throw createHttpError(\"rclone_sync_failed\", 500, `Failed to start rclone sync: ${error.message}`);");
  requireText(clientServerSource, "client/src/clientServer.js", "claimRecovery: claimRecoveryFile");
  requireText(clientServerSource, "client/src/clientServer.js", "lastSuccessfulHeartbeat: heartbeatSnapshotFile");
  requireText(runtimeContracts, "scripts/lib/runtimeContracts.mjs", "[\"claimRecovery\", \"jobs\", \"lastSuccessfulHeartbeat\", \"profile\", \"secrets\", \"syncHistory\"]");
  requireText(runtimeContracts, "scripts/lib/runtimeContracts.mjs", "[\"profile\", \"jobs\", \"secrets\", \"syncHistory\", \"claimRecovery\", \"lastSuccessfulHeartbeat\"]");
  requireText(clientHttpTest, "tests/client-http.test.js", "const missingVaultSave = await fetch(`${baseUrl}/api/jobs/save`");
  requireText(clientHttpTest, "tests/client-http.test.js", "assertHttpErrorResponseContract(await missingVaultSave.json(), \"missingVaultSave\"");
  requireText(clientHttpTest, "tests/client-http.test.js", "const missingVaultRun = await fetch(`${baseUrl}/api/sync/run`");
  requireText(clientHttpTest, "tests/client-http.test.js", "assertHttpErrorResponseContract(await missingVaultRun.json(), \"missingVaultRun\"");
  requireText(clientHttpTest, "tests/client-http.test.js", "assert.equal(await pathExists(missingVaultRcloneConfigPath), false)");
  requireText(clientHttpTest, "tests/client-http.test.js", "assert.equal(statusAfterMissingVaultRun.processes.sync.metrics.syncState, \"idle\")");
  requireText(clientHttpTest, "tests/client-http.test.js", "assert.equal(missingVaultPayload.profileImported, true)");
  requireText(clientHttpTest, "tests/client-http.test.js", "const missingVaultProfileRead = await fetch(`${baseUrl}/api/profile`)");
  requireText(clientHttpTest, "tests/client-http.test.js", "const missingVaultJobsRead = await fetch(`${baseUrl}/api/jobs`)");
  requireText(clientHttpTest, "tests/client-http.test.js", "assertClientJobsReadContract(missingVaultJobsReadPayload, \"missingVaultJobsRead\")");
  requireText(clientHttpTest, "tests/client-http.test.js", "assertClientJobsReadContract(jobsReadPayload, \"jobsRead\")");
  requireText(contract, "docs/INTERFACE_CONTRACT.md", "若 secret vault 缺失，该展示接口仍必须基于未水合的 `profile.json` 返回展示安全摘要");
  requireText(contract, "docs/INTERFACE_CONTRACT.md", "若 secret vault 缺失，该展示接口仍必须基于未水合的 `jobs.json` 返回展示安全摘要");
  requireText(contract, "docs/INTERFACE_CONTRACT.md", "继续基于未水合的 profile/jobs 本地 JSON 返回 `profileImported: true`");
  requireText(contract, "docs/INTERFACE_CONTRACT.md", "/api/jobs/save`、`/api/singbox/start`、`/api/sync/preview` 和 `/api/sync/run` 必须检查整个 secret vault 健康状态");
  requireText(clientHttpTest, "tests/client-http.test.js", "client sync endpoints refuse partial secret vault misses before starting binaries");
  requireText(clientHttpTest, "tests/client-http.test.js", "vaultStatus.safeguards.secretVault.missingRefs.includes(missingJobSecretRef), false");
  requireText(clientHttpTest, "tests/client-http.test.js", "vaultStatus.safeguards.secretVault.missingRefs[0], \"redacted\"");
  requireText(contract, "docs/INTERFACE_CONTRACT.md", "公开 HTTP 状态和诊断包不得暴露真实 vault key");
  requireText(contract, "docs/INTERFACE_CONTRACT.md", "当自动调度触发时发现本地 secret vault 缺失");
  requireText(contract, "docs/INTERFACE_CONTRACT.md", "同步启动成功后必须写入一条 `status: \"running\"` 的同步历史");
  requireText(contract, "docs/INTERFACE_CONTRACT.md", "同步启动阶段也必须 single-flight");
  requireText(contract, "docs/INTERFACE_CONTRACT.md", "同一 job 的重复 `/api/sync/run` 返回 `200`");
  requireText(contract, "docs/INTERFACE_CONTRACT.md", "不同 job 返回 `409 sync_already_running`");
  requireText(contract, "docs/INTERFACE_CONTRACT.md", "若等待超时，响应必须保留运行状态并通过 `stopTimedOut: true` 暴露诊断");
  requireText(contract, "docs/INTERFACE_CONTRACT.md", "同一次 `/api/sync/run` 必须只生成一个 normalized job 快照");
  requireText(contract, "docs/INTERFACE_CONTRACT.md", "rclone config 写入成功后，若 sing-box 尚未运行，才自动启动本地 sing-box");
  requireText(contract, "docs/INTERFACE_CONTRACT.md", "同一次 `/api/sync/run` 必须以归一化后的 job `localProxyPort` 为单一来源");
  requireText(contract, "docs/INTERFACE_CONTRACT.md", "rclone `ALL_PROXY` 端口必须等于 sing-box client config `inbounds[0].listen_port`");
  requireText(contract, "docs/INTERFACE_CONTRACT.md", "旧 `jobs.json` 缺少 `localProxyPort` 时也必须从 profile defaults 兜底");
  requireText(contract, "docs/INTERFACE_CONTRACT.md", "不得启动 rclone sync，若 sing-box 原本未运行也不得留下新启动的 sing-box 进程");
  requireText(contract, "docs/INTERFACE_CONTRACT.md", "`processes.sync.metrics.syncState` 必须保持 `idle`");
  requireText(matrix, "docs/API_MATRIX.md", "rclone config 失败不写同步历史、不启动 rclone sync");
  requireText(matrix, "docs/API_MATRIX.md", "不同 job 冲突返回 `409 sync_already_running`");
  requireText(matrix, "docs/API_MATRIX.md", "同一次运行只生成一个 normalized job 快照");
  requireText(matrix, "docs/API_MATRIX.md", "同一次运行中 rclone `ALL_PROXY` 端口必须等于 sing-box `inbounds[0].listen_port`");
  requireText(clientDesign, "docs/client-design.md", "Sync run writes the app-scoped rclone config before starting a new sing-box process");
  requireText(clientDesign, "docs/client-design.md", "does not leave a newly-started tunnel process behind");
  requireText(contract, "docs/INTERFACE_CONTRACT.md", "只返回该合同登记的展示安全字段");
  requireText(contract, "docs/INTERFACE_CONTRACT.md", "未知扩展字段、`lastExit` 运行细节、`secretAccessKey`、SyncKey、导入 URI、VLESS URI、profile 或调试对象不得透传");
  requireText(contract, "docs/INTERFACE_CONTRACT.md", "只有 `status: \"error\"` 可以携带非空 `errorCode` 和 `error`");
  requireText(contract, "docs/INTERFACE_CONTRACT.md", "`stopped` 记录不得在顶层或嵌套字段中暴露 `rclone_sync_failed`");
  requireText(contract, "docs/INTERFACE_CONTRACT.md", "不得新增 `sync-history.json` 记录");
  requireText(clientHttpTest, "tests/client-http.test.js", "client scheduler records secret vault failures without starting sync");
  requireText(clientHttpTest, "tests/client-http.test.js", "client sync run does not write history when rclone sync spawn fails after config");
  requireText(clientHttpTest, "tests/client-http.test.js", "client sync run refuses missing sing-box before writing rclone config");
  requireText(clientHttpTest, "tests/client-http.test.js", "client sync run fails rclone config before starting sing-box or history");
  requireText(clientHttpTest, "tests/client-http.test.js", "SFSC_FAKE_CONFIG_EXIT_CODE");
  requireText(clientHttpTest, "tests/client-http.test.js", "SFSC_FAKE_CONFIG_STDERR_SECRET");
  requireText(clientHttpTest, "tests/client-http.test.js", "assert.equal(statusAfterRun.processes.singbox.running, false)");
  requireText(clientHttpTest, "tests/client-http.test.js", "assert.match(runPayload.message, /bare-secret \\*\\*\\*\\*/)");
  requireText(clientHttpTest, "tests/client-http.test.js", "SFSC_FAKE_REMOVE_RCLONE_AFTER_CONFIG");
  requireText(clientHttpTest, "tests/client-http.test.js", "assert.equal(fakeToolEvents.some((event) => event.tool === \"rclone-sync\"), false)");
  requireText(clientHttpTest, "tests/client-http.test.js", "client sync run is single-flight while rclone config is starting");
  requireText(clientHttpTest, "tests/client-http.test.js", "client scheduler and manual sync run share single-flight while rclone config is starting");
  requireText(clientHttpTest, "tests/client-http.test.js", "errorCode: \"sync_already_running\"");
  requireText(clientHttpTest, "tests/client-http.test.js", "stopActive.conflictingRun");
  requireText(clientHttpTest, "tests/client-http.test.js", "client scheduler sync run aligns legacy job proxy port with profile defaults");
  requireText(clientHttpTest, "tests/client-http.test.js", "delete storedJobs[0].localProxyPort;");
  requireText(clientHttpTest, "tests/client-http.test.js", "assert.equal(syncEvent.allProxy, \"socks5://127.0.0.1:18092\")");
  requireText(clientHttpTest, "tests/client-http.test.js", "assert.equal(singboxConfig.inbounds[0].listen_port, 18092)");
  requireTextOrder(clientHttpTest, "tests/client-http.test.js", [
    "client scheduler and manual sync run share single-flight while rclone config is starting",
    "await waitForFakeToolEvent(fakeToolLog, \"rclone-config\");",
    "const manualRun = await fetch(`${secondBaseUrl}/api/sync/run`",
    "assert.equal(history.history.length, 1);",
    "assert.equal(status.scheduler.lastError, \"\");",
    "assert.equal(fakeToolEvents.filter((event) => event.tool === \"rclone-config\").length, 1);",
    "assert.equal(fakeToolEvents.filter((event) => event.tool === \"rclone-sync\").length, 1);"
  ], "scheduler/manual sync collision must share the rclone config/start single-flight");
  requireText(clientHttpTest, "tests/client-http.test.js", "await waitForSchedulerError(baseUrl, \"secret_vault_missing\")");
}

async function auditClaimRedeemRecoveryContract() {
  const [
    contract,
    matrix,
    tKeyProtocol,
    clientDesign,
    coreErrorsSource,
    serverAdminSource,
    clientServerSource,
    profileImportSource,
    storeSource,
    pathsSource,
    clientUiSource,
    clientHttpTest,
    contractHttpTest,
    clientTest,
    coreTest
  ] = await Promise.all([
    readFile(join(root, "docs", "INTERFACE_CONTRACT.md"), "utf8").catch(() => ""),
    readFile(join(root, "docs", "API_MATRIX.md"), "utf8").catch(() => ""),
    readFile(join(root, "docs", "T_KEY_PROTOCOL.md"), "utf8").catch(() => ""),
    readFile(join(root, "docs", "client-design.md"), "utf8").catch(() => ""),
    readFile(join(root, "src", "core", "errors.js"), "utf8").catch(() => ""),
    readFile(join(root, "src", "core", "serverAdmin.js"), "utf8").catch(() => ""),
    readFile(join(root, "client", "src", "clientServer.js"), "utf8").catch(() => ""),
    readFile(join(root, "client", "src", "profileImport.js"), "utf8").catch(() => ""),
    readFile(join(root, "client", "src", "store.js"), "utf8").catch(() => ""),
    readFile(join(root, "client", "src", "paths.js"), "utf8").catch(() => ""),
    readFile(join(root, "client", "public", "app.js"), "utf8").catch(() => ""),
    readFile(join(root, "tests", "client-http.test.js"), "utf8").catch(() => ""),
    readFile(join(root, "tests", "contract-http.test.js"), "utf8").catch(() => ""),
    readFile(join(root, "tests", "client.test.js"), "utf8").catch(() => ""),
    readFile(join(root, "tests", "core.test.js"), "utf8").catch(() => "")
  ]);

  for (const [label, text] of [
    ["docs/INTERFACE_CONTRACT.md", contract],
    ["docs/API_MATRIX.md", matrix],
    ["docs/T_KEY_PROTOCOL.md", tKeyProtocol],
    ["docs/client-design.md", clientDesign],
    ["src/core/errors.js", coreErrorsSource],
    ["src/core/serverAdmin.js", serverAdminSource],
    ["client/src/clientServer.js", clientServerSource],
    ["client/src/profileImport.js", profileImportSource],
    ["client/src/store.js", storeSource],
    ["client/src/paths.js", pathsSource],
    ["client/public/app.js", clientUiSource],
    ["tests/client-http.test.js", clientHttpTest],
    ["tests/contract-http.test.js", contractHttpTest],
    ["tests/client.test.js", clientTest],
    ["tests/core.test.js", coreTest]
  ]) {
    if (!text) {
      issues.push(`${label} is missing for claim redeem recovery audit`);
    }
  }
  if (!contract || !matrix || !tKeyProtocol || !clientDesign || !coreErrorsSource || !serverAdminSource || !clientServerSource || !profileImportSource || !storeSource || !pathsSource || !clientUiSource || !clientHttpTest || !contractHttpTest || !clientTest || !coreTest) {
    return;
  }

  for (const expected of [
    "短时绑定重放",
    "pending recovery stash",
    "同一客户端绑定",
    "不同客户端",
    "`clientRedeemId`",
    "`clientInstallId`",
    "`claim-recovery.json`",
    "`claim_already_used`",
    "`claim_not_found`",
    "`claim_expired`",
    "`claim_redeem_failed`",
    "`server_state_write_failed`",
    "`validation_failed`",
    "`profile_heartbeat_required`",
    "`profile_storage_required`",
    "不得保存一次性短码",
    "导入未完成",
    "短码，只供服务端 `/api/claims/redeem` 使用",
    "`400 import_code_invalid`",
    "导入模式不变量",
    "legacy VLESS 导入不得补 `source.server`",
    "服务端在首次兑换和短时绑定重放返回 profile 前，必须重新校验",
    "不得设置 `claim.used`、`redeemedAt`、`redeemedBy` 或 `replayUntil`",
    "收到远端 HTTP 响应",
    "无 HTTP 响应时使用 502",
    "远端 HTTP 2xx 但响应不是 JSON、不是对象、返回 `ok:false`",
    "保留 pending recovery stash",
    "终态错误 `claim_not_found`、`claim_already_used`、`claim_expired` 或 `validation_failed`",
    "`claim_redeem_rate_limited`、`server_state_write_failed`、本地降级为 `claim_redeem_failed`",
    "远端成功后本地校验发现服务端签发 profile 缺少必要材料",
    "`profile_heartbeat_required`、`profile_storage_required` 或 `profile_tunnel_required`",
    "应检查服务端配置后重新生成 SyncKey",
    "无法靠重放同一个 SyncKey 恢复"
  ]) {
    requireText(contract, "docs/INTERFACE_CONTRACT.md", expected);
  }

  for (const expected of [
    "短时绑定重放",
    "pending recovery stash",
    "`clientRedeemId`",
    "`clientInstallId`",
    "`claim-recovery.json`",
    "`claim_already_used`",
    "`claim_not_found`",
    "`claim_expired`",
    "`claim_redeem_failed`",
    "`server_state_write_failed`",
    "`validation_failed`",
    "补齐 source.server",
    "heartbeat、storage credentials 或 tunnel",
    "同一客户端绑定",
    "不同客户端",
    "不得保存一次性短码",
    "导入未完成",
    "短码直传返回 `import_code_invalid`",
    "兑换前必须重新校验 claim 指向的设备和 bucket 仍未删除、未停用",
    "失效时返回 `validation_failed` 且不得消耗 SyncKey",
    "远端终态错误",
    "远端成功但签发 profile 缺少 heartbeat/storage/tunnel 材料",
    "远端 HTTP 2xx 但响应不是 JSON/profile 对象或返回 `ok:false` 也降级为 `claim_redeem_failed` 并保留 recovery",
    "收到远端 HTTP 响应时保留 status",
    "无 HTTP 响应使用 502"
  ]) {
    requireText(matrix, "docs/API_MATRIX.md", expected);
  }

  for (const expected of [
    "短时绑定重放",
    "pending recovery stash",
    "同一客户端绑定",
    "不同客户端",
    "`clientRedeemId`",
    "`clientInstallId`",
    "`claim-recovery.json`",
    "`claim_already_used`",
    "`claim_not_found`",
    "`claim_expired`",
    "`claim_redeem_failed`",
    "`server_state_write_failed`",
    "`validation_failed`",
    "不得保存一次性短码",
    "导入未完成",
    "claim: { server, codeHash }",
    "服务端兑换前必须重新校验 claim 指向的设备和 bucket 仍未删除、未停用",
    "服务端返回 `validation_failed` 且不得把 SyncKey 标记为 used",
    "回滚导入前 profile/jobs/secrets",
    "收到远端 HTTP 响应时保留 status",
    "无 HTTP 响应使用 502",
    "HTTP 2xx 但不是 JSON/profile 对象、返回 `ok:false` 的坏成功响应统一降级为 `claim_redeem_failed`",
    "坏成功响应统一使用 `claim_redeem_failed`",
    "终态结构化错误",
    "`profile_heartbeat_required`、`profile_storage_required` 或 `profile_tunnel_required`",
    "清理 pending recovery stash"
  ]) {
    requireText(tKeyProtocol, "docs/T_KEY_PROTOCOL.md", expected);
  }
  for (const expected of [
    "Remote terminal redeem errors",
    "claim_not_found",
    "claim_already_used",
    "claim_expired",
    "remote `validation_failed`",
    "missing required server-issued heartbeat, storage, or tunnel material also clears the pending recovery stash",
    "replaying the same SyncKey can only return the same unusable profile",
    "server_state_write_failed",
    "claim_redeem_failed",
    "malformed successful responses become `claim_redeem_failed`",
    "HTTP 2xx responses that are not JSON",
    "local job/scheduler/persistence failures keep recovery pending",
    "only registered redeem `errorCode` values",
    "Responses with an HTTP status preserve that status",
    "without a response use 502",
    "UI wrapper call to `/api/profile/import` uses a 60 second timeout"
  ]) {
    requireText(clientDesign, "docs/client-design.md", expected);
  }
  for (const expected of [
    "SyncKey 导入错误 UI 建议合同",
    "`retryable: false`",
    "不可重试当前 SyncKey",
    "不可重试当前内容",
    "重新复制完整 SyncKey",
    "在服务端重新生成 SyncKey",
    "`retryable: true`",
    "可重试",
    "检查服务端数据目录权限和磁盘空间",
    "检查网络、服务端地址和服务端进程",
    "用同一个 SyncKey 再试",
    "服务端签发 profile 缺材料",
    "检查服务端配置后重新生成 SyncKey"
  ]) {
    requireText(contract, "docs/INTERFACE_CONTRACT.md", expected);
  }
  for (const expected of [
    "客户端 UI 对 SyncKey 导入失败必须给出动作建议",
    "retryable: false",
    "不可重试当前 SyncKey/当前内容",
    "retryable: true",
    "用同一个 SyncKey 再试",
    "服务端签发 profile 缺材料"
  ]) {
    requireText(matrix, "docs/API_MATRIX.md", expected);
  }
  for (const expected of [
    "dedicated SyncKey error guidance",
    "retryable: false",
    "不可重试当前 SyncKey",
    "不可重试当前内容",
    "retryable: true",
    "可重试",
    "using the same SyncKey again",
    "missing required material",
    "profile_heartbeat_required`, `profile_storage_required`, and `profile_tunnel_required",
    "missing heartbeat key, storage credentials, or tunnel info",
    "check server configuration"
  ]) {
    requireText(clientDesign, "docs/client-design.md", expected);
  }
  if (/serverDigest|codeDigest/.test(tKeyProtocol)) {
    issues.push("docs/T_KEY_PROTOCOL.md must document claim-recovery.json as claim: { server, codeHash }, not serverDigest/codeDigest");
  }

  requireText(serverAdminSource, "src/core/serverAdmin.js", "const CLAIM_REPLAY_WINDOW_MS");
  requireText(serverAdminSource, "src/core/serverAdmin.js", "rememberClaimRedeemBinding(claim, input)");
  requireText(serverAdminSource, "src/core/serverAdmin.js", "function canReplayClaim(claim, input = {})");
  requireText(serverAdminSource, "src/core/serverAdmin.js", "clientRedeemId");
  requireText(serverAdminSource, "src/core/serverAdmin.js", "clientInstallIdHash");
  requireText(serverAdminSource, "src/core/serverAdmin.js", "new Error(\"claim_already_used\")");
  requireText(serverAdminSource, "src/core/serverAdmin.js", "return claim.profile;");
  requireText(serverAdminSource, "src/core/serverAdmin.js", "Date.parse(claim.replayUntil) <= Date.now()");
  requireText(serverAdminSource, "src/core/serverAdmin.js", "function assertClaimRedeemStillValid");
  requireText(serverAdminSource, "src/core/serverAdmin.js", "profileIssuedFrom");
  requireText(serverAdminSource, "src/core/serverAdmin.js", "function hashClaimProfileMaterial");
  requireText(serverAdminSource, "src/core/serverAdmin.js", "function normalizeClaimProfileExpiresAt");
  requireText(serverAdminSource, "src/core/serverAdmin.js", "function assertClaimProfileNotExpired");
  requireText(serverAdminSource, "src/core/serverAdmin.js", "SyncKey claim profile is stale; regenerate SyncKey");
  requireText(serverAdminSource, "src/core/serverAdmin.js", "SyncKey claim profile is expired; regenerate SyncKey");
  requireText(serverAdminSource, "src/core/serverAdmin.js", "SyncKey claim device is disabled");
  requireText(serverAdminSource, "src/core/serverAdmin.js", "SyncKey claim storage bucket is no longer available");
  requireText(coreTest, "tests/core.test.js", "stale SyncKeys cannot redeem after issued profile material drifts");
  requireText(coreTest, "tests/core.test.js", "SyncKey profile expiry is validated before issuing and redeeming");
  requireText(contractHttpTest, "tests/contract-http.test.js", "HTTP contract: stale SyncKeys cannot redeem after issued profile material drifts");
  requireText(contractHttpTest, "tests/contract-http.test.js", "expiredProfileRedeem");
  requireText(contract, "docs/INTERFACE_CONTRACT.md", "claim 创建时签发的 profile 下发材料仍与当前可签发材料一致");
  requireText(contract, "docs/INTERFACE_CONTRACT.md", "SyncKey claim profile is expired; regenerate SyncKey");
  requireText(matrix, "docs/API_MATRIX.md", "profile 下发材料仍与当前可签发材料一致");
  requireText(matrix, "docs/API_MATRIX.md", "拒绝已过期的 profile");
  requireText(tKeyProtocol, "docs/T_KEY_PROTOCOL.md", "SyncKey claim profile is stale; regenerate SyncKey");
  requireText(tKeyProtocol, "docs/T_KEY_PROTOCOL.md", "SyncKey claim profile is expired; regenerate SyncKey");

  requireText(clientServerSource, "client/src/clientServer.js", "const claimRecovery = await prepareClaimRecoveryForImport(body);");
  requireText(clientServerSource, "client/src/clientServer.js", "const CLAIM_RECOVERY_TERMINAL_ERRORS = new Set([");
  requireText(clientServerSource, "client/src/clientServer.js", "\"claim_not_found\"");
  requireText(clientServerSource, "client/src/clientServer.js", "\"claim_already_used\"");
  requireText(clientServerSource, "client/src/clientServer.js", "\"claim_expired\"");
  requireText(clientServerSource, "client/src/clientServer.js", "\"profile_heartbeat_required\"");
  requireText(clientServerSource, "client/src/clientServer.js", "\"profile_storage_required\"");
  requireText(clientServerSource, "client/src/clientServer.js", "\"profile_tunnel_required\"");
  requireText(clientServerSource, "client/src/clientServer.js", "\"validation_failed\"");
  requireText(clientServerSource, "client/src/clientServer.js", "function shouldClearClaimRecoveryAfterImportFailure");
  requireText(clientServerSource, "client/src/clientServer.js", "error?.claimRedeemRemoteResponse");
  requireText(clientServerSource, "client/src/clientServer.js", "return withClientStateLock(paths, async () => {");
  requireText(clientServerSource, "client/src/clientServer.js", "const stateSnapshot = await snapshotProfileImportState(paths);");
  requireText(clientServerSource, "client/src/clientServer.js", "clientRedeemId: claimRecovery?.clientRedeemId");
  requireText(clientServerSource, "client/src/clientServer.js", "clientInstallId: claimRecovery?.clientInstallId");
  requireText(clientServerSource, "client/src/clientServer.js", "await restoreProfileImportState(stateSnapshot);");
  requireText(clientServerSource, "client/src/clientServer.js", "await clearClaimRecovery(claimRecovery, paths);");
  requireText(clientServerSource, "client/src/clientServer.js", "return prepareClaimRecovery(claim, paths);");
  requireTextOrder(clientServerSource, "client/src/clientServer.js", [
    "const stateSnapshot = await snapshotProfileImportState(paths);",
    "const profile = await saveProfile(await resolveProfileImport(body, {",
    "await refreshJobsForProfile(profile);",
    "await refreshScheduler();",
    "await clearClaimRecovery(claimRecovery, paths);"
  ], "SyncKey import must keep claim-recovery.json until profile, jobs, and scheduler are persisted");
  const importSuccessRecoveryClearBlock = [
    "      await refreshJobsForProfile(profile);",
    "      await refreshScheduler();",
    "      await clearClaimRecovery(claimRecovery, paths);",
    "      await resetHeartbeatState();"
  ].join("\n");
  if (!clientServerSource.includes(importSuccessRecoveryClearBlock)) {
    issues.push("client/src/clientServer.js must clear claim recovery only after successful profile/jobs/scheduler import block");
  }

  requireText(profileImportSource, "client/src/profileImport.js", "redeemBody.clientRedeemId = String(options.clientRedeemId);");
  requireText(profileImportSource, "client/src/profileImport.js", "redeemBody.clientInstallId = String(options.clientInstallId);");
  requireText(coreErrorsSource, "src/core/errors.js", "export const CLAIM_REDEEM_ERROR_CODES = Object.freeze([");
  requireText(coreErrorsSource, "src/core/errors.js", "\"claim_not_found\"");
  requireText(coreErrorsSource, "src/core/errors.js", "\"claim_already_used\"");
  requireText(coreErrorsSource, "src/core/errors.js", "\"claim_expired\"");
  requireText(coreErrorsSource, "src/core/errors.js", "\"server_state_write_failed\"");
  requireText(coreErrorsSource, "src/core/errors.js", "\"validation_failed\"");
  requireText(coreErrorsSource, "src/core/errors.js", "export function isClaimRedeemErrorCode");
  requireText(profileImportSource, "client/src/profileImport.js", "isClaimRedeemErrorCode");
  requireText(profileImportSource, "client/src/profileImport.js", "\"claim_redeem_failed\"");
  requireText(profileImportSource, "client/src/profileImport.js", "response.status || 502");
  requireText(profileImportSource, "client/src/profileImport.js", "function createClaimRedeemProtocolError");
  requireText(profileImportSource, "client/src/profileImport.js", "payload.ok === false");
  requireText(profileImportSource, "client/src/profileImport.js", "const hasWrappedProfile = Object.hasOwn(payload, \"profile\");");
  requireText(profileImportSource, "client/src/profileImport.js", "function looksLikeBareProfile");
  requireText(profileImportSource, "client/src/profileImport.js", "SyncKey redemption response was not valid JSON");
  requireText(profileImportSource, "client/src/profileImport.js", "SyncKey redemption response did not include a profile object");
  requireText(profileImportSource, "client/src/profileImport.js", "error.claimRedeemRemoteResponse = true;");
  requireText(profileImportSource, "client/src/profileImport.js", "function validateClaimRedeemProfile");
  requireText(profileImportSource, "client/src/profileImport.js", "  } catch (error) {\n    error.claimRedeemRemoteResponse = true;\n    throw error;\n  }\n}\n\nfunction validateClaimRedeemStorage");
  requireText(profileImportSource, "client/src/profileImport.js", "\"profile_heartbeat_required\"");
  requireText(profileImportSource, "client/src/profileImport.js", "function validateClaimRedeemStorage");
  requireText(profileImportSource, "client/src/profileImport.js", "\"profile_storage_required\"");
  requireText(profileImportSource, "client/src/profileImport.js", "error.claimRedeemRemoteResponse = true;");
  requireText(clientServerSource, "client/src/clientServer.js", "const heartbeatSecret = typeof profile?.heartbeat?.secret === \"string\" ? profile.heartbeat.secret.trim() : \"\";");
  requireText(clientServerSource, "client/src/clientServer.js", "payload.auth = createHeartbeatAuth(payload, heartbeatSecret);");
  requireText(clientUiSource, "client/public/app.js", "function formatProfileImportError(error)");
  requireText(clientUiSource, "client/public/app.js", "function profileImportErrorGuidance(code)");
  requireText(clientUiSource, "client/public/app.js", "const message = formatProfileImportError(error);");
  requireText(clientUiSource, "client/public/app.js", "$(\"profileSummary\").textContent = message;");
  requireText(clientUiSource, "client/public/app.js", "setAction(message, \"bad\");");
  requireText(clientUiSource, "client/public/app.js", "return `导入失败：${item.message} ${item.action}`;");
  for (const code of [
    "claim_not_found",
    "claim_already_used",
    "claim_expired",
    "validation_failed",
    "import_code_invalid",
    "profile_heartbeat_required",
    "profile_storage_required",
    "profile_tunnel_required"
  ]) {
    requireProfileImportGuidance(clientUiSource, code, {
      retryable: false,
      required: ["retryable: false"]
    });
  }
  for (const code of [
    "server_state_write_failed",
    "claim_redeem_failed",
    "request_timeout",
    "network_error"
  ]) {
    requireProfileImportGuidance(clientUiSource, code, {
      retryable: true,
      required: ["retryable: true"]
    });
  }
  for (const expected of [
    "不可重试当前 SyncKey",
    "不可重试当前内容",
    "请从服务端重新复制完整 SyncKey，不要粘贴短码",
    "可重试",
    "用同一个 SyncKey 再试",
    "服务端数据目录权限和磁盘空间",
    "网络、服务端地址和服务端进程",
    "服务端下发配置缺少心跳密钥",
    "服务端下发配置缺少存储凭据",
    "服务端下发配置缺少隧道信息",
    "检查服务端配置后重新生成 SyncKey"
  ]) {
    requireText(clientUiSource, "client/public/app.js", expected);
  }

  requireText(pathsSource, "client/src/paths.js", "claimRecoveryFile: join(dataRoot, \"claim-recovery.json\")");
  requireText(storeSource, "client/src/store.js", "export async function prepareClaimRecovery");
  requireText(storeSource, "client/src/store.js", "export async function prepareClaimRecovery(claim, paths = getClientPaths()) {\n  return withClientStateLock(paths, async () => {");
  requireText(storeSource, "client/src/store.js", "type: \"claim-import-recovery\"");
  requireText(storeSource, "client/src/store.js", "claim: { server, codeHash }");
  requireText(storeSource, "client/src/store.js", "recovery.claim = { server, codeHash };");
  requireText(storeSource, "client/src/store.js", "clientRedeemId: randomUUID()");
  requireText(storeSource, "client/src/store.js", "clientInstallId: randomUUID()");
  requireText(storeSource, "client/src/store.js", "export async function clearClaimRecovery");
  requireText(storeSource, "client/src/store.js", "export async function clearClaimRecovery(recovery, paths = getClientPaths())");
  requireText(storeSource, "client/src/store.js", "await withFileWriteLock(file, async () => {");
  requireText(storeSource, "client/src/store.js", "export async function snapshotProfileImportState");
  requireText(storeSource, "client/src/store.js", "export async function restoreProfileImportState");
  requireText(storeSource, "client/src/store.js", "type: \"profile-import-state-snapshot\"");
  requireText(storeSource, "client/src/store.js", "current.claim?.codeHash === recovery.claim.codeHash");
  requireText(storeSource, "client/src/store.js", "function hashClaimRecoveryCode");
  if (/claim:\s*\{\s*server,\s*code\s*\}/.test(storeSource)) {
    issues.push("client/src/store.js must not save the one-time claim code in claim-recovery.json");
  }

  requireText(clientHttpTest, "tests/client-http.test.js", "client profile import reuses pending recovery binding after lost redeem response");
  requireText(clientHttpTest, "tests/client-http.test.js", "client profile import clears claim recovery after terminal claim redeem errors");
  requireText(clientHttpTest, "tests/client-http.test.js", "client profile import keeps claim recovery after retryable claim redeem errors");
  requireText(clientHttpTest, "tests/client-http.test.js", "client profile import keeps claim recovery after malformed successful claim redeem responses");
  requireText(clientHttpTest, "tests/client-http.test.js", "R200-HTML");
  requireText(clientHttpTest, "tests/client-http.test.js", "R200-OKAY");
  requireText(clientHttpTest, "tests/client-http.test.js", "R200-MSG1");
  requireText(clientHttpTest, "tests/client-http.test.js", "R200-NULL");
  requireText(contract, "docs/INTERFACE_CONTRACT.md", "`{ \"ok\": true }`、`{ \"message\": \"ok\" }`、`{ \"profile\": null }`");
  requireText(contractHttpTest, "tests/contract-http.test.js", "HTTP contract: stale SyncKeys cannot redeem after device disable");
  requireText(contractHttpTest, "tests/contract-http.test.js", "staleDisabledRedeem");
  requireText(contractHttpTest, "tests/contract-http.test.js", "SyncKey claim device is disabled");
  requireText(clientHttpTest, "tests/client-http.test.js", "claim_not_found");
  requireText(clientHttpTest, "tests/client-http.test.js", "claim_expired");
  requireText(clientHttpTest, "tests/client-http.test.js", "validation_failed");
  requireText(clientHttpTest, "tests/client-http.test.js", "server_state_write_failed");
  requireText(clientHttpTest, "tests/client-http.test.js", "remote_new_failure");
  requireText(clientHttpTest, "tests/client-http.test.js", "assert.equal(await pathExists(recoveryPath), false)");
  requireText(clientHttpTest, "tests/client-http.test.js", "const recovery = await readClaimRecovery(tempRoot)");
  requireText(clientHttpTest, "tests/client-http.test.js", "assertClaimRecoveryRetained(recovery, {");
  requireText(clientHttpTest, "tests/client-http.test.js", "client profile import rolls back profile jobs and secrets when job refresh fails");
  requireText(clientHttpTest, "tests/client-http.test.js", "client profile import rejects claim redeem profiles without storage credentials");
  requireText(clientHttpTest, "tests/client-http.test.js", "client profile import rejects claim redeem profiles without tunnel credentials");
  requireText(clientHttpTest, "tests/client-http.test.js", "profile_tunnel_required");
  requireText(clientHttpTest, "tests/client-http.test.js", "const shortCodeImport = await fetch(`${clientBaseUrl}/api/profile/import`");
  requireText(clientHttpTest, "tests/client-http.test.js", "body: JSON.stringify({ code: createdClaim.code })");
  requireText(clientHttpTest, "tests/client-http.test.js", "assertHttpErrorResponseContract(shortCodeImportPayload, \"shortCodeImport\"");
  requireText(contract, "docs/INTERFACE_CONTRACT.md", "`S3_CLIENT_ENDPOINT`");
  requireText(contract, "docs/INTERFACE_CONTRACT.md", "`http://n1-minio.sfsc:9000`");
  requireText(clientHttpTest, "tests/client-http.test.js", "const n1StorageEndpoint = \"http://n1-minio.sfsc:9000\";");
  requireText(clientHttpTest, "tests/client-http.test.js", "S3_CLIENT_ENDPOINT: n1StorageEndpoint");
  requireText(clientHttpTest, "tests/client-http.test.js", "assert.equal(createdClaim.profile.storage.endpoint, n1StorageEndpoint);");
  requireText(clientHttpTest, "tests/client-http.test.js", "assert.equal(savedJob.job.s3Endpoint, n1StorageEndpoint);");
  requireText(clientHttpTest, "tests/client-http.test.js", "assert.equal(remoteConfigArgs[remoteConfigArgs.indexOf(\"endpoint\") + 1], n1StorageEndpoint);");
  requireText(clientHttpTest, "tests/client-http.test.js", "assert.equal(await pathExists(join(tempRoot, \"data\", \"claim-recovery.json\")), false)");
  requireText(clientHttpTest, "tests/client-http.test.js", "\"claim_redeem_failed\"");
  requireText(clientHttpTest, "tests/client-http.test.js", "recovery.claim.code, undefined");
  requireText(clientHttpTest, "tests/client-http.test.js", "recovery.claim.codeHash");
  requireText(clientHttpTest, "tests/client-http.test.js", "JSON.stringify(recovery).includes(\"RCVY-0001\"), false");
  requireText(clientHttpTest, "tests/client-http.test.js", "assert.equal(await readFile(profilePath, \"utf8\"), oldProfileRaw)");
  requireText(clientHttpTest, "tests/client-http.test.js", "const concurrentSavePromise = fetch(`${baseUrl}/api/jobs/save`");
  requireText(clientHttpTest, "tests/client-http.test.js", "assert.equal(concurrentSavePayload.job.clientName, \"old-rollback-pc\")");
  requireText(clientHttpTest, "tests/client-http.test.js", "assert.deepEqual(finalJobs.find((job) => job.id === \"job-rollback\"), JSON.parse(oldJobsRaw)[0])");
  requireText(clientHttpTest, "tests/client-http.test.js", "assert.equal(finalJobs.find((job) => job.id === \"job-after-rollback\")?.clientName, \"old-rollback-pc\")");
  requireText(clientHttpTest, "tests/client-http.test.js", "JSON.stringify(recovery).includes(\"RLBK-0001\"), false");
  requireText(clientHttpTest, "tests/client-http.test.js", "redeemRequests[1].clientRedeemId, redeemRequests[0].clientRedeemId");
  requireText(clientHttpTest, "tests/client-http.test.js", "client sends signed heartbeat for server-issued offline full profile");
  requireText(clientHttpTest, "tests/client-http.test.js", "assert.equal(imported.profile.source.type, \"profile\")");
  requireText(clientHttpTest, "tests/client-http.test.js", "assert.equal(request.auth.scheme, \"sfsc-hmac-sha256-v1\")");
  requireText(clientHttpTest, "tests/client-http.test.js", "Transferred: C:\\\\Users\\\\Tong_hp\\\\Documents\\\\private.txt");
  requireText(clientHttpTest, "tests/client-http.test.js", "diagnostics.bundle.summary.heartbeatDeviceCurrentFile, \"redacted\"");
  requireText(clientHttpTest, "tests/client-http.test.js", "JSON.stringify(diagnosticPayload.bundle).includes(\"projects/current.iso\"), false");
  requireText(clientHttpTest, "tests/client-http.test.js", "JSON.stringify(diagnosticPayload.bundle).includes(tempRoot), false");
  requireText(clientHttpTest, "tests/client-http.test.js", "diagnosticPayload.bundle.logs.rclone.text.includes(\"private.txt\"), false");

  requireText(clientTest, "tests/client.test.js", "client claim recovery stores only a one-time code hash");
  requireText(clientTest, "tests/client.test.js", "const [first, concurrent] = await Promise.all([");
  requireText(clientTest, "tests/client.test.js", "assert.equal(concurrent.clientRedeemId, first.clientRedeemId)");
  requireText(clientTest, "tests/client.test.js", "client store snapshots and restores profile import state");
  requireText(clientTest, "tests/client.test.js", "client store write queues continue after a failed JSON write");
  requireText(clientTest, "tests/client.test.js", "client job secret updates use immutable vault references");
  requireText(storeSource, "client/src/store.js", "const key = `job:${stored.id || \"default\"}:${field}:${randomUUID()}`;");
  requireText(contract, "docs/INTERFACE_CONTRACT.md", "Job 密钥引用必须是不可变引用");
  requireText(clientTest, "tests/client.test.js", "client rejects claim redemption profiles without heartbeat credentials");
  requireText(clientTest, "tests/client.test.js", "client rejects claim redemption profiles without storage credentials");
  requireText(clientTest, "tests/client.test.js", "not valid JSON");
  requireText(clientTest, "tests/client.test.js", "resolver returned an error envelope with HTTP 2xx");
  requireText(clientTest, "tests/client.test.js", "profile_heartbeat_required");
  requireText(clientTest, "tests/client.test.js", "profile_storage_required");
  requireText(clientTest, "tests/client.test.js", "prepareClaimRecovery");
  requireText(clientTest, "tests/client.test.js", "stored.claim.code, undefined");
  requireText(clientTest, "tests/client.test.js", "stored.claim.codeHash");
  requireText(clientTest, "tests/client.test.js", "JSON.stringify(stored).includes(claim.code), false");
  requireText(clientTest, "tests/client.test.js", "legacy-redeem");
  requireText(clientTest, "tests/client.test.js", "bundle.summary.heartbeatDeviceCurrentFile, \"redacted\"");
  requireText(clientTest, "tests/client.test.js", "text.includes(\"projects/fallback.iso\"), false");
  requireText(clientTest, "tests/client.test.js", "text.includes(\"job:missing-secret\"), false");

  requireText(coreTest, "tests/core.test.js", "server allows short claim replay only for the same redeem binding");
  requireText(coreTest, "tests/core.test.js", "stale SyncKeys cannot redeem after their storage bucket changes state");
  requireText(coreTest, "tests/core.test.js", "storage bucket is no longer available");
  requireText(coreTest, "tests/core.test.js", "clientRedeemId: \"redeem-attempt-1\"");
  requireText(coreTest, "tests/core.test.js", "clientInstallId: \"install-device-1\"");
  requireText(coreTest, "tests/core.test.js", "/claim_already_used/");
}

async function auditInterfaceRouteContract() {
  const contract = await readFile(join(root, "docs", "INTERFACE_CONTRACT.md"), "utf8").catch(() => "");
  if (!contract) {
    issues.push("docs/INTERFACE_CONTRACT.md is missing");
    return;
  }

  const routeSources = await readRouteSources("interface contract audit");
  if (!routeSources) {
    return;
  }

  requireText(contract, "docs/INTERFACE_CONTRACT.md", "当前机器可读入口（32 个）位于 `src/core/protocolSchemas.js`");
  requireText(contract, "docs/INTERFACE_CONTRACT.md", "服务端 `/api/admin/tunnel/generate`、`/api/admin/tunnel/autofill`、`/api/admin/singbox/write`、`/api/admin/singbox/apply`、`/api/admin/singbox/mark-applied`");
  requireText(contract, "docs/INTERFACE_CONTRACT.md", "`/api/admin/storage/save`、`/api/admin/storage/buckets/refresh`、`/api/admin/storage/buckets/create`、`/api/admin/storage/buckets/enable`、`/api/admin/storage/buckets/disable`、`/api/admin/storage/buckets/clear`、`/api/admin/storage/buckets/delete-empty`");
  requireText(contract, "docs/INTERFACE_CONTRACT.md", "`/api/admin/users/create`、`/api/admin/users/enable`、`/api/admin/users/disable`、`/api/admin/users/delete`");
  requireText(contract, "docs/INTERFACE_CONTRACT.md", "`/api/claims/create`、`/api/claims/redeem`、`/api/devices/heartbeat`、`/api/profile/encode`、`/api/vless/parse`、`/api/singbox/client-config`、`/api/jobs/preview`");
  requireText(contract, "docs/INTERFACE_CONTRACT.md", "必须同时更新 `src/core/protocolSchemas.js`、本文档和 `tests/core.test.js` 的 schema 回归");

  for (const route of [
    ...extractImplementedRoutes(routeSources["src/server.js"]),
    ...extractImplementedRoutes(routeSources["client/src/clientServer.js"])
  ]) {
    if (!routeMentionPattern(route).test(contract)) {
      issues.push(`docs/INTERFACE_CONTRACT.md must document API route ${route.method} ${route.path}`);
    }
  }
}

async function auditApiMatrixContract() {
  const matrix = await readFile(join(root, "docs", "API_MATRIX.md"), "utf8").catch(() => "");
  const serverConsoleHtml = await readFile(join(root, "public", "index.html"), "utf8").catch(() => "");
  if (!matrix) {
    issues.push("docs/API_MATRIX.md is missing");
    return;
  }

  requireText(
    matrix,
    "docs/API_MATRIX.md",
    "| POST | `/api/admin/users/create` | 管理 token | 调试/运维入口 | 低层创建或登记设备；服务端控制台生成设备应使用 `/api/claims/create` |"
  );
  requireText(
    matrix,
    "docs/API_MATRIX.md",
    "| GET | `/api/admin/singbox/config` | 管理 token | 服务端控制台、smoke、运维只读入口 | 预览脱敏 sing-box 配置 |"
  );
  requireText(matrix, "docs/API_MATRIX.md", "消费者分类采用固定词汇");
  requireText(matrix, "docs/API_MATRIX.md", "`smoke` 表示验收脚本会直接调用");
  requireText(matrix, "docs/API_MATRIX.md", "smoke 脚本新增直接调用时，对应 API 行的“当前消费者”必须包含 `smoke`");
  requireText(
    matrix,
    "docs/API_MATRIX.md",
    "修改 `/api/admin/tunnel/generate`、`/api/admin/tunnel/autofill`、`/api/admin/singbox/write`、`/api/admin/singbox/apply`、`/api/admin/singbox/mark-applied`、`/api/admin/storage/save`、`/api/admin/storage/buckets/refresh`、`/api/admin/storage/buckets/create`、`/api/admin/storage/buckets/enable`、`/api/admin/storage/buckets/disable`、`/api/admin/storage/buckets/clear`、`/api/admin/storage/buckets/delete-empty`、`/api/admin/users/create`、`/api/admin/users/enable`、`/api/admin/users/disable`、`/api/admin/users/delete`、`/api/claims/create`、`/api/claims/redeem`、`/api/devices/heartbeat`、`/api/binaries/check`、`/api/client/shutdown`、`/api/profile/import`、`/api/jobs/save`、`/api/singbox/start`、`/api/singbox/stop`、`/api/sync/preview`、`/api/sync/run`、`/api/sync/stop`、`/api/profile/encode`、`/api/vless/parse`、`/api/singbox/client-config` 或 `/api/jobs/preview` 的请求字段时，必须同步更新 `src/core/protocolSchemas.js` 和 `tests/core.test.js` 的 schema 回归。"
  );
  if (/\| POST \| `\/api\/admin\/users\/create` \| 管理 token \| 服务端控制台 \|/.test(matrix)) {
    issues.push("docs/API_MATRIX.md must not classify POST /api/admin/users/create as a server console consumer");
  }

  const sources = await readRouteSources("API matrix audit");
  if (!sources) {
    return;
  }
  requireText(serverConsoleHtml, "public/index.html", 'id="refreshSingboxConfigBtn"');
  requireText(
    sources["public/app.js"],
    "public/app.js",
    'byId("refreshSingboxConfigBtn").addEventListener("click", refreshSingboxConfigPreview)'
  );
  requireText(sources["public/app.js"], "public/app.js", 'function refreshSingboxConfigPreview');
  requireText(sources["public/app.js"], "public/app.js", 'api("/api/admin/singbox/config")');
  requireText(sources["public/app.js"], "public/app.js", "async function readSingboxConfigPreview");
  requireText(sources["public/app.js"], "public/app.js", "async function renderLatestSingboxConfigPreview");
  requireText(sources["public/app.js"], "public/app.js", "function renderSingboxConfigPreview");
  requireText(sources["public/app.js"], "public/app.js", "function renderTunnelJson");
  requireText(sources["public/app.js"], "public/app.js", "await renderLatestSingboxConfigPreview(result.config);");
  requireText(sources["public/app.js"], "public/app.js", "await renderLatestSingboxConfigPreview();");
  requireText(sources["public/app.js"], "public/app.js", "操作已完成，但配置预览刷新失败");

  const smokeSources = {
    "scripts/smoke-server.mjs": await readFile(join(root, "scripts", "smoke-server.mjs"), "utf8").catch(() => ""),
    "scripts/smoke-client.mjs": await readFile(join(root, "scripts", "smoke-client.mjs"), "utf8").catch(() => "")
  };
  for (const [label, text] of Object.entries(smokeSources)) {
    if (!text) {
      issues.push(`${label} is missing for API matrix smoke consumer audit`);
    }
  }

  for (const route of [
    ...extractImplementedRoutes(sources["src/server.js"]),
    ...extractImplementedRoutes(sources["client/src/clientServer.js"])
  ]) {
    if (!routeRowPattern(route).test(matrix)) {
      issues.push(`docs/API_MATRIX.md must document API route ${route.method} ${route.path}`);
    }
  }

  const consumedSources = [
    sources["public/app.js"],
    sources["client/public/app.js"],
    sources["client/src/profileImport.js"]
  ].join("\n");
  for (const path of extractApiPaths(consumedSources)) {
    if (!pathPattern(path).test(matrix)) {
      issues.push(`docs/API_MATRIX.md must document consumed API path ${path}`);
    }
  }

  const outboundClientSources = [
    sources["client/src/clientServer.js"],
    sources["client/src/profileImport.js"]
  ].join("\n");
  for (const path of extractOutboundApiPaths(outboundClientSources)) {
    if (!crossRuntimePathPattern(path).test(matrix)) {
      issues.push(`docs/API_MATRIX.md cross-runtime table must document client outbound API path ${path}`);
    }
  }

  for (const path of extractSmokeApiPaths(smokeSources)) {
    if (!matrixConsumerIncludes(matrix, path, "smoke")) {
      issues.push(`docs/API_MATRIX.md row for smoke API path ${path} must include smoke in 当前消费者`);
    }
  }
}

async function auditProtocolRequestSchemaCoverage() {
  const [serverSource, clientServerSource, schemasSource, contract, coreTest] = await Promise.all([
    readFile(join(root, "src", "server.js"), "utf8").catch(() => ""),
    readFile(join(root, "client", "src", "clientServer.js"), "utf8").catch(() => ""),
    readFile(join(root, "src", "core", "protocolSchemas.js"), "utf8").catch(() => ""),
    readFile(join(root, "docs", "INTERFACE_CONTRACT.md"), "utf8").catch(() => ""),
    readFile(join(root, "tests", "core.test.js"), "utf8").catch(() => "")
  ]);
  if (!serverSource || !clientServerSource || !schemasSource || !contract || !coreTest) {
    issues.push("protocol request schema coverage audit requires src/server.js, client/src/clientServer.js, src/core/protocolSchemas.js, docs/INTERFACE_CONTRACT.md, and tests/core.test.js");
    return;
  }

  const expectedSchemas = [
    ["CLIENT_BINARIES_CHECK", "client.binariesCheck"],
    ["CLIENT_PROFILE_IMPORT", "client.profileImport"],
    ["CLIENT_JOB_SAVE", "client.jobSave"],
    ["CLIENT_SHUTDOWN", "client.shutdown"],
    ["CLIENT_SINGBOX_START", "client.singboxStart"],
    ["CLIENT_SINGBOX_STOP", "client.singboxStop"],
    ["CLIENT_SYNC_PREVIEW", "client.syncPreview"],
    ["CLIENT_SYNC_RUN", "client.syncRun"],
    ["CLIENT_SYNC_STOP", "client.syncStop"],
    ["SERVER_ADMIN_TUNNEL_GENERATE", "server.admin.tunnelGenerate"],
    ["SERVER_ADMIN_TUNNEL_AUTOFILL", "server.admin.tunnelAutofill"],
    ["SERVER_ADMIN_SINGBOX_WRITE", "server.admin.singboxWrite"],
    ["SERVER_ADMIN_SINGBOX_APPLY", "server.admin.singboxApply"],
    ["SERVER_ADMIN_SINGBOX_MARK_APPLIED", "server.admin.singboxMarkApplied"],
    ["SERVER_ADMIN_STORAGE_SAVE", "server.admin.storageSave"],
    ["SERVER_ADMIN_STORAGE_BUCKET_REFRESH", "server.admin.storageBucketRefresh"],
    ["SERVER_ADMIN_STORAGE_BUCKET_CREATE", "server.admin.storageBucketCreate"],
    ["SERVER_ADMIN_STORAGE_BUCKET_ENABLE", "server.admin.storageBucketEnable"],
    ["SERVER_ADMIN_STORAGE_BUCKET_DISABLE", "server.admin.storageBucketDisable"],
    ["SERVER_ADMIN_STORAGE_BUCKET_CLEAR", "server.admin.storageBucketClear"],
    ["SERVER_ADMIN_STORAGE_BUCKET_DELETE_EMPTY", "server.admin.storageBucketDeleteEmpty"],
    ["SERVER_ADMIN_USER_CREATE", "server.admin.userCreate"],
    ["SERVER_ADMIN_USER_ENABLE", "server.admin.userEnable"],
    ["SERVER_ADMIN_USER_DISABLE", "server.admin.userDisable"],
    ["SERVER_ADMIN_USER_DELETE", "server.admin.userDelete"],
    ["SERVER_CLAIM_CREATE", "server.claimCreate"],
    ["SERVER_CLAIM_REDEEM", "server.claimRedeem"],
    ["SERVER_DEVICE_HEARTBEAT", "server.deviceHeartbeat"],
    ["SERVER_PROFILE_ENCODE", "server.profileEncode"],
    ["SERVER_VLESS_PARSE", "server.vlessParse"],
    ["SERVER_SINGBOX_CLIENT_CONFIG", "server.singboxClientConfig"],
    ["SERVER_JOBS_PREVIEW", "server.jobsPreview"]
  ];
  for (const [name, value] of expectedSchemas) {
    requireText(schemasSource, "src/core/protocolSchemas.js", `${name}: "${value}"`);
    requireText(schemasSource, "src/core/protocolSchemas.js", `case PROTOCOL_REQUESTS.${name}:`);
  }
  requireText(schemasSource, "src/core/protocolSchemas.js", "function parseServerJobsPreviewOptions(body)");
  requireText(schemasSource, "src/core/protocolSchemas.js", "function parseServerJobsPreviewJob(body)");
  requireText(schemasSource, "src/core/protocolSchemas.js", "function parseServerSingboxClientConfigOptions(body)");
  requireText(schemasSource, "src/core/protocolSchemas.js", "SERVER_SINGBOX_CLIENT_CONFIG_OPTIONS_JSON_FIELDS");
  requireText(schemasSource, "src/core/protocolSchemas.js", "SERVER_JOBS_PREVIEW_JOB_STRING_FIELDS");
  requireText(schemasSource, "src/core/protocolSchemas.js", "copyOptionalStringFields(input, output, SERVER_JOBS_PREVIEW_JOB_STRING_FIELDS)");
  requireText(schemasSource, "src/core/protocolSchemas.js", "copyOptionalJsonFields(input, output, SERVER_JOBS_PREVIEW_JOB_JSON_FIELDS)");
  requireText(contract, "docs/INTERFACE_CONTRACT.md", "请求 schema 只允许 `uri` 和 `options.localProxyPort`");
  requireText(contract, "docs/INTERFACE_CONTRACT.md", "请求不得覆盖客户端本地监听地址、日志级别、TUN、系统代理或系统路由行为");
  requireText(contract, "docs/INTERFACE_CONTRACT.md", "服务端 preview 请求 schema 必须对 `options` 和 `job` 做字段级白名单归一化");
  requireText(contract, "docs/INTERFACE_CONTRACT.md", "未知字段必须丢弃");
  requireText(contract, "docs/INTERFACE_CONTRACT.md", "请求 schema 是空 JSON 信封");
  requireText(contract, "docs/INTERFACE_CONTRACT.md", "非对象、数组或带任意字段的对象必须返回 `400 validation_failed`");
  requireText(contract, "docs/INTERFACE_CONTRACT.md", "`options` 只允许 `localProxyPort`、`rcloneBin` 和 `rcloneConfigPath`");
  requireText(coreTest, "tests/core.test.js", "rcloneBin: \" rclone-custom \"");
  requireText(coreTest, "tests/core.test.js", "localProxyHost: \"0.0.0.0\"");
  requireText(coreTest, "tests/core.test.js", "ignored: \"drop-me\"");

  for (const [label, source, expected] of [
    ["client/src/clientServer.js", clientServerSource, [
      ["POST", "/api/binaries/check", "CLIENT_BINARIES_CHECK"],
      ["POST", "/api/client/shutdown", "CLIENT_SHUTDOWN"],
      ["POST", "/api/profile/import", "CLIENT_PROFILE_IMPORT"],
      ["POST", "/api/jobs/save", "CLIENT_JOB_SAVE"],
      ["POST", "/api/singbox/start", "CLIENT_SINGBOX_START"],
      ["POST", "/api/singbox/stop", "CLIENT_SINGBOX_STOP"],
      ["POST", "/api/sync/preview", "CLIENT_SYNC_PREVIEW"],
      ["POST", "/api/sync/run", "CLIENT_SYNC_RUN"],
      ["POST", "/api/sync/stop", "CLIENT_SYNC_STOP"]
    ]],
    ["src/server.js", serverSource, [
      ["POST", "/api/admin/tunnel/generate", "SERVER_ADMIN_TUNNEL_GENERATE"],
      ["POST", "/api/admin/tunnel/autofill", "SERVER_ADMIN_TUNNEL_AUTOFILL"],
      ["POST", "/api/admin/storage/save", "SERVER_ADMIN_STORAGE_SAVE"],
      ["POST", "/api/admin/storage/buckets/refresh", "SERVER_ADMIN_STORAGE_BUCKET_REFRESH"],
      ["POST", "/api/admin/storage/buckets/create", "SERVER_ADMIN_STORAGE_BUCKET_CREATE"],
      ["POST", "/api/admin/storage/buckets/enable", "SERVER_ADMIN_STORAGE_BUCKET_ENABLE"],
      ["POST", "/api/admin/storage/buckets/disable", "SERVER_ADMIN_STORAGE_BUCKET_DISABLE"],
      ["POST", "/api/admin/storage/buckets/clear", "SERVER_ADMIN_STORAGE_BUCKET_CLEAR"],
      ["POST", "/api/admin/storage/buckets/delete-empty", "SERVER_ADMIN_STORAGE_BUCKET_DELETE_EMPTY"],
      ["POST", "/api/admin/users/create", "SERVER_ADMIN_USER_CREATE"],
      ["POST", "/api/admin/users/enable", "SERVER_ADMIN_USER_ENABLE"],
      ["POST", "/api/admin/users/disable", "SERVER_ADMIN_USER_DISABLE"],
      ["POST", "/api/admin/users/delete", "SERVER_ADMIN_USER_DELETE"],
      ["POST", "/api/admin/singbox/write", "SERVER_ADMIN_SINGBOX_WRITE"],
      ["POST", "/api/admin/singbox/apply", "SERVER_ADMIN_SINGBOX_APPLY"],
      ["POST", "/api/admin/singbox/mark-applied", "SERVER_ADMIN_SINGBOX_MARK_APPLIED"],
      ["POST", "/api/claims/create", "SERVER_CLAIM_CREATE"],
      ["POST", "/api/claims/redeem", "SERVER_CLAIM_REDEEM"],
      ["POST", "/api/devices/heartbeat", "SERVER_DEVICE_HEARTBEAT"],
      ["POST", "/api/profile/encode", "SERVER_PROFILE_ENCODE"],
      ["POST", "/api/vless/parse", "SERVER_VLESS_PARSE"],
      ["POST", "/api/singbox/client-config", "SERVER_SINGBOX_CLIENT_CONFIG"],
      ["POST", "/api/jobs/preview", "SERVER_JOBS_PREVIEW"]
    ]]
  ]) {
    for (const [method, path, schema] of expected) {
      requireText(source, label, `if (req.method === "${method}" && url.pathname === "${path}") {`);
      requireText(source, label, `parseProtocolRequest(PROTOCOL_REQUESTS.${schema}, await readJson(req))`);
    }
  }

  const allowedBareReadJsonRoutes = new Set([]);
  const usages = [
    ...extractBareReadJsonUsages(clientServerSource, "client/src/clientServer.js"),
    ...extractBareReadJsonUsages(serverSource, "src/server.js")
  ];
  for (const usage of usages) {
    const key = `${usage.label} ${usage.method} ${usage.path}`;
    if (!allowedBareReadJsonRoutes.has(key)) {
      issues.push(`${usage.label}:${usage.line} has unclassified bare readJson(req) at ${usage.method} ${usage.path}; use parseProtocolRequest(PROTOCOL_REQUESTS.*) or add an explicit protocol schema debt allowlist entry`);
    }
  }
  for (const expected of allowedBareReadJsonRoutes) {
    if (!usages.some((usage) => `${usage.label} ${usage.method} ${usage.path}` === expected)) {
      issues.push(`protocol schema debt allowlist entry is stale or missing from code: ${expected}`);
    }
  }
}

async function auditServerWriteInterfaceMap() {
  const [matrix, contract, runtimeContracts, helperContracts, contractHttpTest] = await Promise.all([
    readFile(join(root, "docs", "API_MATRIX.md"), "utf8").catch(() => ""),
    readFile(join(root, "docs", "INTERFACE_CONTRACT.md"), "utf8").catch(() => ""),
    readFile(join(root, "scripts", "lib", "runtimeContracts.mjs"), "utf8").catch(() => ""),
    readFile(join(root, "tests", "helpers", "contracts.js"), "utf8").catch(() => ""),
    readFile(join(root, "tests", "contract-http.test.js"), "utf8").catch(() => "")
  ]);

  for (const [label, text] of [
    ["docs/API_MATRIX.md", matrix],
    ["docs/INTERFACE_CONTRACT.md", contract],
    ["scripts/lib/runtimeContracts.mjs", runtimeContracts],
    ["tests/helpers/contracts.js", helperContracts],
    ["tests/contract-http.test.js", contractHttpTest]
  ]) {
    if (!text) {
      issues.push(`${label} is missing for server write interface map audit`);
    }
  }
  if (!matrix || !contract || !runtimeContracts || !helperContracts || !contractHttpTest) {
    return;
  }

  const entries = [
    {
      method: "POST",
      path: "/api/admin/tunnel/generate",
      contractPhrase: "admin tunnel generate response contract",
      helper: "assertAdminTunnelGenerateResponseContract",
      contractHttpAssertion: 'assertAdminTunnelGenerateResponseContract(generated, "generated")'
    },
    {
      method: "POST",
      path: "/api/admin/tunnel/autofill",
      contractPhrase: "admin tunnel autofill response contract",
      helper: "assertAdminTunnelAutofillResponseContract",
      contractHttpAssertion: 'assertAdminTunnelAutofillResponseContract(autofill, "autofill")'
    },
    {
      method: "POST",
      path: "/api/admin/storage/save",
      contractPhrase: "admin storage save response contract",
      helper: "assertAdminStorageSaveResponseContract",
      contractHttpAssertion: 'assertAdminStorageSaveResponseContract(storageSave, "storageSave"'
    },
    {
      method: "POST",
      path: "/api/admin/storage/buckets/refresh",
      contractPhrase: "admin storage buckets refresh response contract",
      helper: "assertAdminStorageBucketsRefreshResponseContract",
      contractHttpAssertion: 'assertAdminStorageBucketsRefreshResponseContract(refreshedBuckets, "refreshedBuckets")'
    },
    {
      method: "POST",
      path: "/api/admin/storage/buckets/create",
      contractPhrase: "admin storage bucket create response contract",
      helper: "assertAdminStorageBucketCreateResponseContract",
      contractHttpAssertion: 'assertAdminStorageBucketCreateResponseContract(archiveBucket, "archiveBucket")'
    },
    {
      method: "POST",
      path: "/api/admin/storage/buckets/enable",
      contractPhrase: "admin storage bucket toggle response contract",
      helper: "assertAdminStorageBucketToggleResponseContract",
      contractHttpAssertion: 'assertAdminStorageBucketToggleResponseContract(enabledArchiveBucket, "enabledArchiveBucket")'
    },
    {
      method: "POST",
      path: "/api/admin/storage/buckets/disable",
      contractPhrase: "admin storage bucket toggle response contract",
      helper: "assertAdminStorageBucketToggleResponseContract",
      contractHttpAssertion: 'assertAdminStorageBucketToggleResponseContract(disabledArchiveBucket, "disabledArchiveBucket")'
    },
    {
      method: "POST",
      path: "/api/admin/storage/buckets/clear",
      contractPhrase: "admin storage bucket clear response contract",
      helper: "assertAdminStorageBucketClearResponseContract",
      contractHttpAssertion: 'assertAdminStorageBucketClearResponseContract(clearedBucket, "nonEmptyBucket.clearedBucket")'
    },
    {
      method: "POST",
      path: "/api/admin/storage/buckets/delete-empty",
      contractPhrase: "admin storage bucket delete-empty response contract",
      helper: "assertAdminStorageBucketDeleteEmptyResponseContract",
      contractHttpAssertion: 'assertAdminStorageBucketDeleteEmptyResponseContract(deletedEmptyBucket, "nonEmptyBucket.deletedEmptyBucket")'
    },
    {
      method: "POST",
      path: "/api/admin/users/create",
      contractPhrase: "admin user write response contract",
      helper: "assertAdminUserWriteResponseContract",
      contractHttpAssertion: 'assertAdminUserWriteResponseContract(userCreate, "userCreate"'
    },
    {
      method: "POST",
      path: "/api/admin/users/enable",
      contractPhrase: "admin user write response contract",
      helper: "assertAdminUserWriteResponseContract",
      contractHttpAssertion: 'assertAdminUserWriteResponseContract(enabledAgain, "enabledAgain")'
    },
    {
      method: "POST",
      path: "/api/admin/users/disable",
      contractPhrase: "admin user write response contract",
      helper: "assertAdminUserWriteResponseContract",
      contractHttpAssertion: 'assertAdminUserWriteResponseContract(disabledUser, "disabledUser")'
    },
    {
      method: "POST",
      path: "/api/admin/users/delete",
      contractPhrase: "admin user delete response contract",
      helper: "assertAdminUserDeleteResponseContract",
      contractHttpAssertion: 'assertAdminUserDeleteResponseContract(deletedUser, "deletedUser")'
    },
    {
      method: "POST",
      path: "/api/admin/singbox/write",
      contractPhrase: "admin sing-box write response contract",
      helper: "assertAdminSingboxWriteResponseContract",
      contractHttpAssertion: 'assertAdminSingboxWriteResponseContract(directWritten, "directWritten")'
    },
    {
      method: "POST",
      path: "/api/admin/singbox/apply",
      contractPhrase: "admin sing-box apply response contract",
      helper: "assertAdminSingboxApplyResponseContract",
      helperContractsRequired: false,
      contractHttpAssertion: 'assertAdminSingboxApplyResponseContract(directApplied, "directApplied")'
    },
    {
      method: "POST",
      path: "/api/admin/singbox/mark-applied",
      contractPhrase: "admin sing-box mark-applied response contract",
      helper: "assertAdminSingboxMarkAppliedResponseContract",
      contractHttpAssertion: 'assertAdminSingboxMarkAppliedResponseContract(directMarkedApplied, "directMarkedApplied")'
    },
    {
      method: "POST",
      path: "/api/claims/create",
      contractPhrase: "claim create response contract",
      helper: "assertClaimCreateResponseContract",
      contractHttpAssertion: 'assertClaimCreateResponseContract(created, "created"'
    },
    {
      method: "POST",
      path: "/api/claims/redeem",
      contractPhrase: "claim redeem response contract",
      helper: "assertClaimRedeemResponseContract",
      contractHttpAssertion: 'assertClaimRedeemResponseContract(rawRedeemed, "rawRedeemed"'
    },
    {
      method: "POST",
      path: "/api/devices/heartbeat",
      contractPhrase: "server heartbeat response contract",
      helper: "assertServerHeartbeatResponseContract",
      contractHttpAssertion: 'assertServerHeartbeatResponseContract(heartbeat, "heartbeat")'
    }
  ];

  for (const entry of entries) {
    const route = `${entry.method} ${entry.path}`;
    if (!routeRowPattern(entry).test(matrix)) {
      issues.push(`server write interface map missing API matrix row for ${route}`);
    }
    if (!contract.includes(entry.contractPhrase)) {
      issues.push(`server write interface map missing INTERFACE_CONTRACT phrase for ${route}: ${entry.contractPhrase}`);
    }
    if (!runtimeContracts.includes(`export function ${entry.helper}`)) {
      issues.push(`server write interface map missing runtime contract helper for ${route}: ${entry.helper}`);
    }
    if (entry.helperContractsRequired !== false && !helperContracts.includes(entry.helper)) {
      issues.push(`server write interface map missing tests helper export for ${route}: ${entry.helper}`);
    }
    if (!contractHttpTest.includes(entry.contractHttpAssertion)) {
      issues.push(`server write interface map missing contract-http assertion for ${route}: ${entry.contractHttpAssertion}`);
    }
  }

  requireText(
    contractHttpTest,
    "tests/contract-http.test.js",
    'import { assertAdminSingboxApplyResponseContract } from "../scripts/lib/runtimeContracts.mjs";'
  );

  requireText(matrix, "docs/API_MATRIX.md", "显式 `server` 会更新 `settings.publicServerUrl`");
  requireText(matrix, "docs/API_MATRIX.md", "持久化失败必须回滚");
  requireText(matrix, "docs/API_MATRIX.md", "污染 SyncKey 服务地址");
  requireText(contract, "docs/INTERFACE_CONTRACT.md", "回滚请求体 `server` 对 `settings.publicServerUrl` 的临时更新");
  requireText(contractHttpTest, "tests/contract-http.test.js", "const failedServerUrl = \"https://should-not-stick.example\";");
  requireText(contractHttpTest, "tests/contract-http.test.js", "assert.equal(afterFailure.settings.publicServerUrl, before.settings.publicServerUrl);");
  requireText(contractHttpTest, "tests/contract-http.test.js", "assert.notEqual(afterFailure.settings.publicServerUrl, failedServerUrl);");
  requireText(contractHttpTest, "tests/contract-http.test.js", "assert.equal(afterFailure.tunnel.lastConfigWrittenAt, before.tunnel.lastConfigWrittenAt);");
  requireText(contract, "docs/INTERFACE_CONTRACT.md", "未持久化的“配置已写入”状态");
  requireText(contract, "docs/INTERFACE_CONTRACT.md", "若请求前不存在 sing-box config 文件，必须删除本次未提交的新 config");
  requireText(contractHttpTest, "tests/contract-http.test.js", "failed sing-box write persistence deletes uncommitted config");
  requireText(contractHttpTest, "tests/contract-http.test.js", "assert.equal(afterFailure.tunnel.restartRequired, before.tunnel.restartRequired);");
  requireText(contractHttpTest, "tests/contract-http.test.js", "assert.equal(afterFailure.tunnel.lastConfigWrittenAt, before.tunnel.lastConfigWrittenAt);");
  requireText(contractHttpTest, "tests/contract-http.test.js", "await assert.rejects(readFile(configPath, \"utf8\"), (error) => error.code === \"ENOENT\");");
  requireText(contract, "docs/INTERFACE_CONTRACT.md", "未持久化的“自动补全 tunnel”状态");
  requireText(contract, "docs/INTERFACE_CONTRACT.md", "回滚本次对 tunnel 协议、host/port、REALITY 摘要");
  requireText(contractHttpTest, "tests/contract-http.test.js", "failed tunnel autofill persistence rolls back tunnel state");
  requireText(contractHttpTest, "tests/contract-http.test.js", "assert.deepEqual(afterFailure.tunnel, before.tunnel);");
  requireText(contractHttpTest, "tests/contract-http.test.js", "assert.equal(afterFailure.tunnel.publicHost, before.tunnel.publicHost);");
  requireText(contract, "docs/INTERFACE_CONTRACT.md", "回滚本次请求对 `tunnel.restartRequired` 和 `tunnel.lastAppliedAt` 的内存修改");
  requireText(contract, "docs/INTERFACE_CONTRACT.md", "未持久化的“已应用”状态");
  requireText(contractHttpTest, "tests/contract-http.test.js", "failed mark-applied persistence keeps sing-box pending");
  requireText(contractHttpTest, "tests/contract-http.test.js", "assert.equal(afterFailure.tunnel.restartRequired, before.tunnel.restartRequired);");
  requireText(contractHttpTest, "tests/contract-http.test.js", "assert.equal(afterFailure.tunnel.lastAppliedAt, before.tunnel.lastAppliedAt);");
  requireText(contract, "docs/INTERFACE_CONTRACT.md", "未持久化的“幽灵运维用户”");
  requireText(contract, "docs/INTERFACE_CONTRACT.md", "回滚本次新增的 user/device");
  requireText(contractHttpTest, "tests/contract-http.test.js", "failed admin user creation persistence does not publish a phantom user");
  requireText(contractHttpTest, "tests/contract-http.test.js", "assert.equal(afterFailure.users.some((user) => user.clientName === \"phantom-admin-pc\"), false);");
  requireText(contractHttpTest, "tests/contract-http.test.js", "assert.equal(afterFailure.devices.some((device) => device.clientName === \"phantom-admin-pc\"), false);");
  requireText(contractHttpTest, "tests/contract-http.test.js", "assert.equal(afterConfig, beforeConfig);");
  requireText(contract, "docs/INTERFACE_CONTRACT.md", "未持久化的“假停用”设备状态");
  requireText(contract, "docs/INTERFACE_CONTRACT.md", "回滚本次对 `user.enabled`");
  requireText(contractHttpTest, "tests/contract-http.test.js", "failed admin user disable persistence keeps user enabled");
  requireText(contractHttpTest, "tests/contract-http.test.js", "assert.equal(afterUser.enabled, true);");
  requireText(contractHttpTest, "tests/contract-http.test.js", "assert.equal(afterDevice.enabled, true);");
  requireText(contractHttpTest, "tests/contract-http.test.js", "assert.deepEqual(readSingboxUserNames(afterConfig), [\"disable-rollback-pc\"]);");
  requireText(contract, "docs/INTERFACE_CONTRACT.md", "未持久化的“假启用”设备状态");
  requireText(contractHttpTest, "tests/contract-http.test.js", "failed admin user enable persistence keeps user disabled");
  requireText(contractHttpTest, "tests/contract-http.test.js", "assert.equal(afterUser.enabled, false);");
  requireText(contractHttpTest, "tests/contract-http.test.js", "assert.equal(afterDevice.enabled, false);");
  requireText(contractHttpTest, "tests/contract-http.test.js", "assert.deepEqual(readSingboxUserNames(afterConfig), []);");
  requireText(contract, "docs/INTERFACE_CONTRACT.md", "未持久化的“假删除”设备状态");
  requireText(contract, "docs/INTERFACE_CONTRACT.md", "回滚本次对 `user.enabled`、`user.deletedAt`");
  requireText(contractHttpTest, "tests/contract-http.test.js", "failed admin user delete persistence keeps user present");
  requireText(contractHttpTest, "tests/contract-http.test.js", "assert.equal(afterFailure.devices.some((device) => device.clientName === \"delete-rollback-pc\"), true);");
  requireText(contractHttpTest, "tests/contract-http.test.js", "assert.deepEqual(readSingboxUserNames(afterConfig), [\"delete-rollback-pc\"]);");
  requireText(contract, "docs/INTERFACE_CONTRACT.md", "未持久化的“假刷新 bucket 列表”状态");
  requireText(contract, "docs/INTERFACE_CONTRACT.md", "回滚本次对 `storage.buckets[]`、默认 bucket 兜底");
  requireText(contractHttpTest, "tests/contract-http.test.js", "failed storage bucket refresh persistence keeps previous bucket list");
  requireText(contractHttpTest, "tests/contract-http.test.js", "assert.equal(afterFailure.storage.buckets.some((bucket) => bucket.name === \"refresh-rollback\"), false);");
  requireText(contractHttpTest, "tests/contract-http.test.js", "assertAdminStorageBucketsRefreshResponseContract(refreshed, \"bucketRefreshRollback.refreshed\")");
  requireText(contract, "docs/INTERFACE_CONTRACT.md", "未持久化的“幽灵 bucket”状态");
  requireText(contract, "docs/INTERFACE_CONTRACT.md", "回滚本次新增的 `storage.buckets[]` 条目");
  requireText(contractHttpTest, "tests/contract-http.test.js", "failed storage bucket creation persistence does not publish a phantom bucket");
  requireText(contractHttpTest, "tests/contract-http.test.js", "assert.equal(afterFailure.storage.buckets.some((bucket) => bucket.name === \"phantom-bucket\"), false);");
  requireText(contractHttpTest, "tests/contract-http.test.js", "assertAdminStorageBucketCreateResponseContract(created, \"bucketCreateRollback.created\")");
  requireText(contract, "docs/INTERFACE_CONTRACT.md", "未持久化的“假停用 bucket”状态");
  requireText(contract, "docs/INTERFACE_CONTRACT.md", "回滚本次对 `bucket.disabledAt`、默认 `storage.bucket` 和 `storage.buckets[]`");
  requireText(contractHttpTest, "tests/contract-http.test.js", "failed storage bucket disable persistence keeps bucket active");
  requireText(contractHttpTest, "tests/contract-http.test.js", "assert.deepEqual(afterFailure.storage, before.storage);");
  requireText(contractHttpTest, "tests/contract-http.test.js", "assert.equal(afterBucket.disabledAt, null);");
  requireText(contract, "docs/INTERFACE_CONTRACT.md", "未持久化的“假启用 bucket”状态");
  requireText(contract, "docs/INTERFACE_CONTRACT.md", "回滚本次对 `bucket.disabledAt` 和 `storage.buckets[]`");
  requireText(contractHttpTest, "tests/contract-http.test.js", "failed storage bucket enable persistence keeps bucket disabled");
  requireText(contractHttpTest, "tests/contract-http.test.js", "assert.equal(afterBucket.disabledAt, beforeBucket.disabledAt);");
  requireText(contract, "docs/INTERFACE_CONTRACT.md", "未持久化的“假清空 bucket”状态");
  requireText(contract, "docs/INTERFACE_CONTRACT.md", "回滚本次对 `bucket.clearedAt`、`bucket.objectCount`、`bucket.sizeBytes`");
  requireText(contractHttpTest, "tests/contract-http.test.js", "failed bucket clear persistence keeps cleared marker uncommitted");
  requireText(contractHttpTest, "tests/contract-http.test.js", "assert.equal(minioRequests.some((request) => request.method === \"DELETE\" && request.url === \"/clear-rollback/devices/contract.txt\"), true);");
  requireText(contractHttpTest, "tests/contract-http.test.js", "assert.equal(afterBucket.clearedAt, null);");
  requireText(contract, "docs/INTERFACE_CONTRACT.md", "未持久化的“假删除 bucket”状态");
  requireText(contract, "docs/INTERFACE_CONTRACT.md", "远端删除成功后状态持久化失败");
  requireText(contractHttpTest, "tests/contract-http.test.js", "failed delete-empty persistence keeps externally deleted bucket registered");
  requireText(contractHttpTest, "tests/contract-http.test.js", "assert.equal(minioRequests.some((request) => request.method === \"DELETE\" && request.url === \"/delete-rollback\"), true);");
  requireText(contractHttpTest, "tests/contract-http.test.js", "assert.deepEqual(afterFailure.storage, before.storage);");
}

async function auditClientLocalInterfaceMap() {
  const [matrix, contract, runtimeContracts, helperContracts, clientHttpTest] = await Promise.all([
    readFile(join(root, "docs", "API_MATRIX.md"), "utf8").catch(() => ""),
    readFile(join(root, "docs", "INTERFACE_CONTRACT.md"), "utf8").catch(() => ""),
    readFile(join(root, "scripts", "lib", "runtimeContracts.mjs"), "utf8").catch(() => ""),
    readFile(join(root, "tests", "helpers", "contracts.js"), "utf8").catch(() => ""),
    readFile(join(root, "tests", "client-http.test.js"), "utf8").catch(() => "")
  ]);

  for (const [label, text] of [
    ["docs/API_MATRIX.md", matrix],
    ["docs/INTERFACE_CONTRACT.md", contract],
    ["scripts/lib/runtimeContracts.mjs", runtimeContracts],
    ["tests/helpers/contracts.js", helperContracts],
    ["tests/client-http.test.js", clientHttpTest]
  ]) {
    if (!text) {
      issues.push(`${label} is missing for client local interface map audit`);
    }
  }
  if (!matrix || !contract || !runtimeContracts || !helperContracts || !clientHttpTest) {
    return;
  }

  const entries = [
    {
      method: "POST",
      path: "/api/client/shutdown",
      contractPhrase: "client shutdown response contract",
      helper: "assertClientShutdownResponseContract",
      clientHttpAssertion: 'assertClientShutdownResponseContract(await shutdown.json(), "clientShutdown")'
    },
    {
      method: "POST",
      path: "/api/binaries/check",
      contractPhrase: "client binaries check response contract",
      helper: "assertClientBinariesCheckContract",
      clientHttpAssertion: 'assertClientBinariesCheckContract(missingBinaryCheckPayload, "missingBinaryCheck")'
    },
    {
      method: "POST",
      path: "/api/profile/import",
      contractPhrase: "client profile import response contract",
      helper: "assertClientProfileImportResponseContract",
      clientHttpAssertion: 'assertClientProfileImportResponseContract(profileImportPayload, "profileImport")'
    },
    {
      method: "POST",
      path: "/api/jobs/save",
      contractPhrase: "client job save response contract",
      helper: "assertClientJobSaveResponseContract",
      clientHttpAssertion: 'assertClientJobSaveResponseContract(savedJobPayload, "savedJob")'
    },
    {
      method: "POST",
      path: "/api/singbox/start",
      contractPhrase: "client singbox process response contract",
      helper: "assertClientSingboxProcessResponseContract",
      clientHttpAssertion: 'assertClientSingboxProcessResponseContract(startSingboxPayload, "startedSingbox")'
    },
    {
      method: "POST",
      path: "/api/singbox/stop",
      contractPhrase: "client singbox process response contract",
      helper: "assertClientSingboxProcessResponseContract",
      clientHttpAssertion: 'assertClientSingboxProcessResponseContract(stoppedSingboxPayload, "stoppedSingbox")'
    },
    {
      method: "POST",
      path: "/api/sync/preview",
      contractPhrase: "sync preview contract",
      helper: "assertSyncPreviewContract",
      clientHttpAssertion: 'assertSyncPreviewContract(previewFromMinimalJobPayload, "previewFromMinimalJob"'
    },
    {
      method: "POST",
      path: "/api/sync/run",
      contractPhrase: "client sync run response contract",
      helper: "assertClientSyncRunResponseContract",
      clientHttpAssertion: 'assertClientSyncRunResponseContract(runPayload, "run")'
    },
    {
      method: "POST",
      path: "/api/sync/stop",
      contractPhrase: "client sync run response contract",
      helper: "assertClientSyncRunResponseContract",
      clientHttpAssertion: 'assertClientSyncRunResponseContract(stoppedSyncPayload, "stoppedSync")'
    }
  ];

  for (const entry of entries) {
    const route = `${entry.method} ${entry.path}`;
    if (!routeRowPattern(entry).test(matrix)) {
      issues.push(`client local interface map missing API matrix row for ${route}`);
    }
    if (!contract.includes(entry.contractPhrase)) {
      issues.push(`client local interface map missing INTERFACE_CONTRACT phrase for ${route}: ${entry.contractPhrase}`);
    }
    if (!runtimeContracts.includes(`export function ${entry.helper}`)) {
      issues.push(`client local interface map missing runtime contract helper for ${route}: ${entry.helper}`);
    }
    if (!helperContracts.includes(entry.helper)) {
      issues.push(`client local interface map missing tests helper export for ${route}: ${entry.helper}`);
    }
    if (!clientHttpTest.includes(entry.clientHttpAssertion)) {
      issues.push(`client local interface map missing client-http assertion for ${route}: ${entry.clientHttpAssertion}`);
    }
  }
}

async function readRouteSources(label) {
  const sourceFiles = [
    "src/server.js",
    "client/src/clientServer.js",
    "public/app.js",
    "client/public/app.js",
    "client/src/profileImport.js"
  ];
  const sources = {};
  for (const rel of sourceFiles) {
    const text = await readFile(join(root, ...rel.split("/")), "utf8").catch(() => "");
    if (!text) {
      issues.push(`${rel} is missing for ${label}`);
    }
    sources[rel] = text;
  }
  if (sourceFiles.some((rel) => !sources[rel])) {
    return null;
  }
  return sources;
}

function extractDefaultStatusCodes(source) {
  const block = source.match(/const DEFAULT_STATUS_BY_CODE = \{([\s\S]*?)\n\};/);
  if (!block) {
    return [];
  }
  return [...block[1].matchAll(/^\s*([a-z][a-z0-9_]*):\s*(\d+),?/gm)]
    .map((match) => ({
      code: match[1],
      status: Number(match[2])
    }));
}

function extractClaimRedeemErrorCodes(source) {
  const block = source.match(/export const CLAIM_REDEEM_ERROR_CODES = Object\.freeze\(\[([\s\S]*?)\]\);/);
  if (!block) {
    return [];
  }
  return [...block[1].matchAll(/"([a-z][a-z0-9_]*)"/g)].map((match) => match[1]);
}

function extractFormatErrorCodes(source) {
  const block = source.match(/function formatError[\s\S]*?const copy = \{([\s\S]*?)\n\s*\};/);
  if (!block) {
    return [];
  }
  return [...block[1].matchAll(/^\s*([a-z][a-z0-9_]*):\s*"/gm)]
    .map((match) => match[1])
    .sort();
}

function extractStringConstant(source, name) {
  const match = source.match(new RegExp(`export const ${escapeRegExp(name)} = "([^"]+)";`));
  return match?.[1] || "";
}

function extractNumberConstant(source, name) {
  const match = source.match(new RegExp(`export const ${escapeRegExp(name)} = (\\d+);`));
  return match ? Number(match[1]) : NaN;
}

function extractImplementedRoutes(source) {
  return [...source.matchAll(/req\.method === "([A-Z]+)" && url\.pathname === "([^"]+)"/g)]
    .map((match) => ({ method: match[1], path: match[2] }))
    .filter((route) => route.path.startsWith("/api/"));
}

function extractBareReadJsonUsages(source, label) {
  const lines = source.split(/\r?\n/);
  const usages = [];
  for (const [index, line] of lines.entries()) {
    if (!line.includes("await readJson(req)") || line.includes("parseProtocolRequest(")) {
      continue;
    }
    let route = null;
    for (let cursor = index; cursor >= 0 && cursor >= index - 8; cursor -= 1) {
      const match = lines[cursor].match(/req\.method === "([A-Z]+)" && url\.pathname === "([^"]+)"/);
      if (match) {
        route = { method: match[1], path: match[2] };
        break;
      }
    }
    usages.push({
      label,
      line: index + 1,
      method: route?.method || "UNKNOWN",
      path: route?.path || "UNKNOWN"
    });
  }
  return usages;
}

function extractApiPaths(source) {
  return [...new Set([...source.matchAll(/["'`]([^"'`]*\/api\/[^"'`${}\s]+)["'`]/g)]
    .map((match) => match[1])
    .map((path) => path.replace(/^.*?(\/api\/)/, "/api/"))
    .map((path) => path.replace(/[),;]+$/, ""))
    .filter((path) => path.startsWith("/api/")))]
    .sort();
}

function extractOutboundApiPaths(source) {
  return [...new Set([...source.matchAll(/\bfetch(?:Impl)?\s*\(\s*`[^`]*?(\/api\/[^`'"${}\s,)]+)/g)]
    .map((match) => match[1])
    .filter((path) => path.startsWith("/api/")))]
    .sort();
}

function extractSmokeApiPaths(smokeSources) {
  return [...new Set(Object.values(smokeSources)
    .filter(Boolean)
    .flatMap((source) => extractApiPaths(source)))]
    .sort();
}

function matrixConsumerIncludes(matrix, path, expected) {
  for (const line of matrix.split(/\r?\n/)) {
    if (!line.includes(`\`${path}\``)) {
      continue;
    }
    const cells = line.split("|").map((cell) => cell.trim());
    if (!/^(GET|POST|PUT|PATCH|DELETE)$/.test(cells[1] || "")) {
      continue;
    }
    if (cells[2] !== `\`${path}\``) {
      continue;
    }
    const consumerCell = cells.length >= 7 ? cells[4] : cells[3];
    if (consumerCell?.includes(expected)) {
      return true;
    }
  }
  return false;
}

function routeRowPattern(route) {
  return new RegExp(`\\|\\s*${escapeRegExp(route.method)}\\s*\\|\\s*${escapeRegExp(`\`${route.path}\``)}\\s*\\|`);
}

function pathPattern(path) {
  return new RegExp(escapeRegExp(`\`${path}\``));
}

function crossRuntimePathPattern(path) {
  return new RegExp(`\\|\\s*客户端本地运行时\\s*\\|\\s*[A-Z]+\\s*\\|\\s*${escapeRegExp(`\`${path}\``)}\\s*\\|`);
}

function routeMentionPattern(route) {
  return new RegExp(`${escapeRegExp(route.method)}\\s+\`?${escapeRegExp(route.path)}\`?`);
}

function requireText(text, label, expected) {
  if (!text.includes(expected)) {
    issues.push(`${label} must mention ${expected}`);
  }
}

function parseProtocolJsonSchema(text, label) {
  try {
    return JSON.parse(text);
  } catch (error) {
    issues.push(`${label} could not be parsed: ${error.message}`);
    return null;
  }
}

function requireSchemaArray(schema, label, key, expected) {
  const actual = Array.isArray(schema?.[key]) ? schema[key] : null;
  if (!actual || JSON.stringify(actual) !== JSON.stringify(expected)) {
    issues.push(`${label} ${key} must equal ${JSON.stringify(expected)}`);
  }
}

function requireTextOrder(text, label, expectedSnippets, description) {
  let cursor = 0;
  for (const expected of expectedSnippets) {
    const index = text.indexOf(expected, cursor);
    if (index === -1) {
      issues.push(`${label} must keep order for ${description}: ${expected}`);
      return;
    }
    cursor = index + expected.length;
  }
}

function sourceWindow(text, startMarker, endMarker) {
  const start = text.indexOf(startMarker);
  if (start < 0) {
    return "";
  }
  const end = text.indexOf(endMarker, start + startMarker.length);
  return end < 0 ? text.slice(start) : text.slice(start, end);
}

function requireProfileImportGuidance(source, code, { retryable, required = [] } = {}) {
  const pattern = new RegExp(`${escapeRegExp(code)}:\\s*\\{([\\s\\S]*?)\\n\\s*\\},`);
  const match = source.match(pattern);
  if (!match) {
    issues.push(`client/public/app.js profileImportErrorGuidance must include ${code}`);
    return;
  }
  const block = match[1];
  const expectedRetryable = `retryable: ${retryable ? "true" : "false"}`;
  if (!block.includes(expectedRetryable)) {
    issues.push(`client/public/app.js profileImportErrorGuidance ${code} must include ${expectedRetryable}`);
  }
  const wrongRetryable = `retryable: ${retryable ? "false" : "true"}`;
  if (block.includes(wrongRetryable)) {
    issues.push(`client/public/app.js profileImportErrorGuidance ${code} must not include ${wrongRetryable}`);
  }
  for (const expected of required) {
    if (!block.includes(expected)) {
      issues.push(`client/public/app.js profileImportErrorGuidance ${code} must mention ${expected}`);
    }
  }
}

function requireClaimCreateGuidance(source, code, retryable) {
  const match = findGuidanceBlock(source, "claimCreateErrorGuidance", code);
  if (!match) {
    issues.push(`public/app.js claimCreateErrorGuidance must include ${code}`);
    return;
  }
  const block = match;
  const expectedRetryable = `retryable: ${retryable ? "true" : "false"}`;
  if (!block.includes(expectedRetryable)) {
    issues.push(`public/app.js claimCreateErrorGuidance ${code} must include ${expectedRetryable}`);
  }
  const wrongRetryable = `retryable: ${retryable ? "false" : "true"}`;
  if (block.includes(wrongRetryable)) {
    issues.push(`public/app.js claimCreateErrorGuidance ${code} must not include ${wrongRetryable}`);
  }
}

function requireClaimRedeemPreviewGuidance(source, code, retryable) {
  const match = findGuidanceBlock(source, "claimRedeemPreviewErrorGuidance", code);
  if (!match) {
    issues.push(`public/app.js claimRedeemPreviewErrorGuidance must include ${code}`);
    return;
  }
  const block = match;
  const expectedRetryable = `retryable: ${retryable ? "true" : "false"}`;
  if (!block.includes(expectedRetryable)) {
    issues.push(`public/app.js claimRedeemPreviewErrorGuidance ${code} must include ${expectedRetryable}`);
  }
  const wrongRetryable = `retryable: ${retryable ? "false" : "true"}`;
  if (block.includes(wrongRetryable)) {
    issues.push(`public/app.js claimRedeemPreviewErrorGuidance ${code} must not include ${wrongRetryable}`);
  }
}

function findGuidanceBlock(source, functionName, code) {
  const functionPattern = new RegExp(`function ${escapeRegExp(functionName)}\\(code\\) \\{([\\s\\S]*?)\\n\\}`);
  const functionMatch = source.match(functionPattern);
  if (!functionMatch) return "";
  const body = functionMatch[1];
  const codePattern = new RegExp(`${escapeRegExp(code)}:\\s*\\{([\\s\\S]*?)\\n\\s*\\}(?:,|\\s*;|\\s*$)`);
  const codeMatch = body.match(codePattern);
  return codeMatch?.[1] || "";
}

function normalizePath(path) {
  return path.split(sep).join("/");
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
