import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { opendirSync, statSync } from "node:fs";
import {
  access,
  chmod,
  chown,
  link,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  writeFile
} from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import { createOwnerStateSnapshotGate } from "../src/service/ownerStateSnapshot.js";
import { loadOwnerStateSnapshotBinding } from "../src/service/ownerLockBinding.js";
import { evaluateManagerHistoryClosure } from "../src/service/startupQuiescenceStateParser.js";
import { STARTUP_STATE_POLICY_LIMITS } from "../src/service/strictStateJson.js";
import {
  assertSafeDirectory,
  ensureSafeDirectory
} from "../scripts/lib/owner-lock-evidence-paths.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const selfPath = fileURLToPath(import.meta.url);
const holderConfigVariable = "SFSC_OWNER_STATE_SNAPSHOT_HOLDER_CONFIG";
const holderMode = process.argv.includes("--holder");
const skipCase = Symbol("skip-case");
let holderSequence = 0;
let publishSequence = 0;
const trackedPublishTemps = new Set();
const caseTrackers = new Map();
const caseDirectorySegments = Object.freeze([
  ".tmp",
  "development-2026-10-21",
  "p2-owner-admission",
  "owner-state-snapshot-implementation-r3",
  "linux-synthetic-cases"
]);
const canonicalState = Buffer.from(JSON.stringify({
  version: 1,
  kind: "relation-file-service-manager-state",
  storageContract:
    "single-manager-owner+injected-scoped-locks+atomic-json-replace-v1",
  revision: 0,
  createdAt: "2026-10-23T00:00:00.000Z",
  updatedAt: "2026-10-23T00:00:00.000Z",
  operations: {},
  relations: {}
}));
const canonicalSha256 = createHash("sha256")
  .update(canonicalState)
  .digest("hex");
const blockedState = Buffer.from("{");
const blockedSha256 = createHash("sha256")
  .update(blockedState)
  .digest("hex");
const SNAPSHOT_LIMITS = Object.freeze({
  maxBytes: STARTUP_STATE_POLICY_LIMITS.maxBytes,
  maxDepth: STARTUP_STATE_POLICY_LIMITS.maxDepth,
  maxNodes: STARTUP_STATE_POLICY_LIMITS.maxNodes
});

