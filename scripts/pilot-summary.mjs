import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assertReportSafe, writeJsonReportSync } from "./lib/reportSecrets.mjs";
import { releaseBundlePaths } from "./lib/releasePaths.mjs";

const projectRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const cohortDir = repoPath(readArg("--cohort-dir") || latestPilotDir() || "reports/pilot");
const outputPath = repoPath(readArg("--output") || join(relative(projectRoot, cohortDir), "pilot-summary.json"));
const exitCriteriaAnchor = "install success rate must be >= 90%";

try {
  const report = buildSummary();
  mkdirSync(dirname(outputPath), { recursive: true });
  writeJsonReportSync(outputPath, report, "pilot summary");
  printSummary(report);
  console.log(`Pilot summary written: ${rel(outputPath)}`);
  if (!report.ok && hasArg("--fail-on-not-ready")) {
    process.exitCode = 1;
  }
} catch (error) {
  console.error(`Pilot summary failed: ${error.message || error}`);
  process.exitCode = 1;
}

function buildSummary() {
  const wave = readOptionalJson(join(cohortDir, "pilot-wave.json"));
  const records = findParticipantRecords(cohortDir).map(readParticipantRecord);
  const release = releaseEvidence(wave);
  const dailyHealth = summarizeDailyHealth(readDailyHealth());
  const metrics = summarizeMetrics(records);
  const blockers = collectBlockers(records, release, metrics, dailyHealth);
  return {
    schemaVersion: 1,
    app: "singbox-folder-sync",
    type: "pilot-summary",
    ok: blockers.length === 0 && records.length >= 5 && metrics.exitCriteriaReady === true && dailyHealth.ready === true,
    generatedAt: new Date().toISOString(),
    cohortId: wave?.cohortId || records[0]?.cohortId || basename(cohortDir),
    cohortDir: rel(cohortDir),
    participantCount: records.length,
    release,
    dailyHealth,
    metrics,
    participants: records.map(summarizeParticipant),
    blockers,
    recommendation: recommendation(blockers, records, metrics),
    safety: {
      plaintextTKeyStored: false,
      importUriStored: false,
      note: "Summary contains status, paths, hashes, and error codes only; it must not contain real SyncKey, sfsc import URI, VLESS URI, token, or storage secrets."
    }
  };
}

function releaseEvidence(wave = {}) {
  const releasePaths = releaseBundlePaths(projectRoot);
  const releaseManifest = readOptionalJson(releasePaths.manifest);
  const betaBaseline = readOptionalJson("reports/beta-host/beta-candidate-baseline.json");
  const n1Latest = readOptionalJson("reports/n1/latest-post-deploy.json");
  const n1Summary = readOptionalJson(n1Latest?.summaryJson || "");
  const internalTrial = readOptionalJson("reports/internal-trial/internal-trial-record.json");
  const assistant = readOptionalJson("reports/internal-trial/internal-trial-assistant.json");
  return {
    releaseBundle: {
      path: releasePaths.zip,
      exists: existsSync(repoPath(releasePaths.zip)),
      sha256: fileSha256IfExists(releasePaths.zip),
      preflightVerified: releaseManifest?.preflightVerified === true,
      preflightSummary: releaseManifest?.preflightVerification?.summary || releaseManifest?.preflight?.summary || null,
      desktopFileCount: releaseManifest?.preflightVerified ? releaseManifest?.artifacts ? null : null : null,
      generatedAt: releaseManifest?.generatedAt || ""
    },
    deployment: deploymentEvidence({ wave, releaseManifest, betaBaseline, n1Latest, n1Summary }),
    n1: {
      ok: n1Latest?.ok === true && n1Summary?.ok === true,
      runId: n1Latest?.runId || n1Summary?.runId || "",
      releaseBundleVerified: n1Summary?.acceptance?.releaseAcceptance?.releaseBundleVerified === true,
      restartRequired: n1Summary?.acceptance?.releaseAcceptance?.restartRequired === false ? false : n1Summary?.acceptance?.releaseAcceptance?.restartRequired,
      finalRestartClear: n1Summary?.acceptance?.releaseAcceptance?.finalRestartClear === true,
      targetHostsMatch: n1Summary?.acceptance?.target?.targetHostsMatch === true
    },
    internalTrial: {
      ok: internalTrial?.ok === true,
      sectionsPassed: Array.isArray(internalTrial?.sections) ? internalTrial.sections.filter((section) => section.status === "passed").length : 0,
      assistantRecommendation: assistant?.recommendation || ""
    }
  };
}

