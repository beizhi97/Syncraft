import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  open,
  rm,
  writeFile
} from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  createSftpRelationRuntimeManifest,
  RELATION_RUNTIME_MANIFEST_FILE,
  SFTP_RELATION_RUNTIME_ARTIFACTS
} from "../src/service/relationRuntimePackage.js";

const root = fileURLToPath(new URL("..", import.meta.url));
const DEFAULT_SUPERVISOR_INPUT = join(
  root,
  ".tmp",
  "development-2026-10-21",
  "p2-owner-admission",
  "sftp-service-v2-candidate-r2"
);
const DEFAULT_SERVICE_INPUT = join(root, ".tmp", "r75-sftp-service");
const DEFAULT_OUTPUT = join(
  root,
  "server",
  "runtime",
  "native",
  "linux-arm64",
  "relation-v2"
);
const STAGING_ROOT = join(
  root,
  ".tmp",
  "development-2026-10-21",
  "p2-owner-admission"
);
const SOURCE_FILES = Object.freeze({
  supervisor: "relation-supervisor-linux-arm64",
  rootGuard: "root-guard-linux-arm64",
  sftpService: "sfsc-sftp-service-linux-arm64"
});
const OPEN_NOFOLLOW = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0);

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function assertArm64Elf(bytes, label) {
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
    const opened = await handle.stat();
    if (!opened.isFile()) {
      throw new Error(`${label} must be a regular non-symlink file`);
    }
    const bytes = await handle.readFile();
    if (bytes.length !== opened.size) {
      throw new Error(`${label} changed while being read`);
    }
    return bytes;
  } finally {
    await handle.close();
  }
}

async function requireRealDirectory(path, label, create = false) {
  if (create) {
    await mkdir(path, { recursive: true, mode: 0o755 });
  }
  try {
    const info = await lstat(path);
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new Error(`${label} must be a real directory`);
    }
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new Error(`${label} is missing`);
    }
    throw error;
  }
}

async function readPinnedCandidates(supervisorInput, serviceInput) {
  await requireRealDirectory(supervisorInput, "candidate directory");
  await requireRealDirectory(serviceInput, "SFTP service candidate directory");
  const bytesByKey = new Map();
  const inputByKey = {
    supervisor: supervisorInput,
    rootGuard: supervisorInput,
    sftpService: serviceInput
  };
  for (const key of ["supervisor", "rootGuard", "sftpService"]) {
    const expected = SFTP_RELATION_RUNTIME_ARTIFACTS[key];
    const bytes = await readRegularFile(
      join(inputByKey[key], SOURCE_FILES[key]),
      `candidate ${key}`
    );
    if (bytes.length !== expected.sizeBytes || sha256(bytes) !== expected.sha256) {
      throw new Error(`candidate ${key} does not match the fixed artifact contract`);
    }
    assertArm64Elf(bytes, `candidate ${key}`);
    bytesByKey.set(key, bytes);
  }
  return bytesByKey;
}

function outputEntries(outputDirectory, bytesByKey, manifestBytes) {
  return [
    ...["supervisor", "rootGuard", "sftpService"].map(key => ({
      name: SFTP_RELATION_RUNTIME_ARTIFACTS[key].file,
      path: join(outputDirectory, SFTP_RELATION_RUNTIME_ARTIFACTS[key].file),
      mode: 0o755,
      bytes: bytesByKey.get(key)
    })),
    {
      name: RELATION_RUNTIME_MANIFEST_FILE,
      path: join(outputDirectory, RELATION_RUNTIME_MANIFEST_FILE),
      mode: 0o600,
      bytes: manifestBytes
    }
  ];
}

