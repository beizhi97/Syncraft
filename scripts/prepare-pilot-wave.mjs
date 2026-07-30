import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { writeJsonReportSync, writeTextReportSync } from "./lib/reportSecrets.mjs";
import { releaseBundlePaths } from "./lib/releasePaths.mjs";

const projectRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const cohortId = slug(readArg("--cohort-id") || `pilot-${dateSlug()}`);
const outputDir = repoPath(readArg("--output-dir") || `reports/pilot/${cohortId}`);
const allowInsecureServerBaseUrl = process.argv.includes("--allow-insecure-server-base-url");
const serverBaseUrl = normalizePilotServerBaseUrl(readArg("--server-base-url") || process.env.SFSC_PILOT_SERVER_BASE_URL || "", allowInsecureServerBaseUrl);
const clientBaseUrl = normalizeBaseUrl(readArg("--client-base-url") || "http://127.0.0.1:5188");
const betaApplyCommand = String(readArg("--beta-apply-command") || "pnpm run apply:beta-singbox -- --apply").trim();
const expiresInHours = Number(readArg("--expires-in-hours") || 4);
const participantArgs = readArgs("--participant");
const sensitiveTKeyPatternAnchor = "SFSC1-[A-Za-z0-9_-]+";

try {
  const participants = participantArgs.length ? participantArgs.map(parseParticipant) : defaultParticipants();
  const wave = buildWave(participants);
  mkdirSync(outputDir, { recursive: true });
  writeJsonReportSync(resolve(outputDir, "pilot-wave.json"), wave, "pilot wave");
  writeJsonReportSync(resolve(outputDir, "pilot-daily-health.json"), buildDailyHealthRecord(wave), "pilot daily health");
  writeTextReportSync(resolve(outputDir, "pilot-wave-command-sheet.md"), renderWaveMarkdown(wave), "pilot wave command sheet");
  for (const participant of wave.participants) {
    const participantDir = resolve(outputDir, participant.participantId);
    mkdirSync(participantDir, { recursive: true });
    writeTextReportSync(resolve(participantDir, "participant-command-sheet.md"), renderParticipantMarkdown(wave, participant), "participant command sheet");
    writeJsonReportSync(resolve(participantDir, "participant-record.json"), buildParticipantRecord(wave, participant), "participant record");
  }
  console.log(`Pilot wave prepared: ${rel(outputDir)}`);
  console.log(`- cohortId: ${wave.cohortId}`);
  console.log(`- participants: ${wave.participants.length}`);
  console.log("- safety: plaintext SyncKey and import URIs are not stored");
} catch (error) {
  console.error(`Pilot wave preparation failed: ${error.message || error}`);
  process.exitCode = 1;
}

function buildWave(participants) {
  const artifacts = collectArtifacts();
  return {
    schemaVersion: 1,
    app: "singbox-folder-sync",
    type: "pilot-wave",
    generatedAt: new Date().toISOString(),
    cohortId,
    serverBaseUrl,
    serverTransport: allowInsecureServerBaseUrl ? "http-test-only" : "https",
    clientBaseUrl,
    betaApplyCommand,
    expiresInHours,
    participants: participants.map((participant, index) => {
      const participantId = slug(participant.participantId || `pilot-${String(index + 1).padStart(3, "0")}`);
      const remoteFolder = participant.remoteFolder || `pilot/${cohortId}/${participantId}`;
      return {
        participantId,
        displayName: participant.displayName || participantId,
        machine: participant.machine || "",
        wave: participant.wave || waveName(index),
        clientName: participant.clientName || `${cohortId}-${participantId}`,
        remoteFolder,
        localPathHint: participant.localPath || `%USERPROFILE%\\Desktop\\SFSC Pilot\\${participantId}`,
        supportOwner: participant.supportOwner || "",
        recordPath: rel(resolve(outputDir, participantId, "participant-record.json")),
        commandSheetPath: rel(resolve(outputDir, participantId, "participant-command-sheet.md"))
      };
    }),
    rollout: {
      waves: ["wave-1", "wave-2", "wave-3"],
      rule: "Start with 1-2 power users, observe one full business day, then expand only if P0/P1 gates remain clear."
    },
    artifacts,
    safety: {
      plaintextTKeyStored: false,
      importUriStored: false,
      note: "This pilot wave file only contains participant metadata, command templates, paths, and artifact hashes."
    }
  };
}