function deploymentEvidence({ wave, releaseManifest, betaBaseline, n1Latest, n1Summary }) {
  const betaHost = String(betaBaseline?.server?.baseUrl || "");
  const useBetaHost = /^https:\/\//.test(String(wave?.serverBaseUrl || "")) && betaHost === wave.serverBaseUrl;
  if (useBetaHost) {
    const buildId = String(releaseManifest?.buildId || "");
    const sourceTreeHash = String(releaseManifest?.sourceTreeHash || "");
    const aligned = betaBaseline?.candidate?.buildId === buildId
      && betaBaseline?.candidate?.sourceTreeHash === sourceTreeHash
      && betaBaseline?.server?.buildId === buildId;
    return {
      mode: "public-beta",
      ok: aligned && betaBaseline?.verification?.serverSmoke?.ok === true && betaBaseline?.verification?.realClientSync?.ok === true,
      baseUrl: betaHost,
      buildId,
      restartRequired: betaBaseline?.server?.restartRequired === false ? false : betaBaseline?.server?.restartRequired,
      finalRestartClear: betaBaseline?.server?.restartRequired === false,
      releaseBundleVerified: aligned,
      evidencePath: "reports/beta-host/beta-candidate-baseline.json"
    };
  }
  const ok = n1Latest?.ok === true && n1Summary?.ok === true;
  return {
    mode: "n1-fallback",
    ok,
    baseUrl: "",
    buildId: n1Summary?.acceptance?.delivery?.releaseBundle?.buildId || "",
    restartRequired: n1Summary?.acceptance?.releaseAcceptance?.restartRequired === false ? false : n1Summary?.acceptance?.releaseAcceptance?.restartRequired,
    finalRestartClear: n1Summary?.acceptance?.releaseAcceptance?.finalRestartClear === true,
    releaseBundleVerified: n1Summary?.acceptance?.releaseAcceptance?.releaseBundleVerified === true,
    evidencePath: "reports/n1/latest-post-deploy.json"
  };
}

function readDailyHealth() {
  const health = readOptionalJson(join(cohortDir, "pilot-daily-health.json"));
  if (!health) return null;
  if (health.type !== "pilot-daily-health") {
    throw new Error(`Not a pilot daily health record: ${rel(join(cohortDir, "pilot-daily-health.json"))}`);
  }
  assertReportSafe(health, "pilot daily health");
  return health;
}

function summarizeDailyHealth(health) {
  const records = Array.isArray(health?.records) ? health.records.map(summarizeDailyHealthEntry) : [];
  const completeRecords = records.filter((record) => record.complete);
  const recentCompleteRecords = completeRecords.slice(-3);
  const recentFailingRecords = recentCompleteRecords.filter((record) => !record.ok);
  return {
    path: rel(join(cohortDir, "pilot-daily-health.json")),
    exists: health !== null,
    recordCount: records.length,
    completeRecordCount: completeRecords.length,
    requiredConsecutiveDays: 3,
    recentCompleteRecords,
    failingRecords: records.filter((record) => record.complete && !record.ok),
    ready: recentCompleteRecords.length >= 3 && recentFailingRecords.length === 0
  };
}

