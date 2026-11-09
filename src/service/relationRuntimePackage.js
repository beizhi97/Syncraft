import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const OPEN_NOFOLLOW = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0);

export const RELATION_RUNTIME_MANIFEST_FILE = "manifest.json";
export const RELATION_RUNTIME_SCHEMA_VERSION = 1;
export const RELATION_RUNTIME_PLATFORM = "linux";
export const RELATION_RUNTIME_ARCH = "arm64";

export const RELATION_RUNTIME_ARTIFACTS = Object.freeze({
  supervisor: Object.freeze({
    name: "sfsc-relation-supervisor",
    file: "sfsc-relation-supervisor",
    sizeBytes: 3_729_529,
    sha256:
      "67c5e8b2aed052c908eb6a789db4e0e5aaffdbac6506ee05e76cda993985e9ba"
  }),
  rootGuard: Object.freeze({
    name: "sfsc-root-guard",
    file: "sfsc-root-guard",
    sizeBytes: 3_536_944,
    sha256:
      "a01a75e1991c01d2e28fc7f98b0983789dbc73099f5bdd4043c6f41eb22756a1"
  })
});

export const SFTP_RELATION_RUNTIME_SCHEMA_VERSION = 2;
export const SFTP_RELATION_RUNTIME_PLATFORM = "linux";
export const SFTP_RELATION_RUNTIME_ARCH = "arm64";
// Filled only from the independently frozen R2/R74 and R75 candidate files.
// The loader deliberately fails closed until those fixed pins are recorded.
export const SFTP_RELATION_RUNTIME_ARTIFACTS = Object.freeze({
  supervisor: Object.freeze({
    name: "sfsc-relation-supervisor",
    file: "sfsc-relation-supervisor",
    sizeBytes: 3_733_811,
    sha256: "70441080a62b4281516c02a6d23d9925b7427a5b3b2d34e3a963bdfcee6a03a4"
  }),
  rootGuard: Object.freeze({
    name: "sfsc-root-guard",
    file: "sfsc-root-guard",
    sizeBytes: 3_543_319,
    sha256: "fb9506a5449db95da53b1c225241517efde2ae695517e6a177139ee0ebd5bab5"
  }),
  sftpService: Object.freeze({
    name: "sfsc-sftp-service",
    file: "sfsc-sftp-service",
    sizeBytes: 6_632_706,
    sha256: "57bb9bb1ada629fc59328ab25a8391d502036989d6dc349a8590c5ea17589023"
  })
});

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function hasExactKeys(value, expectedKeys) {
  if (value === null
    || typeof value !== "object"
    || Array.isArray(value)) {
    return false;
  }
  const actual = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  return actual.length === expected.length
    && actual.every((key, index) => key === expected[index]);
}

function assertManifestArtifact(value, expected, position) {
  const label = `relation runtime manifest artifact ${position}`;
  if (!hasExactKeys(value, ["file", "name", "sha256", "sizeBytes"])) {
    throw new Error(`${label} does not match the strict schema`);
  }
  if (value.name !== expected.name
    || value.file !== expected.file
    || value.sizeBytes !== expected.sizeBytes
    || value.sha256 !== expected.sha256) {
    throw new Error(`${label} does not match the fixed artifact contract`);
  }
}

function validateManifest(value) {
  if (!hasExactKeys(value, ["arch", "artifacts", "platform", "schemaVersion"])) {
    throw new Error("relation runtime manifest does not match the strict schema");
  }
  if (value.schemaVersion !== RELATION_RUNTIME_SCHEMA_VERSION
    || value.platform !== RELATION_RUNTIME_PLATFORM
    || value.arch !== RELATION_RUNTIME_ARCH) {
    throw new Error("relation runtime manifest platform metadata does not match");
  }
  if (!Array.isArray(value.artifacts) || value.artifacts.length !== 2) {
    throw new Error("relation runtime manifest must contain exactly two artifacts");
  }
  assertManifestArtifact(
    value.artifacts[0],
    RELATION_RUNTIME_ARTIFACTS.supervisor,
    "supervisor"
  );
  assertManifestArtifact(
    value.artifacts[1],
    RELATION_RUNTIME_ARTIFACTS.rootGuard,
    "root-guard"
  );
}

