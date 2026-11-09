import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  constants,
  copyFile,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  stat,
  writeFile
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import {
  assertSafeDirectory,
  ensureSafeDirectory
} from "./lib/owner-lock-evidence-paths.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const addonRoot = path.join(root, "native", "sfsc-owner-lock-addon");
const arch = process.arch;
const BUILD_TIMEOUT_MS = 10 * 60 * 1_000;
const BUILD_MAX_BUFFER_BYTES = 16 * 1024 * 1024;
const EVIDENCE_SEGMENTS = Object.freeze([
  ".tmp",
  "development-2026-10-21",
  "p2-owner-admission",
  "owner-state-snapshot-implementation-r1"
]);
const EVIDENCE_DIRECTORY = EVIDENCE_SEGMENTS.join("/");
const NATIVE_API_REVISION = "2";
const MANIFEST_SCHEMA_VERSION = "2";

if (process.platform !== "linux" || !["arm64", "x64"].includes(arch)) {
  throw new Error("owner-lock addon builds only on Linux arm64 or x64");
}

const nodeMajor = Number(process.versions.node.split(".")[0]);
const runtimeNapi = Number(process.versions.napi);
if (!Number.isSafeInteger(nodeMajor) || nodeMajor < 1
  || !Number.isSafeInteger(runtimeNapi) || runtimeNapi < 8) {
  throw new Error("owner-lock build runtime lacks required Node metadata");
}

function digest(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function relativePath(filePath) {
  return path.relative(root, filePath).split(path.sep).join("/");
}

function errorDetails(error) {
  if (!error) {
    return null;
  }
  return {
    name: typeof error.name === "string" ? error.name : "Error",
    code: typeof error.code === "string" ? error.code : null,
    message: error.message ?? String(error),
    signal: typeof error.signal === "string" ? error.signal : null
  };
}

function reportLibc() {
  const report = process.report?.getReport?.();
  if (report?.header?.glibcVersionRuntime) {
    return "glibc";
  }
  const sharedObjects = report?.sharedObjects ?? [];
  if (sharedObjects.some(file => file.includes("ld-musl"))) {
    return "musl";
  }
  return "unknown";
}

async function fileSnapshot(filePath, relative) {
  const metadata = await lstat(filePath);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error(`controlled source is not a regular file: ${relative}`);
  }
  const bytes = await readFile(filePath);
  return {
    path: relative,
    sizeBytes: bytes.length,
    sha256: digest(bytes)
  };
}

async function collectTree(directory, relative, files) {
  const entries = await readdir(directory, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name, "en"));
  for (const entry of entries) {
    const absolute = path.join(directory, entry.name);
    const entryRelative = path.posix.join(relative, entry.name);
    if (entry.isSymbolicLink()) {
      throw new Error(`controlled source contains a symlink: ${entryRelative}`);
    }
    if (entry.isDirectory()) {
      await collectTree(absolute, entryRelative, files);
    } else if (entry.isFile()) {
      files.push(await fileSnapshot(absolute, entryRelative));
    } else {
      throw new Error(
        `controlled source contains an unsupported entry: ${entryRelative}`
      );
    }
  }
}

async function controlledSourceSnapshot(sourceRoot) {
  const files = [
    await fileSnapshot(path.join(sourceRoot, "binding.gyp"), "binding.gyp")
  ];
  await collectTree(path.join(sourceRoot, "src"), "src", files);
  files.sort((left, right) => left.path.localeCompare(right.path, "en"));
  const aggregate = digest(Buffer.from(
    files.map(file => `${file.path}\0${file.sha256}`).join("\n"),
    "utf8"
  ));
  return {
    scope: ["binding.gyp", "src/**"],
    files,
    snapshotSha256: aggregate
  };
}

async function captureSnapshot(sourceRoot) {
  try {
    return { value: await controlledSourceSnapshot(sourceRoot), error: null };
  } catch (error) {
    return { value: null, error: errorDetails(error) };
  }
}

