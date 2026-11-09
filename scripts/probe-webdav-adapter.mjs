#!/usr/bin/env node

import { spawn } from "node:child_process";
import {
  createHash,
  randomBytes,
  randomUUID
} from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, "..");
const BINARY_PATH = path.join(
  REPO_ROOT,
  "client",
  "resources",
  "bin",
  "win32",
  "rclone.exe"
);
const LOCK_PATH = path.join(
  REPO_ROOT,
  "client",
  "resources",
  "bin",
  "win32",
  "binaries.lock.json"
);
const TASK_ROOT = path.join(
  REPO_ROOT,
  ".tmp",
  "development-2026-10-19",
  "p2-webdav"
);
const RUNS_ROOT = path.join(TASK_ROOT, "runs");
const EVIDENCE_PATH = path.join(TASK_ROOT, "latest-probe.json");

const USERNAME = "p2probe";
const LOOPBACK_HOST = "127.0.0.1";
const SERVER_ARGS = Object.freeze({
  addr: `${LOOPBACK_HOST}:0`,
  dirCacheTime: "1s",
  pollInterval: "0",
  vfsCacheMode: "off",
  serverReadTimeout: "30s",
  serverWriteTimeout: "30s"
});
const REQUIRED_RANGE_STREAMS = 8;
const OBSERVATION_INTERVAL_MS = 25;
const COPY_SOURCE_SIZE = 1024 * 1024;
const COPY_BANDWIDTH = "256Ki";
const BISYNC_SOURCE_SIZE = 1024 * 1024;
const BISYNC_BANDWIDTH = "256Ki";

const evidence = {
  schemaVersion: 1,
  kind: "syncraft-p2-webdav-probe",
  status: "running",
  startedAt: new Date().toISOString(),
  finishedAt: null,
  runId: randomUUID(),
  boundaries: [
    "Windows-local loopback evidence only",
    "Does not prove N1 ARM64 behavior",
    "Does not prove public-network routing",
    "Does not prove final gateway authorization",
    "Does not establish P1 acceptance or P2 release"
  ],
  environment: {
    platform: process.platform,
    arch: process.arch,
    osRelease: os.release(),
    nodeVersion: process.version
  },
  binary: null,
  server: null,
  probes: {},
  failures: [],
  cleanup: null,
  conclusion: null
};

const secrets = [];
let serverChild = null;
let serverBaseUrl = null;
let authHeader = null;
let runRoot = null;
let serveRoot = null;

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

async function sha256File(filePath) {
  const handle = await fs.open(filePath, "r");
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(1024 * 1024);

  try {
    while (true) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) {
        break;
      }
      hash.update(buffer.subarray(0, bytesRead));
    }
  } finally {
    await handle.close();
  }

  return hash.digest("hex");
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function nowIso() {
  return new Date().toISOString();
}

function roundedMs(value) {
  return Number(value.toFixed(3));
}

function normalizeForComparison(value) {
  return process.platform === "win32"
    ? path.resolve(value).toLowerCase()
    : path.resolve(value);
}

function assertAbsolutePathInside(rootPath, candidatePath) {
  if (!path.isAbsolute(rootPath) || !path.isAbsolute(candidatePath)) {
    throw new Error("cleanup path validation requires absolute paths");
  }

  const root = normalizeForComparison(rootPath);
  const candidate = normalizeForComparison(candidatePath);
  const relative = path.relative(root, candidate);

  if (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  ) {
    return;
  }

  throw new Error("cleanup path escaped the designated experiment root");
}

function repoRelative(filePath) {
  return path.relative(REPO_ROOT, filePath).replaceAll("\\", "/");
}

function redact(value) {
  let result = String(value ?? "");
  for (const secret of secrets.filter(Boolean)) {
    result = result.replaceAll(secret, "[REDACTED]");
  }
  return result;
}

function sanitizedError(error) {
  return redact(error instanceof Error ? error.message : String(error));
}

function baseEnvironment(extra = {}) {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.toUpperCase().startsWith("RCLONE_")) {
      env[key] = value;
    }
  }
  env.RCLONE_CONFIG = path.join(runRoot, "rclone.conf");
  env.RCLONE_CACHE_DIR = path.join(runRoot, "rclone-cache");
  env.RCLONE_TEMP_DIR = path.join(runRoot, "rclone-temp");
  return { ...env, ...extra };
}

function webdavEnvironment(obscuredPassword) {
  return baseEnvironment({
    RCLONE_WEBDAV_URL: serverBaseUrl,
    RCLONE_WEBDAV_VENDOR: "rclone",
    RCLONE_WEBDAV_USER: USERNAME,
    RCLONE_WEBDAV_PASS: obscuredPassword
  });
}

function runProcess(binary, args, options = {}) {
  const {
    env = baseEnvironment(),
    input = null,
    timeoutMs = 30_000,
    maxOutputBytes = 100_000
  } = options;

  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, {
      cwd: REPO_ROOT,
      env,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      if (stdout.length < maxOutputBytes) {
        stdout += chunk.toString("utf8").slice(0, maxOutputBytes - stdout.length);
      }
    });
    child.stderr.on("data", (chunk) => {
      if (stderr.length < maxOutputBytes) {
        stderr += chunk.toString("utf8").slice(0, maxOutputBytes - stderr.length);
      }
    });
    child.once("error", (error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (exitCode, signalCode) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      const result = {
        exitCode,
        signalCode,
        timedOut,
        stdout: redact(stdout),
        stderr: redact(stderr)
      };
      if (timedOut) {
        reject(new Error(`process timed out after ${timeoutMs}ms`));
        return;
      }
      resolve(result);
    });

    if (input !== null) {
      child.stdin.end(input);
    } else {
      child.stdin.end();
    }
  });
}

async function runRclone(args, options = {}) {
  const result = await runProcess(BINARY_PATH, args, options);
  if (result.exitCode !== 0) {
    throw new Error(
      `rclone ${args[0]} exited ${result.exitCode}: ${result.stderr || result.stdout}`
    );
  }
  return result;
}

