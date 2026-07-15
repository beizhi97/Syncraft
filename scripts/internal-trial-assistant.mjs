import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import os from "node:os";
import { writeJsonReportSync } from "./lib/reportSecrets.mjs";
import { releaseBundlePaths } from "./lib/releasePaths.mjs";

const projectRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const recordPath = repoPath(readArg("--record") || "reports/internal-trial/internal-trial-record.json");
const outputPath = repoPath(readArg("--output") || "reports/internal-trial/internal-trial-assistant.json");
const diagnosticPath = readArg("--diagnostics-json");
const startedAt = new Date().toISOString();

try {
  const record = readJson(recordPath, "internal trial record");
  const report = buildAssistantReport(record);
  mkdirSync(dirname(outputPath), { recursive: true });
  writeJsonReportSync(outputPath, report, "internal trial assistant report");
  printSummary(report);
  console.log(`Internal trial assistant report written: ${outputPath}`);
} catch (error) {
  console.error(`Internal trial assistant failed: ${error.message || error}`);
  process.exitCode = 1;
}

function buildAssistantReport(record) {
  const artifacts = collectArtifacts(record);
  const observations = collectObservations(record, artifacts);
  const sectionHints = buildSectionHints(record, observations);
  const redFlags = collectRedFlags(record, observations);
  const requiredHumanActions = collectRequiredHumanActions(record, sectionHints);
  const finishedAt = new Date().toISOString();
  return {
    schemaVersion: 1,
    app: "singbox-folder-sync",
    type: "internal-trial-assistant-report",
    ok: true,
    assistantOk: true,
    generatedAt: finishedAt,
    mode: "assist-only",
    recommendation: redFlags.length ? "review-red-flags-before-human-signoff" : "ready-for-human-review",
    sourceRecordPath: rel(recordPath),
    checklistPath: "docs/INTERNAL_TRIAL_CHECKLIST.md",
    trialRecord: summarizeTrialRecord(record),
    observations,
    sectionHints,
    requiredHumanActions,
    redFlags,
    artifacts,
    audit: {
      script: "scripts/internal-trial-assistant.mjs",
      command: "pnpm run trial:assist",
      cwd: projectRoot,
      nodeVersion: process.version,
      host: os.hostname(),
      platform: `${os.type()} ${os.release()} ${os.arch()}`,
      startedAt,
      finishedAt
    },
    limitations: [
      "This report does not certify manual Windows/N1 trial sections.",
      "Only reports observed evidence and suggested attention points.",
      "Human tester must update internal-trial-record.json section statuses.",
      "The assistant must not mark internal trial sections as passed."
    ]
  };
}

function summarizeTrialRecord(record) {
  const environment = record.environment || {};
  const sections = Array.isArray(record.sections) ? record.sections : [];
  return {
    schemaVersion: record.schemaVersion || null,
    generatedAt: record.generatedAt || "",
    environmentComplete: ["tester", "date", "windowsVersion", "machine", "serverBaseUrl"]
      .every((field) => String(environment[field] || "").trim()),
    pendingSections: sections.filter((section) => section.status === "pending").map((section) => section.id),
    failedSections: sections.filter((section) => section.status === "failed").map((section) => section.id),
    skippedSections: sections.filter((section) => section.status === "skipped").map((section) => section.id)
  };
}

function collectArtifacts(record) {
  const release = releaseBundlePaths(projectRoot);
  const trialRunnerArtifacts = findRecordArtifactPaths(record, /client-trial-runner.*\.json$/i);
  const candidates = [
    ["trial-record", recordPath],
    ["release-bundle-manifest", release.manifest],
    ["release-bundle-zip", record.evidence?.releaseBundle?.path],
    ["desktop-zip", record.evidence?.desktopPackage?.path],
    ["portable-zip", record.evidence?.portablePackage?.path],
    ["n1-latest", "reports/n1/latest-post-deploy.json"],
    ["n1-summary", record.evidence?.n1?.summaryPath],
    ["preflight-json", "reports/release/preflight.json"],
    ["electron-window-smoke", "reports/release/electron-window-smoke.json"],
    ["electron-e2e-smoke", "reports/release/electron-e2e-smoke.json"],
    ["desktop-package-smoke", "reports/release/client-package-smoke-desktop.json"],
    ["portable-package-smoke", "reports/release/client-package-smoke-portable.json"],
    ...trialRunnerArtifacts.map((path) => ["client-trial-runner", path])
  ];
  if (!trialRunnerArtifacts.length) {
    candidates.push(["client-trial-runner", "reports/internal-trial/client-trial-runner.json"]);
  }
  if (diagnosticPath) {
    candidates.push(["manual-diagnostics-json", diagnosticPath]);
  }
  return candidates
    .filter(([, path]) => path)
    .map(([kind, path]) => artifact(kind, path));
}

