import { appendFile, readFile, stat } from "node:fs/promises";
import { spawn } from "node:child_process";

export async function fileExists(path) {
  try {
    const info = await stat(path);
    return info.isFile();
  } catch {
    return false;
  }
}

export async function runBuffered(executable, args = [], options = {}) {
  const timeoutMs = options.timeoutMs || 10000;
  const startedAt = new Date();

  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    let child;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        executable,
        args,
        startedAt: startedAt.toISOString(),
        finishedAt: new Date().toISOString(),
        stdout,
        stderr,
        ...result
      });
    };

    const timer = setTimeout(() => {
      if (child) {
        child.kill();
      }
      finish({ ok: false, timedOut: true, exitCode: null, error: `Timed out after ${timeoutMs}ms` });
    }, timeoutMs);

    try {
      child = spawn(executable, args, {
        cwd: options.cwd,
        env: { ...process.env, ...(options.env || {}) },
        windowsHide: true
      });
    } catch (error) {
      finish({ ok: false, exitCode: null, error: error.message });
      return;
    }

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      finish({ ok: false, exitCode: null, error: error.message });
    });
    child.on("close", (exitCode) => {
      finish({ ok: exitCode === 0, exitCode });
    });
  });
}

export class ManagedProcess {
  constructor(name, logFile) {
    this.name = name;
    this.logFile = logFile;
    this.child = null;
    this.startedAt = null;
    this.lastExit = null;
    this.exitWaiters = [];
  }

  isRunning() {
    return Boolean(this.child && this.child.exitCode == null && this.child.signalCode == null);
  }

  async start(executable, args = [], options = {}) {
    if (this.isRunning()) {
      return this.status();
    }

    const errorCode = options.errorCode || "";
    await appendLog(this.logFile, `\n[${new Date().toISOString()}] start ${this.name}: ${executable} ${args.join(" ")}\n`);
    let readySettled = false;
    let spawned = false;
    const pendingOutput = [];
    let stdoutEnded = false;
    let stderrEnded = false;
    let resolveOutputDrained;
    const outputDrained = new Promise((resolve) => {
      resolveOutputDrained = resolve;
    });
    const markOutputEnded = (stream) => {
      if (stream === "stdout") stdoutEnded = true;
      if (stream === "stderr") stderrEnded = true;
      if (stdoutEnded && stderrEnded) resolveOutputDrained();
    };
    let resolveReady;
    let rejectReady;
    const ready = new Promise((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });
    const settleReady = (handler, value) => {
      if (readySettled) return;
      readySettled = true;
      handler(value);
    };
    const deliverOutput = (output) => {
      if (typeof options.onOutput === "function") {
        options.onOutput(output);
      }
    };
    const flushPendingOutput = () => {
      for (const output of pendingOutput.splice(0)) {
        deliverOutput(output);
      }
    };
    const handleOutput = (stream, chunk) => {
      const output = { stream, text: chunk.toString() };
      appendLog(this.logFile, output.text);
      // A child can write before an asynchronous onStarted callback has
      // established the consumer's run context. Preserve output ordering and
      // replay it immediately after startup bookkeeping instead of dropping
      // direction-sensitive parsers (notably bisync conflict detection).
      if (!readySettled) {
        pendingOutput.push(output);
        return;
      }
      deliverOutput(output);
    };
    const notifyExit = (exit) => {
      const waiters = this.exitWaiters.splice(0);
      const run = async () => {
        await ready.catch(() => {});
        if (typeof options.onExit === "function") {
          await options.onExit(exit);
        }
        return exit;
      };
      run()
        .catch(() => exit)
        .then((settledExit) => {
          for (const waiter of waiters) {
            waiter(settledExit);
          }
        });
    };

    try {
      if (options.testSpawnFailure) {
        throw new Error(`${this.name} test spawn failure`);
      }
      this.child = spawn(executable, args, {
        cwd: options.cwd,
        env: { ...process.env, ...(options.env || {}) },
        windowsHide: true
      });
    } catch (error) {
      this.lastExit = {
        ok: false,
        errorCode,
        error: error.message,
        at: new Date().toISOString()
      };
      appendLog(this.logFile, `[error] ${error.message}\n`);
      throw error;
    }

    this.child.stdout.on("data", (chunk) => {
      handleOutput("stdout", chunk);
    });
    this.child.stderr.on("data", (chunk) => {
      handleOutput("stderr", chunk);
    });
    this.child.stdout.on("end", () => markOutputEnded("stdout"));
    this.child.stderr.on("end", () => markOutputEnded("stderr"));
    this.child.on("spawn", async () => {
      spawned = true;
      this.startedAt = new Date();
      this.lastExit = null;
      try {
        if (typeof options.onStarted === "function") {
          await options.onStarted(this.status());
        }
        if (typeof options.readyProbe === "function") {
          await waitForReadyProbe(() => {
            if (!this.isRunning()) {
              throw new Error(`${this.name} exited before it became ready`);
            }
            return options.readyProbe(this.status());
          }, {
            timeoutMs: options.readyTimeoutMs || 5000,
            intervalMs: options.readyIntervalMs || 100
          });
        }
        flushPendingOutput();
        settleReady(resolveReady, this.status());
      } catch (error) {
        this.lastExit = { ok: false, errorCode, error: error.message, at: new Date().toISOString() };
        if (this.isRunning()) {
          this.child.kill();
        }
        appendLog(this.logFile, `[error] ${error.message}\n`);
        settleReady(rejectReady, error);
      }
    });
    this.child.on("error", (error) => {
      this.lastExit = { ok: false, errorCode, error: error.message, at: new Date().toISOString() };
      appendLog(this.logFile, `[error] ${error.message}\n`);
      if (!spawned) {
        this.child = null;
        settleReady(rejectReady, error);
      } else {
        notifyExit(this.lastExit);
      }
    });
    this.child.on("close", (exitCode, signalCode) => {
      finalizeCloseAfterOutput(exitCode, signalCode).catch(() => {});
    });

    const finalizeCloseAfterOutput = async (exitCode, signalCode) => {
      // child_process 'close' usually follows stream end, but Windows pipe
      // scheduling can make the final data event observable just after the
      // process exit notification. Finish the consumer-facing exit lifecycle
      // only once both output streams have ended, so onExit snapshots include
      // every output-derived metric (including split bisync conflicts).
      await outputDrained;
      this.lastExit = {
        ok: exitCode === 0,
        exitCode,
        signalCode: signalCode || null,
        errorCode: exitCode === 0 ? "" : errorCode,
        at: new Date().toISOString()
      };
      appendLog(this.logFile, `\n[${new Date().toISOString()}] ${this.name} exited with ${exitCode}\n`);
      this.child = null;
      if (spawned) {
        notifyExit(this.lastExit);
      }
    };

    return ready;
  }

