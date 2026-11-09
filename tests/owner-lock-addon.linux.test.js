import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  access,
  chmod,
  chown,
  link,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  readlink,
  rename,
  rm,
  symlink,
  unlink,
  writeFile
} from "node:fs/promises";
import { constants as fsConstants, statSync } from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  assertSafeDirectory,
  ensureSafeDirectory
} from "../scripts/lib/owner-lock-evidence-paths.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const fixture = name => path.join(root, "tests", "fixtures", "owner-lock", name);
const linuxSkip = process.platform === "linux"
  ? false
  : "requires separately authorized Linux build/run";
const evidenceReadFlags = fsConstants.O_RDONLY
  | fsConstants.O_NOFOLLOW
  | fsConstants.O_NONBLOCK
  | fsConstants.O_CLOEXEC;
const implementationSegments = Object.freeze([
  ".tmp",
  "development-2026-10-21",
  "p2-owner-admission",
  "native-linux-implementation-r2"
]);

function sha256Bytes(value) {
  return createHash("sha256").update(value).digest("hex");
}

function evidenceEntryType(stat) {
  if (stat.isDirectory()) {
    return "directory";
  }
  if (stat.isFile()) {
    return "regular-file";
  }
  if (stat.isSymbolicLink()) {
    return "symbolic-link";
  }
  if (stat.isFIFO()) {
    return "fifo";
  }
  if (stat.isSocket()) {
    return "socket";
  }
  if (stat.isCharacterDevice()) {
    return "character-device";
  }
  if (stat.isBlockDevice()) {
    return "block-device";
  }
  throw new Error("unsupported filesystem entry type");
}

function evidenceStatMetadata(stat, type) {
  const permissions = Number(stat.mode & 0o777n);
  return {
    type,
    mode: `0${permissions.toString(8).padStart(3, "0")}`,
    uid: stat.uid.toString(),
    gid: stat.gid.toString(),
    sizeBytes: stat.size.toString(),
    device: stat.dev.toString(),
    inode: stat.ino.toString(),
    links: stat.nlink.toString(),
    mtimeNs: stat.mtimeNs.toString()
  };
}

function sameEvidenceIdentity(left, right) {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.mode === right.mode;
}

function containedEvidencePath(base, relativePath, description) {
  const resolved = path.resolve(base, relativePath);
  const relation = path.relative(base, resolved);
  if (relation === ".."
    || relation.startsWith(`..${path.sep}`)
    || path.isAbsolute(relation)) {
    throw new Error(`${description} escapes its evidence root`);
  }
  return resolved;
}

function manifestRelativePath(relativePath) {
  return relativePath === ""
    ? "."
    : relativePath.split(path.sep).join("/");
}

async function archiveEvidenceTree(sourceRoot, archiveRoot) {
  if (typeof fsConstants.O_NOFOLLOW !== "number"
    || typeof fsConstants.O_NONBLOCK !== "number") {
    throw new Error("safe evidence archive requires O_NOFOLLOW and O_NONBLOCK");
  }
  await mkdir(archiveRoot, { mode: 0o700 });
  const entries = [];
  const summary = {
    entries: 0,
    directoriesCopied: 0,
    regularFilesCopied: 0,
    symbolicLinksRecreated: 0,
    specialEntriesRecorded: 0,
    regularFileBytesCopied: 0,
    entryTypes: {}
  };

  async function recordEntry(relativePath) {
    const sourcePath = containedEvidencePath(
      sourceRoot,
      relativePath,
      "source evidence path"
    );
    const archivePath = containedEvidencePath(
      archiveRoot,
      relativePath,
      "archive evidence path"
    );
    const sourceStat = await lstat(sourcePath, { bigint: true });
    const type = evidenceEntryType(sourceStat);
    const metadata = {
      relativePath: manifestRelativePath(relativePath),
      ...evidenceStatMetadata(sourceStat, type)
    };
    summary.entries += 1;
    summary.entryTypes[type] = (summary.entryTypes[type] ?? 0) + 1;

    if (type === "directory") {
      const mode = Number(sourceStat.mode & 0o777n);
      if (relativePath !== "") {
        await mkdir(archivePath, { mode });
      }
      await chmod(archivePath, mode);
      entries.push({
        ...metadata,
        copied: true,
        copyMode: "recursive-directory"
      });
      summary.directoriesCopied += 1;
      const names = (await readdir(sourcePath)).sort();
      for (const name of names) {
        if (name === "." || name === ".." || name.includes(path.sep)) {
          throw new Error("evidence directory contains an unsafe entry name");
        }
        await recordEntry(
          relativePath === "" ? name : path.join(relativePath, name)
        );
      }
      const sourceAfter = await lstat(sourcePath, { bigint: true });
      if (!sameEvidenceIdentity(sourceStat, sourceAfter)
        || evidenceEntryType(sourceAfter) !== "directory") {
        throw new Error(`source directory changed while archiving: ${relativePath}`);
      }
      return;
    }

    if (type === "regular-file") {
      const mode = Number(sourceStat.mode & 0o777n);
      const handle = await open(sourcePath, evidenceReadFlags);
      let bytes;
      try {
        const openedStat = await handle.stat({ bigint: true });
        if (!openedStat.isFile() || !sameEvidenceIdentity(sourceStat, openedStat)) {
          throw new Error(`source file changed before archiving: ${relativePath}`);
        }
        bytes = await handle.readFile();
        const readStat = await handle.stat({ bigint: true });
        if (!sameEvidenceIdentity(openedStat, readStat)
          || openedStat.size !== readStat.size
          || openedStat.mtimeNs !== readStat.mtimeNs
          || BigInt(bytes.length) !== openedStat.size) {
          throw new Error(`source file changed while archiving: ${relativePath}`);
        }
      } finally {
        await handle.close();
      }
      await writeFile(archivePath, bytes, { flag: "wx", mode });
      await chmod(archivePath, mode);
      const archivedStat = await lstat(archivePath, { bigint: true });
      if (!archivedStat.isFile()
        || archivedStat.size !== BigInt(bytes.length)) {
        throw new Error(`archived regular file is incomplete: ${relativePath}`);
      }
      const sourceAfter = await lstat(sourcePath, { bigint: true });
      if (!sameEvidenceIdentity(sourceStat, sourceAfter)
        || evidenceEntryType(sourceAfter) !== "regular-file") {
        throw new Error(`source file changed during archive: ${relativePath}`);
      }
      entries.push({
        ...metadata,
        copied: true,
        copyMode: "byte-for-byte",
        copiedBytes: bytes.length,
        sha256: sha256Bytes(bytes)
      });
      summary.regularFilesCopied += 1;
      summary.regularFileBytesCopied += bytes.length;
      return;
    }

    if (type === "symbolic-link") {
      const linkTarget = await readlink(sourcePath);
      await symlink(linkTarget, archivePath);
      const archivedStat = await lstat(archivePath, { bigint: true });
      if (!archivedStat.isSymbolicLink()
        || await readlink(archivePath) !== linkTarget) {
        throw new Error(`archived symbolic link is incomplete: ${relativePath}`);
      }
      const sourceAfter = await lstat(sourcePath, { bigint: true });
      if (!sameEvidenceIdentity(sourceStat, sourceAfter)
        || evidenceEntryType(sourceAfter) !== "symbolic-link") {
        throw new Error(`source symbolic link changed during archive: ${relativePath}`);
      }
      entries.push({
        ...metadata,
        copied: true,
        copyMode: "symbolic-link-target",
        linkTarget
      });
      summary.symbolicLinksRecreated += 1;
      return;
    }

    const sourceAfter = await lstat(sourcePath, { bigint: true });
    if (!sameEvidenceIdentity(sourceStat, sourceAfter)
      || evidenceEntryType(sourceAfter) !== type) {
      throw new Error(`special evidence entry changed during archive: ${relativePath}`);
    }
    entries.push({
      ...metadata,
      copied: false,
      copyMode: "metadata-only",
      contentRead: false
    });
    summary.specialEntriesRecorded += 1;
  }

  await recordEntry("");
  const specialEntries = entries.filter(entry => entry.copyMode === "metadata-only");
  return {
    schemaVersion: "1",
    generatedAt: new Date().toISOString(),
    sourceRoot,
    archiveRoot,
    entries,
    specialEntries,
    summary,
    rawEvidenceCopied: specialEntries.length === 0,
    rawEvidenceCopyScope: specialEntries.length === 0
      ? "all entries copied or recreated"
      : "regular files and symbolic links archived; special entries recorded by lstat metadata only"
  };
}