function summarizeDailyHealthEntry(record) {
  const activeParticipants = nonNegativeInteger(record?.activeParticipants);
  const successfulHeartbeats24h = nonNegativeInteger(record?.successfulHeartbeats24h);
  const heartbeatSuccessRate = activeParticipants > 0
    ? rate(Math.min(successfulHeartbeats24h, activeParticipants), activeParticipants)
    : 0;
  const heartbeatWindowOk = record?.heartbeatWindowOk === true || heartbeatSuccessRate >= 0.9;
  const complete = Boolean(
    hasText(record?.date)
      && hasText(record?.checkedAt)
      && hasText(record?.checkedBy)
      && deploymentHealthOk(record)
      && deploymentEvidenceOk(record)
      && record?.restartRequired === false
      && record?.finalRestartClear === true
      && activeParticipants > 0
      && hasText(record?.diagnosticSampleArtifact)
      && hasText(record?.prefixSampleArtifact)
  );
  const ok = Boolean(
    complete
      && heartbeatWindowOk
      && nonNegativeInteger(record?.openP1Count) === 0
      && nonNegativeInteger(record?.openP2Count) <= 3
  );
  return {
    day: nonNegativeInteger(record?.day),
    date: String(record?.date || ""),
    checkedAt: String(record?.checkedAt || ""),
    checkedBy: String(record?.checkedBy || ""),
    serverHealthOk: deploymentHealthOk(record),
    candidateBaselineOk: deploymentEvidenceOk(record),
    restartRequired: record?.restartRequired === false ? false : record?.restartRequired,
    finalRestartClear: record?.finalRestartClear === true,
    activeParticipants,
    successfulHeartbeats24h,
    heartbeatSuccessRate,
    heartbeatWindowOk,
    openP1Count: nonNegativeInteger(record?.openP1Count),
    openP2Count: nonNegativeInteger(record?.openP2Count),
    diagnosticSampleArtifact: String(record?.diagnosticSampleArtifact || ""),
    prefixSampleArtifact: String(record?.prefixSampleArtifact || ""),
    complete,
    ok
  };
}

function deploymentHealthOk(record) {
  return record?.serverHealthOk === true || record?.n1HealthOk === true;
}

function deploymentEvidenceOk(record) {
  return record?.candidateBaselineOk === true || record?.n1PostDeployOk === true;
}

