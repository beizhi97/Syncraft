import { spawn } from "node:child_process";
import {
  opendirSync,
  statSync
} from "node:fs";
import {
  access,
  link,
  readFile,
  unlink,
  writeFile
} from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { loadOwnerLockBinding } from "../../../src/service/ownerLockBinding.js";

function argument(name) {
  const index = process.argv.indexOf(name);
  if (index < 0 || index + 1 >= process.argv.length) {
    throw new Error(`missing ${name}`);
  }
  return process.argv[index + 1];
}

function errorRecord(error) {
  return {
    code: typeof error?.code === "string" ? error.code : "unknown",
    reason: typeof error?.reason === "string" ? error.reason : null,
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

function waitForSignal(timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      process.off("SIGTERM", onTerm);
      process.off("SIGINT", onInt);
      reject(new Error("timed out waiting for a termination signal"));
    }, timeoutMs);
    const handle = signal => {
      clearTimeout(timer);
      process.off("SIGTERM", onTerm);
      process.off("SIGINT", onInt);
      resolve(signal);
    };
    const onTerm = () => handle("SIGTERM");
    const onInt = () => handle("SIGINT");
    process.once("SIGTERM", onTerm);
    process.once("SIGINT", onInt);
  });
}

function workerObservation(worker) {
  let workerError;
  worker.on("error", error => {
    workerError = error;
  });
  const message = new Promise((resolve, reject) => {
    worker.once("message", resolve);
    worker.once("exit", code => {
      reject(workerError ?? new Error(
        `worker exited before reporting a message (code ${code})`
      ));
    });
  });
  const exit = new Promise(resolve => {
    worker.once("exit", code => resolve({ code, error: workerError ?? null }));
  });
  return { message, exit };
}

async function waitForChildProcessClose(child) {
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
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => {
      resolve({ code, signal, stdout, stderr });
    });
  });
}

async function runExecProbe(config, evidence) {
  const child = spawn(process.execPath, [
    config.execChildPath,
    "--parent-dev", evidence.parentDev,
    "--parent-ino", evidence.parentIno,
    "--lock-dev", evidence.lockDev,
    "--lock-ino", evidence.lockIno
  ], {
    cwd: config.root,
    stdio: ["ignore", "pipe", "pipe"]
  });
  const completion = await waitForChildProcessClose(child);
  let probe = null;
  try {
    probe = JSON.parse(completion.stdout);
  } catch {
    // The raw streams are retained in the completion record.
  }
  return {
    kind: "ChildProcess",
    pid: child.pid,
    completionEvent: "close",
    code: completion.code,
    signal: completion.signal,
    timedOut: false,
    stdout: completion.stdout,
    stderr: completion.stderr,
    probe
  };
}

function inspectFdIdentity(evidence) {
  const directory = opendirSync("/proc/self/fd");
  const fdNames = [];
  const matchingLockFds = [];
  const matchingParentFds = [];
  const statErrors = [];
  let fdCount = 0;
  try {
    let entry;
    while ((entry = directory.readSync()) !== null) {
      fdCount += 1;
      fdNames.push(entry.name);
      try {
        const metadata = statSync(
          `/proc/self/fd/${entry.name}`,
          { bigint: true }
        );
        if (metadata.dev.toString() === evidence.lockDev
          && metadata.ino.toString() === evidence.lockIno) {
          matchingLockFds.push(entry.name);
        }
        if (metadata.dev.toString() === evidence.parentDev
          && metadata.ino.toString() === evidence.parentIno) {
          matchingParentFds.push(entry.name);
        }
      } catch (error) {
        statErrors.push({
          fd: entry.name,
          code: typeof error?.code === "string" ? error.code : "unknown"
        });
      }
    }
  } finally {
    directory.closeSync();
  }
  return {
    complete: statErrors.length === 0,
    fdNames: [...fdNames].sort((left, right) => Number(left) - Number(right)),
    matchingLockFds,
    matchingParentFds,
    statErrors,
    fdCount
  };
}

function pathIdentity(statePath) {
  const parentPath = path.dirname(statePath);
  const lockPath = path.join(
    parentPath,
    "relation-services.json.manager-owner.lock"
  );
  let parent;
  let lock;
  try {
    const metadata = statSync(parentPath, { bigint: true });
    parent = { dev: metadata.dev.toString(), ino: metadata.ino.toString() };
  } catch {
    parent = null;
  }
  try {
    const metadata = statSync(lockPath, { bigint: true });
    lock = { dev: metadata.dev.toString(), ino: metadata.ino.toString() };
  } catch {
    lock = null;
  }
  return {
    parentPath,
    lockPath,
    parent,
    lock,
    comparison: {
      parentDev: parent?.dev ?? null,
      parentIno: parent?.ino ?? null,
      lockDev: lock?.dev ?? null,
      lockIno: lock?.ino ?? null
    }
  };
}

let exclusiveSequence = 0;