async function writeExclusive(filePath, contents) {
  await writeFile(filePath, contents, { flag: "wx" });
}

const buildParentChain = await ensureSafeDirectory(
  root,
  [...EVIDENCE_SEGMENTS, "build"]
);
const buildParent = buildParentChain.canonicalTargetPath;
const createdBuildRoot = await mkdtemp(path.join(buildParent, "run-"));
const buildRootChain = await assertSafeDirectory(
  root,
  [...EVIDENCE_SEGMENTS, "build", path.basename(createdBuildRoot)]
);
const buildRoot = buildRootChain.canonicalTargetPath;
if ((await readdir(buildRoot)).length !== 0) {
  throw new Error("new owner-lock build root is not empty");
}

const stagingSource = path.join(buildRoot, "source");
const artifactPath = path.join(buildRoot, "sfsc_owner_lock.node");
const manifestPath = path.join(buildRoot, "manifest.json");
const sourceSnapshotPath = path.join(buildRoot, "source-snapshot.json");
const artifactDigestPath = path.join(buildRoot, "artifact.sha256");
const stdoutPath = path.join(buildRoot, "build.stdout.txt");
const stderrPath = path.join(buildRoot, "build.stderr.txt");
const provenancePath = path.join(buildRoot, "build-provenance.json");

const sourceBefore = await controlledSourceSnapshot(addonRoot);
await mkdir(stagingSource, { recursive: false });
await copyFile(
  path.join(addonRoot, "binding.gyp"),
  path.join(stagingSource, "binding.gyp"),
  constants.COPYFILE_EXCL
);
await cp(path.join(addonRoot, "src"), path.join(stagingSource, "src"), {
  recursive: true,
  errorOnExist: true,
  force: false
});
const stagedBefore = await controlledSourceSnapshot(stagingSource);
if (!isDeepStrictEqual(stagedBefore, sourceBefore)) {
  throw new Error("staged controlled source differs from the original snapshot");
}

const command = "node-gyp";
const args = [
  "rebuild",
  "--directory",
  stagingSource,
  "--napi_build_version=8"
];
const build = spawnSync(command, args, {
  cwd: root,
  shell: false,
  timeout: BUILD_TIMEOUT_MS,
  maxBuffer: BUILD_MAX_BUFFER_BYTES
});
const stdoutBytes = Buffer.isBuffer(build.stdout)
  ? build.stdout
  : Buffer.alloc(0);
const stderrBytes = Buffer.isBuffer(build.stderr)
  ? build.stderr
  : Buffer.alloc(0);
await writeExclusive(stdoutPath, stdoutBytes);
await writeExclusive(stderrPath, stderrBytes);

const sourceAfterCapture = await captureSnapshot(addonRoot);
const stagedAfterCapture = await captureSnapshot(stagingSource);
const sourceAfter = sourceAfterCapture.value;
const stagedAfter = stagedAfterCapture.value;
const sourceSnapshotFailures = {
  originalAfter: sourceAfterCapture.error,
  stagedAfter: stagedAfterCapture.error
};

const provenanceBase = {
  schemaVersion: MANIFEST_SCHEMA_VERSION,
  nativeApiRevision: NATIVE_API_REVISION,
  evidenceDirectory: EVIDENCE_DIRECTORY,
  command,
  args,
  limits: {
    timeoutMs: BUILD_TIMEOUT_MS,
    maxBufferBytes: BUILD_MAX_BUFFER_BYTES
  },
  runtime: {
    nodeVersion: process.version,
    nodeMajor,
    napiVersion: runtimeNapi,
    platform: process.platform,
    arch,
    libc: reportLibc()
  },
  buildRoot: relativePath(buildRoot),
  stagingSource: relativePath(stagingSource),
  exitCode: build.status,
  signal: build.signal,
  spawnError: errorDetails(build.error),
  outputTruncated: build.error?.code === "ENOBUFS",
  stdout: {
    path: relativePath(stdoutPath),
    sizeBytes: stdoutBytes.length,
    sha256: digest(stdoutBytes)
  },
  stderr: {
    path: relativePath(stderrPath),
    sizeBytes: stderrBytes.length,
    sha256: digest(stderrBytes)
  },
  sourceSnapshot: {
    before: sourceBefore,
    stagedBefore,
    stagedAfter,
    after: sourceAfter,
    failures: sourceSnapshotFailures
  }
};

