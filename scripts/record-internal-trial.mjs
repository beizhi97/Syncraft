import { createHash } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { writeJsonReportSync } from "./lib/reportSecrets.mjs";

const projectRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const outputPath = resolve(readArg("--output") || "reports/internal-trial/internal-trial-record.json");
const force = hasArg("--force");
const verifyOnly = hasArg("--verify");
const updateOnly = hasArg("--update");
const allowPending = hasArg("--allow-pending");
const updateSectionId = readArg("--section");
const updateStatus = readArg("--status");
const updateNotes = readArg("--notes");
const updateArtifacts = readArgs("--artifact");
const preserveEvidence = hasArg("--preserve-evidence");

const sectionIds = [
  "release-evidence",
  "install-first-launch",
  "t-key-profile",
  "folder-job-save",
  "preview-small-sync",
  "stop-restart-recovery",
  "diagnostics-privacy",
  "portable-compat"
];

try {
  if (verifyOnly) {
    const record = readJson(outputPath, "internal trial record");
    const verified = verifyRecord(record, outputPath);
    printSummary(verified);
    if (shouldExitUnverified(verified)) {
      process.exitCode = 1;
    }
  } else if (updateOnly) {
    const record = readJson(outputPath, "internal trial record");
    const updated = updateRecord(record);
    mkdirSync(dirname(outputPath), { recursive: true });
    writeJsonReportSync(outputPath, updated, "internal trial record");
    const preliminary = verifyRecord(updated, outputPath, { checkStoredOk: false });
    updated.ok = preliminary.ok;
    writeJsonReportSync(outputPath, updated, "internal trial record");
    const verified = verifyRecord(updated, outputPath);
    printSummary(verified);
    if (shouldExitUnverified(verified)) {
      process.exitCode = 1;
    }
    console.log(`Internal trial record updated: ${outputPath}`);
  } else {
    if (!force && fileExists(outputPath)) {
      throw new Error(`Refusing to overwrite existing record without --force: ${outputPath}`);
    }
    const record = buildInitialRecord();
    mkdirSync(dirname(outputPath), { recursive: true });
    writeJsonReportSync(outputPath, record, "internal trial record");
    const verified = verifyRecord(record, outputPath);
    record.ok = verified.ok;
    writeJsonReportSync(outputPath, record, "internal trial record");
    printSummary(verified);
    console.log(`Internal trial record template written: ${outputPath}`);
  }
} catch (error) {
  console.error(`Internal trial record failed: ${error.message || error}`);
  process.exitCode = 1;
}

function shouldExitUnverified(result) {
  if (result.ok) return false;
  if (!allowPending) return true;
  return result.failures.some((failure) => !failure.startsWith("section failed: "));
}

function updateRecord(record) {
  if (record.type !== "internal-trial-record") {
    throw new Error("Refusing to update a non internal-trial-record JSON file.");
  }
  const updated = structuredClone(record);
  updated.updatedAt = new Date().toISOString();
  if (!preserveEvidence) {
    updated.evidence = collectEvidence();
  }
  updated.environment = {
    ...(updated.environment || {})
  };

  setEnvironmentField(updated.environment, "tester", readArg("--tester"));
  setEnvironmentField(updated.environment, "date", readArg("--date"));
  setEnvironmentField(updated.environment, "windowsVersion", readArg("--windows-version"));
  setEnvironmentField(updated.environment, "machine", readArg("--machine"));
  setEnvironmentField(updated.environment, "serverBaseUrl", readArg("--server-base-url"));

  if (updateSectionId || updateStatus || updateNotes || updateArtifacts.length) {
    updateSection(updated);
  }

  return updated;
}

function setEnvironmentField(environment, field, value) {
  if (!value) return;
  assertSafeText(value, `environment.${field}`);
  environment[field] = value;
}

function updateSection(record) {
  if (!sectionIds.includes(updateSectionId)) {
    throw new Error(`Unknown --section. Expected one of: ${sectionIds.join(", ")}`);
  }
  if (!["passed", "failed", "pending", "skipped"].includes(updateStatus)) {
    throw new Error("Missing or invalid --status. Expected passed, failed, pending, or skipped.");
  }
  assertSafeText(updateNotes, "section notes");
  for (const artifact of updateArtifacts) {
    assertSafeText(artifact, "section artifact");
  }

  const sections = Array.isArray(record.sections) ? record.sections : [];
  const section = sections.find((item) => item.id === updateSectionId);
  if (!section) {
    throw new Error(`Record is missing section: ${updateSectionId}`);
  }

  const mergedArtifacts = [
    ...new Set([
      ...normalizeArtifacts(section.artifacts),
      ...updateArtifacts.map((artifact) => rel(artifact))
    ])
  ];
  const notes = updateNotes || section.notes || "";

  if (updateStatus === "passed" && !notes.trim() && mergedArtifacts.length === 0) {
    throw new Error("Refusing to mark a section passed without --notes or --artifact evidence.");
  }
  if ((updateStatus === "failed" || updateStatus === "skipped") && !notes.trim()) {
    throw new Error(`Refusing to mark a section ${updateStatus} without --notes.`);
  }

  section.status = updateStatus;
  section.notes = notes;
  section.artifacts = mergedArtifacts;
  section.updatedAt = new Date().toISOString();
}