function buildDailyHealthRecord(wave) {
  return {
    schemaVersion: 1,
    app: "singbox-folder-sync",
    type: "pilot-daily-health",
    ok: false,
    generatedAt: new Date().toISOString(),
    cohortId: wave.cohortId,
    records: [
      dailyHealthEntry(1),
      dailyHealthEntry(2),
      dailyHealthEntry(3)
    ],
    safety: {
      plaintextTKeyStored: false,
      importUriStored: false,
      forbiddenInNotes: ["完整 SyncKey", "sfsc import URI", "VLESS URI", "S3 secret", "heartbeat secret", "admin token", "SSH private key"]
    }
  };
}

function dailyHealthEntry(day) {
  return {
    day,
    date: "",
    checkedAt: "",
    checkedBy: "",
    serverHealthOk: null,
    candidateBaselineOk: null,
    n1HealthOk: null,
    n1PostDeployOk: null,
    restartRequired: null,
    finalRestartClear: null,
    activeParticipants: 0,
    successfulHeartbeats24h: 0,
    heartbeatWindowOk: null,
    openP1Count: 0,
    openP2Count: 0,
    diagnosticSampleArtifact: "",
    prefixSampleArtifact: "",
    notes: ""
  };
}

function parseParticipant(value) {
  assertSafeText(value, "participant");
  const parts = String(value || "").split(":").map((item) => item.trim());
  if (!parts[0]) {
    throw new Error("--participant requires at least participantId, e.g. pilot-001:Alice:PC-A");
  }
  return {
    participantId: parts[0],
    displayName: parts[1] || parts[0],
    machine: parts[2] || "",
    wave: parts[3] || "",
    supportOwner: parts[4] || ""
  };
}

function defaultParticipants() {
  return Array.from({ length: 5 }, (_, index) => ({
    participantId: `pilot-${String(index + 1).padStart(3, "0")}`,
    displayName: `Participant ${index + 1}`,
    wave: waveName(index)
  }));
}

function waveName(index) {
  if (index < 2) return "wave-1";
  if (index < 5) return "wave-2";
  return "wave-3";
}

function buildParticipantRecord(wave, participant) {
  return {
    schemaVersion: 1,
    app: "singbox-folder-sync",
    type: "pilot-participant-record",
    ok: false,
    generatedAt: new Date().toISOString(),
    cohortId: wave.cohortId,
    participant: {
      participantId: participant.participantId,
      displayName: participant.displayName,
      machine: participant.machine,
      wave: participant.wave,
      clientName: participant.clientName,
      remoteFolder: participant.remoteFolder,
      supportOwner: participant.supportOwner
    },
    releaseEvidence: wave.artifacts,
    gates: [
      gate("install", "pending", "Install or unzip the assigned package and launch the client."),
      gate("import", "pending", "Generate a dedicated one-time SyncKey and import it on this machine."),
      gate("preview", "pending", "Save a job and verify preview redaction."),
      gate("small-sync", "pending", "Run real sync only against this participant remoteFolder."),
      gate("diagnostics", "pending", "Export support-safe diagnostics and verify privacy."),
      gate("rollback-ready", "pending", "Confirm data backup and rollback instructions are understood.")
    ],
    issues: [],
    syncEvidence: {
      expectedRemoteFolder: participant.remoteFolder,
      actualRemoteFolderConfirmed: "",
      prefixEvidenceArtifact: "",
      prefixCheckAt: "",
      checkedBy: ""
    },
    rollbackDrill: {
      performed: false,
      packageType: "",
      fromVersion: "",
      toVersion: "",
      dataBackupConfirmed: false,
      verificationArtifact: "",
      recoveredAt: "",
      owner: ""
    },
    metrics: {
      installOk: null,
      importOk: null,
      firstSyncOk: null,
      diagnosticsOk: null,
      rollbackDrillOk: null
    },
    notes: "",
    safety: {
      plaintextTKeyStored: false,
      importUriStored: false,
      forbiddenInNotes: ["完整 SyncKey", "sfsc import URI", "VLESS URI", "S3 secret", "heartbeat secret", "admin token", "SSH private key"]
    }
  };
}