let phase = "build_result";
try {
  if (build.error) {
    throw build.error;
  }
  if (build.status !== 0) {
    throw new Error(`node-gyp exited with status ${build.status}`);
  }

  phase = "source_snapshot_after_build";
  if (sourceSnapshotFailures.originalAfter
    || sourceSnapshotFailures.stagedAfter) {
    throw new Error("controlled source snapshot failed after the build");
  }
  if (!isDeepStrictEqual(sourceAfter, sourceBefore)) {
    throw new Error("controlled source changed during the isolated build");
  }
  if (!isDeepStrictEqual(stagedAfter, sourceBefore)) {
    throw new Error("staged controlled source changed during the isolated build");
  }

  phase = "runtime_metadata";
  const libc = reportLibc();
  if (!["glibc", "musl"].includes(libc)) {
    throw new Error("owner-lock build runtime libc family is unknown");
  }

  phase = "artifact_copy";
  const builtArtifact = path.join(
    stagingSource,
    "build",
    "Release",
    "sfsc_owner_lock.node"
  );
  await copyFile(builtArtifact, artifactPath, constants.COPYFILE_EXCL);
  const artifactBytes = await readFile(artifactPath);
  const artifactStat = await stat(artifactPath);
  const artifactSha256 = digest(artifactBytes);
  const canonicalArtifactPath = await realpath(artifactPath);

  phase = "artifact_manifest";
  const manifest = {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    nativeApiRevision: NATIVE_API_REVISION,
    nodeMajor,
    napiVersion: 8,
    platform: process.platform,
    arch,
    libc,
    artifactFile: path.basename(artifactPath),
    artifactSizeBytes: artifactStat.size,
    artifactSha256
  };

  phase = "evidence_write";
  await writeExclusive(
    manifestPath,
    `${JSON.stringify(manifest, null, 2)}\n`
  );
  await writeExclusive(
    sourceSnapshotPath,
    `${JSON.stringify({
      before: sourceBefore,
      stagedBefore,
      stagedAfter,
      after: sourceAfter
    }, null, 2)}\n`
  );
  await writeExclusive(
    artifactDigestPath,
    `${artifactSha256}  ${path.basename(artifactPath)}\n`
  );

  phase = "provenance_write";
  await writeExclusive(
    provenancePath,
    `${JSON.stringify({
      ...provenanceBase,
      completed: true,
      artifact: {
        path: relativePath(artifactPath),
        canonicalPath: canonicalArtifactPath,
        sizeBytes: artifactStat.size,
        sha256: artifactSha256
      },
      manifest: {
        path: relativePath(manifestPath),
        value: manifest
      },
      evidence: {
        sourceSnapshot: relativePath(sourceSnapshotPath),
        artifactDigest: relativePath(artifactDigestPath)
      }
    }, null, 2)}\n`
  );

  console.log(JSON.stringify({
    evidenceDirectory: EVIDENCE_DIRECTORY,
    buildRoot: relativePath(buildRoot),
    artifactPath: relativePath(artifactPath),
    artifactSizeBytes: manifest.artifactSizeBytes,
    artifactSha256,
    manifestPath: relativePath(manifestPath),
    provenancePath: relativePath(provenancePath)
  }));
} catch (error) {
  await writeExclusive(
    provenancePath,
    `${JSON.stringify({
      ...provenanceBase,
      completed: false,
      failedPhase: phase,
      failure: {
        ...errorDetails(error),
        buildStatus: build.status,
        buildSignal: build.signal,
        outputTruncated: build.error?.code === "ENOBUFS"
      }
    }, null, 2)}\n`
  );
  throw error;
}