function argument(name) {
  const index = process.argv.indexOf(name);
  if (index < 0 || index + 1 >= process.argv.length) {
    return undefined;
  }
  return process.argv[index + 1];
}

async function writeJsonExclusive(filePath, value) {
  await writeFile(
    filePath,
    `${JSON.stringify(value, null, 2)}\n`,
    { flag: "wx" }
  );
}

async function waitForPath(filePath, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      await access(filePath);
      return;
    } catch (error) {
      if (error?.code !== "ENOENT") {
        throw error;
      }
    }
    if (Date.now() >= deadline) {
      throw new Error(`timed out waiting for ${filePath}`);
    }
    await delay(20);
  }
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

function spawnNode(args) {
  const child = spawn(process.execPath, args, {
    cwd: root,
    stdio: ["ignore", "pipe", "pipe"]
  });
  let timedOut = false;
  const watchdog = setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) {
      timedOut = true;
      child.kill("SIGKILL");
    }
  }, 20_000);
  watchdog.unref();
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", chunk => {
    stdout += chunk;
  });
  child.stderr.on("data", chunk => {
    stderr += chunk;
  });
  const completed = new Promise((resolve, reject) => {
    child.once("error", error => {
      clearTimeout(watchdog);
      reject(error);
    });
    child.once("close", (code, signal) => {
      clearTimeout(watchdog);
      resolve({ code, signal, stdout, stderr, timedOut });
    });
  });
  return { child, completed };
}

async function closeAfterRelease(execution, releasePath) {
  await writeFile(releasePath, "release\n", { flag: "wx" });
  return execution.completed;
}

async function recordFailureCase({
  caseRoot,
  artifactPath,
  manifestPath,
  statePath,
  expectedCode,
  track = execution => execution,
  requireNoRetainedFds = false
}) {
  const configPath = path.join(caseRoot, "holder-config.json");
  const readyPath = path.join(caseRoot, "ready.json");
  const resultPath = path.join(caseRoot, "result.json");
  const descendantsFinalPath = path.join(caseRoot, "descendants-final.json");
  await writeJsonExclusive(configPath, {
    mode: "acquire-failure",
    artifactPath,
    manifestPath,
    statePath,
    readyPath,
    resultPath,
    descendantsFinalPath,
    timeoutMs: 5_000
  });
  const execution = track(spawnNode([
    fixture("holder-child.mjs"),
    "--config",
    configPath
  ]));
  const completion = await execution.completed;
  await writeJsonExclusive(path.join(caseRoot, "direct-child.json"), {
    pid: execution.child.pid,
    completionEvent: "close",
    code: completion.code,
    signal: completion.signal,
    timedOut: completion.timedOut
  });
  assert.equal(completion.code, 0, completion.stderr);
  const result = await readJson(resultPath);
  assert.equal(result.ok, true);
  const attempt = result.records.find(record => record.label === "attempt");
  const retry = result.records.find(record => record.label === "retry");
  const fds = result.records.find(record => record.label === "fds");
  assert.equal(attempt.code, expectedCode);
  assert.equal(retry.code, "owner_lock_retry_forbidden");
  assert.equal(fds.before.complete, true);
  assert.equal(fds.after.complete, true);
  assert.deepEqual(fds.newMatchingParentFds, []);
  assert.deepEqual(fds.newMatchingLockFds, []);
  if (requireNoRetainedFds) {
    assert.ok(fds.identity.parent, "parent identity must be observable");
    assert.ok(fds.identity.lock, "lock identity must be observable");
    assert.deepEqual(fds.before.matchingParentFds, []);
    assert.deepEqual(fds.before.matchingLockFds, []);
    assert.deepEqual(fds.after.matchingParentFds, []);
    assert.deepEqual(fds.after.matchingLockFds, []);
  }
  return result;
}