function gate(id, status, description) {
  return { id, status, description, notes: "", artifacts: [] };
}

function renderWaveMarkdown(wave) {
  const rows = wave.participants
    .map((p) => `| ${p.participantId} | ${p.displayName} | ${p.machine || "-"} | ${p.wave} | \`${p.clientName}\` | \`${p.remoteFolder}\` | ${p.supportOwner || "-"} |`)
    .join("\n");
  return `# 5-10 人小范围试点批次命令单

- cohortId: \`${wave.cohortId}\`
- generatedAt: ${wave.generatedAt}
- serverBaseUrl: ${wave.serverBaseUrl}
- clientBaseUrl: ${wave.clientBaseUrl}
- SyncKey 有效期建议: ${wave.expiresInHours} 小时

## 参与者名册

| participantId | displayName | machine | wave | clientName | remoteFolder | supportOwner |
| --- | --- | --- | --- | --- | --- | --- |
${rows}

## 批次规则

- wave-1：1-2 名熟悉场景的用户，观察 1 个完整工作日。
- wave-2：扩展到 5 人以内，继续观察安装、导入、首次同步和诊断包。
- wave-3：扩展到 5-10 人，只有 P0/P1 门禁清零后继续。
- 每个参与者必须使用独立 clientName 和 remoteFolder。
- 任何真实 SyncKey 只允许短暂出现在操作者终端或用户粘贴框，不得写入本目录文件。
- 每日检查写入 \`${rel(resolve(outputDir, "pilot-daily-health.json"))}\`，扩大发布前至少连续 3 条记录必须达标。

## 汇总命令

\`\`\`powershell
pnpm run pilot:summary -- --cohort-dir ${psQuote(rel(outputDir))}
\`\`\`
`;
}

function renderParticipantMarkdown(wave, participant) {
  return `# 试点参与者命令单: ${participant.participantId}

- cohortId: \`${wave.cohortId}\`
- participantId: \`${participant.participantId}\`
- wave: \`${participant.wave}\`
- clientName: \`${participant.clientName}\`
- remoteFolder: \`${participant.remoteFolder}\`
- localPath 建议: \`${participant.localPathHint}\`

## 管理员生成一次性 SyncKey

\`\`\`powershell
pnpm run trial:create-t-key -- --base-url ${psQuote(wave.serverBaseUrl)} --client-name ${psQuote(participant.clientName)} --expires-in-hours ${wave.expiresInHours} --print-t-key
${wave.betaApplyCommand}
\`\`\`

只把完整 SyncKey 交给该参与者本机导入。不要写入 participant-record、聊天、工单或截图。

生成 SyncKey 后必须先执行上方 apply 命令，并确认其报告中的 \`restartRequired=false\`，再让参与者导入。

## 参与者本机试跑

\`\`\`powershell
$env:SFSC_TRIAL_T_KEY="<完整 SyncKey>"
pnpm run trial:client-runner -- --base-url ${psQuote(wave.clientBaseUrl)} --local-path ${psQuote(participant.localPathHint)} --remote-folder ${psQuote(participant.remoteFolder)}
pnpm run trial:client-runner -- --base-url ${psQuote(wave.clientBaseUrl)} --local-path ${psQuote(participant.localPathHint)} --remote-folder ${psQuote(participant.remoteFolder)} --run-sync --i-understand-real-sync
pnpm run pilot:summary -- --cohort-dir ${psQuote(rel(outputDir))}
\`\`\`

## 记录要求

- 更新 \`${participant.recordPath}\`，只记录状态、错误码、诊断包路径和人工结论。
- 禁止写入完整 SyncKey、sfsc import URI、VLESS URI、S3 secret、heartbeat secret、admin token 或 SSH private key。
- 若出现 P0/P1，立即暂停该 wave 的新增 SyncKey。
`;
}

