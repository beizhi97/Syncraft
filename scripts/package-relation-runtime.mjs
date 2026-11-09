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
  RELATION_RUNTIME_ARTIFACTS,
  RELATION_RUNTIME_MANIFEST_FILE,
  RELATION_RUNTIME_PLATFORM,
  RELATION_RUNTIME_ARCH,
  createRelationRuntimeManifest
} from "../src/service/relationRuntimePackage.js";

const root = fileURLToPath(new URL("..", import.meta.url));
const DEFAULT_INPUT_DIRECTORY = join(
  root,
  ".tmp",
  "development-2026-10-21",
  "p2-runtime-adapter",
  "integration-r9-manifest-r2",
  "candidates"
);
const DEFAULT_OUTPUT_DIRECTORY = join(
  root,
  "server",
  "runtime",
  "native",
  "linux-arm64",
  "relation"
);
const STAGING_ROOT = join(
  root,
  ".tmp",
  "development-2026-10-21",
  "p2-owner-admission"
);
const SOURCE_MANIFEST_SHA256 =
  "8adbff3a487a58b0a4291f6e3b33cb00bb5cacbdedb263948e04645194f0fa09";
const SOURCE_FILES = Object.freeze({
  supervisor: "sfsc-relation-supervisor-linux-arm64",
  rootGuard: "sfsc-root-guard-linux-arm64"
});
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const OPEN_NOFOLLOW = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0);

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
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
    return Object.freeze({ bytes, mode: openedStat.mode });
  } finally {
    await handle.close();
  }
}

function assertFixedArtifact(bytes, expected, label) {
  if (bytes.length !== expected.sizeBytes) {
    throw new Error(`${label} size does not match the accepted ARM64 artifact`);
  }
  if (sha256(bytes) !== expected.sha256) {
    throw new Error(`${label} SHA-256 does not match the accepted ARM64 artifact`);
  }
  assertLinuxArm64Elf(bytes, label);
}

function validateSourceManifest(value) {
  if (value?.goos !== RELATION_RUNTIME_PLATFORM
    || !Array.isArray(value.candidates)) {
    throw new Error("candidate manifest does not describe Linux ARM64 artifacts");
  }
  for (const [name, key] of [
    [RELATION_RUNTIME_ARTIFACTS.supervisor.name, "supervisor"],
    [RELATION_RUNTIME_ARTIFACTS.rootGuard.name, "rootGuard"]
  ]) {
    const expected = RELATION_RUNTIME_ARTIFACTS[key];
    const matches = value.candidates.filter(
      candidate => candidate?.name === name
        && candidate?.goarch === RELATION_RUNTIME_ARCH
    );
    if (matches.length !== 1
      || matches[0].file !== SOURCE_FILES[key]
      || matches[0].size !== expected.sizeBytes
      || matches[0].sha256 !== expected.sha256) {
      throw new Error(
        `candidate manifest ${name} entry does not match the accepted ARM64 artifact`
      );
    }
  }
}

async function readOutputDirectory(outputDirectory) {
  try {
    const value = await lstat(outputDirectory);
    if (!value.isDirectory() || value.isSymbolicLink()) {
      throw new Error("relation runtime output directory must be a real directory");
    }
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
  }
}

function outputPaths(outputDirectory, packageManifestBytes) {
  return [
    {
      name: SOURCE_FILES.supervisor,
      path: join(outputDirectory, RELATION_RUNTIME_ARTIFACTS.supervisor.file),
      mode: 0o755
    },
    {
      name: SOURCE_FILES.rootGuard,
      path: join(outputDirectory, RELATION_RUNTIME_ARTIFACTS.rootGuard.file),
      mode: 0o755
    },
    {
      name: RELATION_RUNTIME_MANIFEST_FILE,
      path: join(outputDirectory, RELATION_RUNTIME_MANIFEST_FILE),
      mode: 0o600
    }
  ].map(item => ({
    ...item,
    bytes: item.name === RELATION_RUNTIME_MANIFEST_FILE
      ? packageManifestBytes
      : null
  }));
}

async function inspectExistingOutputs(outputs, stagedBytes) {
  let existingCount = 0;
  const matches = [];
  for (const output of outputs) {
    try {
      const file = await readRegularFile(
        output.path,
        `relation runtime output ${output.name}`
      );
      existingCount += 1;
      const expectedBytes = stagedBytes.get(output.name);
      const bytesMatch = file.bytes.equals(expectedBytes);
      const modeMatch = process.platform === "win32"
        || (file.mode & 0o777) === output.mode;
      matches.push(bytesMatch && modeMatch);
    } catch (error) {
      if (error?.message?.endsWith(" is missing")) {
        matches.push(false);
        continue;
      }
      if (error?.code === "ENOENT") {
        matches.push(false);
        continue;
      }
      throw error;
    }
  }
  if (existingCount === 0) {
    return false;
  }
  if (existingCount !== outputs.length || matches.some(value => !value)) {
    throw new Error(
      "relation runtime output differs from the fixed package; refusing to overwrite"
    );
  }
  return true;
}

function publicResult({
  inputDirectory,
  outputDirectory,
  packageManifestBytes,
  alreadyPresent
}) {
  return Object.freeze({
    inputDirectory,
    outputDirectory,
    manifestPath: join(outputDirectory, RELATION_RUNTIME_MANIFEST_FILE),
    manifestSha256: sha256(packageManifestBytes),
    supervisorPath: join(
      outputDirectory,
      RELATION_RUNTIME_ARTIFACTS.supervisor.file
    ),
    supervisorSha256: RELATION_RUNTIME_ARTIFACTS.supervisor.sha256,
    helperPath: join(
      outputDirectory,
      RELATION_RUNTIME_ARTIFACTS.rootGuard.file
    ),
    helperSha256: RELATION_RUNTIME_ARTIFACTS.rootGuard.sha256,
    alreadyPresent
  });
}

