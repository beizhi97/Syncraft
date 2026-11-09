import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  symlink,
  writeFile
} from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import {
  loadRelationRuntimePackage,
  RELATION_RUNTIME_ARTIFACTS
} from "../src/service/relationRuntimePackage.js";
import {
  packageRelationRuntime
} from "../scripts/package-relation-runtime.mjs";

const root = join(import.meta.dirname, "..");
const productionPackageDirectory = join(
  root,
  "server",
  "runtime",
  "native",
  "linux-arm64",
  "relation"
);
const historicalCandidateDirectory = join(
  root,
  ".tmp",
  "development-2026-10-21",
  "p2-runtime-adapter",
  "integration-r9-manifest-r2",
  "candidates"
);
const testTemporaryRoot = join(
  root,
  ".tmp",
  "development-2026-10-21",
  "p2-owner-admission"
);
const historicalManifestSha256 =
  "8adbff3a487a58b0a4291f6e3b33cb00bb5cacbdedb263948e04645194f0fa09";
const sourceSupervisor = "sfsc-relation-supervisor-linux-arm64";
const sourceRootGuard = "sfsc-root-guard-linux-arm64";

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function temporaryDirectory(t) {
  await mkdir(testTemporaryRoot, { recursive: true });
  const directory = await mkdtemp(
    join(testTemporaryRoot, "relation-runtime-package-test-")
  );
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

function candidateManifestBytes() {
  return Buffer.from(`${JSON.stringify({
    goos: "linux",
    candidates: [
      {
        name: RELATION_RUNTIME_ARTIFACTS.supervisor.name,
        goarch: "arm64",
        file: sourceSupervisor,
        size: RELATION_RUNTIME_ARTIFACTS.supervisor.sizeBytes,
        sha256: RELATION_RUNTIME_ARTIFACTS.supervisor.sha256
      },
      {
        name: RELATION_RUNTIME_ARTIFACTS.rootGuard.name,
        goarch: "arm64",
        file: sourceRootGuard,
        size: RELATION_RUNTIME_ARTIFACTS.rootGuard.sizeBytes,
        sha256: RELATION_RUNTIME_ARTIFACTS.rootGuard.sha256
      }
    ]
  }, null, 2)}\n`);
}

async function copyProductionCandidates(t) {
  const directory = await temporaryDirectory(t);
  await copyFile(
    join(productionPackageDirectory, "sfsc-relation-supervisor"),
    join(directory, sourceSupervisor)
  );
  await copyFile(
    join(productionPackageDirectory, "sfsc-root-guard"),
    join(directory, sourceRootGuard)
  );
  const manifestBytes = candidateManifestBytes();
  await writeFile(join(directory, "manifest.json"), manifestBytes);
  return {
    directory,
    expectedManifestSha256: sha256(manifestBytes)
  };
}

async function packageFixture(t) {
  const candidates = await copyProductionCandidates(t);
  const outputDirectory = join(candidates.directory, "relation");
  const result = await packageRelationRuntime({
    inputDirectory: candidates.directory,
    outputDirectory,
    expectedManifestSha256: candidates.expectedManifestSha256
  });
  return {
    directory: candidates.directory,
    outputDirectory,
    result
  };
}

function loadOptions(overrides = {}) {
  const options = {
    platform: "linux",
    arch: "arm64",
    ...overrides
  };
  if (process.platform === "win32"
    && !Object.hasOwn(options, "executableModeReader")) {
    // Windows cannot expose POSIX execute bits to Node. This seam is injected
    // only on Windows and does not claim Windows ACL truth.
    options.executableModeReader = () => 0o755;
  }
  return options;
}

test("packages the accepted ARM64 candidates and is idempotent", async t => {
  const candidates = await copyProductionCandidates(t);
  const outputDirectory = join(candidates.directory, "relation");
  const first = await packageRelationRuntime({
    inputDirectory: candidates.directory,
    outputDirectory,
    expectedManifestSha256: candidates.expectedManifestSha256
  });
  assert.equal(first.alreadyPresent, false);
  assert.equal(first.manifestSha256, sha256(
    await readFile(join(outputDirectory, "manifest.json"))
  ));
  assert.equal(sha256(await readFile(first.supervisorPath)), (
    RELATION_RUNTIME_ARTIFACTS.supervisor.sha256
  ));
  assert.equal(sha256(await readFile(first.helperPath)), (
    RELATION_RUNTIME_ARTIFACTS.rootGuard.sha256
  ));
  assert.deepEqual(
    JSON.parse(await readFile(join(outputDirectory, "manifest.json"), "utf8")),
    {
      schemaVersion: 1,
      platform: "linux",
      arch: "arm64",
      artifacts: [
        { ...RELATION_RUNTIME_ARTIFACTS.supervisor },
        { ...RELATION_RUNTIME_ARTIFACTS.rootGuard }
      ]
    }
  );

  if (process.platform !== "win32") {
    assert.equal(
      (await lstat(first.supervisorPath)).mode & 0o777,
      0o755
    );
    assert.equal(
      (await lstat(first.helperPath)).mode & 0o777,
      0o755
    );
    assert.equal(
      (await lstat(first.manifestPath)).mode & 0o777,
      0o600
    );
  }

  const second = await packageRelationRuntime({
    inputDirectory: candidates.directory,
    outputDirectory,
    expectedManifestSha256: candidates.expectedManifestSha256
  });
  assert.equal(second.alreadyPresent, true);
  assert.equal(second.supervisorPath, first.supervisorPath);
  assert.equal(second.helperPath, first.helperPath);
});

test("loads a fixed package contract and returns one root-guard for both services", async t => {
  const { outputDirectory } = await packageFixture(t);
  const options = loadOptions();
  assert.equal(
    Object.hasOwn(options, "executableModeReader"),
    process.platform === "win32"
  );
  const loaded = await loadRelationRuntimePackage({
    directory: outputDirectory,
    ...options
  });
  assert.deepEqual(Object.keys(loaded), [
    "supervisorPath",
    "helperPath",
    "helperSha256",
    "execServicePath",
    "signalServicePath"
  ]);
  assert.equal(
    loaded.supervisorPath,
    join(outputDirectory, "sfsc-relation-supervisor")
  );
  assert.equal(
    loaded.helperPath,
    join(outputDirectory, "sfsc-root-guard")
  );
  assert.equal(
    loaded.helperSha256,
    RELATION_RUNTIME_ARTIFACTS.rootGuard.sha256
  );
  assert.equal(loaded.execServicePath, loaded.helperPath);
  assert.equal(loaded.signalServicePath, loaded.helperPath);
  assert.equal(Object.isFrozen(loaded), true);
});

test("rejects execute mode unless POSIX mode bits are executable", async t => {
  const { outputDirectory } = await packageFixture(t);
  await assert.rejects(
    loadRelationRuntimePackage({
      directory: outputDirectory,
      ...loadOptions({ executableModeReader: () => 0o644 })
    }),
    /is not executable/
  );
});

test("rejects candidate tampering, missing files, wrong manifest, and source path escape", async t => {
  await t.test("changed binary", async t => {
    const candidates = await copyProductionCandidates(t);
    const supervisorPath = join(candidates.directory, sourceSupervisor);
    const bytes = await readFile(supervisorPath);
    bytes[bytes.length - 1] ^= 1;
    await writeFile(supervisorPath, bytes);
    await assert.rejects(
      packageRelationRuntime({
        inputDirectory: candidates.directory,
        outputDirectory: join(candidates.directory, "output"),
        expectedManifestSha256: candidates.expectedManifestSha256
      }),
      /SHA-256 does not match/
    );
  });

  await t.test("missing binary", async t => {
    const candidates = await copyProductionCandidates(t);
    await rm(join(candidates.directory, sourceRootGuard));
    await assert.rejects(
      packageRelationRuntime({
        inputDirectory: candidates.directory,
        outputDirectory: join(candidates.directory, "output"),
        expectedManifestSha256: candidates.expectedManifestSha256
      }),
      /candidate root-guard is missing/
    );
  });

  await t.test("wrong manifest hash", async t => {
    const candidates = await copyProductionCandidates(t);
    await assert.rejects(
      packageRelationRuntime({
        inputDirectory: candidates.directory,
        outputDirectory: join(await temporaryDirectory(t), "output"),
        expectedManifestSha256: "0".repeat(64)
      }),
      /candidate manifest SHA-256/
    );
  });

  await t.test("source path escape", async t => {
    const candidates = await copyProductionCandidates(t);
    const manifestPath = join(candidates.directory, "manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    const entry = manifest.candidates.find(
      candidate => candidate.name === "sfsc-relation-supervisor"
        && candidate.goarch === "arm64"
    );
    entry.file = "../sfsc-relation-supervisor-linux-arm64";
    const bytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
    await writeFile(manifestPath, bytes);
    await assert.rejects(
      packageRelationRuntime({
        inputDirectory: candidates.directory,
        outputDirectory: join(candidates.directory, "output"),
        expectedManifestSha256: sha256(bytes)
      }),
      /candidate manifest sfsc-relation-supervisor entry/
    );
  });
});

test("does not overwrite an unknown partial output", async t => {
  const candidates = await copyProductionCandidates(t);
  const outputDirectory = join(candidates.directory, "relation");
  await mkdir(outputDirectory);
  const unknownPath = join(outputDirectory, "sfsc-relation-supervisor");
  await writeFile(unknownPath, "user-owned-content", { mode: 0o644 });
  await assert.rejects(
    packageRelationRuntime({
      inputDirectory: candidates.directory,
      outputDirectory,
      expectedManifestSha256: candidates.expectedManifestSha256
    }),
    /refusing to overwrite/
  );
  assert.equal(await readFile(unknownPath, "utf8"), "user-owned-content");
  await assert.rejects(
    readFile(join(outputDirectory, "sfsc-root-guard")),
    { code: "ENOENT" }
  );
  await assert.rejects(
    readFile(join(outputDirectory, "manifest.json")),
    { code: "ENOENT" }
  );
});

test("rejects missing, changed, malformed, and path-escaping package files", async t => {
  await t.test("missing root-guard", async t => {
    const { outputDirectory } = await packageFixture(t);
    await rm(join(outputDirectory, "sfsc-root-guard"));
    await assert.rejects(
      loadRelationRuntimePackage({
        directory: outputDirectory,
        ...loadOptions()
      }),
      /root-guard is missing/
    );
  });

  await t.test("changed supervisor", async t => {
    const { outputDirectory } = await packageFixture(t);
    const supervisorPath = join(outputDirectory, "sfsc-relation-supervisor");
    const bytes = await readFile(supervisorPath);
    bytes[bytes.length - 1] ^= 1;
    await writeFile(supervisorPath, bytes);
    await assert.rejects(
      loadRelationRuntimePackage({
        directory: outputDirectory,
        ...loadOptions()
      }),
      /SHA-256 does not match/
    );
  });

  await t.test("malformed manifest", async t => {
    const { outputDirectory } = await packageFixture(t);
    await writeFile(join(outputDirectory, "manifest.json"), "{");
    await assert.rejects(
      loadRelationRuntimePackage({
        directory: outputDirectory,
        ...loadOptions()
      }),
      /manifest is not valid JSON/
    );
  });

  await t.test("manifest path escape", async t => {
    const { outputDirectory } = await packageFixture(t);
    const manifestPath = join(outputDirectory, "manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    manifest.artifacts[0].file = "../sfsc-relation-supervisor";
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    await assert.rejects(
      loadRelationRuntimePackage({
        directory: outputDirectory,
        ...loadOptions()
      }),
      /manifest artifact supervisor/
    );
  });
});

test("rejects a symlinked package artifact when symlinks are available", async t => {
  const { outputDirectory } = await packageFixture(t);
  const expectedPath = join(outputDirectory, "sfsc-root-guard");
  const realPath = join(outputDirectory, "root-guard.real");
  await rename(expectedPath, realPath);
  try {
    await symlink(realPath, expectedPath, "file");
  } catch (error) {
    if (["EPERM", "EACCES", "ENOSYS"].includes(error?.code)) {
      t.skip(`symlink unavailable on this host: ${error.code}`);
      return;
    }
    throw error;
  }
  await assert.rejects(
    loadRelationRuntimePackage({
      directory: outputDirectory,
      ...loadOptions()
    }),
    /regular non-symlink file/
  );
});

test("source candidate symlinks are rejected when symlinks are available", async t => {
  const candidates = await copyProductionCandidates(t);
  const supervisorPath = join(candidates.directory, sourceSupervisor);
  const realPath = join(candidates.directory, "supervisor.real");
  await rename(supervisorPath, realPath);
  try {
    await symlink(realPath, supervisorPath, "file");
  } catch (error) {
    if (["EPERM", "EACCES", "ENOSYS"].includes(error?.code)) {
      t.skip(`symlink unavailable on this host: ${error.code}`);
      return;
    }
    throw error;
  }
  await assert.rejects(
    packageRelationRuntime({
      inputDirectory: candidates.directory,
      outputDirectory: join(candidates.directory, "output"),
      expectedManifestSha256: candidates.expectedManifestSha256
    }),
    /regular non-symlink file/
  );
});

test("historical r9 candidate manifest provenance remains pinned when available", async t => {
  const manifestPath = join(historicalCandidateDirectory, "manifest.json");
  try {
    await lstat(manifestPath);
  } catch (error) {
    if (error?.code === "ENOENT") {
      t.skip("historical r9 candidate manifest is unavailable");
      return;
    }
    throw error;
  }
  assert.equal(
    sha256(await readFile(manifestPath)),
    historicalManifestSha256
  );
});