function errorRecord(error) {
  return {
    code: typeof error?.code === "string" ? error.code : "unknown",
    message: error?.message ?? String(error)
  };
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

async function removeTrackedPublishTemp(tempPath) {
  await rm(tempPath, { force: true });
  trackedPublishTemps.delete(tempPath);
}

async function writeClosedJsonTemp(filePath, value) {
  const tempPath = path.join(
    path.dirname(filePath),
    `${path.basename(filePath)}.${process.pid}-${publishSequence}`
      + `-${randomUUID()}.tmp`
  );
  publishSequence += 1;

  let handle = null;
  try {
    handle = await open(tempPath, "wx", 0o600);
    trackedPublishTemps.add(tempPath);
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = null;
    return tempPath;
  } catch (error) {
    if (handle) {
      try {
        await handle.close();
      } catch (closeError) {
        error.closeError = errorRecord(closeError);
      }
    }
    if (trackedPublishTemps.has(tempPath)) {
      try {
        await removeTrackedPublishTemp(tempPath);
      } catch (cleanupError) {
        error.cleanupError = errorRecord(cleanupError);
      }
    }
    throw error;
  }
}

async function publishJsonTempExclusive(tempPath, filePath) {
  if (!trackedPublishTemps.has(tempPath)) {
    throw new Error("JSON publication source is not tracked");
  }
  await link(tempPath, filePath);
}

async function writeJsonExclusive(filePath, value) {
  const tempPath = await writeClosedJsonTemp(filePath, value);
  let publishError = null;
  try {
    await publishJsonTempExclusive(tempPath, filePath);
  } catch (error) {
    publishError = error;
    throw error;
  } finally {
    try {
      await removeTrackedPublishTemp(tempPath);
    } catch (cleanupError) {
      if (publishError) {
        publishError.cleanupError = errorRecord(cleanupError);
      } else {
        throw cleanupError;
      }
    }
  }
}

function inspectFds(identity) {
  const directory = opendirSync("/proc/self/fd");
  const matches = {
    parent: [],
    lock: [],
    state: []
  };
  const errors = [];
  try {
    let entry;
    while ((entry = directory.readSync()) !== null) {
      try {
        const metadata = statSync(`/proc/self/fd/${entry.name}`, {
          bigint: true
        });
        const value = {
          dev: metadata.dev.toString(),
          ino: metadata.ino.toString()
        };
        for (const key of ["parent", "lock", "state"]) {
          if (identity[key]
            && value.dev === identity[key].dev
            && value.ino === identity[key].ino) {
            matches[key].push(entry.name);
          }
        }
      } catch (error) {
        errors.push({
          fd: entry.name,
          code: typeof error?.code === "string" ? error.code : "unknown"
        });
      }
    }
  } finally {
    directory.closeSync();
  }
  return {
    complete: errors.length === 0,
    parent: matches.parent.sort((left, right) => Number(left) - Number(right)),
    lock: matches.lock.sort((left, right) => Number(left) - Number(right)),
    state: matches.state.sort((left, right) => Number(left) - Number(right)),
    errors
  };
}

function statIdentity(filePath) {
  const metadata = statSync(filePath, { bigint: true });
  return {
    dev: metadata.dev.toString(),
    ino: metadata.ino.toString()
  };
}

function snapshotPathIdentity(statePath) {
  return {
    parent: statIdentity(path.dirname(statePath)),
    lock: statIdentity(path.join(
      path.dirname(statePath),
      "relation-services.json.manager-owner.lock"
    )),
    state: statIdentity(statePath)
  };
}

function readAndParseSnapshot(binding, evidence, report) {
  let bytes;
  try {
    bytes = binding.readOwnerStateSnapshot({
      evidence,
      maxBytes: SNAPSHOT_LIMITS.maxBytes
    });
  } catch (error) {
    report.snapshotError = errorRecord(error);
    return;
  }
  if (!Buffer.isBuffer(bytes)) {
    report.snapshotError = {
      code: "owner_state_snapshot_invalid",
      message: "native snapshot did not return a Buffer"
    };
    return;
  }
  report.nativeSnapshot = {
    byteLength: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex")
  };
  try {
    report.snapshotResult = evaluateManagerHistoryClosure(
      bytes,
      SNAPSHOT_LIMITS
    );
  } catch (error) {
    report.parserError = errorRecord(error);
  }
}

function runPrivateGateHolder(config, report) {
  report.gate = {
    factoryError: null,
    acquireError: null,
    evaluateError: null,
    assertError: null,
    leaseOpaque: null,
    result: null,
    verification: null,
    fdsAfterAcquire: null,
    fdsAfterEvaluate: null
  };

  let gate;
  try {
    gate = createOwnerStateSnapshotGate({
      artifactPath: config.artifactPath,
      manifestPath: config.manifestPath
    });
  } catch (error) {
    report.gate.factoryError = errorRecord(error);
    return;
  }

  let lease;
  try {
    lease = gate.acquireOwnerLease({ statePath: config.statePath });
  } catch (error) {
    report.gate.acquireError = errorRecord(error);
    return;
  }
  report.gate.leaseOpaque = {
    frozen: Object.isFrozen(lease),
    nullPrototype: Object.getPrototypeOf(lease) === null,
    keys: Object.keys(lease)
  };
  const identity = snapshotPathIdentity(config.statePath);
  report.gate.fdsAfterAcquire = inspectFds(identity);

  try {
    report.gate.result = gate.evaluateStartupState(lease);
  } catch (error) {
    report.gate.evaluateError = errorRecord(error);
  }
  report.gate.fdsAfterEvaluate = inspectFds(identity);

  try {
    report.gate.verification = gate.assertOwnerLease(lease);
  } catch (error) {
    report.gate.assertError = errorRecord(error);
  }
}

async function holderMain() {
  const configPath = process.env[holderConfigVariable];
  if (!configPath) {
    throw new Error(`${holderConfigVariable} is required`);
  }
  const config = JSON.parse(await readFile(configPath, "utf8"));
  const binding = config.mode === "private-gate"
    ? null
    : loadOwnerStateSnapshotBinding({
      artifactPath: config.artifactPath,
      manifestPath: config.manifestPath
    });
  const report = {
    schemaVersion: "1",
    mode: config.mode,
    pid: process.pid,
    acquireError: null,
    verificationError: null,
    snapshotError: null,
    postSnapshotVerificationError: null,
    secondSnapshotError: null,
    verification: null,
    nativeSnapshot: null,
    parserError: null,
    snapshotResult: null,
    fdsBefore: null,
    fdsAfter: null,
    getterReentry: null,
    worker: null,
    gate: null
  };

  try {
    if (config.mode === "private-gate") {
      runPrivateGateHolder(config, report);
    } else if (config.mode === "busy") {
      try {
        binding.acquireOwnerLock({ statePath: config.statePath });
      } catch (error) {
        report.acquireError = errorRecord(error);
      }
    } else if (config.mode === "worker") {
      const worker = new Worker(`
        const { parentPort, workerData } = require("node:worker_threads");
        (async () => {
          try {
            const { loadOwnerStateSnapshotBinding } =
              await import(workerData.loaderUrl);
            const binding = loadOwnerStateSnapshotBinding({
              artifactPath: workerData.artifactPath,
              manifestPath: workerData.manifestPath
            });
            binding.acquireOwnerLock({ statePath: workerData.statePath });
            parentPort.postMessage({ ok: true });
          } catch (error) {
            parentPort.postMessage({
              ok: false,
              code: typeof error?.code === "string" ? error.code : "unknown"
            });
          }
        })();
      `, {
        eval: true,
        workerData: {
          artifactPath: config.artifactPath,
          manifestPath: config.manifestPath,
          statePath: config.statePath,
          loaderUrl: pathToFileURL(path.join(
            root,
            "src",
            "service",
            "ownerLockBinding.js"
          )).href
        }
      });
      report.worker = await new Promise((resolve, reject) => {
        worker.once("message", resolve);
        worker.once("error", reject);
      });
      await worker.terminate();
    } else {
      let evidence;
      try {
        evidence = binding.acquireOwnerLock({ statePath: config.statePath });
      } catch (error) {
        report.acquireError = errorRecord(error);
      }
      if (evidence) {
        try {
          report.verification = binding.verifyOwnerLock({ evidence });
        } catch (error) {
          report.verificationError = errorRecord(error);
        }
        report.fdsBefore = inspectFds({
          parent: {
            dev: evidence.parentDev,
            ino: evidence.parentIno
          },
          lock: {
            dev: evidence.lockDev,
            ino: evidence.lockIno
          },
          state: config.stateIdentity
        });

        if (config.mode === "getter-reentry") {
          let nestedError = null;
          let outerError = null;
          if (config.reentryDirection === "verify-to-snapshot") {
            try {
              binding.verifyOwnerLock({
                get evidence() {
                  try {
                    binding.readOwnerStateSnapshot({
                      evidence,
                      maxBytes: 16 * 1024 * 1024
                    });
                  } catch (error) {
                    nestedError = errorRecord(error);
                  }
                  return evidence;
                }
              });
            } catch (error) {
              outerError = errorRecord(error);
            }
          } else if (config.reentryDirection === "snapshot-to-verify") {
            try {
              binding.readOwnerStateSnapshot({
                get evidence() {
                  try {
                    binding.verifyOwnerLock({ evidence });
                  } catch (error) {
                    nestedError = errorRecord(error);
                  }
                  return evidence;
                },
                maxBytes: 16 * 1024 * 1024
              });
            } catch (error) {
              outerError = errorRecord(error);
            }
          }
          report.getterReentry = { nestedError, outerError };
          report.fdsAfter = inspectFds({
            parent: {
              dev: evidence.parentDev,
              ino: evidence.parentIno
            },
            lock: {
              dev: evidence.lockDev,
              ino: evidence.lockIno
            },
            state: config.stateIdentity
          });
        }

        if (config.mode === "snapshot-after-proceed") {
          await writeJsonExclusive(config.readyPath, {
            ready: true,
            pid: process.pid
          });
          await waitForPath(config.proceedPath, 10_000);
        }

        if (config.mode === "snapshot"
          || config.mode === "snapshot-after-proceed") {
          readAndParseSnapshot(binding, evidence, report);
          report.fdsAfter = inspectFds({
            parent: {
              dev: evidence.parentDev,
              ino: evidence.parentIno
            },
            lock: {
              dev: evidence.lockDev,
              ino: evidence.lockIno
            },
            state: config.stateIdentity
          });

          try {
            report.verification = binding.verifyOwnerLock({ evidence });
          } catch (error) {
            report.postSnapshotVerificationError = errorRecord(error);
          }
          try {
            binding.readOwnerStateSnapshot({
              evidence,
              maxBytes: 16 * 1024 * 1024
            });
          } catch (error) {
            report.secondSnapshotError = errorRecord(error);
          }
        }
      }
    }
  } finally {
    await writeJsonExclusive(config.resultPath, report);
    if (config.holdAfter) {
      await waitForPath(config.releasePath, 10_000);
    }
  }
  return 0;
}

function spawnHolder(config) {
  const child = spawn(process.execPath, [selfPath, "--holder"], {
    cwd: root,
    env: {
      ...process.env,
      [holderConfigVariable]: config.configPath
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", chunk => {
    stdout += chunk;
  });
  child.stderr.on("data", chunk => {
    stderr += chunk;
  });
  const close = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => {
      resolve({ code, signal, stdout, stderr });
    });
  });
  return { child, close };
}