function summarizeMetrics(records) {
  const total = records.length;
  const installOk = countMetric(records, "installOk");
  const importOk = countMetric(records, "importOk");
  const firstSyncEvidenceMissing = records
    .filter((record) => record.metrics?.firstSyncOk === true && !hasConfirmedSyncPrefix(record))
    .map((record) => record.participant?.participantId || record.__path || "unknown-participant");
  const firstSyncOk = records
    .filter((record) => record.metrics?.firstSyncOk === true && hasConfirmedSyncPrefix(record))
    .length;
  const diagnosticsOk = countMetric(records, "diagnosticsOk");
  const completedRollbackDrills = records.filter(hasCompleteRollbackDrill).map((record) => ({
    participantId: record.participant?.participantId || "",
    packageType: String(record.rollbackDrill?.packageType || ""),
    fromVersion: String(record.rollbackDrill?.fromVersion || ""),
    toVersion: String(record.rollbackDrill?.toVersion || ""),
    verificationArtifact: String(record.rollbackDrill?.verificationArtifact || ""),
    recoveredAt: String(record.rollbackDrill?.recoveredAt || ""),
    owner: String(record.rollbackDrill?.owner || "")
  }));
  const incompleteRollbackDrills = records
    .filter((record) => record.rollbackDrill?.performed === true && !hasCompleteRollbackDrill(record))
    .map((record) => record.participant?.participantId || record.__path || "unknown-participant");
  const rollbackDrillOk = completedRollbackDrills.length;
  const p0 = records.flatMap((record) => issues(record, "P0"));
  const p1 = records.flatMap((record) => issues(record, "P1"));
  const p2 = records.flatMap((record) => issues(record, "P2"));
  const openIssues = records.flatMap(openIssuesWithParticipant);
  const duplicateErrorCodes = summarizeDuplicateErrorCodes(openIssues);
  const p2MissingFollowup = p2
    .filter((issue) => !hasText(issue.owner) || !hasText(issue.nextAction))
    .map((issue) => issue.id || issue.errorCode || "unknown-p2");
  const p1p2MissingDiagnosticArtifacts = [...p1, ...p2]
    .filter((issue) => !hasDiagnosticArtifact(issue))
    .map((issue) => issue.id || issue.errorCode || "unknown-issue");
  const p1p2Issues = records.flatMap((record) => issuesWithParticipant(record, ["P1", "P2"], { includeClosed: true }));
  const supportResponseMissing = p1p2Issues
    .filter((issue) => supportResponseSummary(issue).missing)
    .map((issue) => issue.id || issue.errorCode || "unknown-issue");
  const supportResponseBreaches = p1p2Issues
    .map((issue) => supportResponseSummary(issue))
    .filter((summary) => summary.breached);
  const installRate = rate(installOk, total);
  const importRate = rate(importOk, total);
  const firstSyncRate = rate(firstSyncOk, total);
  const diagnosticsRate = rate(diagnosticsOk, total);
  return {
    total,
    installOk,
    importOk,
    firstSyncOk,
    firstSyncEvidenceMissing,
    diagnosticsOk,
    rollbackDrillOk,
    completedRollbackDrills,
    incompleteRollbackDrills,
    installRate,
    importRate,
    firstSyncRate,
    diagnosticsRate,
    p0Count: p0.length,
    p1Count: p1.length,
    p2Count: p2.length,
    duplicateErrorCodes,
    p2MissingFollowup,
    p1p2MissingDiagnosticArtifacts,
    supportResponseMissing,
    supportResponseBreaches,
    exitCriteriaReady: total >= 5
      && installRate >= 0.9
      && importRate >= 0.9
      && firstSyncRate >= 0.9
      && firstSyncEvidenceMissing.length === 0
      && diagnosticsRate >= 0.9
      && p0.length === 0
      && p1.length === 0
      && p2.length <= 3
      && p2MissingFollowup.length === 0
      && p1p2MissingDiagnosticArtifacts.length === 0
      && supportResponseMissing.length === 0
      && supportResponseBreaches.length === 0
      && duplicateErrorCodes.length === 0
      && incompleteRollbackDrills.length === 0
      && rollbackDrillOk >= 1
  };
}