async function runRcloneObserved(args, observationRoot, options = {}) {
  const {
    env = baseEnvironment(),
    timeoutMs = 45_000
  } = options;
  const child = spawn(BINARY_PATH, args, {
    cwd: REPO_ROOT,
    env,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"]
  });
  let stdout = "";
  let stderr = "";
  let finished = false;
  const observations = [];
  let lastSignature = "";
  let sampleCount = 0;

  child.stdout.on("data", (chunk) => {
    if (stdout.length < 100_000) {
      stdout += chunk.toString("utf8").slice(0, 100_000 - stdout.length);
    }
  });
  child.stderr.on("data", (chunk) => {
    if (stderr.length < 100_000) {
      stderr += chunk.toString("utf8").slice(0, 100_000 - stderr.length);
    }
  });

  const completion = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`observed rclone ${args[0]} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (exitCode, signalCode) => {
      clearTimeout(timer);
      if (exitCode !== 0) {
        reject(
          new Error(
            `rclone ${args[0]} exited ${exitCode}: ${redact(stderr || stdout)}`
          )
        );
        return;
      }
      resolve({ exitCode, signalCode });
    });
  });

  const sampler = (async () => {
    while (!finished) {
      sampleCount += 1;
      const snapshot = await snapshotTree(observationRoot);
      const signature = JSON.stringify(snapshot);
      if (signature !== lastSignature) {
        observations.push({
          elapsedMs: null,
          snapshot
        });
        lastSignature = signature;
      }
      await delay(OBSERVATION_INTERVAL_MS);
    }
  })();

  try {
    const result = await completion;
    return {
      ...result,
      stdout: redact(stdout),
      stderr: redact(stderr),
      sampleCount,
      observations
    };
  } finally {
    finished = true;
    await sampler;
  }
}

async function createObscuredPassword(password) {
  const result = await runRclone(["obscure", "-"], {
    input: password,
    timeoutMs: 10_000
  });
  const obscured = result.stdout.trim();
  if (!obscured) {
    throw new Error("rclone obscure returned no value");
  }
  secrets.push(obscured);
  return obscured;
}

async function writeHtpasswd(filePath, password) {
  const sha1 = createHash("sha1").update(password).digest("base64");
  await fs.writeFile(filePath, `${USERNAME}:{SHA}${sha1}\r\n`, {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx"
  });
  await fs.chmod(filePath, 0o600).catch(() => {});
}

function startServer(htpasswdPath) {
  const args = [
    "serve",
    "webdav",
    serveRoot,
    "--addr",
    SERVER_ARGS.addr,
    "--htpasswd",
    htpasswdPath,
    "--dir-cache-time",
    SERVER_ARGS.dirCacheTime,
    "--poll-interval",
    SERVER_ARGS.pollInterval,
    "--vfs-cache-mode",
    SERVER_ARGS.vfsCacheMode,
    "--server-read-timeout",
    SERVER_ARGS.serverReadTimeout,
    "--server-write-timeout",
    SERVER_ARGS.serverWriteTimeout,
    "--log-level",
    "INFO"
  ];

  const child = spawn(BINARY_PATH, args, {
    cwd: REPO_ROOT,
    env: baseEnvironment(),
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"]
  });
  let output = "";
  child.stdout.on("data", (chunk) => {
    output += chunk.toString("utf8").slice(0, 100_000 - output.length);
  });
  child.stderr.on("data", (chunk) => {
    output += chunk.toString("utf8").slice(0, 100_000 - output.length);
  });

  return {
    child,
    getOutput: () => redact(output)
  };
}

async function waitForServerAddress(server, timeoutMs = 15_000) {
  const startedAt = performance.now();
  while (performance.now() - startedAt < timeoutMs) {
    if (server.child.exitCode !== null) {
      throw new Error(
        `rclone serve webdav exited during startup: ${server.getOutput()}`
      );
    }
    const match = server.getOutput().match(
      new RegExp(`127\\.0\\.0\\.1:(\\d+)`)
    );
    if (match) {
      return {
        port: Number(match[1]),
        startupMs: roundedMs(performance.now() - startedAt)
      };
    }
    await delay(50);
  }
  throw new Error("rclone serve webdav did not report a loopback port");
}

async function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return true;
  }
  return Promise.race([
    new Promise((resolve) => child.once("exit", () => resolve(true))),
    delay(timeoutMs).then(() => false)
  ]);
}

function pidAppearsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

async function stopServer(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) {
    return {
      attempted: false,
      exited: true,
      forced: false,
      pidStillAlive: false
    };
  }

  const pid = child.pid;
  child.kill("SIGTERM");
  let exited = await waitForExit(child, 5_000);
  let forced = false;

  if (!exited && Number.isInteger(pid)) {
    forced = true;
    await runProcess(
      path.join(process.env.SystemRoot || "C:\\Windows", "System32", "taskkill.exe"),
      ["/PID", String(pid), "/T", "/F"],
      { timeoutMs: 10_000 }
    ).catch(() => {});
    exited = await waitForExit(child, 5_000);
  }

  const pidStillAlive = Number.isInteger(pid) ? pidAppearsAlive(pid) : false;
  return {
    attempted: true,
    exited,
    forced,
    pidStillAlive,
    exitCode: child.exitCode,
    signalCode: child.signalCode
  };
}

function authenticatedHeaders(extra = {}) {
  return {
    authorization: authHeader,
    ...extra
  };
}

async function webdavRequest(pathname, options = {}) {
  const {
    method = "GET",
    headers = {},
    body,
    authenticated = true,
    signal
  } = options;
  const requestHeaders = authenticated
    ? authenticatedHeaders(headers)
    : { ...headers };
  return fetch(new URL(pathname, serverBaseUrl), {
    method,
    headers: requestHeaders,
    body,
    redirect: "manual",
    signal
  });
}

async function ensureWebdavDirectory(pathname, timeoutMs = 5_000) {
  const mkcol = await webdavRequest(pathname, { method: "MKCOL" });
  await mkcol.arrayBuffer();
  if (![201, 405].includes(mkcol.status)) {
    throw new Error(
      `MKCOL ${pathname} returned unexpected status ${mkcol.status}`
    );
  }

  const startedAt = performance.now();
  let lastStatus = null;
  while (performance.now() - startedAt <= timeoutMs) {
    const propfind = await webdavRequest(pathname, {
      method: "PROPFIND",
      headers: { depth: "0" }
    });
    await propfind.arrayBuffer();
    lastStatus = propfind.status;
    if (propfind.status === 207) {
      return {
        mkcolStatus: mkcol.status,
        visible: true,
        latencyMs: roundedMs(performance.now() - startedAt)
      };
    }
    await delay(50);
  }

  throw new Error(
    `WebDAV directory ${pathname} did not become visible; last status ${lastStatus}`
  );
}

async function getBody(pathname) {
  const response = await webdavRequest(pathname);
  const body = Buffer.from(await response.arrayBuffer());
  return { response, body };
}

async function pollVisibleContent(pathname, expectedHash, timeoutMs = 7_000) {
  const startedAt = performance.now();
  let attempts = 0;
  let lastStatus = null;
  let lastHash = null;

  while (performance.now() - startedAt <= timeoutMs) {
    attempts += 1;
    try {
      const { response, body } = await getBody(pathname);
      lastStatus = response.status;
      lastHash = sha256(body);
      if (response.ok && lastHash === expectedHash) {
        return {
          visible: true,
          latencyMs: roundedMs(performance.now() - startedAt),
          attempts,
          lastStatus,
          contentHashMatched: true
        };
      }
    } catch (error) {
      lastStatus = `request_error:${error?.code || error?.name || "unknown"}`;
    }
    await delay(50);
  }

  return {
    visible: false,
    latencyMs: roundedMs(performance.now() - startedAt),
    attempts,
    lastStatus,
    contentHashMatched: lastHash === expectedHash
  };
}

async function snapshotTree(rootPath) {
  const result = [];
  async function walk(current, relativePath = "") {
    let entries;
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch (error) {
      if (error?.code === "ENOENT") {
        return;
      }
      throw error;
    }

    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const absolutePath = path.join(current, entry.name);
      const relative = relativePath
        ? `${relativePath}/${entry.name}`
        : entry.name;
      if (entry.isSymbolicLink()) {
        result.push({ path: relative, type: "link" });
      } else if (entry.isDirectory()) {
        result.push({ path: relative, type: "directory" });
        await walk(absolutePath, relative);
      } else if (entry.isFile()) {
        const stat = await fs.stat(absolutePath);
        result.push({
          path: relative,
          type: "file",
          size: stat.size,
          mtimeMs: stat.mtimeMs
        });
      }
    }
  }
  await walk(rootPath);
  return result;
}

function findSnapshotEntry(snapshot, targetPath) {
  return snapshot.find((entry) => entry.path === targetPath) ?? null;
}

async function rcloneLsJson(remotePath) {
  const result = await runRclone(
    ["lsjson", "--stat", "--no-mimetype", remotePath],
    {
      env: webdavEnvironment(evidence.server.obscuredPasswordForProcessOnly),
      timeoutMs: 20_000
    }
  );
  return JSON.parse(result.stdout);
}

function timeDriftMs(expectedIso, actualIso) {
  const expected = Date.parse(expectedIso);
  const actual = Date.parse(actualIso);
  if (!Number.isFinite(expected) || !Number.isFinite(actual)) {
    return null;
  }
  return roundedMs(Math.abs(actual - expected));
}

function setProbe(name, probe) {
  evidence.probes[name] = probe;
}

function addFailure(scope, error) {
  evidence.failures.push({
    scope,
    at: nowIso(),
    message: sanitizedError(error)
  });
}

async function probeBinaryIntegrity() {
  const lock = JSON.parse(await fs.readFile(LOCK_PATH, "utf8"));
  const expected = lock.tools?.rclone?.sha256;
  const stat = await fs.stat(BINARY_PATH);
  const actual = await sha256File(BINARY_PATH);
  const versionResult = await runRclone(["version"], { timeoutMs: 10_000 });
  const version = versionResult.stdout.split(/\r?\n/)[0]?.trim() || null;

  evidence.binary = {
    path: repoRelative(BINARY_PATH),
    lockPath: repoRelative(LOCK_PATH),
    expectedVersion: lock.tools?.rclone?.version ?? null,
    expectedTag: lock.tools?.rclone?.tag ?? null,
    expectedSha256: expected,
    actualSha256: actual,
    sizeBytes: stat.size,
    version,
    hashMatches: actual === expected,
    versionMatches: version === `rclone v${lock.tools?.rclone?.version}`
  };

  if (!evidence.binary.hashMatches) {
    throw new Error("locked rclone binary SHA-256 does not match");
  }
  if (!evidence.binary.versionMatches) {
    throw new Error("locked rclone binary version does not match");
  }
}

async function probeUnauthenticatedAccess() {
  const response = await webdavRequest("/", {
    method: "GET",
    authenticated: false
  });
  await response.arrayBuffer();
  const status = response.status;
  return {
    status: status === 401 ? "passed" : "failed",
    observedHttpStatus: status,
    expectedHttpStatus: 401
  };
}

async function probeExternalVisibility() {
  const externalDir = path.join(serveRoot, "external");
  await fs.mkdir(externalDir, { recursive: true });
  const initial = randomBytes(64 * 1024);
  const rewritten = Buffer.from(initial);
  for (let index = 0; index < rewritten.length; index += 1) {
    rewritten[index] ^= 0xa5;
  }
  const filePath = path.join(externalDir, "visibility.bin");

  await fs.writeFile(filePath, initial);
  const create = await pollVisibleContent(
    "/external/visibility.bin",
    sha256(initial)
  );

  await fs.writeFile(filePath, rewritten);
  const sameSizeRewrite = await pollVisibleContent(
    "/external/visibility.bin",
    sha256(rewritten)
  );

  return {
    status:
      create.visible && sameSizeRewrite.visible ? "passed" : "blocked",
    configuration: {
      dirCacheTime: SERVER_ARGS.dirCacheTime,
      pollInterval: SERVER_ARGS.pollInterval
    },
    sizeBytes: initial.length,
    create,
    sameSizeRewrite
  };
}

async function probeMtime(obscuredPassword) {
  const mtimeDir = path.join(serveRoot, "mtime");
  const sourceDir = path.join(runRoot, "mtime-source");
  await fs.mkdir(mtimeDir, { recursive: true });
  await fs.mkdir(sourceDir, { recursive: true });

  const sourcePath = path.join(sourceDir, "from-rclone.bin");
  const sourceBody = Buffer.from("mtime-through-rclone\n");
  const expectedWriteMtime = "2026-10-19T12:34:56.789Z";
  await fs.writeFile(sourcePath, sourceBody);
  const expectedWriteDate = new Date(expectedWriteMtime);
  await fs.utimes(sourcePath, expectedWriteDate, expectedWriteDate);

  await runRclone(
    [
      "copyto",
      sourcePath,
      ":webdav:mtime/from-rclone.bin",
      "--no-traverse",
      "--stats",
      "0"
    ],
    {
      env: webdavEnvironment(obscuredPassword),
      timeoutMs: 20_000
    }
  );

  const writtenFsPath = path.join(mtimeDir, "from-rclone.bin");
  const writtenFsStat = await fs.stat(writtenFsPath);
  const writtenRemote = await rcloneLsJson(":webdav:mtime/from-rclone.bin");

  const externalPath = path.join(mtimeDir, "external.bin");
  const externalBody = Buffer.from("mtime-external\n");
  const expectedReadMtime = "2026-10-19T13:45:01.456Z";
  await fs.writeFile(externalPath, externalBody);
  const expectedReadDate = new Date(expectedReadMtime);
  await fs.utimes(externalPath, expectedReadDate, expectedReadDate);
  await pollVisibleContent("/mtime/external.bin", sha256(externalBody));
  const externalRemote = await rcloneLsJson(":webdav:mtime/external.bin");

  const writeFsDriftMs = timeDriftMs(
    expectedWriteMtime,
    writtenFsStat.mtime.toISOString()
  );
  const writeRemoteDriftMs = timeDriftMs(
    expectedWriteMtime,
    writtenRemote.ModTime
  );
  const readRemoteDriftMs = timeDriftMs(
    expectedReadMtime,
    externalRemote.ModTime
  );
  return {
    status: "blocked",
    reason:
      "The locked rclone vendor path truncates mtime to whole seconds. Size plus this mtime cannot prove detection of a same-size rewrite within the same second.",
    observedPrecision: "whole-second truncation",
    risk: {
      sameSizeSameSecondRewriteMayBeMissed: true,
      requiresContentHashOrEquivalentVerification: true
    },
    writeViaRclone: {
      expectedModTime: expectedWriteMtime,
      filesystemModTime: writtenFsStat.mtime.toISOString(),
      vendorReadModTime: writtenRemote.ModTime,
      filesystemDriftMs: writeFsDriftMs,
      vendorReadDriftMs: writeRemoteDriftMs,
      contentHash: sha256(await fs.readFile(writtenFsPath))
    },
    readExternalMtime: {
      expectedModTime: expectedReadMtime,
      vendorReadModTime: externalRemote.ModTime,
      vendorReadDriftMs: readRemoteDriftMs
    }
  };
}

async function probeWebdavFeatures(obscuredPassword) {
  const result = await runRclone(
    ["backend", "features", ":webdav:", "--json"],
    {
      env: webdavEnvironment(obscuredPassword),
      timeoutMs: 15_000
    }
  );
  const features = JSON.parse(result.stdout);
  return {
    status: "blocked",
    reason:
      "The rclone WebDAV vendor exposes no remote hash and reports PartialUploads=false.",
    precisionNanoseconds: features.Precision,
    hashes: features.Hashes,
    remoteHashComparisonAvailable: features.Hashes.length > 0,
    partialUploads: features.Features?.PartialUploads ?? null,
    move: features.Features?.Move ?? null,
    dirMove: features.Features?.DirMove ?? null,
    copy: features.Features?.Copy ?? null,
    putStream: features.Features?.PutStream ?? null,
    openWriterAt: features.Features?.OpenWriterAt ?? null,
    checksumStrategy:
      "Server-provided checksum comparison is unavailable. A full client-side download hash remains a separate design option whose CPU and transfer cost must be measured."
  };
}

async function probeConcurrentRanges() {
  const directory = await ensureWebdavDirectory("/range/");
  const body = randomBytes(2 * 1024 * 1024);
  const response = await webdavRequest("/range/range.bin", {
    method: "PUT",
    headers: { "content-type": "application/octet-stream" },
    body
  });
  await response.arrayBuffer();
  if (!response.ok) {
    throw new Error(`range fixture PUT returned ${response.status}`);
  }

  const rangeSize = Math.ceil(body.length / REQUIRED_RANGE_STREAMS);
  const ranges = [];
  for (let index = 0; index < REQUIRED_RANGE_STREAMS; index += 1) {
    const start = index * rangeSize;
    const end = Math.min(start + rangeSize - 1, body.length - 1);
    ranges.push({ index, start, end });
  }

  const results = await Promise.all(
    ranges.map(async ({ index, start, end }) => {
      const response = await webdavRequest("/range/range.bin", {
        headers: { range: `bytes=${start}-${end}` }
      });
      const actual = Buffer.from(await response.arrayBuffer());
      const expected = body.subarray(start, end + 1);
      return {
        index,
        status: response.status,
        contentRange: response.headers.get("content-range"),
        bytes: actual.length,
        expectedBytes: expected.length,
        expectedSha256: sha256(expected),
        actualSha256: sha256(actual),
        matched:
          response.status === 206 &&
          actual.length === expected.length &&
          sha256(actual) === sha256(expected)
      };
    })
  );

  return {
    status: results.every((result) => result.matched) ? "passed" : "blocked",
    directory,
    streamCount: REQUIRED_RANGE_STREAMS,
    sourceSizeBytes: body.length,
    sourceSha256: sha256(body),
    ranges: results
  };
}

async function probeRcloneCrud(obscuredPassword) {
  const sourceDir = path.join(runRoot, "crud-source");
  await fs.mkdir(sourceDir, { recursive: true });
  const sourcePath = path.join(sourceDir, "write.bin");
  const sourceBody = randomBytes(192 * 1024);
  await fs.writeFile(sourcePath, sourceBody);

  await runRclone(
    ["copyto", sourcePath, ":webdav:crud/write.bin", "--stats", "0"],
    {
      env: webdavEnvironment(obscuredPassword),
      timeoutMs: 20_000
    }
  );
  const originalPath = path.join(serveRoot, "crud", "write.bin");
  const originalHash = sha256(await fs.readFile(originalPath));

  await runRclone(
    [
      "moveto",
      ":webdav:crud/write.bin",
      ":webdav:crud/renamed.bin",
      "--stats",
      "0"
    ],
    {
      env: webdavEnvironment(obscuredPassword),
      timeoutMs: 20_000
    }
  );
  const renamedPath = path.join(serveRoot, "crud", "renamed.bin");
  const originalExistsAfterRename = await fs
    .stat(originalPath)
    .then(() => true)
    .catch(() => false);
  const renamedHash = sha256(await fs.readFile(renamedPath));

  await runRclone(
    ["deletefile", ":webdav:crud/renamed.bin", "--stats", "0"],
    {
      env: webdavEnvironment(obscuredPassword),
      timeoutMs: 20_000
    }
  );
  const renamedExistsAfterDelete = await fs
    .stat(renamedPath)
    .then(() => true)
    .catch(() => false);

  const passed =
    originalHash === sha256(sourceBody) &&
    !originalExistsAfterRename &&
    renamedHash === sha256(sourceBody) &&
    !renamedExistsAfterDelete;

  return {
    status: passed ? "passed" : "failed",
    sourceSha256: sha256(sourceBody),
    write: {
      filesystemHash: originalHash,
      matched: originalHash === sha256(sourceBody)
    },
    rename: {
      originalAbsent: !originalExistsAfterRename,
      renamedFilesystemHash: renamedHash,
      matched: renamedHash === sha256(sourceBody)
    },
    delete: {
      renamedAbsent: !renamedExistsAfterDelete
    }
  };
}

async function probeLinkTraversal() {
  const outsideDir = path.join(runRoot, "outside-serve-root");
  await fs.mkdir(outsideDir, { recursive: true });
  const secretBody = Buffer.from("must-not-cross-webdav-root\n");
  await fs.writeFile(path.join(outsideDir, "secret.txt"), secretBody);
  const junctionPath = path.join(serveRoot, "escape");
  let junctionCreated = false;
  let creationError = null;

  try {
    await fs.symlink(outsideDir, junctionPath, "junction");
    junctionCreated = true;
  } catch (error) {
    creationError = sanitizedError(error);
  }

  if (!junctionCreated) {
    return {
      status: "blocked",
      junctionCreated,
      creationError,
      reason: "could not create the junction used for the isolation test"
    };
  }

  const direct = await webdavRequest("/escape/secret.txt");
  const directBody = Buffer.from(await direct.arrayBuffer());
  const listing = await webdavRequest("/", {
    method: "PROPFIND",
    headers: { depth: "1" }
  });
  const listingBody = await listing.text();
  const linkListed = /\bescape\b/i.test(listingBody);
  const secretReturned =
    direct.status === 200 && sha256(directBody) === sha256(secretBody);

  return {
    status:
      !secretReturned && !linkListed && direct.status >= 400
        ? "passed"
        : "failed",
    junctionCreated,
    junctionTargetOutsideServedRoot: true,
    directRequestStatus: direct.status,
    secretReturned,
    propfindStatus: listing.status,
    linkListed,
    creationError
  };
}

async function snapshotInterruptedPut() {
  const totalLength = 4 * 1024 * 1024;
  const prefix = randomBytes(256 * 1024);
  const url = new URL("/interrupted/stream.bin", serverBaseUrl);
  const request = http.request(url, {
    method: "PUT",
    headers: {
      authorization: authHeader,
      "content-length": String(totalLength),
      "content-type": "application/octet-stream"
    }
  });
  request.on("error", () => {});
  const responsePromise = new Promise((resolve) => {
    request.once("response", (response) => {
      response.resume();
      resolve(response);
    });
    request.once("close", () => resolve(null));
  });
  await new Promise((resolve, reject) => {
    request.write(prefix, (error) => {
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    });
  });

  await delay(300);
  const during = await snapshotTree(serveRoot);
  request.destroy();
  await Promise.race([responsePromise, delay(2_000)]);
  await delay(1_500);
  const after = await snapshotTree(serveRoot);
  return { totalLength, prefixLength: prefix.length, during, after };
}

async function probeInterruptedPut() {
  const directory = await ensureWebdavDirectory("/interrupted/");
  const snapshot = await snapshotInterruptedPut();
  const finalPath = "interrupted/stream.bin";
  const duringFinal = findSnapshotEntry(snapshot.during, finalPath);
  const afterFinal = findSnapshotEntry(snapshot.after, finalPath);
  const duringInterrupted = Boolean(
    duringFinal?.type === "file" && duringFinal.size < snapshot.totalLength
  );
  const afterInterrupted = Boolean(
    afterFinal?.type === "file" && afterFinal.size < snapshot.totalLength
  );
  const tempEntries = snapshot.during.filter(
    (entry) =>
      entry.path.startsWith("interrupted/") &&
      entry.path !== finalPath &&
      entry.type === "file"
  );
  const observedTargetOrTemporary =
    Boolean(duringFinal || afterFinal) || tempEntries.length > 0;

  return {
    status:
      duringInterrupted || afterInterrupted
        ? "blocked"
        : observedTargetOrTemporary
          ? "passed"
          : "blocked",
    observation: observedTargetOrTemporary ? "observed" : "not_observed",
    reason: observedTargetOrTemporary
      ? null
      : "No final or temporary target file was observed while the incomplete request was open or after disconnect. This run does not prove atomic completion.",
    directory,
    rawPutOnly: true,
    totalLength: snapshot.totalLength,
    sentPrefixBytes: snapshot.prefixLength,
    finalNameVisibleWhileInterrupted: duringInterrupted,
    finalNameRemainsPartialAfterDisconnect: afterInterrupted,
    finalEntryDuring: duringFinal,
    finalEntryAfter: afterFinal,
    temporaryEntriesDuring: tempEntries,
    duringSnapshot: snapshot.during,
    afterSnapshot: snapshot.after
  };
}

function analyzeObservedUpload(observations, remoteRelativePath, finalSize) {
  let partialFinalVisible = false;
  let temporaryVisible = false;
  let completeFinalVisible = false;
  let observedFinalMaxSize = null;
  let firstPartialFinalSize = null;
  let lastPartialFinalSize = null;
  const partialFinalSizes = [];
  const temporaryNames = new Set();

  for (const observation of observations) {
    for (const entry of observation.snapshot) {
      if (entry.type !== "file") {
        continue;
      }
      if (entry.path === remoteRelativePath) {
        observedFinalMaxSize = Math.max(observedFinalMaxSize ?? 0, entry.size);
        if (entry.size > 0 && entry.size < finalSize) {
          partialFinalVisible = true;
          firstPartialFinalSize ??= entry.size;
          lastPartialFinalSize = entry.size;
          if (!partialFinalSizes.includes(entry.size)) {
            partialFinalSizes.push(entry.size);
          }
        }
        if (entry.size === finalSize) {
          completeFinalVisible = true;
        }
      } else if (
        entry.path.includes(path.posix.basename(remoteRelativePath))
      ) {
        temporaryVisible = true;
        temporaryNames.add(entry.path);
      }
    }
  }

  return {
    partialFinalVisible,
    temporaryVisible,
    completeFinalVisible,
    observedFinalMaxSize,
    firstPartialFinalSize,
    lastPartialFinalSize,
    partialFinalSizes,
    temporaryNames: [...temporaryNames]
  };
}

async function probeRcloneCopyVisibility(obscuredPassword) {
  const sourceDir = path.join(runRoot, "copy-source");
  const remoteDir = path.join(serveRoot, "copy-upload");
  await fs.mkdir(sourceDir, { recursive: true });
  const body = randomBytes(COPY_SOURCE_SIZE);
  await fs.writeFile(path.join(sourceDir, "copy-upload.bin"), body);

  const result = await runRcloneObserved(
    [
      "copy",
      sourceDir,
      ":webdav:copy-upload",
      "--bwlimit",
      COPY_BANDWIDTH,
      "--stats",
      "0",
      "--log-level",
      "NOTICE"
    ],
    remoteDir,
    {
      env: webdavEnvironment(obscuredPassword),
      timeoutMs: 45_000
    }
  );
  const finalPath = path.join(remoteDir, "copy-upload.bin");
  const finalStat = await fs.stat(finalPath);
  const finalHash = sha256(await fs.readFile(finalPath));
  const analysis = analyzeObservedUpload(
    result.observations,
    "copy-upload.bin",
    body.length
  );

  return {
    status:
      !analysis.partialFinalVisible &&
      finalStat.size === body.length &&
      finalHash === sha256(body)
        ? "passed"
        : "blocked",
    command: "rclone copy",
    bandwidthLimit: COPY_BANDWIDTH,
    observationIntervalMs: OBSERVATION_INTERVAL_MS,
    sampleCount: result.sampleCount,
    sourceSizeBytes: body.length,
    sourceSha256: sha256(body),
    finalSizeBytes: finalStat.size,
    finalSha256: finalHash,
    ...analysis
  };
}

async function probeRcloneCopyExplicitAtomicFlags(obscuredPassword) {
  const sourceDir = path.join(runRoot, "copy-atomic-flags-source");
  const remoteDir = path.join(serveRoot, "copy-atomic-flags");
  await fs.mkdir(sourceDir, { recursive: true });
  const body = randomBytes(COPY_SOURCE_SIZE);
  await fs.writeFile(path.join(sourceDir, "copy-atomic-flags.bin"), body);

  const result = await runRcloneObserved(
    [
      "copy",
      sourceDir,
      ":webdav:copy-atomic-flags",
      "--inplace=false",
      "--partial-suffix",
      ".partial",
      "--bwlimit",
      COPY_BANDWIDTH,
      "--stats",
      "0",
      "--log-level",
      "NOTICE"
    ],
    remoteDir,
    {
      env: webdavEnvironment(obscuredPassword),
      timeoutMs: 45_000
    }
  );
  const finalPath = path.join(remoteDir, "copy-atomic-flags.bin");
  const finalStat = await fs.stat(finalPath);
  const finalHash = sha256(await fs.readFile(finalPath));
  const analysis = analyzeObservedUpload(
    result.observations,
    "copy-atomic-flags.bin",
    body.length
  );

  return {
    status:
      !analysis.partialFinalVisible &&
      finalStat.size === body.length &&
      finalHash === sha256(body)
        ? "passed"
        : "blocked",
    command: "rclone copy --inplace=false --partial-suffix .partial",
    explicitFlags: {
      inplace: false,
      partialSuffix: ".partial"
    },
    bandwidthLimit: COPY_BANDWIDTH,
    observationIntervalMs: OBSERVATION_INTERVAL_MS,
    sampleCount: result.sampleCount,
    sourceSizeBytes: body.length,
    sourceSha256: sha256(body),
    finalSizeBytes: finalStat.size,
    finalSha256: finalHash,
    ...analysis
  };
}

async function probeControlledStagingMove(obscuredPassword) {
  const sourceDir = path.join(runRoot, "staging-source");
  const stagingRoot = path.join(serveRoot, ".syncraft-staging");
  const finalRoot = path.join(serveRoot, "staged-final");
  await fs.mkdir(sourceDir, { recursive: true });
  const stagingDirectory = await ensureWebdavDirectory("/.syncraft-staging/");
  const finalDirectory = await ensureWebdavDirectory("/staged-final/");
  const body = randomBytes(COPY_SOURCE_SIZE);
  const sourcePath = path.join(sourceDir, "staged.bin");
  await fs.writeFile(sourcePath, body);

  const stagingUpload = await runRcloneObserved(
    [
      "copyto",
      sourcePath,
      ":webdav:.syncraft-staging/probe.partial",
      "--bwlimit",
      COPY_BANDWIDTH,
      "--stats",
      "0",
      "--log-level",
      "NOTICE"
    ],
    serveRoot,
    {
      env: webdavEnvironment(obscuredPassword),
      timeoutMs: 45_000
    }
  );
  const stagingUploadAnalysis = analyzeObservedUpload(
    stagingUpload.observations,
    ".syncraft-staging/probe.partial",
    body.length
  );
  const finalAbsentDuringStagingUpload = !stagingUpload.observations.some(
    (observation) =>
      Boolean(findSnapshotEntry(observation.snapshot, "staged-final/final.bin"))
  );

  const move = await runRcloneObserved(
    [
      "moveto",
      ":webdav:.syncraft-staging/probe.partial",
      ":webdav:staged-final/final.bin",
      "--stats",
      "0",
      "--log-level",
      "NOTICE"
    ],
    finalRoot,
    {
      env: webdavEnvironment(obscuredPassword),
      timeoutMs: 30_000
    }
  );
  const moveAnalysis = analyzeObservedUpload(
    move.observations,
    "final.bin",
    body.length
  );
  const finalPath = path.join(finalRoot, "final.bin");
  const stagingPath = path.join(stagingRoot, "probe.partial");
  const finalStat = await fs.stat(finalPath);
  const finalHash = sha256(await fs.readFile(finalPath));
  const stagingAbsent = await fs
    .stat(stagingPath)
    .then(() => false)
    .catch(() => true);

  return {
    status:
      finalAbsentDuringStagingUpload &&
      !moveAnalysis.partialFinalVisible &&
      stagingAbsent &&
      finalStat.size === body.length &&
      finalHash === sha256(body)
        ? "passed"
        : "blocked",
    stagingDirectories: {
      staging: stagingDirectory,
      final: finalDirectory
    },
    sourceSizeBytes: body.length,
    sourceSha256: sha256(body),
    stagingUpload: {
      sampleCount: stagingUpload.sampleCount,
      finalAbsentDuringUpload: finalAbsentDuringStagingUpload,
      stagingPartialVisible: stagingUploadAnalysis.partialFinalVisible,
      observedStagingMaxSize: stagingUploadAnalysis.observedFinalMaxSize
    },
    move: {
      sampleCount: move.sampleCount,
      finalPartialVisible: moveAnalysis.partialFinalVisible,
      observedFinalMaxSize: moveAnalysis.observedFinalMaxSize,
      finalSizeBytes: finalStat.size,
      finalSha256: finalHash,
      stagingAbsentAfterMove: stagingAbsent
    },
    gatewayRequirement:
      "A gateway must hide or deny the staging namespace, reject direct final-name writes, and expose only verified completed files."
  };
}

async function probeBisyncVisibility(obscuredPassword) {
  const sourceDir = path.join(runRoot, "bisync-source");
  const remoteDir = path.join(serveRoot, "bisync-upload");
  const workdir = path.join(runRoot, "bisync-workdir");
  await fs.mkdir(sourceDir, { recursive: true });
  const directory = await ensureWebdavDirectory("/bisync-upload/");
  const body = randomBytes(BISYNC_SOURCE_SIZE);
  await fs.writeFile(path.join(sourceDir, "bisync-upload.bin"), body);

  const result = await runRcloneObserved(
    [
      "bisync",
      sourceDir,
      ":webdav:bisync-upload",
      "--resync",
      "--resync-mode",
      "path1",
      "--workdir",
      workdir,
      "--no-cleanup",
      "--check-sync",
      "true",
      "--bwlimit",
      BISYNC_BANDWIDTH,
      "--stats",
      "0",
      "--log-level",
      "NOTICE"
    ],
    remoteDir,
    {
      env: webdavEnvironment(obscuredPassword),
      timeoutMs: 60_000
    }
  );
  const finalPath = path.join(remoteDir, "bisync-upload.bin");
  const finalStat = await fs.stat(finalPath);
  const finalHash = sha256(await fs.readFile(finalPath));
  const analysis = analyzeObservedUpload(
    result.observations,
    "bisync-upload.bin",
    body.length
  );

  return {
    status:
      !analysis.partialFinalVisible &&
      finalStat.size === body.length &&
      finalHash === sha256(body)
        ? "passed"
        : "blocked",
    command: "rclone bisync --resync --resync-mode path1",
    remoteDirectorySetup: directory,
    bandwidthLimit: BISYNC_BANDWIDTH,
    observationIntervalMs: OBSERVATION_INTERVAL_MS,
    sampleCount: result.sampleCount,
    sourceSizeBytes: body.length,
    sourceSha256: sha256(body),
    finalSizeBytes: finalStat.size,
    finalSha256: finalHash,
    ...analysis
  };
}

async function probeBisyncSameSecondRewrite(obscuredPassword) {
  const sourceDir = path.join(runRoot, "mtime-collision-source");
  const remoteDir = path.join(serveRoot, "mtime-collision");
  const workdir = path.join(runRoot, "mtime-collision-workdir");
  await fs.mkdir(sourceDir, { recursive: true });
  const directory = await ensureWebdavDirectory("/mtime-collision/");
  const fixedMtime = new Date("2026-10-19T14:00:00.000Z");
  const original = Buffer.from("A".repeat(4096), "utf8");
  const rewritten = Buffer.from("B".repeat(4096), "utf8");
  const localPath = path.join(sourceDir, "collision.bin");
  const remotePath = path.join(remoteDir, "collision.bin");
  await fs.writeFile(localPath, original);
  await fs.utimes(localPath, fixedMtime, fixedMtime);

  await runRclone(
    [
      "bisync",
      sourceDir,
      ":webdav:mtime-collision",
      "--resync",
      "--resync-mode",
      "path1",
      "--workdir",
      workdir,
      "--no-cleanup",
      "--check-sync",
      "true",
      "--compare",
      "size,modtime",
      "--stats",
      "0",
      "--log-level",
      "NOTICE"
    ],
    {
      env: webdavEnvironment(obscuredPassword),
      timeoutMs: 30_000
    }
  );

  const initialRemoteHash = sha256(await fs.readFile(remotePath));
  await fs.writeFile(remotePath, rewritten);
  await fs.utimes(remotePath, fixedMtime, fixedMtime);
  const rewrittenVisible = await pollVisibleContent(
    "/mtime-collision/collision.bin",
    sha256(rewritten)
  );

  const secondRun = await runRclone(
    [
      "bisync",
      sourceDir,
      ":webdav:mtime-collision",
      "--workdir",
      workdir,
      "--no-cleanup",
      "--check-sync",
      "true",
      "--compare",
      "size,modtime",
      "--stats",
      "0",
      "--log-level",
      "NOTICE"
    ],
    {
      env: webdavEnvironment(obscuredPassword),
      timeoutMs: 30_000
    }
  );

  const localHashAfter = sha256(await fs.readFile(localPath));
  const remoteHashAfter = sha256(await fs.readFile(remotePath));
  const missedChange =
    localHashAfter === sha256(original) &&
    remoteHashAfter === sha256(rewritten);
  const detectedChange = !missedChange;

  return {
    status: missedChange ? "blocked" : "passed",
    remoteDirectorySetup: directory,
    compare: "size,modtime",
    fixedMtime: fixedMtime.toISOString(),
    sizeBytes: original.length,
    originalSha256: sha256(original),
    rewrittenSha256: sha256(rewritten),
    initialRemoteSha256: initialRemoteHash,
    rewrittenContentVisibleThroughWebdav: rewrittenVisible.visible,
    secondRunExitCode: secondRun.exitCode,
    localSha256After: localHashAfter,
    remoteSha256After: remoteHashAfter,
    detectedChange,
    missedChange,
    reason: missedChange
      ? "Ordinary bisync with size,modtime comparison did not propagate or report a same-size rewrite with the same whole-second mtime."
      : null
  };
}

async function safeRemoveRunRoot() {
  if (!runRoot) {
    return {
      removed: false,
      reason: "run root was not created"
    };
  }

  const target = path.resolve(runRoot);
  assertAbsolutePathInside(TASK_ROOT, target);
  const expectedParent = path.join(path.resolve(RUNS_ROOT));
  if (
    path.dirname(target).toLowerCase() !== expectedParent.toLowerCase()
  ) {
    throw new Error("cleanup target is not a direct child of the runs root");
  }

  const targetStat = await fs.lstat(target);
  if (targetStat.isSymbolicLink()) {
    throw new Error("cleanup target itself is a symbolic link");
  }
  const realTarget = await fs.realpath(target);
  assertAbsolutePathInside(TASK_ROOT, realTarget);

  await fs.rm(target, {
    recursive: true,
    force: false,
    maxRetries: 5,
    retryDelay: 200
  });
  const stillExists = await fs
    .lstat(target)
    .then(() => true)
    .catch(() => false);
  return {
    removed: !stillExists,
    targetWasAbsolute: path.isAbsolute(target),
    targetWasInsideTaskRoot: true,
    targetWasNotSymlink: true,
    realPathWasInsideTaskRoot: true,
    stillExists
  };
}

function calculateStatus() {
  const failedStatuses = Object.entries(evidence.probes)
    .filter(([, probe]) => probe?.status === "failed")
    .map(([name]) => name);
  const blockedStatuses = Object.entries(evidence.probes)
    .filter(([, probe]) => probe?.status === "blocked")
    .map(([name]) => name);

  if (failedStatuses.length > 0 || evidence.failures.length > 0) {
    return "failed";
  }
  if (blockedStatuses.length > 0) {
    return "blocked";
  }
  return "passed";
}

async function main() {
  await fs.mkdir(RUNS_ROOT, { recursive: true });
  runRoot = path.join(RUNS_ROOT, `${Date.now()}-${randomUUID()}`);
  serveRoot = path.join(runRoot, "served-root");
  await fs.mkdir(serveRoot, { recursive: true });
  await fs.mkdir(path.join(runRoot, "rclone-cache"), { recursive: true });
  await fs.mkdir(path.join(runRoot, "rclone-temp"), { recursive: true });
  await fs.writeFile(path.join(runRoot, "rclone.conf"), "", {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx"
  });

  await probeBinaryIntegrity();

  const rawPassword = randomBytes(32).toString("base64url");
  secrets.push(rawPassword);
  const obscuredPassword = await createObscuredPassword(rawPassword);
  authHeader = `Basic ${Buffer.from(`${USERNAME}:${rawPassword}`).toString(
    "base64"
  )}`;
  secrets.push(authHeader, authHeader.slice("Basic ".length));
  evidence.server = {
    loopbackOnly: true,
    host: LOOPBACK_HOST,
    requestedPort: 0,
    credentialDelivery: {
      server: "isolated htpasswd file containing a SHA-1 verifier",
      client: "RCLONE_WEBDAV_PASS environment variable containing an obscured value",
      rawCredentialPersisted: false,
      rawCredentialPresentInArgv: false
    },
    configuration: { ...SERVER_ARGS },
    obscuredPasswordForProcessOnly: obscuredPassword
  };

  const htpasswdPath = path.join(runRoot, "webdav.htpasswd");
  await writeHtpasswd(htpasswdPath, rawPassword);
  const server = startServer(htpasswdPath);
  serverChild = server.child;
  const address = await waitForServerAddress(server);
  serverBaseUrl = `http://${LOOPBACK_HOST}:${address.port}/`;
  evidence.server.actualPort = address.port;
  evidence.server.startupMs = address.startupMs;
  evidence.server.started = true;

  const orderedProbes = [
    ["externalVisibility", probeExternalVisibility],
    ["mtime", () => probeMtime(obscuredPassword)],
    ["webdavFeatures", () => probeWebdavFeatures(obscuredPassword)],
    ["concurrentRanges", probeConcurrentRanges],
    ["rcloneCrud", () => probeRcloneCrud(obscuredPassword)],
    ["unauthenticatedAccess", probeUnauthenticatedAccess],
    ["linkTraversal", probeLinkTraversal],
    ["interruptedRawPut", probeInterruptedPut],
    ["rcloneCopyUpload", () => probeRcloneCopyVisibility(obscuredPassword)],
    ["rcloneCopyExplicitAtomicFlags", () => probeRcloneCopyExplicitAtomicFlags(obscuredPassword)],
    ["controlledStagingMove", () => probeControlledStagingMove(obscuredPassword)],
    ["rcloneBisyncUpload", () => probeBisyncVisibility(obscuredPassword)],
    ["bisyncSameSecondRewrite", () => probeBisyncSameSecondRewrite(obscuredPassword)]
  ];

  for (const [name, probe] of orderedProbes) {
    try {
      setProbe(name, await probe());
    } catch (error) {
      setProbe(name, {
        status: "failed",
        error: sanitizedError(error)
      });
      addFailure(name, error);
    }
  }
}