async function waitForClose(handle, timeoutMs) {
  return Promise.race([
    handle.close.then(
      completion => ({ closed: true, completion }),
      error => ({
        closed: true,
        error: errorRecord(error)
      })
    ),
    delay(timeoutMs).then(() => ({ closed: false }))
  ]);
}

async function terminateHolder(handle, {
  termTimeoutMs = 2_000,
  killTimeoutMs = 2_000
} = {}) {
  const child = handle.child ?? handle;
  if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGTERM");
  }
  let outcome = await waitForClose(handle, termTimeoutMs);
  if (!outcome.closed) {
    child.kill("SIGKILL");
    outcome = await waitForClose(handle, killTimeoutMs);
  }
  handle.termination = outcome;
  if (!outcome.closed) {
    throw new Error(`holder process ${child.pid} did not exit after SIGKILL`);
  }
  return outcome;
}

async function startHolder(
  config,
  { hold = false, prepared = false } = {}
) {
  const sequence = holderSequence;
  holderSequence += 1;
  const fullConfig = {
    ...config,
    configPath: path.join(
      config.caseRoot,
      `holder-${process.pid}-${sequence}.json`
    ),
    resultPath: path.join(
      config.caseRoot,
      `result-${process.pid}-${sequence}.json`
    ),
    releasePath: path.join(
      config.caseRoot,
      `release-${process.pid}-${sequence}.json`
    ),
    readyPath: path.join(
      config.caseRoot,
      `ready-${process.pid}-${sequence}.json`
    ),
    proceedPath: path.join(
      config.caseRoot,
      `proceed-${process.pid}-${sequence}.json`
    ),
    holdAfter: hold
  };
  await writeJsonExclusive(fullConfig.configPath, fullConfig);
  const processState = spawnHolder(fullConfig);
  caseTrackers.get(config.caseRoot)?.(processState);
  try {
    if (prepared) {
      await waitForPath(fullConfig.readyPath);
    } else {
      await waitForPath(fullConfig.resultPath);
    }
  } catch (error) {
    await terminateHolder(processState);
    throw error;
  }
  const awaitReport = async () => {
    await waitForPath(fullConfig.resultPath);
    return JSON.parse(await readFile(fullConfig.resultPath, "utf8"));
  };
  const report = prepared ? null : await awaitReport();
  return Object.assign(processState, {
    config: fullConfig,
    report,
    awaitReport,
    async proceed() {
      await writeJsonExclusive(fullConfig.proceedPath, { proceed: true });
    },
    async release() {
      if (hold) {
        await writeJsonExclusive(fullConfig.releasePath, { release: true });
      }
      return processState.close;
    }
  });
}