function normalizeArtifacts(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => String(item || "").trim())
    .filter(Boolean);
}

function buildInitialRecord() {
  const evidence = collectEvidence();
  return {
    schemaVersion: 1,
    app: "singbox-folder-sync",
    type: "internal-trial-record",
    ok: false,
    generatedAt: new Date().toISOString(),
    instructions: {
      checklist: "docs/INTERNAL_TRIAL_CHECKLIST.md",
      verifyCommand: "pnpm run trial:record:verify",
      note: "Keep status=pending until the corresponding manual Windows/N1 check has actually been performed."
    },
    environment: {
      tester: "",
      date: "",
      windowsVersion: "",
      machine: "",
      serverBaseUrl: evidence.n1.serverBaseUrl || ""
    },
    evidence,
    sections: sectionIds.map((id) => ({
      id,
      status: "pending",
      notes: "",
      artifacts: []
    })),
    failures: []
  };
}

function collectEvidence() {
  const releaseBundleManifestPath = repoPath("dist/release-bundles/singbox-folder-sync-0.2.0-beta.2-release/release-bundle-manifest.json");
  const releaseBundleManifest = readJson(releaseBundleManifestPath, "release bundle manifest");
  const latestN1Path = repoPath("reports/n1/latest-post-deploy.json");
  const latestN1 = readJson(latestN1Path, "latest N1 post-deploy pointer");
  const n1SummaryPath = latestN1.summaryJson || join(projectRoot, "reports", "n1", latestN1.runId || "", "post-deploy-summary.json");
  const n1Summary = readJson(n1SummaryPath, "N1 post-deploy summary");

  return {
    releaseBundle: {
      path: rel("dist/release-bundles/singbox-folder-sync-0.2.0-beta.2-release.zip"),
      sha256Path: rel("dist/release-bundles/singbox-folder-sync-0.2.0-beta.2-release.zip.sha256"),
      manifestPath: rel(releaseBundleManifestPath),
      version: releaseBundleManifest.version || "",
      generatedAt: releaseBundleManifest.generatedAt || "",
      preflightVerified: releaseBundleManifest.preflightVerified === true,
      sha256: fileSha256(repoPath("dist/release-bundles/singbox-folder-sync-0.2.0-beta.2-release.zip"))
    },
    desktopPackage: packageEvidence("SyncraftDesktop"),
    portablePackage: packageEvidence("SyncraftClient"),
    n1: {
      latestPath: rel(latestN1Path),
      summaryPath: rel(n1SummaryPath),
      runId: latestN1.runId || n1Summary.runId || "",
      ok: latestN1.ok === true && n1Summary.ok === true,
      releaseBundleVerified: n1Summary.acceptance?.releaseAcceptance?.releaseBundleVerified === true,
      restartRequired: n1Summary.acceptance?.releaseAcceptance?.restartRequired,
      targetHostsMatch: n1Summary.acceptance?.target?.targetHostsMatch === true,
      serverBaseUrl: n1Summary.acceptance?.target?.smokeBaseUrl || ""
    }
  };
}

function packageEvidence(name) {
  const zipPath = repoPath(`dist/${name}.zip`);
  const manifestPath = repoPath(`dist/${name}/release-manifest.json`);
  const manifest = readJson(manifestPath, `${name} release manifest`);
  return {
    path: rel(zipPath),
    sha256Path: rel(`dist/${name}.zip.sha256`),
    manifestPath: rel(manifestPath),
    version: manifest.version || "",
    builtAt: manifest.builtAt || "",
    fileCount: Array.isArray(manifest.files) ? manifest.files.length : 0,
    sha256: fileSha256(zipPath)
  };
}