function collectBlockers(records, release, metrics, dailyHealth) {
  const blockers = [];
  if (records.length < 5) blockers.push("participantCount must be at least 5 for small pilot exit criteria");
  if (release.releaseBundle.preflightVerified !== true) blockers.push("release bundle preflightVerified must be true");
  if (release.deployment.ok !== true) blockers.push("selected deployment baseline must be healthy and align with the release bundle");
  if (release.deployment.releaseBundleVerified !== true) blockers.push("selected deployment baseline must verify the release bundle build");
  if (release.deployment.restartRequired !== false) blockers.push("selected deployment restartRequired must be false");
  if (release.deployment.finalRestartClear !== true) blockers.push("selected deployment must confirm the applied configuration");
  if (release.internalTrial.ok !== true) blockers.push("internal trial record must be ok");
  if (release.internalTrial.assistantRecommendation !== "ready-for-human-review") blockers.push("internal trial assistant must be ready-for-human-review");
  if (dailyHealth.exists !== true) blockers.push("pilot daily health record must exist");
  if (dailyHealth.completeRecordCount < 3) blockers.push("pilot daily health must include at least 3 complete daily records");
  for (const record of dailyHealth.recentCompleteRecords || []) {
    if (record.ok) continue;
    blockers.push(`pilot daily health ${record.date || `day ${record.day}`} must have deployment health, restartRequired=false, >=90% active heartbeats, P1=0, P2<=3, diagnostic sample, and prefix sample`);
  }
  if (metrics.installRate < 0.9) blockers.push(exitCriteriaAnchor);
  if (metrics.importRate < 0.9) blockers.push("SyncKey import success rate must be >= 90%");
  if (metrics.firstSyncRate < 0.9) blockers.push("first sync success rate must be >= 90%");
  for (const participantId of metrics.firstSyncEvidenceMissing || []) {
    blockers.push(`participant ${participantId} first sync must confirm the expected pilot remote folder`);
  }
  if (metrics.diagnosticsRate < 0.9) blockers.push("diagnostics success rate must be >= 90%");
  if (metrics.rollbackDrillOk < 1) blockers.push("at least one rollback drill must be completed");
  for (const participantId of metrics.incompleteRollbackDrills || []) {
    blockers.push(`participant ${participantId} rollback drill must include packageType, versions, data backup confirmation, verification artifact, recoveredAt, and owner`);
  }
  if (metrics.p0Count > 0) blockers.push("P0 issues must be zero");
  if (metrics.p1Count > 0) blockers.push("P1 issues must be zero before expanding");
  if (metrics.p2Count > 3) blockers.push("open P2 issues must be no more than 3");
  for (const issueId of metrics.p2MissingFollowup || []) {
    blockers.push(`P2 issue ${issueId} must have owner and nextAction before signoff`);
  }
  for (const issueId of metrics.p1p2MissingDiagnosticArtifacts || []) {
    blockers.push(`P1/P2 issue ${issueId} must include a redacted diagnostic artifact`);
  }
  for (const issueId of metrics.supportResponseMissing || []) {
    blockers.push(`P1/P2 issue ${issueId} must include issueStartedAt and firstResponseAt`);
  }
  for (const breach of metrics.supportResponseBreaches || []) {
    blockers.push(`${breach.severity} issue ${breach.id} first response must be within ${breach.limitMinutes} minutes`);
  }
  for (const duplicate of metrics.duplicateErrorCodes || []) {
    blockers.push(`stable error code ${duplicate.errorCode} affects ${duplicate.participantCount} participants`);
  }
  return blockers;
}

function summarizeParticipant(record) {
  return {
    recordPath: record.__path,
    cohortId: record.cohortId || "",
    participantId: record.participant?.participantId || "",
    wave: record.participant?.wave || "",
    clientName: record.participant?.clientName || "",
    remoteFolder: record.participant?.remoteFolder || "",
    ok: record.ok === true,
    metrics: {
      installOk: record.metrics?.installOk === true,
      importOk: record.metrics?.importOk === true,
      firstSyncOk: record.metrics?.firstSyncOk === true,
      diagnosticsOk: record.metrics?.diagnosticsOk === true,
      rollbackDrillOk: hasCompleteRollbackDrill(record)
    },
    rollbackDrill: summarizeRollbackDrill(record),
    failedGates: Array.isArray(record.gates)
      ? record.gates.filter((gate) => gate.status === "failed").map((gate) => gate.id)
      : [],
    pendingGates: Array.isArray(record.gates)
      ? record.gates.filter((gate) => gate.status === "pending").map((gate) => gate.id)
      : [],
    issues: Array.isArray(record.issues)
      ? record.issues.map((issue) => ({
        id: String(issue.id || ""),
        severity: String(issue.severity || ""),
        status: String(issue.status || ""),
        errorCode: String(issue.errorCode || ""),
        diagnosticArtifact: diagnosticArtifact(issue),
        issueStartedAt: String(issue.issueStartedAt || ""),
        firstResponseAt: String(issue.firstResponseAt || ""),
        responseMinutes: supportResponseSummary(issue).responseMinutes
      }))
      : []
  };
}

function recommendation(blockers, records, metrics) {
  if (!records.length) return "prepare-participant-records";
  if (metrics.p0Count > 0) return "stop-pilot-immediately";
  if (metrics.p1Count > 0) return "hold-expansion-until-p1-resolved";
  if (blockers.length) return "continue-observation";
  return "ready-for-pilot-signoff";
}

function findParticipantRecords(root) {
  if (!existsSync(root)) return [];
  const found = [];
  walk(root, (path) => {
    if (path.endsWith("participant-record.json")) {
      found.push(path);
    }
  });
  return found.sort();
}