  stop(signal = "SIGTERM") {
    if (this.isRunning()) {
      this.child.kill(signal);
    }
    return this.status();
  }

  async stopAndWait(options = {}) {
    const timeoutMs = options.timeoutMs || 3000;
    const signal = options.signal || "SIGTERM";
    if (!this.isRunning()) {
      return {
        ...this.status(),
        stopSignal: null,
        stopTimedOut: false
      };
    }
    const child = this.child;
    const wait = this.waitForExit(timeoutMs);
    child.kill(signal);
    const exit = await wait.catch(() => null);
    const status = this.status();
    return {
      ...status,
      stopSignal: signal,
      stopTimedOut: exit === null && status.running
    };
  }

  waitForExit(timeoutMs = 3000) {
    if (!this.isRunning()) {
      return Promise.resolve(this.lastExit);
    }
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.exitWaiters = this.exitWaiters.filter((waiter) => waiter !== done);
        resolve(null);
      }, timeoutMs);
      const done = (exit) => {
        clearTimeout(timer);
        resolve(exit);
      };
      this.exitWaiters.push(done);
    });
  }

  status() {
    return {
      name: this.name,
      running: this.isRunning(),
      pid: this.isRunning() ? this.child.pid : null,
      startedAt: this.startedAt ? this.startedAt.toISOString() : null,
      lastExit: this.lastExit
    };
  }
}

async function waitForReadyProbe(probe, options = {}) {
  const timeoutMs = options.timeoutMs || 5000;
  const intervalMs = options.intervalMs || 100;
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      if (await probe()) {
        return true;
      }
    } catch (error) {
      lastError = error;
      throw error;
    }
    await delay(intervalMs);
  }
  throw new Error(lastError?.message || `Process readiness probe timed out after ${timeoutMs}ms`);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function readRecentLog(file, maxChars = 20000) {
  const result = await readRecentLogWithMeta(file, maxChars);
  return result.text;
}

export async function readRecentLogWithMeta(file, maxChars = 20000) {
  try {
    const info = await stat(file);
    const text = await readFile(file, "utf8");
    const recent = text.length > maxChars ? text.slice(text.length - maxChars) : text;
    return {
      path: file,
      exists: true,
      size: info.size,
      modifiedAt: info.mtime.toISOString(),
      maxChars,
      truncated: text.length > maxChars,
      text: redactLogText(recent)
    };
  } catch (error) {
    if (error && error.code === "ENOENT") {
      return {
        path: file,
        exists: false,
        size: 0,
        modifiedAt: null,
        maxChars,
        truncated: false,
        text: ""
      };
    }
    throw error;
  }
}

async function appendLog(file, text) {
  await appendFile(file, redactLogText(text), "utf8").catch(() => {});
}

export function redactLogText(text = "") {
  return String(text)
    .replace(/\bSFSC1-[A-Za-z0-9_-]+/g, "SFSC1-****")
    .replace(/\bsfsc:\/\/import\/v1#[A-Za-z0-9_-]+/gi, "sfsc://import/v1#****")
    .replace(/\bvless:\/\/[^\s"',<>]+/gi, "vless://****")
    .replace(/\b[A-Za-z]:\\[^\r\n"',<>]*/g, "<local-path>")
    .replace(/\/(?:Users|home|tmp|var|opt|Volumes)\/[^\s"',<>]*/g, "<local-path>")
    .replace(/(\bsecret_access_key\s+)([^\s]+)/gi, "$1****")
    .replace(/(\b(?:S3_SECRET_ACCESS_KEY|AWS_SECRET_ACCESS_KEY|MINIO_ROOT_PASSWORD)\s*=\s*)([^\s]+)/gi, "$1****")
    .replace(/((?:secretAccessKey|secret_access_key)["']?\s*[:=]\s*["']?)([^"',\s}]+)/gi, "$1****");
}