function collectArtifacts() {
  const release = releaseBundlePaths(projectRoot);
  return [
    artifact("release-bundle-manifest", release.manifest),
    artifact("release-bundle-zip", release.zip),
    artifact("desktop-zip", "dist/SyncraftDesktop.zip"),
    artifact("portable-zip", "dist/SyncraftClient.zip"),
    artifact("n1-latest", "reports/n1/latest-post-deploy.json"),
    artifact("internal-trial-record", "reports/internal-trial/internal-trial-record.json")
  ];
}

function artifact(kind, path) {
  const fullPath = repoPath(path);
  const exists = existsSync(fullPath);
  return {
    kind,
    path: rel(fullPath),
    exists,
    sha256: exists ? fileSha256(fullPath) : "",
    bytes: exists ? readFileSync(fullPath).length : 0,
    summary: exists && path.endsWith(".json") ? summarizeJson(fullPath) : {}
  };
}

function summarizeJson(path) {
  try {
    const json = JSON.parse(readFileSync(path, "utf8"));
    return {
      ok: json.ok ?? json.releaseOk ?? null,
      version: json.version || json.appVersion || "",
      generatedAt: json.generatedAt || "",
      runId: json.runId || "",
      preflightVerified: json.preflightVerified ?? null
    };
  } catch {
    return {};
  }
}

function assertSafeText(value, label) {
  const text = String(value || "");
  // Release audit anchor: plaintext SyncKey and import URIs are not stored.
  const patterns = [
    new RegExp(sensitiveTKeyPatternAnchor),
    /sfsc:\/\/import\/v1#/i,
    /vless:\/\//i,
    /BEGIN OPENSSH PRIVATE KEY/,
    /S3_SECRET_ACCESS_KEY\s*=/i,
    /MINIO_ROOT_PASSWORD\s*=/i,
    /SFSC_ADMIN_TOKEN\s*=\s*[^<.\s]/i,
    /heartbeatSecret["']?\s*[:=]\s*["'][^"*]/i,
    /secretAccessKey["']?\s*[:=]\s*["'][^"*]/i
  ];
  if (patterns.some((pattern) => pattern.test(text))) {
    throw new Error(`${label} contains sensitive-looking material; refusing to write pilot wave files.`);
  }
}

function readArg(name) {
  const index = process.argv.indexOf(name);
  if (index === -1 || index + 1 >= process.argv.length) return "";
  return process.argv[index + 1];
}

function readArgs(name) {
  const values = [];
  for (let index = 2; index < process.argv.length; index += 1) {
    if (process.argv[index] === name && index + 1 < process.argv.length) {
      values.push(process.argv[index + 1]);
      index += 1;
    }
  }
  return values;
}

function normalizeBaseUrl(value) {
  const url = new URL(String(value || "").trim());
  url.pathname = url.pathname.replace(/\/+$/, "");
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}

function normalizePilotServerBaseUrl(value, allowInsecure) {
  if (!String(value || "").trim()) {
    throw new Error("--server-base-url (or SFSC_PILOT_SERVER_BASE_URL) must be an HTTPS public Beta address.");
  }
  const normalized = normalizeBaseUrl(value);
  if (new URL(normalized).protocol !== "https:" && !allowInsecure) {
    throw new Error("Pilot waves require an HTTPS --server-base-url. Use --allow-insecure-server-base-url only for internal test environments.");
  }
  return normalized;
}

function repoPath(path) {
  if (!path) return projectRoot;
  return resolve(projectRoot, path);
}

function rel(path) {
  return relative(projectRoot, resolve(path)).replaceAll("\\", "/");
}

function fileSha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function dateSlug() {
  return new Date().toISOString().slice(0, 10).replaceAll("-", "");
}

function slug(value) {
  const normalized = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!normalized) {
    throw new Error("Slug value cannot be empty.");
  }
  return normalized;
}

function psQuote(value) {
  return `"${String(value).replaceAll("`", "``").replaceAll('"', '`"')}"`;
}