function collectObservations(record, artifacts) {
  const observations = [];
  const release = releaseBundlePaths(projectRoot);
  const releaseManifest = readOptionalJson(release.manifest);
  const preflight = readOptionalJson("reports/release/preflight.json");
  const electronWindow = readOptionalJson("reports/release/electron-window-smoke.json");
  const electronE2e = readOptionalJson("reports/release/electron-e2e-smoke.json");
  const desktopSmoke = readOptionalJson("reports/release/client-package-smoke-desktop.json");
  const portableSmoke = readOptionalJson("reports/release/client-package-smoke-portable.json");
  const clientTrialRunnerArtifact = artifacts.find((item) => item.kind === "client-trial-runner" && item.exists);
  const clientTrialRunner = readOptionalJson(clientTrialRunnerArtifact?.path || "");
  const latestN1 = readOptionalJson("reports/n1/latest-post-deploy.json");
  const n1Summary = readOptionalJson(record.evidence?.n1?.summaryPath || "");
  const evidenceDrift = findCurrentEvidenceDrift(record, {
    releaseManifest,
    desktopSmoke,
    portableSmoke,
    latestN1
  });

  observations.push(observation("release-bundle-preflight", releaseManifest?.preflightVerified === true ? "ok" : "attention", {
    message: releaseManifest?.preflightVerified === true
      ? "Release bundle manifest reports preflightVerified=true."
      : "Release bundle manifest is missing or not preflightVerified=true.",
    artifacts: artifactPaths(artifacts, ["release-bundle-manifest"])
  }));
  observations.push(observation("strict-preflight-report", preflight?.releaseOk === true && preflight?.summary?.failed === 0 && preflight?.summary?.skipped === 0 ? "ok" : "attention", {
    message: preflight?.releaseOk === true
      ? "Preflight report is releaseOk with failed=0 and skipped=0."
      : "Preflight report is missing or not releaseOk.",
    details: preflight?.summary || null,
    artifacts: artifactPaths(artifacts, ["preflight-json"])
  }));
  observations.push(observation("electron-window-smoke", electronWindow?.ok === true ? "ok" : "attention", {
    message: electronWindow?.ok === true
      ? "Electron window smoke passed."
      : "Electron window smoke report is missing or not ok.",
    details: electronWindow?.summary || null,
    artifacts: artifactPaths(artifacts, ["electron-window-smoke"])
  }));
  observations.push(observation("electron-e2e-fake-sync", electronE2e?.ok === true && hasCheck(electronE2e, "sync run/stop/history verified through UI") ? "ok" : "attention", {
    message: electronE2e?.ok === true
      ? "Electron E2E smoke passed and covers fake sync run/stop/history."
      : "Electron E2E smoke report is missing or not ok.",
    details: electronE2e?.summary || null,
    artifacts: artifactPaths(artifacts, ["electron-e2e-smoke"])
  }));
  observations.push(observation("client-package-smokes", desktopSmoke?.ok === true && portableSmoke?.ok === true ? "ok" : "attention", {
    message: desktopSmoke?.ok === true && portableSmoke?.ok === true
      ? "Desktop and portable package smokes both passed."
      : "One or both package smoke reports are missing or not ok.",
    details: {
      desktop: desktopSmoke?.summary || null,
      portable: portableSmoke?.summary || null
    },
    artifacts: artifactPaths(artifacts, ["desktop-package-smoke", "portable-package-smoke"])
  }));
  observations.push(observation("trial-evidence-alignment", evidenceDrift.length ? "attention" : "ok", {
    message: evidenceDrift.length
      ? `Internal trial record is not bound to the current Beta evidence: ${evidenceDrift.join("; ")}.`
      : "Internal trial record matches the current release bundle, client packages, and N1 run.",
    details: { drift: evidenceDrift },
    artifacts: artifactPaths(artifacts, ["trial-record", "release-bundle-manifest", "n1-latest"])
  }));
  observations.push(observation("n1-release-acceptance", latestN1?.ok === true && n1Summary?.acceptance?.releaseAcceptance?.releaseBundleVerified === true ? "ok" : "attention", {
    message: latestN1?.ok === true
      ? "Latest N1 post-deploy pointer is ok and bound to release acceptance evidence."
      : "Latest N1 post-deploy pointer is missing or not ok.",
    details: {
      runId: latestN1?.runId || n1Summary?.runId || "",
      releaseBundleVerified: n1Summary?.acceptance?.releaseAcceptance?.releaseBundleVerified === true,
      restartRequired: n1Summary?.acceptance?.releaseAcceptance?.restartRequired === true,
      targetHostsMatch: n1Summary?.acceptance?.target?.targetHostsMatch === true
    },
    artifacts: artifactPaths(artifacts, ["n1-latest", "n1-summary"])
  }));
  if (clientTrialRunner) {
    observations.push(observation("client-trial-runner", clientTrialRunner.ok === true ? "ok" : "attention", {
      message: clientTrialRunner.ok === true
        ? "Client trial runner completed; object storage and UI experience still require human confirmation."
        : "Client trial runner report exists but is not ok.",
      details: {
        mode: clientTrialRunner.mode || "",
        passed: clientTrialRunner.summary?.passed || 0,
        failed: clientTrialRunner.summary?.failed || 0
      },
      artifacts: artifactPaths(artifacts, ["client-trial-runner"])
    }));
  }

  if (diagnosticPath) {
    observations.push(scanDiagnosticArtifact(diagnosticPath, artifacts));
  }

  return observations;
}