function readParticipantRecord(path) {
  const record = readJson(path, "participant record");
  if (record.type !== "pilot-participant-record") {
    throw new Error(`Not a pilot participant record: ${rel(path)}`);
  }
  assertReportSafe(record, rel(path));
  record.__path = rel(path);
  return record;
}

function countMetric(records, name) {
  return records.filter((record) => record.metrics?.[name] === true).length;
}

function hasConfirmedSyncPrefix(record) {
  const evidence = record.syncEvidence || {};
  const expected = String(evidence.expectedRemoteFolder || record.participant?.remoteFolder || "").trim();
  const actual = String(evidence.actualRemoteFolderConfirmed || "").trim();
  return Boolean(
    expected
      && actual === expected
      && hasText(evidence.prefixEvidenceArtifact)
      && hasText(evidence.prefixCheckAt)
  );
}

function hasCompleteRollbackDrill(record) {
  const drill = record.rollbackDrill || {};
  return Boolean(
    drill.performed === true
      && hasText(drill.packageType)
      && hasText(drill.fromVersion)
      && hasText(drill.toVersion)
      && drill.dataBackupConfirmed === true
      && hasText(drill.verificationArtifact)
      && hasText(drill.recoveredAt)
      && hasText(drill.owner)
  );
}

function summarizeRollbackDrill(record) {
  const drill = record.rollbackDrill || {};
  return {
    performed: drill.performed === true,
    complete: hasCompleteRollbackDrill(record),
    packageType: String(drill.packageType || ""),
    fromVersion: String(drill.fromVersion || ""),
    toVersion: String(drill.toVersion || ""),
    dataBackupConfirmed: drill.dataBackupConfirmed === true,
    verificationArtifact: String(drill.verificationArtifact || ""),
    recoveredAt: String(drill.recoveredAt || ""),
    owner: String(drill.owner || "")
  };
}

function rate(count, total) {
  return total ? Number((count / total).toFixed(4)) : 0;
}

function issues(record, severity) {
  return Array.isArray(record.issues)
    ? record.issues.filter((issue) => String(issue.severity || "").toUpperCase() === severity && String(issue.status || "open") !== "closed")
    : [];
}

function issuesWithParticipant(record, severities, options = {}) {
  if (!Array.isArray(record.issues)) return [];
  const allowed = new Set(severities.map((severity) => severity.toUpperCase()));
  const participantId = record.participant?.participantId || "";
  return record.issues
    .filter((issue) => allowed.has(String(issue.severity || "").toUpperCase()))
    .filter((issue) => options.includeClosed || String(issue.status || "open") !== "closed")
    .map((issue) => ({ ...issue, participantId }));
}

function openIssuesWithParticipant(record) {
  if (!Array.isArray(record.issues)) return [];
  const participantId = record.participant?.participantId || "";
  return record.issues
    .filter((issue) => String(issue.status || "open") !== "closed")
    .map((issue) => ({
      ...issue,
      participantId,
      severity: String(issue.severity || ""),
      errorCode: String(issue.errorCode || "")
    }));
}

function hasDiagnosticArtifact(issue) {
  return hasText(diagnosticArtifact(issue));
}

function diagnosticArtifact(issue) {
  if (hasText(issue?.diagnosticArtifact)) {
    return String(issue.diagnosticArtifact);
  }
  if (Array.isArray(issue?.artifacts)) {
    const diagnostic = issue.artifacts.find((artifact) => {
      if (typeof artifact === "string") {
        return /diagnostic|诊断/i.test(artifact);
      }
      return /diagnostic|诊断/i.test(String(artifact?.kind || artifact?.type || artifact?.path || ""));
    });
    if (diagnostic) {
      return typeof diagnostic === "string" ? diagnostic : String(diagnostic.path || diagnostic.name || diagnostic.kind || diagnostic.type || "");
    }
  }
  return "";
}

