import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import os from "node:os";
import { writeJsonReportSync, writeTextReportSync } from "./lib/reportSecrets.mjs";
import { releaseBundlePaths } from "./lib/releasePaths.mjs";

const projectRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const outputPath = repoPath(readArg("--output") || "reports/internal-trial/internal-trial-command-sheet.md");
const jsonOutputPath = repoPath(readArg("--json-output") || "reports/internal-trial/internal-trial-command-sheet.json");
const localPath = resolve(readArg("--local-path") || process.env.SFSC_TRIAL_LOCAL_PATH || defaultLocalPath());
const remoteFolder = readArg("--remote-folder") || process.env.SFSC_TRIAL_REMOTE_FOLDER || `internal-trial-${timestampSlug()}`;
const baseUrl = normalizeBaseUrl(readArg("--base-url") || process.env.SFSC_TRIAL_CLIENT_BASE_URL || "http://127.0.0.1:5188");
const serverBaseUrl = normalizeBaseUrl(readArg("--server-base-url") || process.env.SFSC_TRIAL_SERVER_BASE_URL || "http://192.168.1.254:5177");
const direction = readArg("--direction") || process.env.SFSC_TRIAL_DIRECTION || "upload";
const tester = readArg("--tester") || process.env.SFSC_TRIAL_TESTER || "";
const machine = readArg("--machine") || process.env.SFSC_TRIAL_MACHINE || os.hostname();
const windowsVersion = readArg("--windows-version") || process.env.SFSC_TRIAL_WINDOWS_VERSION || `${os.type()} ${os.release()} ${os.arch()}`;
const createSampleFiles = !hasArg("--no-sample-files");
const overwriteSampleFiles = hasArg("--force-sample-files");

try {
  const report = prepare();
  mkdirSync(dirname(outputPath), { recursive: true });
  mkdirSync(dirname(jsonOutputPath), { recursive: true });
  writeTextReportSync(outputPath, renderMarkdown(report), "internal trial command sheet");
  writeJsonReportSync(jsonOutputPath, report, "internal trial command sheet JSON");
  console.log(`Internal trial command sheet written: ${outputPath}`);
  console.log(`Internal trial command sheet JSON written: ${jsonOutputPath}`);
  console.log(`- localPath: ${localPath}`);
  console.log(`- remoteFolder: ${remoteFolder}`);
} catch (error) {
  console.error(`Internal trial preparation failed: ${error.message || error}`);
  process.exitCode = 1;
}

function prepare() {
  mkdirSync(localPath, { recursive: true });
  const sampleFiles = createSampleFiles ? writeSampleFiles(localPath) : [];
  const artifacts = collectArtifacts();
  return {
    schemaVersion: 1,
    app: "singbox-folder-sync",
    type: "internal-trial-command-sheet",
    generatedAt: new Date().toISOString(),
    environment: {
      tester,
      date: new Date().toISOString().slice(0, 10),
      windowsVersion,
      machine,
      serverBaseUrl
    },
    trial: {
      baseUrl,
      localPath,
      remoteFolder,
      direction,
      sampleFilesCreated: createSampleFiles,
      sampleFiles
    },
    commands: buildCommands(),
    artifacts,
    safety: {
      tKeyPlaintextStored: false,
      note: "This preparation step never asks for, stores, or writes the real SyncKey."
    },
    nextHumanGates: [
      "Generate a fresh one-time SyncKey on the intended N1/server.",
      "Start the delivered Windows client and confirm it listens on the selected local base URL.",
      "Run the profile-preview command first; run the real-sync command only against the dedicated test prefix.",
      "Verify uploaded files in object storage or the server console, then record the result with pnpm run trial:record:update."
    ]
  };
}

function writeSampleFiles(root) {
  const files = [
    ["hello.txt", "Syncraft internal trial sample.\n"],
    ["中文 空格.txt", `generated=${new Date().toISOString()}\nremoteFolder=${remoteFolder}\n`],
    ["nested/notes.md", `# Internal Trial\n\nRun: ${remoteFolder}\nUUID: ${randomUUID()}\n`]
  ];
  const written = [];
  for (const [name, content] of files) {
    const path = resolve(root, name);
    mkdirSync(dirname(path), { recursive: true });
    if (!existsSync(path) || overwriteSampleFiles) {
      writeFileSync(path, content, "utf8");
    }
    written.push({
      path,
      relativePath: relative(root, path).replaceAll("\\", "/"),
      sha256: fileSha256(path),
      bytes: readFileSync(path).length
    });
  }
  return written;
}

