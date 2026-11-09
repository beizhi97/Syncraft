import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile
} from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import {
  createSftpRelationRuntimeManifest,
  loadSftpRelationRuntimePackage,
  SFTP_RELATION_RUNTIME_ARTIFACTS
} from "../src/service/relationRuntimePackage.js";
import {
  packageSftpRelationRuntime
} from "../scripts/package-sftp-relation-runtime.mjs";

const root = join(import.meta.dirname, "..");
const candidateRoot = join(
  root,
  ".tmp",
  "development-2026-10-21",
  "p2-owner-admission",
  "sftp-service-v2-candidate-r2"
);
const serviceCandidate = join(root, ".tmp", "r75-sftp-service");
const temporaryRoot = join(root, ".tmp", "development-2026-10-21", "p2-owner-admission");

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function makePackage(t) {
  await mkdir(temporaryRoot, { recursive: true });
  const directory = await mkdtemp(join(temporaryRoot, "sftp-relation-package-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const sources = {
    supervisor: join(candidateRoot, "relation-supervisor-linux-arm64"),
    rootGuard: join(candidateRoot, "root-guard-linux-arm64"),
    sftpService: join(serviceCandidate, "sfsc-sftp-service-linux-arm64")
  };
  for (const [key, expected] of Object.entries(SFTP_RELATION_RUNTIME_ARTIFACTS)) {
    const bytes = await readFile(sources[key]);
    assert.equal(bytes.length, expected.sizeBytes, `${key} candidate byte size`);
    assert.equal(sha256(bytes), expected.sha256, `${key} candidate SHA-256`);
    const destination = join(directory, expected.file);
    await copyFile(sources[key], destination);
    if (process.platform !== "win32") {
      await chmod(destination, 0o755);
    }
  }
  await writeFile(join(directory, "manifest.json"), `${JSON.stringify(
    createSftpRelationRuntimeManifest(), null, 2
  )}\n`);
  return directory;
}

function loadOptions(directory, overrides = {}) {
  const options = { directory, platform: "linux", arch: "arm64", ...overrides };
  if (process.platform === "win32" && !Object.hasOwn(options, "executableModeReader")) {
    options.executableModeReader = () => 0o755;
  }
  return options;
}

test("loads only the fixed schemaVersion 2 three-artifact package", async t => {
  const directory = await makePackage(t);
  const loaded = await loadSftpRelationRuntimePackage(loadOptions(directory));
  assert.deepEqual(loaded, {
    supervisorPath: join(directory, SFTP_RELATION_RUNTIME_ARTIFACTS.supervisor.file),
    rootGuardPath: join(directory, SFTP_RELATION_RUNTIME_ARTIFACTS.rootGuard.file),
    rootGuardSha256: SFTP_RELATION_RUNTIME_ARTIFACTS.rootGuard.sha256,
    sftpServicePath: join(directory, SFTP_RELATION_RUNTIME_ARTIFACTS.sftpService.file)
  });
  assert.equal(Object.isFrozen(loaded), true);
  const manifest = JSON.parse(await readFile(join(directory, "manifest.json"), "utf8"));
  assert.equal(manifest.schemaVersion, 2);
  assert.equal(manifest.artifacts.length, 3);
});

test("packages the frozen candidates idempotently into an isolated V2 directory", async t => {
  await mkdir(temporaryRoot, { recursive: true });
  const parent = await mkdtemp(join(temporaryRoot, "sftp-runtime-package-output-test-"));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const outputDirectory = join(parent, "relation-v2");
  const options = {
    supervisorInputDirectory: candidateRoot,
    serviceInputDirectory: serviceCandidate,
    outputDirectory
  };
  const first = await packageSftpRelationRuntime(options);
  assert.equal(first.alreadyPresent, false);
  const loaded = await loadSftpRelationRuntimePackage(loadOptions(outputDirectory));
  assert.equal(loaded.sftpServicePath, join(outputDirectory, "sfsc-sftp-service"));
  const second = await packageSftpRelationRuntime(options);
  assert.equal(second.alreadyPresent, true);
  if (process.platform !== "win32") {
    for (const artifact of Object.values(SFTP_RELATION_RUNTIME_ARTIFACTS)) {
      assert.equal((await lstat(join(outputDirectory, artifact.file))).mode & 0o777, 0o755);
    }
    assert.equal((await lstat(join(outputDirectory, "manifest.json")).mode & 0o777), 0o600);
  }
});

test("rejects missing artifact, hash tampering, and non-V2 manifests", async t => {
  await t.test("missing artifact", async t2 => {
    const directory = await makePackage(t2);
    await rm(join(directory, SFTP_RELATION_RUNTIME_ARTIFACTS.sftpService.file));
    await assert.rejects(loadSftpRelationRuntimePackage(loadOptions(directory)), /missing/);
  });
  await t.test("tampered executable", async t2 => {
    const directory = await makePackage(t2);
    const target = join(directory, SFTP_RELATION_RUNTIME_ARTIFACTS.sftpService.file);
    const bytes = await readFile(target);
    bytes[bytes.length - 1] ^= 1;
    await writeFile(target, bytes);
    if (process.platform !== "win32") {
      await chmod(target, 0o755);
    }
    await assert.rejects(loadSftpRelationRuntimePackage(loadOptions(directory)), /SHA-256/);
  });
  await t.test("schema version 1", async t2 => {
    const directory = await makePackage(t2);
    const manifestPath = join(directory, "manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    manifest.schemaVersion = 1;
    await writeFile(manifestPath, JSON.stringify(manifest));
    await assert.rejects(loadSftpRelationRuntimePackage(loadOptions(directory)), /metadata/);
  });
});

test("rejects a non-executable artifact, symlink artifact, and other platforms", async t => {
  await t.test("execute mode", async t2 => {
    const directory = await makePackage(t2);
    await assert.rejects(loadSftpRelationRuntimePackage(loadOptions(directory, {
      executableModeReader: () => 0o644
    })), /not executable/);
  });
  await t.test("symlink", async t2 => {
    const directory = await makePackage(t2);
    const target = join(directory, SFTP_RELATION_RUNTIME_ARTIFACTS.sftpService.file);
    const linked = `${target}.link`;
    await rm(target);
    try {
      await symlink(join(serviceCandidate, "sfsc-sftp-service-linux-arm64"), target);
    } catch (error) {
      if (error?.code === "EPERM" || error?.code === "EACCES") {
        t2.skip("symlink creation is unavailable on this host");
        return;
      }
      throw error;
    }
    assert.equal((await lstat(target)).isSymbolicLink(), true);
    await assert.rejects(loadSftpRelationRuntimePackage(loadOptions(directory)), /non-symlink/);
    await rm(linked, { force: true });
  });
  await t.test("wrong architecture", async t2 => {
    const directory = await makePackage(t2);
    await assert.rejects(loadSftpRelationRuntimePackage(loadOptions(directory, {
      arch: "x64"
    })), /Linux ARM64/);
  });
});