async function matchesExisting(entries) {
  let present = 0;
  let allMatch = true;
  for (const entry of entries) {
    try {
      const bytes = await readRegularFile(entry.path, `output ${entry.name}`);
      present += 1;
      const info = await lstat(entry.path);
      if (!bytes.equals(entry.bytes)
        || (process.platform !== "win32" && (info.mode & 0o777) !== entry.mode)) {
        allMatch = false;
      }
    } catch (error) {
      if (error?.message?.endsWith(" is missing")) {
        allMatch = false;
        continue;
      }
      throw error;
    }
  }
  if (present === 0) {
    return false;
  }
  if (present !== entries.length || !allMatch) {
    throw new Error("SFTP relation runtime output differs from fixed package; refusing to overwrite");
  }
  return true;
}

export async function packageSftpRelationRuntime({
  supervisorInputDirectory = DEFAULT_SUPERVISOR_INPUT,
  serviceInputDirectory = DEFAULT_SERVICE_INPUT,
  outputDirectory = DEFAULT_OUTPUT
} = {}) {
  for (const [value, label] of [
    [supervisorInputDirectory, "supervisor input directory"],
    [serviceInputDirectory, "service input directory"],
    [outputDirectory, "output directory"]
  ]) {
    if (typeof value !== "string" || !isAbsolute(value)) {
      throw new Error(`SFTP relation runtime ${label} must be an absolute path`);
    }
  }
  const supervisorInput = resolve(supervisorInputDirectory);
  const serviceInput = resolve(serviceInputDirectory);
  const output = resolve(outputDirectory);
  const bytesByKey = await readPinnedCandidates(supervisorInput, serviceInput);
  const manifestBytes = Buffer.from(`${JSON.stringify(
    createSftpRelationRuntimeManifest(), null, 2
  )}\n`);
  const entries = outputEntries(output, bytesByKey, manifestBytes);
  try {
    await requireRealDirectory(output, "SFTP relation runtime output directory");
  } catch (error) {
    if (error?.message !== "SFTP relation runtime output directory is missing") {
      throw error;
    }
  }
  if (await matchesExisting(entries)) {
    return Object.freeze({ outputDirectory: output, alreadyPresent: true });
  }

  await mkdir(STAGING_ROOT, { recursive: true, mode: 0o755 });
  const staging = await mkdtemp(join(STAGING_ROOT, "sftp-relation-runtime-package-"));
  const created = [];
  try {
    for (const entry of entries) {
      await writeFile(join(staging, entry.name), entry.bytes, { flag: "wx", mode: entry.mode });
    }
    await requireRealDirectory(output, "SFTP relation runtime output directory", true);
    try {
      for (const entry of entries) {
        await copyFile(join(staging, entry.name), entry.path, fsConstants.COPYFILE_EXCL);
        created.push(entry.path);
      }
      for (const entry of entries) {
        await chmod(entry.path, entry.mode);
      }
    } catch (error) {
      for (const path of created.reverse()) {
        await rm(path, { force: true }).catch(() => {});
      }
      throw error;
    }
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
  return Object.freeze({ outputDirectory: output, alreadyPresent: false });
}

function parseArguments(args) {
  const parsed = {};
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    if (flag === "--help" || flag === "-h") {
      parsed.help = true;
      continue;
    }
    const keyByFlag = {
      "--input": "supervisorInputDirectory",
      "--service-input": "serviceInputDirectory",
      "--output": "outputDirectory"
    };
    if (!Object.hasOwn(keyByFlag, flag)) {
      throw new Error(`unknown argument: ${flag}`);
    }
    const value = args[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`${flag} requires a directory`);
    }
    parsed[keyByFlag[flag]] = resolve(value);
    index += 1;
  }
  return parsed;
}

if (resolve(process.argv[1] || "") === fileURLToPath(import.meta.url)) {
  try {
    const options = parseArguments(process.argv.slice(2));
    if (options.help) {
      console.log("Usage: node scripts/package-sftp-relation-runtime.mjs [--input <r2-directory>] [--service-input <r75-directory>] [--output <directory>]");
    } else {
      const result = await packageSftpRelationRuntime(options);
      console.log(JSON.stringify(result, null, 2));
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