function buildCommands() {
  const baseArgs = [
    "--base-url", psQuote(baseUrl),
    "--local-path", psQuote(localPath),
    "--remote-folder", psQuote(remoteFolder),
    "--direction", psQuote(direction)
  ].join(" ");
  return {
    refreshRecord: "pnpm run trial:record",
    assist: "pnpm run trial:assist",
    updateEnvironment: `pnpm run trial:record:update -- --tester ${psQuote(tester || "<执行人>")} --date ${psQuote(new Date().toISOString().slice(0, 10))} --windows-version ${psQuote(windowsVersion)} --machine ${psQuote(machine)}`,
    createTrialTKey: `pnpm run trial:create-t-key -- --base-url ${psQuote(serverBaseUrl)} --client-name ${psQuote(remoteFolder)} --expires-in-hours 2 --print-t-key`,
    setTKeyEnv: "$env:SFSC_TRIAL_T_KEY=\"<完整 SyncKey>\"",
    profilePreview: `pnpm run trial:client-runner -- ${baseArgs}`,
    realSync: `pnpm run trial:client-runner -- ${baseArgs} --run-sync --i-understand-real-sync`,
    stopRecoveryProbe: `pnpm run trial:client-runner -- ${baseArgs} --run-sync --i-understand-real-sync --stop-after-ms 1500`,
    verifyRecord: "pnpm run trial:record:verify"
  };
}

function collectArtifacts() {
  const release = releaseBundlePaths(projectRoot);
  return [
    artifact("release-bundle-manifest", release.manifest),
    artifact("release-bundle-zip", release.zip),
    artifact("desktop-zip", "dist/SyncraftDesktop.zip"),
    artifact("portable-zip", "dist/SyncraftClient.zip"),
    artifact("n1-latest", "reports/n1/latest-post-deploy.json"),
    artifact("trial-record", "reports/internal-trial/internal-trial-record.json"),
    artifact("trial-assistant", "reports/internal-trial/internal-trial-assistant.json")
  ];
}

function artifact(kind, path) {
  const fullPath = repoPath(path);
  const exists = existsSync(fullPath);
  let summary = {};
  if (exists && path.endsWith(".json")) {
    try {
      const json = JSON.parse(readFileSync(fullPath, "utf8"));
      summary = {
        ok: json.ok ?? json.releaseOk ?? null,
        version: json.version || json.appVersion || null,
        generatedAt: json.generatedAt || json.updatedAt || null,
        runId: json.runId || null,
        preflightVerified: json.preflightVerified ?? null
      };
    } catch {
      summary = {};
    }
  }
  return {
    kind,
    path: rel(fullPath),
    exists,
    sha256: exists ? fileSha256(fullPath) : "",
    bytes: exists ? readFileSync(fullPath).length : 0,
    summary
  };
}

function renderMarkdown(report) {
  const env = report.environment;
  const trial = report.trial;
  const commands = report.commands;
  const artifacts = report.artifacts
    .map((item) => `- ${item.kind}: \`${item.path}\` (${item.exists ? `sha256=${item.sha256}` : "missing"})`)
    .join("\n");
  const sampleFiles = trial.sampleFiles.length
    ? trial.sampleFiles.map((item) => `- \`${item.relativePath}\` sha256=${item.sha256}`).join("\n")
    : "- 未创建样例文件";
  return `# 内部 beta 试跑命令单

生成时间：${report.generatedAt}

## 环境

- tester: ${env.tester || "(待填写)"}
- date: ${env.date}
- windowsVersion: ${env.windowsVersion}
- machine: ${env.machine}
- serverBaseUrl: ${env.serverBaseUrl}
- clientBaseUrl: ${trial.baseUrl}
- localPath: \`${trial.localPath}\`
- remoteFolder: \`${trial.remoteFolder}\`
- direction: \`${trial.direction}\`

## 样例文件

${sampleFiles}

## 命令

\`\`\`powershell
${commands.refreshRecord}
${commands.assist}
${commands.updateEnvironment}
${commands.createTrialTKey}
${commands.setTKeyEnv}
${commands.profilePreview}
\`\`\`

真实小文件同步只对本轮专用目录执行：

\`\`\`powershell
${commands.realSync}
\`\`\`

停止/恢复抽检：

\`\`\`powershell
${commands.stopRecoveryProbe}
\`\`\`

用 \`pnpm run trial:record:update\` 记录各章节结果后校验：

\`\`\`powershell
${commands.verifyRecord}
\`\`\`

## 当前证据

${artifacts}

## 人工门禁

${report.nextHumanGates.map((item) => `- ${item}`).join("\n")}
`;
}

function defaultLocalPath() {
  return resolve(os.homedir(), "Desktop", `SFSC 测试 ${timestampSlug()}`);
}

function normalizeBaseUrl(value) {
  const url = new URL(value);
  url.pathname = url.pathname.replace(/\/+$/, "");
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}

function fileSha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
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

function psQuote(value) {
  return `"${String(value).replaceAll("`", "``").replaceAll("\"", "`\"")}"`;
}

function readArg(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? "" : process.argv[index + 1] || "";
}

function hasArg(name) {
  return process.argv.includes(name);
}