async function writeExclusiveJson(filePath, value) {
  const temporaryPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.${exclusiveSequence++}.tmp`
  );
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, {
    flag: "wx"
  });
  try {
    await link(temporaryPath, filePath);
  } finally {
    try {
      await unlink(temporaryPath);
    } catch (error) {
      if (error?.code !== "ENOENT") {
        throw error;
      }
    }
  }
}

const config = JSON.parse(await readFile(argument("--config"), "utf8"));
const binding = loadOwnerLockBinding({
  artifactPath: config.artifactPath,
  manifestPath: config.manifestPath
});
const records = [];
const descendants = [];
let evidence;
let verification;

try {
  switch (config.mode) {
    case "once": {
      evidence = binding.acquireOwnerLock({ statePath: config.statePath });
      verification = binding.verifyOwnerLock({ evidence });
      break;
    }
    case "hold": {
      evidence = binding.acquireOwnerLock({ statePath: config.statePath });
      verification = binding.verifyOwnerLock({ evidence });
      break;
    }
    case "reacquire": {
      evidence = binding.acquireOwnerLock({ statePath: config.statePath });
      verification = binding.verifyOwnerLock({ evidence });
      for (const [label, path] of [
        ["same_path", config.statePath],
        ["alternate_path", config.alternateStatePath]
      ]) {
        try {
          binding.acquireOwnerLock({ statePath: path });
          records.push({ label, ok: true });
        } catch (error) {
          records.push({ label, ok: false, ...errorRecord(error) });
        }
      }
      records.push({
        label: "owner_after_reacquire",
        verification: binding.verifyOwnerLock({ evidence })
      });
      break;
    }
    case "worker": {
      if (config.mainAcquire === "before") {
        evidence = binding.acquireOwnerLock({ statePath: config.statePath });
        verification = binding.verifyOwnerLock({ evidence });
      }
      const worker = new Worker(config.nativeWorkerPath, {
        workerData: {
          artifactPath: config.artifactPath,
          manifestPath: config.manifestPath,
          mode: config.workerMode,
          statePath: config.statePath,
          evidence
        }
      });
      const observation = workerObservation(worker);
      const message = await observation.message;
      const exit = await observation.exit;
      descendants.push({
        kind: "Worker",
        pid: null,
        threadId: worker.threadId,
        completionEvent: "exit",
        exitCode: exit.code,
        workerError: exit.error?.message ?? null,
        message
      });
      if (config.mainAcquire === "after") {
        evidence = binding.acquireOwnerLock({ statePath: config.statePath });
        verification = binding.verifyOwnerLock({ evidence });
      } else {
        records.push({
          label: "owner_after_worker",
          verification: binding.verifyOwnerLock({ evidence })
        });
      }
      break;
    }
    case "probe": {
      evidence = binding.acquireOwnerLock({ statePath: config.statePath });
      verification = binding.verifyOwnerLock({ evidence });
      descendants.push(await runExecProbe(config, evidence));
      break;
    }
    case "gc-worker": {
      evidence = binding.acquireOwnerLock({ statePath: config.statePath });
      verification = binding.verifyOwnerLock({ evidence });
      const worker = new Worker(config.publicWorkerPath, {
        workerData: {
          artifactPath: config.artifactPath,
          manifestPath: config.manifestPath,
          statePath: config.statePath
        }
      });
      const observation = workerObservation(worker);
      const message = await observation.message;
      await worker.terminate();
      descendants.push({
        kind: "Worker",
        pid: null,
        threadId: worker.threadId,
        completionEvent: "terminate",
        message
      });
      const gcAvailable = typeof global.gc === "function";
      if (gcAvailable) {
        for (let index = 0; index < 3; index += 1) {
          global.gc();
          await delay(25);
        }
      }
      records.push({ label: "gc", gcAvailable });
      records.push({ label: "fds", ...inspectFdIdentity(evidence) });
      break;
    }
    case "reentrant-acquire": {
      let inner;
      evidence = binding.acquireOwnerLock({
        get statePath() {
          try {
            binding.acquireOwnerLock({ statePath: config.statePath });
            inner = { ok: true };
          } catch (error) {
            inner = { ok: false, ...errorRecord(error) };
          }
          return config.statePath;
        }
      });
      verification = binding.verifyOwnerLock({ evidence });
      records.push({ label: "inner", ...inner });
      break;
    }
    case "reentrant-verify": {
      evidence = binding.acquireOwnerLock({ statePath: config.statePath });
      verification = binding.verifyOwnerLock({ evidence });
      let inner;
      const outer = binding.verifyOwnerLock({
        get evidence() {
          try {
            binding.verifyOwnerLock({ evidence });
            inner = { ok: true };
          } catch (error) {
            inner = { ok: false, ...errorRecord(error) };
          }
          return evidence;
        }
      });
      records.push({
        label: "inner",
        ...inner
      }, {
        label: "outer",
        valid: outer.valid
      });
      verification = outer;
      break;
    }
    case "acquire-getter-throw": {
      const identity = pathIdentity(config.statePath);
      const before = inspectFdIdentity(identity.comparison);
      try {
        binding.acquireOwnerLock({
          get statePath() {
            throw new Error("fixture statePath getter failure");
          }
        });
        records.push({ label: "outer", ok: true });
      } catch (error) {
        records.push({ label: "outer", ok: false, ...errorRecord(error) });
      }
      try {
        binding.acquireOwnerLock({ statePath: config.statePath });
        records.push({ label: "retry", ok: true });
      } catch (error) {
        records.push({ label: "retry", ok: false, ...errorRecord(error) });
      }
      const after = inspectFdIdentity(identity.comparison);
      records.push({
        label: "fds",
        identity,
        before,
        after,
        newMatchingParentFds: after.matchingParentFds.filter(
          fd => !before.matchingParentFds.includes(fd)
        ),
        newMatchingLockFds: after.matchingLockFds.filter(
          fd => !before.matchingLockFds.includes(fd)
        )
      });
      break;
    }
    case "verify-getter-throw": {
      evidence = binding.acquireOwnerLock({ statePath: config.statePath });
      verification = binding.verifyOwnerLock({ evidence });
      try {
        binding.verifyOwnerLock({
          get evidence() {
            throw new Error("fixture evidence getter failure");
          }
        });
        records.push({ label: "outer", ok: true });
      } catch (error) {
        records.push({ label: "outer", ok: false, ...errorRecord(error) });
      }
      try {
        binding.verifyOwnerLock({ evidence });
        records.push({ label: "retry", ok: true });
      } catch (error) {
        records.push({ label: "retry", ok: false, ...errorRecord(error) });
      }
      records.push({ label: "fds", ...inspectFdIdentity(evidence) });
      break;
    }
    case "acquire-failure": {
      const identity = pathIdentity(config.statePath);
      const before = inspectFdIdentity(identity.comparison);
      try {
        binding.acquireOwnerLock({ statePath: config.statePath });
        records.push({ label: "attempt", ok: true });
      } catch (error) {
        records.push({ label: "attempt", ok: false, ...errorRecord(error) });
      }
      try {
        binding.acquireOwnerLock({ statePath: config.statePath });
        records.push({ label: "retry", ok: true });
      } catch (error) {
        records.push({ label: "retry", ok: false, ...errorRecord(error) });
      }
      const after = inspectFdIdentity(identity.comparison);
      records.push({
        label: "fds",
        identity,
        before,
        after,
        newMatchingParentFds: after.matchingParentFds.filter(
          fd => !before.matchingParentFds.includes(fd)
        ),
        newMatchingLockFds: after.matchingLockFds.filter(
          fd => !before.matchingLockFds.includes(fd)
        )
      });
      break;
    }
    case "replacement": {
      evidence = binding.acquireOwnerLock({ statePath: config.statePath });
      verification = binding.verifyOwnerLock({ evidence });
      await writeExclusiveJson(config.readyPath, {
        schemaVersion: "1",
        pid: process.pid,
        mode: config.mode,
        evidence,
        verification
      });
      await waitForPath(config.proceedPath, config.timeoutMs);
      for (const label of ["first", "second"]) {
        try {
          records.push({
            label,
            ok: true,
            verification: binding.verifyOwnerLock({ evidence })
          });
        } catch (error) {
          records.push({ label, ok: false, ...errorRecord(error) });
        }
      }
      records.push({ label: "fds", ...inspectFdIdentity(evidence) });
      break;
    }
    default:
      throw new Error(`unsupported holder mode: ${config.mode}`);
  }

  const pendingSignal = config.hold && config.waitMode === "signal"
    ? waitForSignal(config.timeoutMs ?? 5_000)
    : null;

  if (config.descendantsFinalPath) {
    await writeExclusiveJson(config.descendantsFinalPath, {
      schemaVersion: "1",
      pid: process.pid,
      finished: true,
      descendants
    });
  }
  await writeExclusiveJson(config.resultPath, {
    schemaVersion: "1",
    ok: true,
    pid: process.pid,
    mode: config.mode,
    evidence: evidence ?? null,
    verification: verification ?? null,
    records,
    descendants
  });
  if (config.mode !== "replacement") {
    await writeExclusiveJson(config.readyPath, {
      schemaVersion: "1",
      pid: process.pid,
      mode: config.mode,
      evidence: evidence ?? null,
      verification: verification ?? null,
      descendantsFinished: true
    });
  }

  if (config.hold) {
    if (config.waitMode === "signal") {
      const signal = await pendingSignal;
      process.removeAllListeners("SIGTERM");
      process.removeAllListeners("SIGINT");
      process.kill(process.pid, signal);
    } else {
      await waitForPath(config.releasePath, config.timeoutMs);
    }
  }
} catch (error) {
  const report = {
    schemaVersion: "1",
    ok: false,
    pid: process.pid,
    mode: config.mode,
    error: errorRecord(error),
    evidence: evidence ?? null,
    verification: verification ?? null,
    records,
    descendants
  };
  try {
    await writeExclusiveJson(config.resultPath, report);
  } catch {
    process.stdout.write(`${JSON.stringify(report)}\n`);
  }
  process.exitCode = 1;
}