test("Linux owner-lock integration matrix", { skip: linuxSkip }, async t => {
  const artifactPath = argument("--owner-lock-artifact");
  const manifestPath = argument("--owner-lock-manifest");
  assert.ok(artifactPath, "run with --owner-lock-artifact");
  assert.ok(manifestPath, "run with --owner-lock-manifest");

  const casesSegments = Object.freeze([...implementationSegments, "cases"]);
  const casesChain = await ensureSafeDirectory(root, casesSegments);
  const casesParent = casesChain.canonicalTargetPath;
  const evidenceParentChain = await ensureSafeDirectory(
    root,
    [...implementationSegments, "evidence"]
  );
  const createdEvidenceRoot = await mkdtemp(
    path.join(evidenceParentChain.canonicalTargetPath, "run-")
  );
  const evidenceSegments = Object.freeze([
    ...implementationSegments,
    "evidence",
    path.basename(createdEvidenceRoot)
  ]);
  const evidenceRootChain = await assertSafeDirectory(root, evidenceSegments);
  const evidenceRoot = evidenceRootChain.canonicalTargetPath;
  const matrix = [];
  const retainedCases = [];
  const directChildren = new Set();

  // These checks reject an already substituted alias at each boundary. They do
  // not claim to close a concurrent rename between a check and later I/O.
  async function assertCasesRoot() {
    return assertSafeDirectory(root, casesSegments);
  }

  async function assertEvidenceRoot() {
    return assertSafeDirectory(root, evidenceSegments);
  }

  async function assertCaseRoot(entry) {
    await assertCasesRoot();
    return assertSafeDirectory(
      root,
      [...casesSegments, path.basename(entry.caseRoot)]
    );
  }

  async function writeEvidenceJson(fileName, value) {
    await assertEvidenceRoot();
    await writeJsonExclusive(path.join(evidenceRoot, fileName), value);
  }

  t.after(async () => {
    const interruptedChildren = [...directChildren].map(execution => ({
      pid: execution.child.pid,
      exitCode: execution.child.exitCode,
      signalCode: execution.child.signalCode
    }));
    for (const execution of directChildren) {
      if (execution.child.exitCode === null
        && execution.child.signalCode === null) {
        execution.child.kill("SIGKILL");
      }
    }
    await Promise.allSettled(
      [...directChildren].map(execution => execution.completed)
    );
    if (retainedCases.length > 0) {
      for (const entry of retainedCases) {
        await assertEvidenceRoot();
        const retainedCaseChain = await assertCaseRoot(entry);
        const cleanupFinalPath = path.join(
          evidenceRoot,
          `cleanup-final-${entry.label}.json`
        );
        let cleanupFinalExists = true;
        try {
          await access(cleanupFinalPath);
        } catch (error) {
          if (error?.code !== "ENOENT") {
            throw error;
          }
          cleanupFinalExists = false;
        }
        if (!cleanupFinalExists) {
          const cleanupPrePath = path.join(
            evidenceRoot,
            `cleanup-pre-${entry.label}.json`
          );
          try {
            await access(cleanupPrePath);
          } catch (error) {
            if (error?.code !== "ENOENT") {
              throw error;
            }
            const retainedCasesRoot = await assertCasesRoot();
            await assertEvidenceRoot();
            await writeJsonExclusive(cleanupPrePath, {
              schemaVersion: "1",
              allowedRoot: retainedCasesRoot.canonicalTargetPath,
              caseRoot: retainedCaseChain.canonicalTargetPath,
              containment: true,
              directChildren: interruptedChildren,
              descendantsFinal: null,
              completionValidated: false,
              failures: ["test ended before cleanup confirmation"],
              rawEvidenceCopied: false,
              pathsToDelete: []
            });
          }
          await writeEvidenceJson(`cleanup-final-${entry.label}.json`, {
            schemaVersion: "1",
            caseRoot: retainedCaseChain.canonicalTargetPath,
            removed: false,
            failure: "test ended before cleanup confirmation"
          });
        }
      }
      await writeEvidenceJson("cleanup-failure.json", {
        schemaVersion: "1",
        failure: "cases retained because completion evidence was incomplete",
        cases: retainedCases.map(entry => entry.caseRoot),
        directChildren: interruptedChildren
      });
    }
    await writeEvidenceJson("matrix-final.json", matrix);
  });

  async function createCase(label) {
    await assertCasesRoot();
    const createdCaseRoot = await mkdtemp(
      path.join(casesParent, `${label}-`)
    );
    const caseRootChain = await assertSafeDirectory(
      root,
      [...casesSegments, path.basename(createdCaseRoot)]
    );
    const caseRoot = caseRootChain.canonicalTargetPath;
    await chmod(caseRoot, 0o700);
    const entry = { label, caseRoot };
    retainedCases.push(entry);
    return entry;
  }

  function track(execution) {
    directChildren.add(execution);
    execution.completed.then(
      () => directChildren.delete(execution),
      () => directChildren.delete(execution)
    );
    return execution;
  }

  async function startHolder(entry, overrides = {}) {
    const configPath = path.join(entry.caseRoot, "holder-config.json");
    const readyPath = path.join(entry.caseRoot, "ready.json");
    const releasePath = path.join(entry.caseRoot, "release");
    const resultPath = path.join(entry.caseRoot, "result.json");
    const descendantsFinalPath = path.join(
      entry.caseRoot,
      "descendants-final.json"
    );
    const config = {
      artifactPath,
      manifestPath,
      root,
      execChildPath: fixture("exec-child.mjs"),
      nativeWorkerPath: fixture("native-worker.mjs"),
      publicWorkerPath: fixture("worker-acquire.mjs"),
      readyPath,
      releasePath,
      resultPath,
      descendantsFinalPath,
      timeoutMs: 5_000,
      hold: false,
      ...overrides
    };
    await writeJsonExclusive(configPath, config);
    const execution = track(spawnNode([
      ...(config.nodeArgs ?? []),
      fixture("holder-child.mjs"),
      "--config",
      configPath
    ]));
    if (config.waitForReady !== false) {
      await waitForPath(readyPath, config.timeoutMs);
      const ready = await readJson(readyPath);
      assert.equal(ready.pid, execution.child.pid);
    }
    return {
      execution,
      config,
      readyPath,
      releasePath,
      resultPath,
      descendantsFinalPath
    };
  }

  async function cleanupCase(
    entry,
    childEvidence = [],
    { requiresDescendantsFinal = true } = {}
  ) {
    const allowedRootChain = await assertCasesRoot();
    const initialCaseChain = await assertCaseRoot(entry);
    const allowedRoot = allowedRootChain.canonicalTargetPath;
    let resolvedCase = initialCaseChain.canonicalTargetPath;
    let recordedChildren = [];
    try {
      const recorded = await readJson(
        path.join(resolvedCase, "direct-child.json")
      );
      recordedChildren = [recorded];
    } catch (error) {
      if (error?.code !== "ENOENT") {
        throw error;
      }
    }
    const allChildren = [...childEvidence, ...recordedChildren];
    const normalizedChildren = allChildren.map(child => {
      const completion = child.completion ?? child;
      return {
        pid: child.pid ?? null,
        completionEvent: "close",
        code: completion.code ?? null,
        signal: completion.signal ?? null,
        timedOut: completion.timedOut === true
      };
    });
    const validationFailures = [];
    for (const child of normalizedChildren) {
      if (child.timedOut) {
        validationFailures.push(`child ${child.pid} timed out`);
      }
      if (child.code === null && child.signal === null) {
        validationFailures.push(`child ${child.pid} lacks close status`);
      }
    }
    let descendantsFinal = null;
    try {
      descendantsFinal = await readJson(
        path.join(resolvedCase, "descendants-final.json")
      );
      if (descendantsFinal.finished !== true) {
        validationFailures.push("holder descendants-final is not finished");
      }
      for (const descendant of descendantsFinal.descendants ?? []) {
        if (!["exit", "terminate", "close"].includes(
          descendant.completionEvent
        )) {
          validationFailures.push(
            `descendant ${descendant.pid ?? "worker"} lacks completion event`
          );
        }
        if (descendant.completionEvent === "close"
          && descendant.code === null
          && descendant.signal === null) {
          validationFailures.push(
            `ChildProcess descendant ${descendant.pid} lacks close status`
          );
        }
      }
    } catch (error) {
      if (error?.code !== "ENOENT" || requiresDescendantsFinal) {
        validationFailures.push(
          error?.code === "ENOENT"
            ? "holder descendants-final is missing"
            : `holder descendants-final is invalid: ${error?.message}`
        );
      }
    }
    if (validationFailures.length > 0) {
      await writeEvidenceJson(`cleanup-pre-${entry.label}.json`, {
        schemaVersion: "1",
        allowedRoot,
        caseRoot: resolvedCase,
        containment: true,
        directChildren: normalizedChildren,
        descendantsFinal,
        completionValidated: false,
        failures: validationFailures,
        rawEvidenceCopied: false,
        pathsToDelete: []
      });
      await writeEvidenceJson(`cleanup-final-${entry.label}.json`, {
        schemaVersion: "1",
        caseRoot: resolvedCase,
        removed: false,
        failure: validationFailures.join("; ")
      });
      throw new Error(validationFailures.join("; "));
    }
    if (!/^[A-Za-z0-9-]+$/.test(entry.label)) {
      throw new Error("case label is not safe for archive evidence");
    }
    const archiveParentChain = await ensureSafeDirectory(
      root,
      [...evidenceSegments, "cases"]
    );
    const archiveRoot = path.join(
      archiveParentChain.canonicalTargetPath,
      entry.label
    );
    const copyCaseChain = await assertCaseRoot(entry);
    resolvedCase = copyCaseChain.canonicalTargetPath;
    const archiveManifest = await archiveEvidenceTree(resolvedCase, archiveRoot);
    const archiveChain = await assertSafeDirectory(
      root,
      [...evidenceSegments, "cases", entry.label]
    );
    const archiveManifestName = `archive-${entry.label}.json`;
    await writeEvidenceJson(archiveManifestName, archiveManifest);
    const archiveManifestPath = path.join(evidenceRoot, archiveManifestName);
    const archiveManifestSha256 = sha256Bytes(
      Buffer.from(`${JSON.stringify(archiveManifest, null, 2)}\n`)
    );
    await writeEvidenceJson(`cleanup-pre-${entry.label}.json`, {
      schemaVersion: "1",
      allowedRoot,
      caseRoot: resolvedCase,
      containment: true,
      directChildren: normalizedChildren,
      descendantsFinal,
      completionValidated: true,
      archiveRoot: archiveChain.canonicalTargetPath,
      archiveManifest: archiveManifestPath,
      archiveManifestSha256,
      archiveSummary: archiveManifest.summary,
      specialEntries: archiveManifest.specialEntries,
      rawEvidenceCopied: archiveManifest.rawEvidenceCopied,
      rawEvidenceCopyScope: archiveManifest.rawEvidenceCopyScope,
      pathsToDelete: [resolvedCase]
    });
    try {
      const removalCaseChain = await assertCaseRoot(entry);
      resolvedCase = removalCaseChain.canonicalTargetPath;
      await rm(resolvedCase, { recursive: true, force: false });
      await assert.rejects(
        access(resolvedCase),
        error => error?.code === "ENOENT"
      );
    } catch (error) {
      await writeEvidenceJson(`cleanup-final-${entry.label}.json`, {
        schemaVersion: "1",
        caseRoot: resolvedCase,
        removed: false,
        failure: error?.message ?? String(error)
      });
      throw error;
    }
    const retainedIndex = retainedCases.findIndex(
      entry => entry.caseRoot === resolvedCase
    );
    if (retainedIndex >= 0) {
      retainedCases.splice(retainedIndex, 1);
    }
    await writeEvidenceJson(`cleanup-final-${entry.label}.json`, {
      schemaVersion: "1",
      caseRoot: resolvedCase,
      removed: true,
      failure: null
    });
    return {
      archiveManifest,
      archiveManifestPath,
      archiveManifestSha256,
      archiveRoot: archiveChain.canonicalTargetPath
    };
  }

  async function finishPass(
    id,
    entry,
    childEvidence = [],
    cleanupOptions = {},
    validateArchive = null
  ) {
    const archive = await cleanupCase(entry, childEvidence, cleanupOptions);
    if (validateArchive) {
      await validateArchive(archive);
    }
    matrix.push({ id, status: "pass" });
    return archive;
  }

  {
    const entry = await createCase("L1");
    const statePath = path.join(entry.caseRoot, "relation-services.json");
    const holder = await startHolder(entry, { mode: "once", statePath });
    const completion = await holder.execution.completed;
    assert.equal(completion.code, 0, completion.stderr);
    const result = await readJson(holder.resultPath);
    assert.equal(result.verification.valid, true);
    await finishPass("L1", entry, [{
      pid: holder.execution.child.pid,
      completion
    }]);
  }

  {
    const entry = await createCase("L2-L3");
    const alternateDir = path.join(entry.caseRoot, "alternate");
    await mkdir(alternateDir, { mode: 0o700 });
    const statePath = path.join(entry.caseRoot, "relation-services.json");
    const alternateStatePath = path.join(
      alternateDir,
      "relation-services.json"
    );
    const holder = await startHolder(entry, {
      mode: "reacquire",
      statePath,
      alternateStatePath
    });
    const completion = await holder.execution.completed;
    assert.equal(completion.code, 0, completion.stderr);
    const result = await readJson(holder.resultPath);
    assert.equal(result.records[0].code, "owner_lock_already_admitted");
    assert.equal(result.records[1].code, "owner_lock_already_admitted");
    assert.equal(result.records[2].verification.valid, true);
    await finishPass("L2", entry, [{
      pid: holder.execution.child.pid,
      completion
    }]);
    matrix.push({ id: "L3", status: "pass" });
  }

  {
    const entry = await createCase("L4");
    const statePath = path.join(entry.caseRoot, "relation-services.json");
    const barrierPath = path.join(entry.caseRoot, "barrier");
    const reports = [1, 2].map(index => path.join(
      entry.caseRoot,
      `report-${index}.json`
    ));
    const releases = [1, 2].map(index => path.join(
      entry.caseRoot,
      `release-${index}`
    ));
    const contenders = [];
    for (let index = 0; index < 2; index += 1) {
      const configPath = path.join(
        entry.caseRoot,
        `contender-${index + 1}.json`
      );
      await writeJsonExclusive(configPath, {
        contender: index + 1,
        artifactPath,
        manifestPath,
        statePath,
        barrierPath,
        reportPath: reports[index],
        releasePath: releases[index],
        timeoutMs: 5_000
      });
      contenders.push(track(spawnNode([
        fixture("competition-child.mjs"),
        "--config",
        configPath
      ])));
    }
    await writeFile(barrierPath, "go\n", { flag: "wx" });
    await Promise.all(reports.map(report => waitForPath(report)));
    const contenderReports = await Promise.all(reports.map(readJson));
    assert.equal(
      contenderReports.filter(report => report.outcome === "ok").length,
      1
    );
    assert.equal(
      contenderReports.filter(report => report.outcome === "busy").length,
      1
    );
    const loserIndex = contenderReports.findIndex(
      report => report.outcome === "busy"
    );
    const winnerIndex = contenderReports.findIndex(
      report => report.outcome === "ok"
    );
    const loserCompletion = await contenders[loserIndex].completed;
    assert.equal(loserCompletion.code, 0, loserCompletion.stderr);
    await writeFile(releases[winnerIndex], "release\n", { flag: "wx" });
    const winnerCompletion = await contenders[winnerIndex].completed;
    assert.equal(winnerCompletion.code, 0, winnerCompletion.stderr);
    await finishPass("L4", entry, [
      { pid: contenders[0].child.pid, completion: loserIndex === 0
        ? loserCompletion : winnerCompletion },
      { pid: contenders[1].child.pid, completion: loserIndex === 1
        ? loserCompletion : winnerCompletion }
    ], { requiresDescendantsFinal: false });
  }

  {
    const entry = await createCase("L5");
    const statePath = path.join(entry.caseRoot, "relation-services.json");
    const holder = await startHolder(entry, {
      mode: "hold",
      statePath,
      hold: true
    });
    const completion = await closeAfterRelease(
      holder.execution,
      holder.releasePath
    );
    assert.equal(completion.code, 0, completion.stderr);
    const fresh = await createCase("L5-fresh");
    const freshHolder = await startHolder(fresh, {
      mode: "once",
      statePath
    });
    const freshCompletion = await freshHolder.execution.completed;
    assert.equal(freshCompletion.code, 0, freshCompletion.stderr);
    await finishPass("L5", entry, [{
      pid: holder.execution.child.pid,
      completion
    }]);
    await cleanupCase(fresh, [{
      pid: freshHolder.execution.child.pid,
      completion: freshCompletion
    }]);
  }

  for (const [id, signal, withProbe] of [
    ["L6", "SIGTERM", true],
    ["L7", "SIGKILL", false]
  ]) {
    const entry = await createCase(id);
    const statePath = path.join(entry.caseRoot, "relation-services.json");
    const holder = await startHolder(entry, {
      mode: withProbe ? "probe" : "hold",
      statePath,
      hold: true,
      waitMode: "signal"
    });
    if (withProbe) {
      const descendants = await readJson(holder.descendantsFinalPath);
      assert.equal(descendants.finished, true);
      assert.equal(descendants.descendants.length, 1);
      assert.equal(descendants.descendants[0].completionEvent, "close");
    }
    holder.execution.child.kill(signal);
    const completion = await holder.execution.completed;
    assert.equal(completion.signal, signal);
    const fresh = await createCase(`${id}-fresh`);
    const freshHolder = await startHolder(fresh, {
      mode: "once",
      statePath
    });
    const freshCompletion = await freshHolder.execution.completed;
    assert.equal(freshCompletion.code, 0, freshCompletion.stderr);
    await finishPass(id, entry, [{
      pid: holder.execution.child.pid,
      completion
    }]);
    await cleanupCase(fresh, [{
      pid: freshHolder.execution.child.pid,
      completion: freshCompletion
    }]);
  }

  {
    const entry = await createCase("L8");
    const statePath = path.join(entry.caseRoot, "relation-services.json");
    const holder = await startHolder(entry, {
      mode: "gc-worker",
      statePath,
      hold: true,
      nodeArgs: ["--expose-gc"]
    });
    const busy = await createCase("L8-busy");
    await recordFailureCase({
      caseRoot: busy.caseRoot,
      artifactPath,
      manifestPath,
      statePath,
      expectedCode: "owner_lock_busy",
      track,
      requireNoRetainedFds: true
    });
    const completion = await closeAfterRelease(
      holder.execution,
      holder.releasePath
    );
    assert.equal(completion.code, 0, completion.stderr);
    const result = await readJson(holder.resultPath);
    assert.equal(result.descendants[0].completionEvent, "terminate");
    assert.equal(
      result.records.find(record => record.label === "gc").gcAvailable,
      true
    );
    assert.equal(
      result.records.find(record => record.label === "fds")
        .matchingLockFds.length > 0,
      true
    );
    await finishPass("L8", entry, [{
      pid: holder.execution.child.pid,
      completion
    }]);
    await cleanupCase(busy);
  }

  for (const [id, mode, expected] of [
    ["L9", "reentrant-acquire", "owner_lock_already_admitted"],
    ["L10", "reentrant-verify", "owner_lock_verification_in_progress"],
    ["L11", "acquire-getter-throw", "owner_lock_napi_failed"],
    ["L12", "verify-getter-throw", "owner_lock_napi_failed"]
  ]) {
    const entry = await createCase(id);
    const statePath = path.join(entry.caseRoot, "relation-services.json");
    if (id === "L11") {
      await writeFile(
        path.join(
          entry.caseRoot,
          "relation-services.json.manager-owner.lock"
        ),
        "lock\n",
        { mode: 0o600, flag: "wx" }
      );
    }
    const holder = await startHolder(entry, { mode, statePath });
    const completion = await holder.execution.completed;
    assert.equal(completion.code, 0, completion.stderr);
    const result = await readJson(holder.resultPath);
    const inner = result.records.find(record => record.label === "inner")
      ?? result.records.find(record => record.label === "outer");
    assert.equal(inner.code, expected);
    if (id === "L11") {
      const fds = result.records.find(record => record.label === "fds");
      assert.equal(
        result.records.find(record => record.label === "retry").code,
        "owner_lock_retry_forbidden"
      );
      assert.ok(fds.identity.parent);
      assert.ok(fds.identity.lock);
      assert.equal(fds.before.complete, true);
      assert.equal(fds.after.complete, true);
      assert.deepEqual(fds.before.matchingParentFds, []);
      assert.deepEqual(fds.before.matchingLockFds, []);
      assert.deepEqual(fds.after.matchingParentFds, []);
      assert.deepEqual(fds.after.matchingLockFds, []);
      assert.deepEqual(fds.newMatchingParentFds, []);
      assert.deepEqual(fds.newMatchingLockFds, []);
    }
    if (id === "L12") {
      assert.equal(
        result.records.find(record => record.label === "retry").code,
        "owner_lock_sticky_invalid"
      );
      assert.equal(
        result.records.find(record => record.label === "fds")
          .matchingLockFds.length > 0,
        true
      );
    }
    await finishPass(id, entry, [{
      pid: holder.execution.child.pid,
      completion
    }]);
    if (id === "L11") {
      matrix.at(-1).claim = "getter-throw path only; pre-publish N-API construction is not covered";
    }
  }

  for (const [id, workerMode, mainAcquire, expected] of [
    ["WN1", "acquire", "after", "owner_lock_main_thread_required"],
    ["WN2", "verify", "before", "owner_lock_main_thread_required"]
  ]) {
    const entry = await createCase(id);
    const statePath = path.join(entry.caseRoot, "relation-services.json");
    const holder = await startHolder(entry, {
      mode: "worker",
      workerMode,
      mainAcquire,
      statePath
    });
    const completion = await holder.execution.completed;
    assert.equal(completion.code, 0, completion.stderr);
    const result = await readJson(holder.resultPath);
    assert.equal(result.descendants[0].completionEvent, "exit");
    assert.equal(result.descendants[0].message.code, expected);
    assert.equal(result.verification.valid, true);
    await finishPass(id, entry, [{
      pid: holder.execution.child.pid,
      completion
    }]);
  }

  const pathCases = [
    {
      id: "P1",
      code: "owner_lock_path_invalid",
      async setup(caseRoot) {
        const realParent = path.join(caseRoot, "real-parent");
        const aliasParent = path.join(caseRoot, "alias-parent");
        await mkdir(realParent, { mode: 0o700 });
        await symlink(realParent, aliasParent, "dir");
        return path.join(aliasParent, "relation-services.json");
      }
    },
    {
      id: "P2",
      code: "owner_lock_file_untrusted",
      async setup(caseRoot) {
        const parent = path.join(caseRoot, "parent");
        await mkdir(parent, { mode: 0o700 });
        const target = path.join(parent, "target");
        await writeFile(target, "lock\n", { mode: 0o600, flag: "wx" });
        await symlink(
          target,
          path.join(parent, "relation-services.json.manager-owner.lock")
        );
        return path.join(parent, "relation-services.json");
      }
    },
    {
      id: "P3",
      code: "owner_lock_file_untrusted",
      async setup(caseRoot) {
        const parent = path.join(caseRoot, "parent");
        await mkdir(parent, { mode: 0o700 });
        const lockPath = path.join(
          parent,
          "relation-services.json.manager-owner.lock"
        );
        await writeFile(lockPath, "lock\n", { mode: 0o600, flag: "wx" });
        await link(lockPath, path.join(parent, "extra-link"));
        return path.join(parent, "relation-services.json");
      }
    },
    {
      id: "P4",
      code: "owner_lock_path_invalid",
      async setup(caseRoot) {
        const parent = path.join(caseRoot, "not-a-directory");
        await writeFile(parent, "file\n", { flag: "wx" });
        return path.join(parent, "relation-services.json");
      }
    },
    {
      id: "P5",
      code: "owner_lock_file_untrusted",
      async setup(caseRoot) {
        const parent = path.join(caseRoot, "parent");
        await mkdir(parent, { mode: 0o700 });
        await mkdir(
          path.join(parent, "relation-services.json.manager-owner.lock"),
          { mode: 0o700 }
        );
        return path.join(parent, "relation-services.json");
      }
    },
    {
      id: "P6",
      code: "owner_lock_parent_untrusted",
      async setup(caseRoot) {
        const parent = path.join(caseRoot, "parent");
        await mkdir(parent, { mode: 0o700 });
        await chmod(parent, 0o777);
        return path.join(parent, "relation-services.json");
      }
    },
    {
      id: "P7",
      code: "owner_lock_file_untrusted",
      async setup(caseRoot) {
        const parent = path.join(caseRoot, "parent");
        await mkdir(parent, { mode: 0o700 });
        await writeFile(
          path.join(parent, "relation-services.json.manager-owner.lock"),
          "lock\n",
          { mode: 0o644, flag: "wx" }
        );
        return path.join(parent, "relation-services.json");
      }
    }
  ];

  for (const entry of pathCases) {
    const testCase = await createCase(entry.id);
    const statePath = await entry.setup(testCase.caseRoot);
    await recordFailureCase({
      caseRoot: testCase.caseRoot,
      artifactPath,
      manifestPath,
      statePath,
      expectedCode: entry.code,
      track
    });
    await finishPass(entry.id, testCase);
  }

  {
    const entry = await createCase("P5-FIFO");
    const parent = path.join(entry.caseRoot, "parent");
    await mkdir(parent, { mode: 0o700 });
    const lockPath = path.join(
      parent,
      "relation-services.json.manager-owner.lock"
    );
    const fifo = spawnSync("mkfifo", [lockPath], {
      cwd: root,
      shell: false,
      timeout: 5_000
    });
    if (fifo.error?.code === "ENOENT") {
      matrix.push({
        id: "P5-FIFO",
        status: "unsupported",
        reason: "mkfifo tool is unavailable"
      });
      await cleanupCase(entry, [], { requiresDescendantsFinal: false });
    } else {
      assert.equal(fifo.error ?? null, null);
      assert.equal(fifo.status, 0);
      await recordFailureCase({
        caseRoot: entry.caseRoot,
        artifactPath,
        manifestPath,
        statePath: path.join(parent, "relation-services.json"),
        expectedCode: "owner_lock_file_untrusted",
        track
      });
      await finishPass("P5-FIFO", entry, [], {}, archive => {
        assert.equal(archive.archiveManifest.rawEvidenceCopied, false);
        const fifoEntry = archive.archiveManifest.specialEntries.find(entry =>
          entry.relativePath
            === "parent/relation-services.json.manager-owner.lock"
        );
        assert.ok(fifoEntry, "P5-FIFO archive metadata must include the FIFO lock");
        assert.equal(fifoEntry.type, "fifo");
        assert.equal(fifoEntry.copyMode, "metadata-only");
        assert.equal(fifoEntry.contentRead, false);
      });
    }
  }

  for (const [id, target, code] of [
    ["P8", "parent", "owner_lock_parent_untrusted"],
    ["P9", "lock", "owner_lock_file_untrusted"]
  ]) {
    if (process.geteuid?.() !== 0) {
      matrix.push({
        id,
        status: "unsupported",
        reason: "requires root/CAP_CHOWN"
      });
      continue;
    }
    const entry = await createCase(id);
    const parent = path.join(entry.caseRoot, "parent");
    await mkdir(parent, { mode: 0o700 });
    if (target === "lock") {
      const lockPath = path.join(
        parent,
        "relation-services.json.manager-owner.lock"
      );
      await writeFile(lockPath, "lock\n", { mode: 0o600, flag: "wx" });
      await chown(lockPath, 65_534, 65_534);
    } else {
      await chown(parent, 65_534, 65_534);
    }
    await recordFailureCase({
      caseRoot: entry.caseRoot,
      artifactPath,
      manifestPath,
      statePath: path.join(parent, "relation-services.json"),
      expectedCode: code,
      track
    });
    await finishPass(id, entry);
  }

  for (const [id, target] of [["P10", "parent"], ["P11", "lock"]]) {
    const entry = await createCase(id);
    const parent = path.join(entry.caseRoot, "parent");
    await mkdir(parent, { mode: 0o700 });
    const statePath = path.join(parent, "relation-services.json");
    const proceedPath = path.join(entry.caseRoot, "proceed");
    const holder = await startHolder(entry, {
      mode: "replacement",
      statePath,
      proceedPath
    });
    if (target === "parent") {
      await rename(parent, path.join(entry.caseRoot, "parent-old"));
      await mkdir(parent, { mode: 0o700 });
    } else {
      const lockPath = path.join(
        parent,
        "relation-services.json.manager-owner.lock"
      );
      await unlink(lockPath);
      await writeFile(lockPath, "replacement\n", {
        mode: 0o600,
        flag: "wx"
      });
    }
    await writeFile(proceedPath, "proceed\n", { flag: "wx" });
    const completion = await holder.execution.completed;
    assert.equal(completion.code, 0, completion.stderr);
    const result = await readJson(holder.resultPath);
    assert.equal(
      result.records.find(record => record.label === "first").code,
      "owner_lock_replaced"
    );
    assert.equal(
      result.records.find(record => record.label === "second").code,
      "owner_lock_sticky_invalid"
    );
    const fds = result.records.find(record => record.label === "fds");
    assert.equal(fds.complete, true);
    assert.equal(
      target === "parent"
        ? fds.matchingParentFds.length > 0
        : fds.matchingLockFds.length > 0,
      true
    );
    await finishPass(id, entry, [{
      pid: holder.execution.child.pid,
      completion
    }]);
  }

  {
    const entry = await createCase("F1");
    const statePath = path.join(entry.caseRoot, "relation-services.json");
    const holder = await startHolder(entry, {
      mode: "probe",
      statePath,
      hold: true
    });
    const result = await readJson(holder.resultPath);
    assert.equal(result.descendants[0].completionEvent, "close");
    assert.equal(result.descendants[0].code, 0);
    assert.equal(result.descendants[0].signal, null);
    assert.equal(result.descendants[0].timedOut, false);
    assert.equal(result.descendants[0].probe.complete, true);
    assert.equal(result.descendants[0].probe.lockIdentityVisible, false);
    assert.equal(result.descendants[0].probe.parentIdentityVisible, false);
    const completion = await closeAfterRelease(
      holder.execution,
      holder.releasePath
    );
    assert.equal(completion.code, 0, completion.stderr);
    await finishPass("F1", entry, [{
      pid: holder.execution.child.pid,
      completion
    }]);
  }

  {
    const entry = await createCase("F2");
    const parent = path.join(entry.caseRoot, "parent");
    await mkdir(parent, { mode: 0o700 });
    const lockPath = path.join(
      parent,
      "relation-services.json.manager-owner.lock"
    );
    await writeFile(lockPath, "lock\n", { mode: 0o600, flag: "wx" });
    const parentStat = statSync(parent, { bigint: true });
    const execution = track(spawnNode([
      fixture("fd-leak-control-child.mjs"),
      "--lock-path", lockPath,
      "--parent-dev", parentStat.dev.toString(),
      "--parent-ino", parentStat.ino.toString()
    ]));
    const completion = await execution.completed;
    assert.equal(completion.code, 0, completion.stderr);
    const result = JSON.parse(completion.stdout);
    assert.equal(result.complete, true);
    assert.equal(result.probe.lockIdentityVisible, true);
    await finishPass("F2", entry, [{
      pid: execution.child.pid,
      completion
    }], { requiresDescendantsFinal: false });
  }

  {
    const entry = await createCase("F3");
    const statePath = path.join(entry.caseRoot, "relation-services.json");
    const holder = await startHolder(entry, {
      mode: "hold",
      statePath,
      hold: true
    });
    const busy = await createCase("F3-busy");
    await recordFailureCase({
      caseRoot: busy.caseRoot,
      artifactPath,
      manifestPath,
      statePath,
      expectedCode: "owner_lock_busy",
      track,
      requireNoRetainedFds: true
    });
    const completion = await closeAfterRelease(
      holder.execution,
      holder.releasePath
    );
    assert.equal(completion.code, 0, completion.stderr);
    await finishPass("F3", entry, [{
      pid: holder.execution.child.pid,
      completion
    }]);
    await cleanupCase(busy);
  }

  {
    const entry = await createCase("F4");
    const parent = path.join(entry.caseRoot, "parent");
    await mkdir(parent, { mode: 0o700 });
    await writeFile(
      path.join(parent, "relation-services.json.manager-owner.lock"),
      "lock\n",
      { mode: 0o644, flag: "wx" }
    );
    await recordFailureCase({
      caseRoot: entry.caseRoot,
      artifactPath,
      manifestPath,
      statePath: path.join(parent, "relation-services.json"),
      expectedCode: "owner_lock_file_untrusted",
      track,
      requireNoRetainedFds: true
    });
    await finishPass("F4", entry);
  }

  matrix.push({
    id: "F5",
    status: "pass",
    coveredBy: ["L11", "L12"]
  });
  matrix.push({
    id: "F6",
    status: "unsupported",
    reason: "controlled EMFILE/ENFILE injection was not authorized"
  });
  matrix.push({
    id: "F7",
    status: "cannot-inject",
    reason: "no safe product hook for fatal N-API, mutex, or syscall faults"
  });
});