async function preserveCaseEvidence(caseRoot, evidenceRoot, handles) {
  const entries = await readdir(caseRoot, { withFileTypes: true });
  const copied = [];
  for (const entry of entries) {
    if (!entry.isFile()
      || !/^(holder|result|release|ready|proceed)-/.test(entry.name)) {
      continue;
    }
    const source = path.join(caseRoot, entry.name);
    const target = path.join(evidenceRoot, entry.name);
    await writeFile(target, await readFile(source), {
      flag: "wx",
      mode: 0o600
    });
    copied.push(entry.name);
  }

  const holders = [];
  for (const handle of handles) {
    const pid = handle.child?.pid ?? null;
    const termination = handle.termination
      ?? await terminateHolder(handle);
    const completion = termination.completion ?? {};
    const sequence = path.basename(
      handle.config?.configPath ?? "unknown",
      ".json"
    ).replace(/[^a-zA-Z0-9._-]/g, "_");
    const prefix = `holder-${pid ?? "unknown"}-${sequence}`;
    await writeFile(
      path.join(evidenceRoot, `${prefix}.stdout.txt`),
      completion.stdout ?? "",
      { flag: "wx", mode: 0o600 }
    );
    await writeFile(
      path.join(evidenceRoot, `${prefix}.stderr.txt`),
      completion.stderr ?? "",
      { flag: "wx", mode: 0o600 }
    );
    const exit = {
      pid,
      mode: handle.config?.mode ?? null,
      termination
    };
    await writeFile(
      path.join(evidenceRoot, `${prefix}.exit.json`),
      `${JSON.stringify(exit, null, 2)}\n`,
      { flag: "wx", mode: 0o600 }
    );
    holders.push(exit);
  }
  await writeFile(
    path.join(evidenceRoot, "cleanup.json"),
    `${JSON.stringify({
      schemaVersion: "1",
      caseRoot,
      evidenceRoot,
      copiedCaseFiles: copied.sort(),
      holders
    }, null, 2)}\n`,
    { flag: "wx", mode: 0o600 }
  );
}

async function makeCase(t) {
  const baseChain = await ensureSafeDirectory(
    root,
    caseDirectorySegments
  );
  const base = baseChain.canonicalTargetPath;
  const createdCaseRoot = await mkdtemp(path.join(base, "case-"));
  const caseRootChain = await assertSafeDirectory(root, [
    ...caseDirectorySegments,
    path.basename(createdCaseRoot)
  ]);
  const caseRoot = caseRootChain.canonicalTargetPath;
  await chmod(caseRoot, 0o700);
  const evidenceDirectoryName = `evidence-${path.basename(caseRoot)}`;
  const evidenceChain = await ensureSafeDirectory(root, [
    ...caseDirectorySegments,
    evidenceDirectoryName
  ]);
  const evidenceRoot = evidenceChain.canonicalTargetPath;
  const children = new Set();
  caseTrackers.set(caseRoot, child => children.add(child));
  t.after(async () => {
    for (const handle of children) {
      await terminateHolder(handle);
    }
    await preserveCaseEvidence(caseRoot, evidenceRoot, [...children]);
    caseTrackers.delete(caseRoot);
    await assertSafeDirectory(root, caseDirectorySegments);
    const cleanupCaseChain = await assertSafeDirectory(root, [
      ...caseDirectorySegments,
      path.basename(caseRoot)
    ]);
    const resolvedCaseRoot = cleanupCaseChain.canonicalTargetPath;
    await rm(resolvedCaseRoot, { recursive: true, force: false });
    await assert.rejects(
      access(resolvedCaseRoot),
      error => error?.code === "ENOENT"
    );
  });
  return {
    base,
    caseRoot,
    evidenceRoot,
    statePath: path.join(caseRoot, "relation-services.json")
  };
}