function buildSectionHints(record, observations) {
  const byId = new Map(observations.map((item) => [item.id, item]));
  return [
    sectionHint("release-evidence", [
      machineCheck("release-bundle-preflight", byId.get("release-bundle-preflight")),
      machineCheck("strict-preflight-report", byId.get("strict-preflight-report")),
      machineCheck("n1-release-acceptance", byId.get("n1-release-acceptance")),
      machineCheck("trial-evidence-alignment", byId.get("trial-evidence-alignment"))
    ], [
      "release bundle ZIP SHA256",
      "desktop ZIP SHA256",
      "portable ZIP SHA256",
      "N1 post-deploy summary path"
    ], "Tester must confirm the delivery artifacts match the files actually handed to trial users."),
    sectionHint("install-first-launch", [
      machineCheck("electron-window-smoke", byId.get("electron-window-smoke")),
      machineCheck("client-package-smokes", byId.get("client-package-smokes"))
    ], [
      "clean Windows launch notes",
      "first /api/client/status screenshot or diagnostic excerpt"
    ], "Tester must launch the delivered desktop package on the target Windows environment."),
    sectionHint("t-key-profile", [
      machineCheck("n1-release-acceptance", byId.get("n1-release-acceptance")),
      machineCheck("client-trial-runner", byId.get("client-trial-runner") || null)
    ], [
      "real N1 SyncKey creation timestamp",
      "client import result",
      "server device summary after import"
    ], "Tester must generate and import a real one-time SyncKey against the target N1/server."),
    sectionHint("folder-job-save", [
      machineCheck("electron-e2e-fake-sync", byId.get("electron-e2e-fake-sync")),
      machineCheck("client-trial-runner", byId.get("client-trial-runner") || null)
    ], [
      "selected local folder path",
      "saved job status or screenshot"
    ], "Tester must use the real folder picker or manual full-path fallback on the target machine."),
    sectionHint("preview-small-sync", [
      machineCheck("electron-e2e-fake-sync", byId.get("electron-e2e-fake-sync")),
      machineCheck("client-trial-runner", byId.get("client-trial-runner") || null)
    ], [
      "preview output redaction note",
      "object storage verification after small sync"
    ], "Tester must run a real small sync and verify the remote object changes."),
    sectionHint("stop-restart-recovery", [
      machineCheck("electron-e2e-fake-sync", byId.get("electron-e2e-fake-sync")),
      machineCheck("client-trial-runner", byId.get("client-trial-runner") || null)
    ], [
      "stop action result",
      "restart status",
      "profile/jobs/history still readable"
    ], "Tester must stop a real in-progress sync, restart the client, and verify local state recovery."),
    sectionHint("diagnostics-privacy", [
      machineCheck("electron-e2e-fake-sync", byId.get("electron-e2e-fake-sync")),
      machineCheck("client-trial-runner", byId.get("client-trial-runner") || null),
      machineCheck("manual-diagnostics-scan", byId.get("manual-diagnostics-scan") || null)
    ], [
      "exported diagnostics JSON path",
      "redaction scan result"
    ], "Tester must export diagnostics from the real trial run and confirm no operational secrets are present."),
    sectionHint("portable-compat", [
      machineCheck("client-package-smokes", byId.get("client-package-smokes"))
    ], [
      "portable package launch result",
      "portable diagnostic export"
    ], "Tester must run the portable package if it is included in this trial delivery.")
  ].map((hint) => {
    const section = (record.sections || []).find((item) => item.id === hint.sectionId) || {};
    return { ...hint, currentRecordStatus: section.status || "missing" };
  });
}