function assertLinuxArm64Elf(bytes, label) {
  if (bytes.length < 20
    || bytes[0] !== 0x7f
    || bytes[1] !== 0x45
    || bytes[2] !== 0x4c
    || bytes[3] !== 0x46
    || bytes[4] !== 2
    || bytes[5] !== 1
    || bytes.readUInt16LE(18) !== 183) {
    throw new Error(`${label} is not a Linux ARM64 ELF executable`);
  }
}

async function readRegularFile(path, label) {
  let pathStat;
  try {
    pathStat = await lstat(path);
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new Error(`${label} is missing`);
    }
    throw error;
  }
  if (!pathStat.isFile() || pathStat.isSymbolicLink()) {
    throw new Error(`${label} must be a regular non-symlink file`);
  }

  let handle;
  try {
    handle = await open(path, OPEN_NOFOLLOW);
  } catch (error) {
    if (error?.code === "ELOOP") {
      throw new Error(`${label} must be a regular non-symlink file`);
    }
    throw error;
  }
  try {
    const openedStat = await handle.stat();
    if (!openedStat.isFile()) {
      throw new Error(`${label} must be a regular non-symlink file`);
    }
    const bytes = await handle.readFile();
    if (bytes.length !== openedStat.size) {
      throw new Error(`${label} changed while it was being read`);
    }
    return Object.freeze({ bytes, mode: openedStat.mode, stat: openedStat });
  } finally {
    await handle.close();
  }
}

function assertArtifact(bytes, expected, label) {
  if (bytes.length !== expected.sizeBytes) {
    throw new Error(`${label} size does not match the fixed artifact contract`);
  }
  if (sha256(bytes) !== expected.sha256) {
    throw new Error(`${label} SHA-256 does not match the fixed artifact contract`);
  }
  assertLinuxArm64Elf(bytes, label);
}

export function createRelationRuntimeManifest() {
  return {
    schemaVersion: RELATION_RUNTIME_SCHEMA_VERSION,
    platform: RELATION_RUNTIME_PLATFORM,
    arch: RELATION_RUNTIME_ARCH,
    artifacts: [
      { ...RELATION_RUNTIME_ARTIFACTS.supervisor },
      { ...RELATION_RUNTIME_ARTIFACTS.rootGuard }
    ]
  };
}

export async function loadRelationRuntimePackage({
  directory,
  platform = process.platform,
  arch = process.arch,
  // Explicit test seam: callers may simulate POSIX mode bits on Windows.
  executableModeReader = mode => mode
} = {}) {
  if (typeof directory !== "string" || !isAbsolute(directory)) {
    throw new Error("relation runtime package directory must be an absolute path");
  }
  if (platform !== RELATION_RUNTIME_PLATFORM || arch !== RELATION_RUNTIME_ARCH) {
    throw new Error("relation runtime package requires a Linux ARM64 runtime");
  }
  if (typeof executableModeReader !== "function") {
    throw new Error("relation runtime executable mode reader must be a function");
  }

  const packageDirectory = resolve(directory);
  let directoryStat;
  try {
    directoryStat = await lstat(packageDirectory);
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new Error("relation runtime package directory is missing");
    }
    throw error;
  }
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
    throw new Error("relation runtime package directory must be a real directory");
  }

  const manifestPath = join(
    packageDirectory,
    RELATION_RUNTIME_MANIFEST_FILE
  );
  const manifestFile = await readRegularFile(
    manifestPath,
    "relation runtime manifest"
  );
  let manifest;
  try {
    manifest = JSON.parse(manifestFile.bytes.toString("utf8"));
  } catch {
    throw new Error("relation runtime manifest is not valid JSON");
  }
  validateManifest(manifest);

  const loaded = [];
  for (const [key, label] of [
    ["supervisor", "relation runtime supervisor"],
    ["rootGuard", "relation runtime root-guard"]
  ]) {
    const expected = RELATION_RUNTIME_ARTIFACTS[key];
    const path = join(packageDirectory, expected.file);
    const file = await readRegularFile(path, label);
    assertArtifact(file.bytes, expected, label);
    const executableMode = executableModeReader(file.mode, path);
    if (!Number.isInteger(executableMode)
      || (executableMode & 0o111) === 0) {
      throw new Error(`${label} is not executable`);
    }
    loaded.push(Object.freeze({ expected, path }));
  }

  const supervisor = loaded.find(
    entry => entry.expected.name === RELATION_RUNTIME_ARTIFACTS.supervisor.name
  );
  const rootGuard = loaded.find(
    entry => entry.expected.name === RELATION_RUNTIME_ARTIFACTS.rootGuard.name
  );
  if (!supervisor || !rootGuard) {
    throw new Error("relation runtime package artifacts could not be resolved");
  }
  if (!SHA256_PATTERN.test(rootGuard.expected.sha256)) {
    throw new Error("relation runtime root-guard SHA-256 is invalid");
  }

  return Object.freeze({
    supervisorPath: supervisor.path,
    helperPath: rootGuard.path,
    helperSha256: rootGuard.expected.sha256,
    execServicePath: rootGuard.path,
    signalServicePath: rootGuard.path
  });
}