function holderConfig(context, artifactPath, manifestPath, mode) {
  return {
    caseRoot: context.caseRoot,
    artifactPath,
    manifestPath,
    statePath: context.statePath,
    mode,
    stateIdentity: null
  };
}

async function writeState(context, bytes = canonicalState, mode = 0o600) {
  await writeFile(context.statePath, bytes, { flag: "wx", mode });
  await chmod(context.statePath, mode);
  return statIdentity(context.statePath);
}

async function assertLockRetainedAndCleanup(
  t,
  context,
  holder,
  artifactPath,
  manifestPath
) {
  const busyConfig = holderConfig(
    context,
    artifactPath,
    manifestPath,
    "busy"
  );
  const busy = await startHolder(busyConfig);
  assert.equal(busy.report.acquireError?.code, "owner_lock_busy");
  assert.equal((await busy.release()).code, 0);

  assert.equal((await holder.release()).code, 0);
  const cleanupConfig = holderConfig(
    context,
    artifactPath,
    manifestPath,
    "cleanup"
  );
  const cleanup = await startHolder(cleanupConfig);
  assert.equal(cleanup.report.acquireError, null);
  assert.equal(cleanup.report.verificationError, null);
  assert.equal((await cleanup.release()).code, 0);
}

async function runStickyFailureCase(
  t,
  artifactPath,
  manifestPath,
  label,
  expectedCode,
  setup
) {
  const context = await makeCase(t);
  const stateIdentity = await setup(context, t);
  if (stateIdentity === skipCase) {
    return;
  }
  const config = holderConfig(
    context,
    artifactPath,
    manifestPath,
    "snapshot"
  );
  config.stateIdentity = stateIdentity;
  const holder = await startHolder(config, { hold: true });
  assert.equal(holder.report.acquireError, null, label);
  assert.equal(holder.report.verificationError, null, label);
  assert.equal(holder.report.snapshotError?.code, expectedCode, label);
  assert.equal(holder.report.fdsAfter.complete, true, label);
  assert.ok(holder.report.fdsAfter.parent.length >= 1, label);
  assert.ok(holder.report.fdsAfter.lock.length >= 1, label);
  assert.deepEqual(holder.report.fdsAfter.state, [], label);
  await assertLockRetainedAndCleanup(
    t,
    context,
    holder,
    artifactPath,
    manifestPath
  );
}