function findCurrentEvidenceDrift(record, current) {
  const currentRelease = releaseBundlePaths(projectRoot);
  const drift = [];
  const evidence = record.evidence || {};
  const release = evidence.releaseBundle || {};
  const desktop = evidence.desktopPackage || {};
  const portable = evidence.portablePackage || {};
  const n1 = evidence.n1 || {};
  const currentDesktopVersion = current.desktopSmoke?.context?.releaseManifest?.version || current.desktopSmoke?.summary?.version || "";
  const currentPortableVersion = current.portableSmoke?.context?.releaseManifest?.version || current.portableSmoke?.summary?.version || "";

  if (!release.sha256 || release.sha256 !== fileSha256(repoPath(currentRelease.zip))) {
    drift.push("release bundle SHA256 differs");
  }
  if (!release.version || release.version !== current.releaseManifest?.version) {
    drift.push("release bundle version differs");
  }
  if (!desktop.sha256 || desktop.sha256 !== fileSha256(repoPath("dist/SyncraftDesktop.zip"))) {
    drift.push("desktop package SHA256 differs");
  }
  if (currentDesktopVersion && desktop.version !== currentDesktopVersion) {
    drift.push("desktop package version differs");
  }
  if (!portable.sha256 || portable.sha256 !== fileSha256(repoPath("dist/SyncraftClient.zip"))) {
    drift.push("portable package SHA256 differs");
  }
  if (currentPortableVersion && portable.version !== currentPortableVersion) {
    drift.push("portable package version differs");
  }
  if (!n1.runId || n1.runId !== current.latestN1?.runId) {
    drift.push("N1 release acceptance run differs");
  }
  return drift;
}

function collectRedFlags(record, observations) {
  const redFlags = [];
  const environment = record.environment || {};
  for (const field of ["tester", "date", "windowsVersion", "machine", "serverBaseUrl"]) {
    if (!String(environment[field] || "").trim()) {
      redFlags.push({ id: `environment-${field}-missing`, severity: "attention", message: `Trial record environment.${field} is empty.` });
    }
  }
  for (const section of record.sections || []) {
    if (section.status === "passed" && !String(section.notes || "").trim() && !(section.artifacts || []).length) {
      redFlags.push({ id: `section-${section.id}-passed-without-evidence`, severity: "attention", message: `Section ${section.id} is marked passed without notes or artifacts.` });
    }
    if (section.id === "portable-compat" && section.status === "skipped" && !String(section.notes || "").trim()) {
      redFlags.push({ id: "portable-skipped-without-note", severity: "attention", message: "portable-compat is skipped without explaining whether portable delivery is out of scope." });
    }
  }
  for (const item of observations) {
    if (item.status === "attention") {
      redFlags.push({ id: `observation-${item.id}`, severity: "attention", message: item.message });
    }
  }
  return redFlags;
}

function collectRequiredHumanActions(record, sectionHints) {
  const pending = new Set((record.sections || [])
    .filter((section) => section.status === "pending")
    .map((section) => section.id));
  return sectionHints
    .filter((hint) => pending.has(hint.sectionId))
    .map((hint) => ({
      sectionId: hint.sectionId,
      action: hint.humanGate,
      suggestedArtifacts: hint.suggestedArtifacts
    }));
}