export async function packageRelationRuntime({
  inputDirectory = DEFAULT_INPUT_DIRECTORY,
  outputDirectory = DEFAULT_OUTPUT_DIRECTORY,
  expectedManifestSha256 = SOURCE_MANIFEST_SHA256
} = {}) {
  if (typeof expectedManifestSha256 !== "string"
    || !SHA256_PATTERN.test(expectedManifestSha256)) {
    throw new Error("candidate manifest SHA-256 must be a lowercase digest");
  }
  if (typeof inputDirectory !== "string" || !isAbsolute(inputDirectory)) {
    throw new Error("relation runtime input directory must be an absolute path");
  }
  if (typeof outputDirectory !== "string" || !isAbsolute(outputDirectory)) {
    throw new Error("relation runtime output directory must be an absolute path");
  }
  const input = resolve(inputDirectory);
  const output = resolve(outputDirectory);

  const sourceManifest = await readRegularFile(
    join(input, RELATION_RUNTIME_MANIFEST_FILE),
    "candidate manifest"
  );
  if (sha256(sourceManifest.bytes) !== expectedManifestSha256) {
    throw new Error("candidate manifest SHA-256 does not match the accepted value");
  }
  let sourceManifestValue;
  try {
    sourceManifestValue = JSON.parse(sourceManifest.bytes.toString("utf8"));
  } catch {
    throw new Error("candidate manifest is not valid JSON");
  }
  validateSourceManifest(sourceManifestValue);

  const supervisor = await readRegularFile(
    join(input, SOURCE_FILES.supervisor),
    "candidate relation supervisor"
  );
  const rootGuard = await readRegularFile(
    join(input, SOURCE_FILES.rootGuard),
    "candidate root-guard"
  );
  assertFixedArtifact(
    supervisor.bytes,
    RELATION_RUNTIME_ARTIFACTS.supervisor,
    "candidate relation supervisor"
  );
  assertFixedArtifact(
    rootGuard.bytes,
    RELATION_RUNTIME_ARTIFACTS.rootGuard,
    "candidate root-guard"
  );

  const packageManifestBytes = Buffer.from(
    `${JSON.stringify(createRelationRuntimeManifest(), null, 2)}\n`
  );
  const outputs = outputPaths(output, packageManifestBytes);
  const stagedBytes = new Map([
    [SOURCE_FILES.supervisor, supervisor.bytes],
    [SOURCE_FILES.rootGuard, rootGuard.bytes],
    [RELATION_RUNTIME_MANIFEST_FILE, packageManifestBytes]
  ]);

  await readOutputDirectory(output);
  if (await inspectExistingOutputs(outputs, stagedBytes)) {
    return publicResult({
      inputDirectory: input,
      outputDirectory: output,
      packageManifestBytes,
      alreadyPresent: true
    });
  }

  await mkdir(STAGING_ROOT, { recursive: true, mode: 0o755 });
  const stagingDirectory = await mkdtemp(
    join(STAGING_ROOT, "relation-runtime-package-")
  );
  const createdTargets = [];
  try {
    for (const outputItem of outputs) {
      await writeFile(
        join(stagingDirectory, outputItem.name),
        stagedBytes.get(outputItem.name),
        { flag: "wx", mode: outputItem.mode }
      );
    }

    await mkdir(output, { recursive: true, mode: 0o755 });
    await readOutputDirectory(output);
    try {
      for (const outputItem of outputs) {
        await copyFile(
          join(stagingDirectory, outputItem.name),
          outputItem.path,
          fsConstants.COPYFILE_EXCL
        );
        createdTargets.push(outputItem.path);
      }
      for (const outputItem of outputs) {
        await chmod(outputItem.path, outputItem.mode);
      }
    } catch (error) {
      for (const path of createdTargets.reverse()) {
        await rm(path, { force: true }).catch(() => {});
      }
      throw error;
    }
  } finally {
    await rm(stagingDirectory, { recursive: true, force: true });
  }

  return publicResult({
    inputDirectory: input,
    outputDirectory: output,
    packageManifestBytes,
    alreadyPresent: false
  });
}

function usage() {
  return [
    "Usage: node scripts/package-relation-runtime.mjs [--input <directory>] [--output <directory>]",
    "",
    "Packages the accepted Linux ARM64 relation supervisor and root-guard.",
    "Defaults use the pinned r9-manifest-r2 candidate directory and",
    "server/runtime/native/linux-arm64/relation output."
  ].join("\n");
}

function parseArguments(args) {
  const parsed = {};
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--help" || argument === "-h") {
      parsed.help = true;
      continue;
    }
    if (argument !== "--input" && argument !== "--output") {
      throw new Error(`unknown argument: ${argument}`);
    }
    const value = args[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`${argument} requires a directory`);
    }
    parsed[argument === "--input" ? "inputDirectory" : "outputDirectory"] = value;
    index += 1;
  }
  return parsed;
}

if (resolve(process.argv[1] || "") === fileURLToPath(import.meta.url)) {
  try {
    const options = parseArguments(process.argv.slice(2));
    if (options.help) {
      console.log(usage());
    } else {
      const result = await packageRelationRuntime({
        inputDirectory: options.inputDirectory
          ? resolve(options.inputDirectory)
          : DEFAULT_INPUT_DIRECTORY,
        outputDirectory: options.outputDirectory
          ? resolve(options.outputDirectory)
          : DEFAULT_OUTPUT_DIRECTORY
      });
      console.log(JSON.stringify(result, null, 2));
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