async function parentMain() {
  const { default: test } = await import("node:test");
  const artifactPath = process.env.SFSC_OWNER_SNAPSHOT_ARTIFACT;
  const manifestPath = process.env.SFSC_OWNER_SNAPSHOT_MANIFEST;
  const skip = process.platform !== "linux"
    ? "requires a later authorized Linux r4 native build"
    : !artifactPath || !manifestPath
      ? "set SFSC_OWNER_SNAPSHOT_ARTIFACT and SFSC_OWNER_SNAPSHOT_MANIFEST"
      : false;

  test("exclusive JSON publication exposes only complete closed files", async t => {
    const context = await makeCase(t);
    const targetPath = path.join(context.caseRoot, "published.json");
    const value = {
      schemaVersion: "1",
      marker: "complete-before-publish",
      payload: "x".repeat(4096)
    };
    const tempPath = await writeClosedJsonTemp(targetPath, value);

    assert.equal(path.dirname(tempPath), path.dirname(targetPath));
    assert.match(path.basename(tempPath), /\.tmp$/);
    assert.ok(trackedPublishTemps.has(tempPath));
    await assert.rejects(
      access(targetPath),
      error => error?.code === "ENOENT"
    );
    assert.deepEqual(
      JSON.parse(await readFile(tempPath, "utf8")),
      value
    );

    await publishJsonTempExclusive(tempPath, targetPath);
    await removeTrackedPublishTemp(tempPath);
    assert.deepEqual(
      JSON.parse(await readFile(targetPath, "utf8")),
      value
    );
    assert.equal(trackedPublishTemps.has(tempPath), false);

    const original = await readFile(targetPath, "utf8");
    await assert.rejects(
      writeJsonExclusive(targetPath, {
        schemaVersion: "1",
        marker: "must-not-overwrite"
      }),
      error => error?.code === "EEXIST"
    );
    assert.equal(await readFile(targetPath, "utf8"), original);

    const secondTarget = path.join(context.caseRoot, "published-second.json");
    await writeJsonExclusive(secondTarget, {
      schemaVersion: "1",
      marker: "second-publication"
    });
    assert.deepEqual(
      JSON.parse(await readFile(secondTarget, "utf8")),
      {
        schemaVersion: "1",
        marker: "second-publication"
      }
    );
    assert.deepEqual(
      (await readdir(context.caseRoot)).filter(name => name.endsWith(".tmp")),
      []
    );
    assert.equal(trackedPublishTemps.size, 0);
  });

  test("Linux r4 real-FS snapshot matrix", { skip }, async t => {
    await t.test("valid bytes, consumption, verify, and temporary FD cleanup", async t => {
      const context = await makeCase(t);
      const stateIdentity = await writeState(context);
      const config = holderConfig(
        context,
        artifactPath,
        manifestPath,
        "snapshot"
      );
      config.stateIdentity = stateIdentity;
      const holder = await startHolder(config);
      assert.equal(holder.report.acquireError, null);
      assert.equal(holder.report.verificationError, null);
      assert.equal(holder.report.snapshotError, null);
      assert.equal(holder.report.parserError, null);
      assert.equal(
        holder.report.nativeSnapshot.byteLength,
        canonicalState.length
      );
      assert.equal(holder.report.nativeSnapshot.sha256, canonicalSha256);
      assert.equal(
        holder.report.snapshotResult.rawSha256,
        canonicalSha256
      );
      assert.equal(
        holder.report.snapshotResult.observedBytes,
        canonicalState.length
      );
      assert.equal(holder.report.snapshotResult.fullStartupAdmission, false);
      assert.equal(holder.report.postSnapshotVerificationError, null);
      assert.equal(
        holder.report.secondSnapshotError?.code,
        "owner_state_snapshot_consumed"
      );
      assert.equal(holder.report.fdsAfter.complete, true);
      assert.ok(holder.report.fdsAfter.parent.length >= 1);
      assert.ok(holder.report.fdsAfter.lock.length >= 1);
      assert.deepEqual(holder.report.fdsAfter.state, []);
      assert.equal((await holder.release()).code, 0);
      const cleanup = await startHolder(holderConfig(
        context,
        artifactPath,
        manifestPath,
        "cleanup"
      ));
      assert.equal(cleanup.report.acquireError, null);
      assert.equal((await cleanup.release()).code, 0);
    });

    await t.test("real private gate acquires, evaluates, and verifies", async t => {
      const context = await makeCase(t);
      const stateIdentity = await writeState(context);
      const config = holderConfig(
        context,
        artifactPath,
        manifestPath,
        "private-gate"
      );
      config.stateIdentity = stateIdentity;
      const holder = await startHolder(config);
      const gate = holder.report.gate;

      assert.equal(gate.factoryError, null);
      assert.equal(gate.acquireError, null);
      assert.equal(gate.evaluateError, null);
      assert.equal(gate.assertError, null);
      assert.deepEqual(gate.leaseOpaque, {
        frozen: true,
        nullPrototype: true,
        keys: []
      });
      assert.equal(gate.result.rawSha256, canonicalSha256);
      assert.equal(gate.result.observedBytes, canonicalState.length);
      assert.equal(gate.result.fullStartupAdmission, false);
      assert.equal(gate.verification.valid, true);
      for (const fds of [gate.fdsAfterAcquire, gate.fdsAfterEvaluate]) {
        assert.equal(fds.complete, true);
        assert.ok(fds.parent.length >= 1);
        assert.ok(fds.lock.length >= 1);
        assert.deepEqual(fds.state, []);
      }
      assert.equal((await holder.release()).code, 0);
      const cleanup = await startHolder(holderConfig(
        context,
        artifactPath,
        manifestPath,
        "cleanup"
      ));
      assert.equal(cleanup.report.acquireError, null);
      assert.equal((await cleanup.release()).code, 0);
    });

    await t.test("typed parser blocked result remains safe and consumed", async t => {
      const context = await makeCase(t);
      const stateIdentity = await writeState(context, blockedState);
      const config = holderConfig(
        context,
        artifactPath,
        manifestPath,
        "snapshot"
      );
      config.stateIdentity = stateIdentity;
      const holder = await startHolder(config);
      assert.equal(holder.report.snapshotError, null);
      assert.equal(holder.report.parserError, null);
      assert.equal(holder.report.nativeSnapshot.byteLength, blockedState.length);
      assert.equal(holder.report.nativeSnapshot.sha256, blockedSha256);
      assert.equal(holder.report.snapshotResult.decision, "blocked");
      assert.equal(
        holder.report.snapshotResult.code,
        "startup_quiescence_json_invalid"
      );
      assert.equal(
        holder.report.secondSnapshotError?.code,
        "owner_state_snapshot_consumed"
      );
      assert.equal((await holder.release()).code, 0);
    });

    await t.test("exact 16 MiB state is read and parsed without snapshot substitution", async t => {
      const context = await makeCase(t);
      const exactState = Buffer.alloc(16 * 1024 * 1024, 0x20);
      const exactStateSha256 = createHash("sha256")
        .update(exactState)
        .digest("hex");
      const stateIdentity = await writeState(
        context,
        exactState
      );
      const config = holderConfig(
        context,
        artifactPath,
        manifestPath,
        "snapshot"
      );
      config.stateIdentity = stateIdentity;
      const holder = await startHolder(config);
      assert.equal(holder.report.snapshotError, null);
      assert.equal(holder.report.parserError, null);
      assert.equal(
        holder.report.nativeSnapshot.byteLength,
        16 * 1024 * 1024
      );
      assert.equal(holder.report.nativeSnapshot.sha256, exactStateSha256);
      assert.equal(
        holder.report.snapshotResult.observedBytes,
        16 * 1024 * 1024
      );
      assert.equal(holder.report.snapshotResult.fullStartupAdmission, false);
      assert.equal((await holder.release()).code, 0);
    });

    await t.test("worker thread rejects before owner I/O", async t => {
      const context = await makeCase(t);
      await writeState(context);
      const holder = await startHolder(holderConfig(
        context,
        artifactPath,
        manifestPath,
        "worker"
      ));
      assert.equal(holder.report.worker.ok, false);
      assert.equal(
        holder.report.worker.code,
        "owner_lock_main_thread_required"
      );
      assert.equal((await holder.release()).code, 0);
    });

    for (const direction of [
      "verify-to-snapshot",
      "snapshot-to-verify"
    ]) {
      await t.test(`caught getter reentry ${direction}`, async t => {
        const context = await makeCase(t);
        const stateIdentity = await writeState(context);
        const config = holderConfig(
          context,
          artifactPath,
          manifestPath,
          "getter-reentry"
        );
        config.stateIdentity = stateIdentity;
        config.reentryDirection = direction;
        const holder = await startHolder(
          config,
          { hold: true }
        );
        assert.equal(
          holder.report.getterReentry.nestedError.code,
          "owner_lock_verification_in_progress"
        );
        assert.equal(
          holder.report.getterReentry.outerError.code,
          "owner_lock_sticky_invalid"
        );
        assert.ok(holder.report.fdsAfter.parent.length >= 1);
        assert.ok(holder.report.fdsAfter.lock.length >= 1);
        assert.deepEqual(holder.report.fdsAfter.state, []);
        await assertLockRetainedAndCleanup(
          t,
          context,
          holder,
          artifactPath,
          manifestPath
        );
      });
    }

    await t.test("lock replacement before snapshot is detected", async t => {
      const context = await makeCase(t);
      const stateIdentity = await writeState(context);
      const config = holderConfig(
        context,
        artifactPath,
        manifestPath,
        "snapshot-after-proceed"
      );
      config.stateIdentity = stateIdentity;
      const holder = await startHolder(
        config,
        { hold: true, prepared: true }
      );
      const lockPath = path.join(
        context.caseRoot,
        "relation-services.json.manager-owner.lock"
      );
      await rename(lockPath, `${lockPath}.replaced`);
      await writeFile(lockPath, Buffer.alloc(0), {
        flag: "wx",
        mode: 0o600
      });
      await holder.proceed();
      const report = await holder.awaitReport();
      assert.equal(report.snapshotError?.code, "owner_lock_replaced");
      assert.ok(report.fdsAfter.parent.length >= 1);
      assert.ok(report.fdsAfter.lock.length >= 1);
      assert.deepEqual(report.fdsAfter.state, []);
      assert.equal((await holder.release()).code, 0);
      const cleanup = await startHolder(holderConfig(
        context,
        artifactPath,
        manifestPath,
        "cleanup"
      ));
      assert.equal(cleanup.report.acquireError, null);
      assert.equal((await cleanup.release()).code, 0);
    });

    await t.test("parent trust change before snapshot is detected", async t => {
      const context = await makeCase(t);
      const stateIdentity = await writeState(context);
      const config = holderConfig(
        context,
        artifactPath,
        manifestPath,
        "snapshot-after-proceed"
      );
      config.stateIdentity = stateIdentity;
      const holder = await startHolder(
        config,
        { hold: true, prepared: true }
      );
      await chmod(context.caseRoot, 0o777);
      await holder.proceed();
      const report = await holder.awaitReport();
      assert.equal(report.snapshotError?.code, "owner_state_untrusted");
      assert.ok(report.fdsAfter.parent.length >= 1);
      assert.ok(report.fdsAfter.lock.length >= 1);
      await chmod(context.caseRoot, 0o700);
      assert.equal((await holder.release()).code, 0);
      const cleanup = await startHolder(holderConfig(
        context,
        artifactPath,
        manifestPath,
        "cleanup"
      ));
      assert.equal(cleanup.report.acquireError, null);
      assert.equal((await cleanup.release()).code, 0);
    });

    await t.test("lock trust change before snapshot is detected", async t => {
      const context = await makeCase(t);
      const stateIdentity = await writeState(context);
      const config = holderConfig(
        context,
        artifactPath,
        manifestPath,
        "snapshot-after-proceed"
      );
      config.stateIdentity = stateIdentity;
      const holder = await startHolder(
        config,
        { hold: true, prepared: true }
      );
      const lockPath = path.join(
        context.caseRoot,
        "relation-services.json.manager-owner.lock"
      );
      await chmod(lockPath, 0o644);
      await holder.proceed();
      const report = await holder.awaitReport();
      assert.equal(report.snapshotError?.code, "owner_state_untrusted");
      assert.ok(report.fdsAfter.parent.length >= 1);
      assert.ok(report.fdsAfter.lock.length >= 1);
      await chmod(lockPath, 0o600);
      assert.equal((await holder.release()).code, 0);
      const cleanup = await startHolder(holderConfig(
        context,
        artifactPath,
        manifestPath,
        "cleanup"
      ));
      assert.equal(cleanup.report.acquireError, null);
      assert.equal((await cleanup.release()).code, 0);
    });

    await t.test("parent replacement between acquisition and snapshot", {
      skip: "cannot-inject with this holder barrier; dedicated parent swap required"
    }, () => {});

    await t.test("state replacement, truncation, growth, and nanosecond races", {
      skip: "cannot-inject deterministically without an in-native barrier"
    }, () => {});

    await t.test("missing state", async t => {
      await runStickyFailureCase(
        t,
        artifactPath,
        manifestPath,
        "missing",
        "owner_state_missing",
        async () => null
      );
    });

    await t.test("symbolic-link state", async t => {
      await runStickyFailureCase(
        t,
        artifactPath,
        manifestPath,
        "symlink",
        "owner_state_untrusted",
        async context => {
          const target = path.join(context.caseRoot, "target.json");
          await writeFile(target, canonicalState, { flag: "wx", mode: 0o600 });
          await symlink(target, context.statePath);
          return null;
        }
      );
    });

    await t.test("FIFO state", async t => {
      const context = await makeCase(t);
      const fifo = spawnSync("mkfifo", [context.statePath], {
        encoding: "utf8"
      });
      if (fifo.error || fifo.status !== 0) {
        t.skip("mkfifo is unavailable; FIFO case is unsupported in this run");
        return;
      }
      const config = holderConfig(
        context,
        artifactPath,
        manifestPath,
        "snapshot"
      );
      const holder = await startHolder(config, { hold: true });
      assert.equal(holder.report.snapshotError?.code, "owner_state_untrusted");
      assert.ok(holder.report.fdsAfter.parent.length >= 1);
      assert.ok(holder.report.fdsAfter.lock.length >= 1);
      assert.deepEqual(holder.report.fdsAfter.state, []);
      await assertLockRetainedAndCleanup(
        t,
        context,
        holder,
        artifactPath,
        manifestPath
      );
    });

    await t.test("directory state", async t => {
      await runStickyFailureCase(
        t,
        artifactPath,
        manifestPath,
        "directory",
        "owner_state_untrusted",
        async context => {
          await mkdir(context.statePath, { mode: 0o700 });
          return statIdentity(context.statePath);
        }
      );
    });

    for (const mode of [0o640, 0o700, 0o1644, 0o2644, 0o4644]) {
      await t.test(`mode ${mode.toString(8)}`, async t => {
        await runStickyFailureCase(
          t,
          artifactPath,
          manifestPath,
          `mode-${mode.toString(8)}`,
          "owner_state_untrusted",
          async context => {
            const identity = await writeState(context, canonicalState, mode);
            const actualMode = Number(
              statSync(context.statePath, { bigint: true }).mode & 0o7777n
            );
            if (actualMode !== mode) {
              t.skip("filesystem did not preserve the requested special mode");
              return skipCase;
            }
            return identity;
          }
        );
      });
    }

    await t.test("wrong uid", async t => {
      await runStickyFailureCase(
        t,
        artifactPath,
        manifestPath,
        "uid",
        "owner_state_untrusted",
        async (context, t) => {
          const identity = await writeState(context);
          try {
            await chown(context.statePath, 1, process.getgid());
          } catch (error) {
            if (error?.code === "EPERM") {
              t.skip("cannot inject wrong uid without privilege");
              return skipCase;
            }
            throw error;
          }
          return identity;
        }
      );
    });

    await t.test("hardlink nlink 2", async t => {
      await runStickyFailureCase(
        t,
        artifactPath,
        manifestPath,
        "nlink",
        "owner_state_untrusted",
        async context => {
          const identity = await writeState(context);
          await link(
            context.statePath,
            path.join(context.caseRoot, "relation-services.alias.json")
          );
          return identity;
        }
      );
    });

    await t.test("16 MiB + 1 rejects before read", async t => {
      await runStickyFailureCase(
        t,
        artifactPath,
        manifestPath,
        "too-large",
        "owner_state_too_large",
        context => writeState(
          context,
          Buffer.alloc((16 * 1024 * 1024) + 1, 0x20)
        )
      );
    });

    t.diagnostic(
      "State metadata races that cannot be injected deterministically are "
      + "recorded as cannot-inject, never as PASS."
    );
  });
}

if (holderMode) {
  await holderMain();
} else {
  await parentMain();
}