function sectionHint(sectionId, machineChecks, suggestedArtifacts, humanGate) {
  const usefulChecks = machineChecks.filter(Boolean);
  const assistantStatus = usefulChecks.some((check) => check.status === "attention")
    ? "needs-human-review"
    : usefulChecks.length
      ? "observed"
      : "not-run";
  return {
    sectionId,
    assistantStatus,
    machineChecks: usefulChecks,
    suggestedArtifacts,
    humanGate
  };
}

function machineCheck(id, source) {
  if (!source) {
    return { id, status: "not-run", evidence: [], message: "No machine-readable evidence was available." };
  }
  return {
    id,
    status: source.status,
    evidence: source.artifacts || [],
    message: source.message
  };
}

function scanDiagnosticArtifact(path, artifacts) {
  const diag = readOptionalText(path);
  if (diag == null) {
    return observation("manual-diagnostics-scan", "attention", {
      message: "Provided diagnostics JSON path does not exist or could not be read.",
      artifacts: artifactPaths(artifacts, ["manual-diagnostics-json"])
    });
  }
  const findings = [];
  for (const [id, pattern] of [
    ["t-key", /SFSC1-[A-Za-z0-9_-]+/],
    ["vless-uri", /vless:\/\/[^\s"']+/i],
    ["storage-secret-field", /secret[_-]?access[_-]?key["']?\s*[:=]\s*["']?[^"'\s,*]{6,}/i],
    ["heartbeat-secret-field", /heartbeatSecret["']?\s*[:=]\s*["']?[^"'\s,*]{6,}/i],
    ["admin-token-field", /admin[_-]?token["']?\s*[:=]\s*["']?[^"'\s,*]{12,}/i]
  ]) {
    if (pattern.test(diag)) {
      findings.push(id);
    }
  }
  return observation("manual-diagnostics-scan", findings.length ? "attention" : "ok", {
    message: findings.length
      ? `Diagnostics scan found sensitive-looking patterns: ${findings.join(", ")}.`
      : "Diagnostics scan found no known sensitive patterns.",
    details: { findings },
    artifacts: artifactPaths(artifacts, ["manual-diagnostics-json"])
  });
}

function observation(id, status, extra = {}) {
  return {
    id,
    status,
    ...extra
  };
}

function artifact(kind, path) {
  const fullPath = repoPath(path);
  const exists = existsSync(fullPath);
  return {
    kind,
    path: rel(fullPath),
    exists,
    sha256: exists ? fileSha256(fullPath) : "",
    observedAt: new Date().toISOString()
  };
}

function artifactPaths(artifacts, kinds) {
  const wanted = new Set(kinds);
  return artifacts.filter((item) => wanted.has(item.kind) && item.exists).map((item) => item.path);
}

function findRecordArtifactPaths(record, pattern) {
  const paths = [];
  for (const section of record.sections || []) {
    for (const item of section.artifacts || []) {
      const path = String(item || "").trim().replaceAll("\\", "/");
      if (pattern.test(path) && !paths.includes(path)) {
        paths.push(path);
      }
    }
  }
  return paths;
}

function hasCheck(report, text) {
  return Array.isArray(report?.checks) && report.checks.some((check) => String(check).includes(text));
}

function readOptionalJson(path) {
  if (!path) return null;
  try {
    return JSON.parse(readFileSync(repoPath(path), "utf8"));
  } catch {
    return null;
  }
}

function readOptionalText(path) {
  try {
    return readFileSync(repoPath(path), "utf8");
  } catch {
    return null;
  }
}

function readJson(path, label) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`${label} could not be read as JSON (${path}): ${error.message}`);
  }
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

function readArg(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? "" : process.argv[index + 1] || "";
}

function printSummary(report) {
  console.log(`Internal trial assistant ${report.assistantOk ? "completed" : "failed"}: ${outputPath}`);
  console.log(`- recommendation: ${report.recommendation}`);
  console.log(`- observations: ${report.observations.filter((item) => item.status === "ok").length} ok, ${report.observations.filter((item) => item.status === "attention").length} attention`);
  console.log(`- required human actions: ${report.requiredHumanActions.length}`);
  if (report.redFlags.length) {
    console.log(`- red flags: ${report.redFlags.map((item) => item.id).join(", ")}`);
  }
}