function requireSftpArtifactPins() {
  return SFTP_RELATION_RUNTIME_ARTIFACTS;
}

function validateSftpManifest(value) {
  const artifacts = requireSftpArtifactPins();
  if (!hasExactKeys(value, ["arch", "artifacts", "platform", "schemaVersion"])) {
    throw new Error("SFTP relation runtime manifest does not match the strict schema");
  }
  if (value.schemaVersion !== SFTP_RELATION_RUNTIME_SCHEMA_VERSION
    || value.platform !== SFTP_RELATION_RUNTIME_PLATFORM
    || value.arch !== SFTP_RELATION_RUNTIME_ARCH) {
    throw new Error("SFTP relation runtime manifest platform metadata does not match");
  }
  if (!Array.isArray(value.artifacts) || value.artifacts.length !== 3) {
    throw new Error("SFTP relation runtime manifest must contain exactly three artifacts");
  }
  for (const [index, key] of ["supervisor", "rootGuard", "sftpService"].entries()) {
    assertManifestArtifact(value.artifacts[index], artifacts[key], key);
  }
}

export function createSftpRelationRuntimeManifest() {
  const artifacts = requireSftpArtifactPins();
  return {
    schemaVersion: SFTP_RELATION_RUNTIME_SCHEMA_VERSION,
    platform: SFTP_RELATION_RUNTIME_PLATFORM,
    arch: SFTP_RELATION_RUNTIME_ARCH,
    artifacts: [
      { ...artifacts.supervisor },
      { ...artifacts.rootGuard },
      { ...artifacts.sftpService }
    ]
  };
}

export async function loadSftpRelationRuntimePackage({
  directory,
  platform = process.platform,
  arch = process.arch,
  executableModeReader = mode => mode
} = {}) {
  const artifacts = requireSftpArtifactPins();
  if (typeof directory !== "string" || !isAbsolute(directory)) {
    throw new Error("SFTP relation runtime package directory must be an absolute path");
  }
  if (typeof executableModeReader !== "function") {
    throw new Error("SFTP relation runtime executable mode reader must be a function");
  }
  const packageDirectory = resolve(directory);
  let directoryStat;
  try {
    directoryStat = await lstat(packageDirectory);
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new Error("SFTP relation runtime package directory is missing");
    }
    throw error;
  }
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
    throw new Error("SFTP relation runtime package directory must be a real directory");
  }
  if (platform !== SFTP_RELATION_RUNTIME_PLATFORM || arch !== SFTP_RELATION_RUNTIME_ARCH) {
    throw new Error("SFTP relation runtime package requires a Linux ARM64 runtime");
  }
  const manifestFile = await readRegularFile(
    join(packageDirectory, RELATION_RUNTIME_MANIFEST_FILE),
    "SFTP relation runtime manifest"
  );
  let manifest;
  try {
    manifest = JSON.parse(manifestFile.bytes.toString("utf8"));
  } catch {
    throw new Error("SFTP relation runtime manifest is not valid JSON");
  }
  validateSftpManifest(manifest);

  const loaded = {};
  for (const key of ["supervisor", "rootGuard", "sftpService"]) {
    const expected = artifacts[key];
    const file = await readRegularFile(join(packageDirectory, expected.file), `SFTP relation runtime ${key}`);
    assertArtifact(file.bytes, expected, `SFTP relation runtime ${key}`);
    const executableMode = executableModeReader(file.mode, join(packageDirectory, expected.file));
    if (!Number.isInteger(executableMode) || (executableMode & 0o111) === 0) {
      throw new Error(`SFTP relation runtime ${key} is not executable`);
    }
    loaded[key] = join(packageDirectory, expected.file);
  }
  return Object.freeze({
    supervisorPath: loaded.supervisor,
    rootGuardPath: loaded.rootGuard,
    rootGuardSha256: artifacts.rootGuard.sha256,
    sftpServicePath: loaded.sftpService
  });
}