function verifyRecord(record, recordPath, options = {}) {
  const checkStoredOk = options.checkStoredOk !== false;
  const failures = [];
  if (record.schemaVersion !== 1) failures.push("schemaVersion must be 1");
  if (record.app !== "singbox-folder-sync") failures.push("app must be singbox-folder-sync");
  if (record.type !== "internal-trial-record") failures.push("type must be internal-trial-record");

  const evidence = record.evidence || {};
  verifyZipEvidence(evidence.releaseBundle, "releaseBundle", failures);
  verifyZipEvidence(evidence.desktopPackage, "desktopPackage", failures);
  verifyZipEvidence(evidence.portablePackage, "portablePackage", failures);

  if (evidence.releaseBundle?.manifestPath) {
    const manifest = readJson(repoPath(evidence.releaseBundle.manifestPath), "release bundle manifest");
    if (manifest.preflightVerified !== true) failures.push("releaseBundle manifest must have preflightVerified=true");
  }

  const n1 = evidence.n1 || {};
  if (!n1.runId) failures.push("n1.runId is required");
  if (n1.ok !== true) failures.push("n1.ok must be true");
  if (n1.releaseBundleVerified !== true) failures.push("n1.releaseBundleVerified must be true");
  if (n1.restartRequired !== false) failures.push("n1.restartRequired must be false");
  if (n1.targetHostsMatch !== true) failures.push("n1.targetHostsMatch must be true");

  const sections = Array.isArray(record.sections) ? record.sections : [];
  const seen = new Set(sections.map((section) => section.id));
  for (const id of sectionIds) {
    if (!seen.has(id)) failures.push(`missing section: ${id}`);
  }
  const pending = [];
  for (const section of sections) {
    if (!["passed", "failed", "pending", "skipped"].includes(section.status)) {
      failures.push(`section ${section.id || "(unknown)"} has invalid status: ${section.status}`);
    }
    if (section.status === "pending") pending.push(section.id);
    if (section.status === "failed") failures.push(`section failed: ${section.id}`);
    if (section.status === "passed" && !String(section.notes || "").trim() && normalizeArtifacts(section.artifacts).length === 0) {
      failures.push(`section ${section.id} is passed without notes or artifacts`);
    }
    if ((section.status === "failed" || section.status === "skipped") && !String(section.notes || "").trim()) {
      failures.push(`section ${section.id} is ${section.status} without notes`);
    }
    try {
      assertSafeText(section.notes || "", `section ${section.id} notes`);
      for (const artifact of normalizeArtifacts(section.artifacts)) {
        assertSafeText(artifact, `section ${section.id} artifact`);
      }
    } catch (error) {
      failures.push(error.message);
    }
  }

  const computedOk = failures.length === 0 && pending.length === 0;
  if (checkStoredOk && record.ok !== computedOk) {
    failures.push(`ok must match verification result (${computedOk})`);
  }
  const ok = failures.length === 0 && pending.length === 0;
  return {
    ok,
    recordPath: rel(recordPath),
    pending,
    failures,
    summary: {
      sections: sections.length,
      passed: sections.filter((section) => section.status === "passed").length,
      pending: pending.length,
      failed: sections.filter((section) => section.status === "failed").length,
      skipped: sections.filter((section) => section.status === "skipped").length
    }
  };
}

function assertSafeText(value, label) {
  const text = String(value || "");
  const patterns = [
    ["SyncKey", /SFSC1-[A-Za-z0-9_-]+/],
    ["VLESS URI", /vless:\/\/[^\s"']+/i],
    ["secret access key", /secret[_-]?access[_-]?key\s*[:=]\s*[^,\s]+/i],
    ["heartbeat secret", /heartbeatSecret\s*[:=]\s*[^,\s]+/i],
    ["admin token", /admin[_-]?token\s*[:=]\s*[^,\s]{12,}/i],
    ["private key", /-----BEGIN [A-Z ]*PRIVATE KEY-----/]
  ];
  for (const [name, pattern] of patterns) {
    if (pattern.test(text)) {
      throw new Error(`${label} contains sensitive-looking ${name} content.`);
    }
  }
}

function verifyZipEvidence(value, label, failures) {
  if (!value || typeof value !== "object") {
    failures.push(`${label} evidence is missing`);
    return;
  }
  for (const field of ["path", "sha256Path", "sha256"]) {
    if (!value[field]) failures.push(`${label}.${field} is required`);
  }
  if (value.path && value.sha256) {
    const actual = fileSha256(repoPath(value.path));
    if (actual !== String(value.sha256).toLowerCase()) {
      failures.push(`${label}.sha256 does not match ${value.path}`);
    }
  }
  if (value.sha256Path && value.sha256) {
    const expected = readSidecarSha256(repoPath(value.sha256Path));
    if (expected !== String(value.sha256).toLowerCase()) {
      failures.push(`${label}.sha256 does not match ${value.sha256Path}`);
    }
  }
}

function printSummary(result) {
  console.log(`Internal trial record ${result.ok ? "verified" : "not complete"}: ${resolve(result.recordPath)}`);
  console.log(`- sections: passed=${result.summary.passed}, pending=${result.summary.pending}, failed=${result.summary.failed}, skipped=${result.summary.skipped}`);
  if (result.pending.length) console.log(`- pending: ${result.pending.join(", ")}`);
  for (const failure of result.failures) {
    console.log(`- failure: ${failure}`);
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

function readSidecarSha256(path) {
  const hash = readFileSync(path, "utf8").trim().split(/\s+/)[0]?.toLowerCase() || "";
  if (!/^[a-f0-9]{64}$/.test(hash)) {
    throw new Error(`Invalid SHA256 sidecar: ${path}`);
  }
  return hash;
}

function repoPath(path) {
  return resolve(projectRoot, path);
}

function rel(path) {
  return relative(projectRoot, resolve(path)).replaceAll("\\", "/");
}

function fileExists(path) {
  try {
    readFileSync(path);
    return true;
  } catch {
    return false;
  }
}

function readArg(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? "" : process.argv[index + 1] || "";
}

function readArgs(name) {
  const values = [];
  for (let index = 0; index < process.argv.length; index += 1) {
    if (process.argv[index] === name && process.argv[index + 1]) {
      values.push(process.argv[index + 1]);
      index += 1;
    }
  }
  return values;
}

function hasArg(name) {
  return process.argv.includes(name);
}