function supportResponseSummary(issue) {
  const severity = String(issue?.severity || "").toUpperCase();
  const limitMinutes = severity === "P1" ? 120 : severity === "P2" ? 1440 : null;
  const id = String(issue?.id || issue?.errorCode || "unknown-issue");
  const startedAt = Date.parse(String(issue?.issueStartedAt || ""));
  const firstResponseAt = Date.parse(String(issue?.firstResponseAt || ""));
  if (!limitMinutes || !Number.isFinite(startedAt) || !Number.isFinite(firstResponseAt) || firstResponseAt < startedAt) {
    return {
      id,
      participantId: String(issue?.participantId || ""),
      severity,
      limitMinutes,
      responseMinutes: null,
      missing: true,
      breached: false
    };
  }
  const responseMinutes = Math.round((firstResponseAt - startedAt) / 60000);
  return {
    id,
    participantId: String(issue?.participantId || ""),
    severity,
    limitMinutes,
    responseMinutes,
    missing: false,
    breached: responseMinutes > limitMinutes
  };
}

function summarizeDuplicateErrorCodes(openIssues) {
  const groups = new Map();
  for (const issue of openIssues) {
    const errorCode = String(issue.errorCode || "").trim();
    if (!errorCode) continue;
    if (!groups.has(errorCode)) {
      groups.set(errorCode, new Set());
    }
    groups.get(errorCode).add(issue.participantId || "unknown");
  }
  return [...groups.entries()]
    .map(([errorCode, participants]) => ({
      errorCode,
      participantCount: participants.size,
      participantIds: [...participants].sort()
    }))
    .filter((item) => item.participantCount >= 2)
    .sort((a, b) => a.errorCode.localeCompare(b.errorCode));
}

function hasText(value) {
  return String(value || "").trim() !== "";
}

function nonNegativeInteger(value) {
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 ? number : 0;
}

function walk(root, visit) {
  for (const entry of readdirSync(root)) {
    const path = join(root, entry);
    const stats = statSync(path);
    if (stats.isDirectory()) {
      walk(path, visit);
    } else {
      visit(path);
    }
  }
}

function latestPilotDir() {
  const root = repoPath("reports/pilot");
  if (!existsSync(root)) return "";
  const dirs = readdirSync(root)
    .map((name) => join(root, name))
    .filter((path) => statSync(path).isDirectory())
    .sort();
  return dirs.at(-1) || "";
}

function printSummary(report) {
  console.log(`Pilot summary: ${report.cohortId}`);
  console.log(`- participants: ${report.participantCount}`);
  console.log(`- recommendation: ${report.recommendation}`);
  console.log(`- blockers: ${report.blockers.length}`);
  console.log(`- rates: install=${Math.round(report.metrics.installRate * 100)}%, import=${Math.round(report.metrics.importRate * 100)}%, sync=${Math.round(report.metrics.firstSyncRate * 100)}%, diagnostics=${Math.round(report.metrics.diagnosticsRate * 100)}%`);
}

function readJson(path, label) {
  return JSON.parse(readFileSync(repoPath(path), "utf8"));
}

function readOptionalJson(path) {
  if (!path) return null;
  const fullPath = repoPath(path);
  if (!existsSync(fullPath)) return null;
  try {
    return JSON.parse(readFileSync(fullPath, "utf8"));
  } catch {
    return null;
  }
}

function readArg(name) {
  const index = process.argv.indexOf(name);
  if (index === -1 || index + 1 >= process.argv.length) return "";
  return process.argv[index + 1];
}

function hasArg(name) {
  return process.argv.includes(name);
}

function repoPath(path) {
  if (!path) return projectRoot;
  if (resolve(path) === path) return path;
  return resolve(projectRoot, path);
}

function rel(path) {
  return relative(projectRoot, resolve(path)).replaceAll("\\", "/");
}

function basename(path) {
  return resolve(path).split(/[\\/]/).filter(Boolean).at(-1) || "";
}

function fileSha256IfExists(path) {
  const fullPath = repoPath(path);
  return existsSync(fullPath) ? createHash("sha256").update(readFileSync(fullPath)).digest("hex") : "";
}