try {
  await main();
} catch (error) {
  evidence.status = "failed";
  addFailure("harness", error);
} finally {
  const cleanupFailures = [];
  try {
    const processCleanup = await stopServer(serverChild);
    evidence.server = {
      ...(evidence.server || {}),
      processCleanup
    };
    if (
      !processCleanup.exited ||
      processCleanup.pidStillAlive
    ) {
      cleanupFailures.push("rclone serve webdav process did not exit cleanly");
    }
  } catch (error) {
    cleanupFailures.push(`process cleanup: ${sanitizedError(error)}`);
  }

  try {
    const filesystemCleanup = await safeRemoveRunRoot();
    evidence.cleanup = {
      ...(evidence.cleanup || {}),
      filesystemCleanup
    };
    if (!filesystemCleanup.removed) {
      cleanupFailures.push("isolated run root was not removed");
    }
  } catch (error) {
    cleanupFailures.push(`filesystem cleanup: ${sanitizedError(error)}`);
  }

  for (const message of cleanupFailures) {
    addFailure("cleanup", new Error(message));
  }
  evidence.cleanup = {
    ...(evidence.cleanup || {}),
    failures: cleanupFailures
  };

  if (evidence.server) {
    delete evidence.server.obscuredPasswordForProcessOnly;
  }
  evidence.finishedAt = new Date().toISOString();
  evidence.status = calculateStatus();
  evidence.conclusion = {
    p2ProbeStatus: evidence.status,
    windowsLocalEvidenceOnly: true,
    canEstablishP2Release: false,
    canEstablishP1Acceptance: false,
    canProveN1Arm64Behavior: false,
    canProvePublicNetworkRouting: false,
    canProveFinalGatewayAuthorization: false
  };

  await fs.mkdir(TASK_ROOT, { recursive: true });
  await fs.writeFile(EVIDENCE_PATH, `${JSON.stringify(evidence, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600
  });

  const summary = {
    status: evidence.status,
    evidencePath: repoRelative(EVIDENCE_PATH),
    probes: Object.fromEntries(
      Object.entries(evidence.probes).map(([name, probe]) => [
        name,
        probe?.status ?? "missing"
      ])
    ),
    failures: evidence.failures.length,
    processExited:
      evidence.server?.processCleanup?.exited === true &&
      evidence.server?.processCleanup?.pidStillAlive === false,
    runRootRemoved:
      evidence.cleanup?.filesystemCleanup?.removed === true
  };
  console.log(JSON.stringify(summary, null, 2));

  if (evidence.status !== "passed") {
    process.exitCode = 2;
  }
}
