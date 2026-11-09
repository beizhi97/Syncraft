#!/usr/bin/env node

import { spawn } from "node:child_process";
import {
  createHash,
  randomBytes,
  randomUUID
} from "node:crypto";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, "..");
const DEFAULT_RCLONE_PATH = path.join(
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
  "p2-sftp"
);
const SSH_KEYGEN_PATH = path.join(
  process.env.SystemRoot || "C:\\Windows",
  "System32",
  "OpenSSH",
  "ssh-keygen.exe"
);
const SSH_VERSION_PATH = path.join(
  path.dirname(SSH_KEYGEN_PATH),
  "ssh.exe"
);

const USERNAME = "p2probe";
const LOOPBACK_HOST = "127.0.0.1";
const SERVER_SETTINGS = Object.freeze({
  dirCacheTime: "1s",
  pollInterval: "0",
  vfsCacheMode: "off",
  logLevel: "INFO"
});
const OBSERVATION_INTERVAL_MS = 25;
const COPY_SOURCE_SIZE = 1024 * 1024;
const COPY_BANDWIDTH = "256Ki";
const BISYNC_SOURCE_SIZE = 1024 * 1024;
const BISYNC_BANDWIDTH = "256Ki";
const EXTERNAL_CACHE_WAIT_MS = 1500;
const EXTERNAL_FILE_SIZE = 64 * 1024;
const FIXED_COLLISION_MTIME = new Date("2026-10-19T14:00:00.000Z");

const evidence = {
  schemaVersion: 1,
  kind: "syncraft-p2-sftp-probe",
  status: "running",
  startedAt: new Date().toISOString(),
  finishedAt: null,
  runId: randomUUID(),
  boundaries: [
    "Windows-local loopback evidence only",
    "Does not prove N1 ARM64 behavior",
    "Does not prove public-network, proxy, or production behavior",
    "Does not establish P1 acceptance or P2 release",
    "Probe settings use a 1 second directory cache and disabled polling"
  ],
  environment: {
    platform: process.platform,
    arch: process.arch,
    osRelease: os.release(),
    nodeVersion: process.version
  },
  binary: null,
  sshKeygen: null,
  server: null,
  configuration: null,
  probes: {},
  failures: [],
  cleanup: null,
  conclusion: null
};

const secrets = [];
let options = null;
let runDir = null;
let workRoot = null;
let serveRoot = null;
let outsideRoot = null;
let configPath = null;
let serverChild = null;
let serverPort = null;
let rootEscapeLinkPath = null;
let sshRuntime = null;

function printHelp() {
  console.log(
    [
      "Usage: node scripts/probe-sftp-adapter.mjs [--rclone <path>] [--out-dir <path>]",
      "",
      "Runs isolated Windows-local loopback SFTP probes with the locked rclone binary.",
      "Default evidence: .tmp/development-2026-10-19/p2-sftp/<timestamp>/",
      "A custom --out-dir must resolve inside that p2-sftp task root."
    ].join("\n")
  );
}

function parseArguments(argv) {
  const parsed = {
    rclonePath: DEFAULT_RCLONE_PATH,
    outDir: null,
    help: false
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help" || argument === "-h") {
      parsed.help = true;
      continue;
    }
    if (argument === "--rclone" || argument === "--out-dir") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) {
        throw new Error(`${argument} requires a value`);
      }
      index += 1;
      if (argument === "--rclone") {
        parsed.rclonePath = path.resolve(value);
      } else {
        parsed.outDir = path.resolve(value);
      }
      continue;
    }
    throw new Error(`unknown argument: ${argument}`);
  }

  return parsed;
}

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

function isPathInside(rootPath, candidatePath, allowEqual = true) {
  if (!path.isAbsolute(rootPath) || !path.isAbsolute(candidatePath)) {
    return false;
  }
  const relative = path.relative(
    normalizeForComparison(rootPath),
    normalizeForComparison(candidatePath)
  );
  if (relative === "") {
    return allowEqual;
  }
  return !relative.startsWith("..") && !path.isAbsolute(relative);
}

function assertPathInside(rootPath, candidatePath, allowEqual = true) {
  if (!isPathInside(rootPath, candidatePath, allowEqual)) {
    throw new Error("path escaped the designated experiment root");
  }
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
  const code = error?.code ? `${error.code}: ` : "";
  return redact(`${code}${error instanceof Error ? error.message : String(error)}`);
}

function baseEnvironment(extra = {}) {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    const upper = key.toUpperCase();
    if (
      upper.startsWith("RCLONE_") ||
      key === "SSH_AUTH_SOCK" ||
      key === "SSH_AGENT_PID"
    ) {
      continue;
    }
    env[key] = value;
  }
  env.RCLONE_CONFIG = configPath;
  env.RCLONE_CACHE_DIR = path.join(workRoot, "rclone-cache");
  env.RCLONE_TEMP_DIR = path.join(workRoot, "rclone-temp");
  return { ...env, ...extra };
}

function runProcess(binary, args, runOptions = {}) {
  const {
    env = baseEnvironment(),
    input = null,
    timeoutMs = 30_000,
    maxOutputBytes = 100_000
  } = runOptions;

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

async function runRclone(args, runOptions = {}) {
  return runProcess(options.rclonePath, args, runOptions);
}

async function runRcloneRequired(args, runOptions = {}) {
  const result = await runRclone(args, runOptions);
  if (result.exitCode !== 0) {
    throw new Error(
      `rclone ${args[0]} exited ${result.exitCode}: ${result.stderr || result.stdout}`
    );
  }
  return result;
}

async function runRequired(binary, args, runOptions = {}) {
  const result = await runProcess(binary, args, runOptions);
  if (result.exitCode !== 0) {
    throw new Error(
      `${path.basename(binary)} exited ${result.exitCode}: ${result.stderr || result.stdout}`
    );
  }
  return result;
}

async function allocateLoopbackPort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, LOOPBACK_HOST, resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("failed to allocate a loopback TCP port");
  }
  const port = address.port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function waitForPort(port, timeoutMs = 15_000) {
  const startedAt = performance.now();
  while (performance.now() - startedAt < timeoutMs) {
    const connected = await new Promise((resolve) => {
      const socket = net.connect({ host: LOOPBACK_HOST, port });
      let settled = false;
      const finish = (value) => {
        if (settled) {
          return;
        }
        settled = true;
        socket.destroy();
        resolve(value);
      };
      socket.once("connect", () => finish(true));
      socket.once("error", () => finish(false));
      socket.setTimeout(250, () => finish(false));
    });
    if (connected) {
      return roundedMs(performance.now() - startedAt);
    }
    await delay(50);
  }
  throw new Error(`SFTP server did not listen on ${LOOPBACK_HOST}:${port}`);
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
  return {
    attempted: true,
    exited,
    forced,
    pidStillAlive: Number.isInteger(pid) ? pidAppearsAlive(pid) : false,
    exitCode: child.exitCode,
    signalCode: child.signalCode
  };
}

async function generateEd25519Key(filePath) {
  await runRequired(
    SSH_KEYGEN_PATH,
    ["-q", "-t", "ed25519", "-N", "", "-f", filePath],
    { timeoutMs: 20_000 }
  );
  const fingerprintResult = await runRequired(
    SSH_KEYGEN_PATH,
    ["-lf", `${filePath}.pub`],
    { timeoutMs: 10_000 }
  );
  return {
    privateKeyPath: filePath,
    publicKeyPath: `${filePath}.pub`,
    fingerprint: fingerprintResult.stdout.trim() || null
  };
}

function normalizeConfigPath(filePath) {
  return path.resolve(filePath).replaceAll("\\", "/");
}

async function prepareSshConfiguration() {
  const keysRoot = path.join(workRoot, "keys");
  await fs.mkdir(keysRoot, { recursive: true });
  const hostKey = await generateEd25519Key(path.join(keysRoot, "host_ed25519"));
  const clientKey = await generateEd25519Key(path.join(keysRoot, "client_ed25519"));

  const authorizedKeysPath = path.join(keysRoot, "authorized_keys");
  const clientPublicKey = (await fs.readFile(clientKey.publicKeyPath, "utf8")).trim();
  await fs.writeFile(authorizedKeysPath, `${clientPublicKey}\n`, {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx"
  });

  const hostPublicKey = (await fs.readFile(hostKey.publicKeyPath, "utf8")).trim();
  const hostPublicFields = hostPublicKey.split(/\s+/).slice(0, 2).join(" ");
  const knownHostsPath = path.join(keysRoot, "known_hosts");
  await fs.writeFile(
    knownHostsPath,
    `[${LOOPBACK_HOST}]:${serverPort} ${hostPublicFields}\n`,
    { encoding: "utf8", mode: 0o600, flag: "wx" }
  );

  configPath = path.join(workRoot, "rclone.conf");
  const config = [
    "[probe]",
    "type = sftp",
    `host = ${LOOPBACK_HOST}`,
    `port = ${serverPort}`,
    `user = ${USERNAME}`,
    `key_file = ${normalizeConfigPath(clientKey.privateKeyPath)}`,
    `known_hosts_file = ${normalizeConfigPath(knownHostsPath)}`,
    "shell_type = unix",
    "md5sum_command = md5sum",
    "sha1sum_command = sha1sum",
    ""
  ].join("\r\n");
  await fs.writeFile(configPath, config, {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx"
  });

  return {
    hostKey,
    clientKey,
    authorizedKeysPath,
    knownHostsPath,
    knownHostsValidation: true,
    authentication: "public key via isolated authorized_keys file",
    privateKeyMaterialPersistedInReport: false,
    privateKeyMaterialPassedInArgv: false
  };
}

function startServer(
  authorizedKeysPath,
  hostPrivateKeyPath,
  settings = SERVER_SETTINGS
) {
  const args = [
    "serve",
    "sftp",
    `:local:${serveRoot}`,
    "--addr",
    `${LOOPBACK_HOST}:${serverPort}`,
    "--user",
    USERNAME,
    "--authorized-keys",
    authorizedKeysPath,
    "--key",
    hostPrivateKeyPath,
    "--dir-cache-time",
    settings.dirCacheTime,
    "--poll-interval",
    settings.pollInterval,
    "--vfs-cache-mode",
    settings.vfsCacheMode,
    "--log-level",
    settings.logLevel
  ];
  const child = spawn(options.rclonePath, args, {
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
  return { child, getOutput: () => redact(output) };
}

async function restartServerWithSettings(settings) {
  if (!sshRuntime) {
    throw new Error("SSH runtime configuration is unavailable for restart");
  }
  const previousServerCleanup = await stopServer(serverChild);
  if (!previousServerCleanup.exited || previousServerCleanup.pidStillAlive) {
    throw new Error("previous SFTP server did not exit before restart");
  }
  const server = startServer(
    sshRuntime.authorizedKeysPath,
    sshRuntime.hostKey.privateKeyPath,
    settings
  );
  serverChild = server.child;
  const startupMs = await waitForPort(serverPort);
  if (serverChild.exitCode !== null) {
    throw new Error(
      `rclone serve sftp exited during cache diagnostic restart: ${server.getOutput()}`
    );
  }
  return {
    previousServerCleanup,
    startupMs,
    settings: { ...settings }
  };
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

function parseJsonOutput(result, label) {
  try {
    return JSON.parse(result.stdout);
  } catch (error) {
    throw new Error(`${label} returned invalid JSON: ${sanitizedError(error)}`);
  }
}

function firstHexHash(value, expectedLength) {
  const expression = new RegExp(`\\b[0-9a-fA-F]{${expectedLength}}\\b`);
  return value.match(expression)?.[0]?.toLowerCase() ?? null;
}

async function probeBinaryAndToolchain() {
  const lock = JSON.parse(await fs.readFile(LOCK_PATH, "utf8"));
  const expected = lock.tools?.rclone?.sha256;
  const stat = await fs.stat(options.rclonePath);
  const actualSha256 = await sha256File(options.rclonePath);
  const versionResult = await runRcloneRequired(["version"], { timeoutMs: 10_000 });
  const versionLines = versionResult.stdout.trim().split(/\r?\n/);
  const version = versionLines[0]?.trim() || null;
  const goVersion = versionLines.find((line) => line.startsWith("go:")) ?? null;
  const keygenVersionResult = await runProcess(
    SSH_VERSION_PATH,
    ["-V"],
    { timeoutMs: 10_000 }
  );

  evidence.binary = {
    path: repoRelative(options.rclonePath),
    lockPath: repoRelative(LOCK_PATH),
    expectedVersion: lock.tools?.rclone?.version ?? null,
    expectedTag: lock.tools?.rclone?.tag ?? null,
    expectedSha256: expected,
    actualSha256,
    sizeBytes: stat.size,
    version,
    goVersion,
    hashMatchesLockedBinary: actualSha256 === expected,
    versionMatchesLock: version === `rclone v${lock.tools?.rclone?.version}`
  };
  evidence.sshKeygen = {
    path: SSH_KEYGEN_PATH,
    versionCommandPath: SSH_VERSION_PATH,
    versionExitCode: keygenVersionResult.exitCode,
    versionOutput:
      (keygenVersionResult.stdout || keygenVersionResult.stderr).trim() || null
  };

  if (!evidence.binary.hashMatchesLockedBinary) {
    throw new Error("rclone binary SHA-256 does not match binaries.lock.json");
  }
  if (!evidence.binary.versionMatchesLock) {
    throw new Error("rclone binary version does not match binaries.lock.json");
  }
}

async function probeBackendDeclarations() {
  const backendHelp = await runRcloneRequired(
    ["help", "backend", "sftp"],
    { timeoutMs: 20_000 }
  );
  const serverHelp = await runRcloneRequired(
    ["serve", "sftp", "--help"],
    { timeoutMs: 20_000 }
  );
  const lines = backendHelp.stdout.split(/\r?\n/);
  const serverLines = serverHelp.stdout.split(/\r?\n/);
  const findContext = (needle, sourceLines, contextLines = 7) => {
    const index = sourceLines.findIndex((line) => line.includes(needle));
    if (index < 0) {
      return null;
    }
    return sourceLines.slice(index, index + contextLines).join("\n").trim();
  };

  const socksProxyContext = findContext("--sftp-socks-proxy", lines);
  const httpProxyContext = findContext("--sftp-http-proxy", lines);
  const md5ServerSupport = serverLines
    .slice(0, 18)
    .join("\n")
    .includes("md5sum");
  const sha1ServerSupport = serverLines
    .slice(0, 18)
    .join("\n")
    .includes("sha1sum");
  const symlinkDefault = serverLines
    .join("\n")
    .includes("By default the VFS does not support symlinks");

  return {
    status:
      socksProxyContext && httpProxyContext ? "declared" : "unavailable",
    backendHelpSha256: sha256(Buffer.from(backendHelp.stdout, "utf8")),
    serverHelpSha256: sha256(Buffer.from(serverHelp.stdout, "utf8")),
    socksProxy: {
      declared: Boolean(socksProxyContext),
      configKey: socksProxyContext?.includes("Config:      socks_proxy") ?? false,
      context: socksProxyContext
    },
    httpProxy: {
      declared: Boolean(httpProxyContext),
      configKey: httpProxyContext?.includes("Config:      http_proxy") ?? false,
      context: httpProxyContext
    },
    serverShellHashes: {
      md5sumMentioned: md5ServerSupport,
      sha1sumMentioned: sha1ServerSupport
    },
    defaultChunkSizeDeclared: backendHelp.stdout.includes(
      "Config:      chunk_size"
    ) && backendHelp.stdout.includes("Default:     32Ki"),
    symlinksUnsupportedByDefaultDeclared: symlinkDefault,
    endToEndProxyRoutingTested: false,
    endToEndProxyAuthenticationTested: false,
    limitation:
      "This probe confirms locked-binary option declarations only; it does not start a SOCKS or HTTP proxy or prove proxy authentication or routing."
  };
}

async function probeSftpFeatures() {
  const featuresResult = await runRcloneRequired(
    ["backend", "features", "probe:"],
    { timeoutMs: 20_000 }
  );
  const features = parseJsonOutput(featuresResult, "rclone backend features probe:");
  const featureHashes =
    features.Hashes ?? features.hashes ?? features.Features?.Hashes ?? null;

  const sourceDir = path.join(workRoot, "hash-source");
  const body = randomBytes(64 * 1024);
  const sourcePath = path.join(sourceDir, "feature-hash.bin");
  await fs.mkdir(sourceDir, { recursive: true });
  await fs.writeFile(sourcePath, body);
  await runRcloneRequired(
    [
      "copyto",
      sourcePath,
      "probe:hash-feature/feature-hash.bin",
      "--stats",
      "0",
      "--log-level",
      "NOTICE"
    ],
    { timeoutMs: 30_000 }
  );

  const md5Result = await runRclone(
    ["md5sum", "probe:hash-feature/feature-hash.bin"],
    { timeoutMs: 20_000 }
  );
  const sha1Result = await runRclone(
    ["sha1sum", "probe:hash-feature/feature-hash.bin"],
    { timeoutMs: 20_000 }
  );
  const expectedMd5 = createHash("md5").update(body).digest("hex");
  const expectedSha1 = createHash("sha1").update(body).digest("hex");
  const actualMd5 =
    md5Result.exitCode === 0
      ? firstHexHash(md5Result.stdout, 32)
      : null;
  const actualSha1 =
    sha1Result.exitCode === 0
      ? firstHexHash(sha1Result.stdout, 40)
      : null;
  const md5Matches = actualMd5 === expectedMd5;
  const sha1Matches = actualSha1 === expectedSha1;

  return {
    status: md5Matches && sha1Matches ? "passed" : "blocked",
    features,
    featureHashes,
    fixture: {
      sizeBytes: body.length,
      sha256: sha256(body)
    },
    md5: {
      exitCode: md5Result.exitCode,
      expected: expectedMd5,
      actual: actualMd5,
      matches: md5Matches,
      stderr: md5Result.stderr.trim() || null
    },
    sha1: {
      exitCode: sha1Result.exitCode,
      expected: expectedSha1,
      actual: actualSha1,
      matches: sha1Matches,
      stderr: sha1Result.stderr.trim() || null
    }
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

async function runRcloneObserved(args, observationRoot, runOptions = {}) {
  const {
    env = baseEnvironment(),
    timeoutMs = 45_000
  } = runOptions;
  const child = spawn(options.rclonePath, args, {
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
        observations.push({ snapshot });
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

function analyzeObservedUpload(observations, remoteRelativePath, finalSize) {
  let partialFinalVisible = false;
  let temporaryVisible = false;
  let completeFinalVisible = false;
  let observedFinalMaxSize = null;
  let firstPartialFinalSize = null;
  let lastPartialFinalSize = null;
  const partialFinalSizes = [];
  const temporaryNames = new Set();
  const basename = path.posix.basename(remoteRelativePath);

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
      } else if (entry.path.includes(basename)) {
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

async function probeCopyUploadVisibility() {
  const sourceDir = path.join(workRoot, "copy-source");
  const remoteDir = path.join(serveRoot, "copy-upload");
  await fs.mkdir(sourceDir, { recursive: true });
  await fs.mkdir(remoteDir, { recursive: true });
  const body = randomBytes(COPY_SOURCE_SIZE);
  await fs.writeFile(path.join(sourceDir, "copy-upload.bin"), body);

  const result = await runRcloneObserved(
    [
      "copy",
      sourceDir,
      "probe:copy-upload",
      "--bwlimit",
      COPY_BANDWIDTH,
      "--stats",
      "0",
      "--log-level",
      "NOTICE"
    ],
    remoteDir,
    { timeoutMs: 45_000 }
  );
  const finalPath = path.join(remoteDir, "copy-upload.bin");
  const finalStat = await fs.stat(finalPath);
  const finalHash = await sha256File(finalPath);
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

async function probeBisyncUploadVisibility() {
  const sourceDir = path.join(workRoot, "bisync-upload-source");
  const remoteDir = path.join(serveRoot, "bisync-upload");
  const bisyncWorkdir = path.join(workRoot, "bisync-upload-workdir");
  await fs.mkdir(sourceDir, { recursive: true });
  await runRcloneRequired(
    ["mkdir", "probe:bisync-upload", "--stats", "0", "--log-level", "NOTICE"],
    { timeoutMs: 20_000 }
  );
  await runRcloneRequired(
    ["lsjson", "probe:bisync-upload", "--no-mimetype"],
    { timeoutMs: 20_000 }
  );
  const body = randomBytes(BISYNC_SOURCE_SIZE);
  await fs.writeFile(path.join(sourceDir, "bisync-upload.bin"), body);

  const result = await runRcloneObserved(
    [
      "bisync",
      sourceDir,
      "probe:bisync-upload",
      "--resync",
      "--resync-mode",
      "path1",
      "--workdir",
      bisyncWorkdir,
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
    { timeoutMs: 60_000 }
  );
  const finalPath = path.join(remoteDir, "bisync-upload.bin");
  const finalStat = await fs.stat(finalPath);
  const finalHash = await sha256File(finalPath);
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

async function setFixedMtime(filePath, date) {
  await fs.utimes(filePath, date, date);
}

function combinedReportHasDifference(report) {
  return report
    .split(/\r?\n/)
    .some((line) => line.startsWith("* ") || line === "*");
}

async function probeSameSizeChecksum() {
  const sourceDir = path.join(workRoot, "checksum-source");
  const remoteDir = path.join(serveRoot, "checksum-remote");
  const localResultPath = path.join(workRoot, "checksum-readback.bin");
  const combinedPath = path.join(workRoot, "checksum-combined.txt");
  await fs.mkdir(sourceDir, { recursive: true });
  await fs.mkdir(remoteDir, { recursive: true });
  const original = Buffer.from("A".repeat(4096), "utf8");
  const rewritten = Buffer.from("B".repeat(4096), "utf8");
  const sourcePath = path.join(sourceDir, "collision.bin");
  const remotePath = path.join(remoteDir, "collision.bin");
  await fs.writeFile(sourcePath, original);
  await setFixedMtime(sourcePath, FIXED_COLLISION_MTIME);
  await runRcloneRequired(
    [
      "copyto",
      sourcePath,
      "probe:checksum-remote/collision.bin",
      "--stats",
      "0",
      "--log-level",
      "NOTICE"
    ],
    { timeoutMs: 30_000 }
  );
  await fs.writeFile(remotePath, rewritten);
  await setFixedMtime(remotePath, FIXED_COLLISION_MTIME);
  const sourceStat = await fs.stat(sourcePath);
  const remoteStat = await fs.stat(remotePath);

  const exactCheck = await runRclone(
    [
      "check",
      sourceDir,
      "probe:checksum-remote",
      "--checksum",
      "--combined",
      combinedPath,
      "--checkers",
      "1",
      "--stats",
      "0",
      "--log-level",
      "NOTICE"
    ],
    { timeoutMs: 30_000 }
  );
  const checksumFlagRejected =
    exactCheck.exitCode !== 0 &&
    /unknown flag:\s*--checksum|flag provided but not defined/i.test(
      exactCheck.stderr
    );
  let checkResult = exactCheck;
  let checkMode = "check --checksum";
  if (checksumFlagRejected) {
    checkResult = await runRclone(
      [
        "check",
        sourceDir,
        "probe:checksum-remote",
        "--combined",
        combinedPath,
        "--checkers",
        "1",
        "--stats",
        "0",
        "--log-level",
        "NOTICE"
      ],
      { timeoutMs: 30_000 }
    );
    checkMode = "check (default hash comparison)";
  }
  const combinedReport = await fs
    .readFile(combinedPath, "utf8")
    .catch(() => "");
  const detectedDifference =
    checkResult.exitCode === 1 &&
    (combinedReportHasDifference(combinedReport) ||
      /differ|mismatch|different/i.test(`${checkResult.stdout}\n${checkResult.stderr}`));

  const copyResult = await runRcloneRequired(
    [
      "copy",
      sourceDir,
      "probe:checksum-remote",
      "--checksum",
      "--checkers",
      "1",
      "--transfers",
      "1",
      "--stats",
      "0",
      "--log-level",
      "NOTICE"
    ],
    { timeoutMs: 30_000 }
  );
  const remoteHashAfter = await sha256File(remotePath);
  const repaired = remoteHashAfter === sha256(original);
  await runRcloneRequired(
    [
      "copyto",
      "probe:checksum-remote/collision.bin",
      localResultPath,
      "--stats",
      "0",
      "--log-level",
      "NOTICE"
    ],
    { timeoutMs: 20_000 }
  );
  const readbackHash = await sha256File(localResultPath);

  return {
    status: detectedDifference && repaired && readbackHash === sha256(original)
      ? "passed"
      : "blocked",
    sourceSizeBytes: original.length,
    remoteMutatedSizeBytes: rewritten.length,
    fixedMtime: FIXED_COLLISION_MTIME.toISOString(),
    sourceMtimeMs: sourceStat.mtimeMs,
    remoteMtimeMs: remoteStat.mtimeMs,
    sameSize: sourceStat.size === remoteStat.size,
    sameMtime: sourceStat.mtimeMs === remoteStat.mtimeMs,
    requestedCheckMode: "check --checksum",
    checksumFlagAccepted: !checksumFlagRejected,
    actualCheckMode: checkMode,
    exactCheckExitCode: exactCheck.exitCode,
    exactCheckStderr: exactCheck.stderr.trim() || null,
    checkExitCode: checkResult.exitCode,
    checkStdout: checkResult.stdout.trim() || null,
    checkStderr: checkResult.stderr.trim() || null,
    combinedReport: combinedReport.trim() || null,
    detectedDifference,
    copyExitCode: copyResult.exitCode,
    originalSha256: sha256(original),
    rewrittenSha256: sha256(rewritten),
    remoteSha256AfterCopy: remoteHashAfter,
    readbackSha256: readbackHash,
    repaired,
    reason: detectedDifference && repaired
      ? null
      : "The checksum check did not flag the same-size, same-mtime mutation or copy --checksum did not repair it."
  };
}

async function runBisyncCollisionScenario(name, compareMode) {
  const sourceDir = path.join(workRoot, `${name}-source`);
  const remoteDir = path.join(serveRoot, name);
  const bisyncWorkdir = path.join(workRoot, `${name}-workdir`);
  await fs.mkdir(sourceDir, { recursive: true });
  await runRcloneRequired(
    ["mkdir", `probe:${name}`, "--stats", "0", "--log-level", "NOTICE"],
    { timeoutMs: 20_000 }
  );
  await runRcloneRequired(
    ["lsjson", `probe:${name}`, "--no-mimetype"],
    { timeoutMs: 20_000 }
  );
  const original = Buffer.from("A".repeat(4096), "utf8");
  const rewritten = Buffer.from("B".repeat(4096), "utf8");
  const originalSha256 = sha256(original);
  const rewrittenSha256 = sha256(rewritten);
  const localPath = path.join(sourceDir, "collision.bin");
  const remotePath = path.join(remoteDir, "collision.bin");
  const canaryFixtures = [
    { name: "canary-a.txt", body: Buffer.from("canary-a-stays-unchanged\n", "utf8") },
    { name: "canary-b.txt", body: Buffer.from("canary-b-stays-unchanged\n", "utf8") }
  ];
  await fs.writeFile(localPath, original);
  await setFixedMtime(localPath, FIXED_COLLISION_MTIME);
  for (const fixture of canaryFixtures) {
    const canaryPath = path.join(sourceDir, fixture.name);
    await fs.writeFile(canaryPath, fixture.body);
    await setFixedMtime(canaryPath, FIXED_COLLISION_MTIME);
  }

  const explicitChecksum = compareMode.split(",").includes("checksum");
  const comparisonArgs = ["--compare", compareMode];
  if (explicitChecksum) {
    comparisonArgs.push("--checksum");
  }

  const initial = await runRcloneRequired(
    [
      "bisync",
      sourceDir,
      `probe:${name}`,
      "--resync",
      "--resync-mode",
      "path1",
      "--workdir",
      bisyncWorkdir,
      "--no-cleanup",
      "--check-sync",
      "true",
      ...comparisonArgs,
      "--stats",
      "0",
      "--log-level",
      "NOTICE"
    ],
    { timeoutMs: 40_000 }
  );
  const initialRemoteSha256 = await sha256File(remotePath);
  const canariesInitial = [];
  for (const fixture of canaryFixtures) {
    const localCanaryHash = await sha256File(path.join(sourceDir, fixture.name));
    const remoteCanaryHash = await sha256File(path.join(remoteDir, fixture.name));
    canariesInitial.push({
      name: fixture.name,
      expectedSha256: sha256(fixture.body),
      localSha256: localCanaryHash,
      remoteSha256: remoteCanaryHash,
      bothSidesOriginal:
        localCanaryHash === sha256(fixture.body) &&
        remoteCanaryHash === sha256(fixture.body)
    });
  }
  if (canariesInitial.some((entry) => !entry.bothSidesOriginal)) {
    throw new Error("canary fixture was not identical on both sides after initialization");
  }

  await fs.writeFile(remotePath, rewritten);
  await setFixedMtime(remotePath, FIXED_COLLISION_MTIME);

  const second = await runRclone(
    [
      "bisync",
      sourceDir,
      `probe:${name}`,
      "--workdir",
      bisyncWorkdir,
      "--no-cleanup",
      "--check-sync",
      "true",
      ...comparisonArgs,
      "--stats",
      "0",
      "--log-level",
      "NOTICE"
    ],
    { timeoutMs: 40_000 }
  );
  const localHashAfter = await sha256File(localPath);
  const remoteHashAfter = await sha256File(remotePath);
  const convergedToRewritten =
    localHashAfter === rewrittenSha256 && remoteHashAfter === rewrittenSha256;
  const localRemainedOriginal = localHashAfter === originalSha256;
  const remoteRemainedRewritten = remoteHashAfter === rewrittenSha256;
  const canariesAfter = [];
  for (const fixture of canaryFixtures) {
    const expectedSha256 = sha256(fixture.body);
    const localCanaryHash = await sha256File(path.join(sourceDir, fixture.name));
    const remoteCanaryHash = await sha256File(path.join(remoteDir, fixture.name));
    canariesAfter.push({
      name: fixture.name,
      expectedSha256,
      localSha256: localCanaryHash,
      remoteSha256: remoteCanaryHash,
      localUnchanged: localCanaryHash === expectedSha256,
      remoteUnchanged: remoteCanaryHash === expectedSha256
    });
  }
  const canariesRemainUnchanged = canariesAfter.every(
    (entry) => entry.localUnchanged && entry.remoteUnchanged
  );

  return {
    status:
      second.exitCode === 0 && convergedToRewritten && canariesRemainUnchanged
        ? "passed"
        : "blocked",
    compareMode,
    explicitChecksum,
    fixedMtime: FIXED_COLLISION_MTIME.toISOString(),
    sizeBytes: original.length,
    originalSha256,
    rewrittenSha256,
    initialExitCode: initial.exitCode,
    initialRemoteSha256,
    canariesInitial,
    canariesAfter,
    canariesRemainUnchanged,
    onlyCollisionChangedRemotely: canariesRemainUnchanged,
    secondExitCode: second.exitCode,
    secondStdout: second.stdout.trim().slice(-4000) || null,
    secondStderr: second.stderr.trim().slice(-4000) || null,
    localSha256After: localHashAfter,
    remoteSha256After: remoteHashAfter,
    convergedToRewritten,
    localRemainedOriginal,
    remoteRemainedRewritten,
    expectedOutcome:
      "Only collision.bin changes on the remote. It propagates to the local side, both sides end on rewritten content, and both canaries remain unchanged."
  };
}
async function probeBisyncSameSizeCollision() {
  const defaultScenario = await runBisyncCollisionScenario(
    "bisync-collision-default",
    "size,modtime"
  );
  const checksumScenario = await runBisyncCollisionScenario(
    "bisync-collision-checksum",
    "size,modtime,checksum"
  );
  return {
    status:
      checksumScenario.status === "passed" &&
      defaultScenario.status === "passed"
        ? "passed"
        : "blocked",
    defaultComparison: defaultScenario,
    checksumComparison: checksumScenario,
    interpretation:
      "Default bisync comparison and explicit checksum comparison are isolated scenarios with the same fixed size and whole-second mtime."
  };
}

async function listRemoteNames(remotePath) {
  const result = await runRclone(
    ["lsjson", remotePath, "--no-mimetype"],
    { timeoutMs: 20_000 }
  );
  if (result.exitCode !== 0) {
    return {
      exitCode: result.exitCode,
      names: [],
      error: (result.stderr || result.stdout).trim() || null
    };
  }
  const entries = JSON.parse(result.stdout);
  return {
    exitCode: 0,
    names: entries.map((entry) => entry.Name),
    error: null
  };
}

async function readRemoteHash(remotePath, localPath) {
  await fs.rm(localPath, { force: true });
  const result = await runRclone(
    [
      "copyto",
      remotePath,
      localPath,
      "--stats",
      "0",
      "--log-level",
      "NOTICE"
    ],
    { timeoutMs: 20_000 }
  );
  if (result.exitCode !== 0) {
    return {
      exitCode: result.exitCode,
      hash: null,
      error: (result.stderr || result.stdout).trim() || null
    };
  }
  const body = await fs.readFile(localPath);
  const utf8 = body.toString("utf8");
  return {
    exitCode: 0,
    hash: sha256(body),
    byteLength: body.length,
    contentUtf8: utf8.includes("\uFFFD") ? null : utf8,
    error: null
  };
}

async function probeExternalVisibility() {
  const externalDir = path.join(serveRoot, "external");
  const initial = randomBytes(EXTERNAL_FILE_SIZE);
  const rewritten = Buffer.from(initial);
  for (let index = 0; index < rewritten.length; index += 1) {
    rewritten[index] ^= 0xa5;
  }
  const externalPath = path.join(externalDir, "visibility.bin");
  const readPath = path.join(workRoot, "external-readback.bin");
  await fs.mkdir(externalDir, { recursive: true });
  const prime = await listRemoteNames("probe:external");
  await fs.writeFile(externalPath, initial);
  const immediate = await listRemoteNames("probe:external");
  await delay(EXTERNAL_CACHE_WAIT_MS);
  const afterExpiry = await listRemoteNames("probe:external");
  const initialRead = await readRemoteHash(
    "probe:external/visibility.bin",
    readPath
  );
  await fs.writeFile(externalPath, rewritten);
  const rewrittenRead = await readRemoteHash(
    "probe:external/visibility.bin",
    readPath
  );

  const initialSha256 = sha256(initial);
  const rewrittenSha256 = sha256(rewritten);
  const initialReadMatched = initialRead.hash === initialSha256;
  const defaultCacheReadMatched = rewrittenRead.hash === rewrittenSha256;

  const noDirCacheSettings = {
    ...SERVER_SETTINGS,
    dirCacheTime: "0"
  };
  const cacheDiagnostic = await restartServerWithSettings(noDirCacheSettings);
  evidence.server = {
    ...(evidence.server || {}),
    currentSettings: { ...noDirCacheSettings },
    cacheDiagnosticRestart: cacheDiagnostic
  };

  const cacheZeroDir = path.join(serveRoot, "external-cache-zero");
  const cacheZeroPath = path.join(cacheZeroDir, "visibility.txt");
  const cacheZeroPrimeReadPath = path.join(workRoot, "external-cache-zero-a.txt");
  const cacheZeroAfterReadPath = path.join(workRoot, "external-cache-zero-b.txt");
  const cacheZeroA = Buffer.from("A".repeat(EXTERNAL_FILE_SIZE), "utf8");
  const cacheZeroB = Buffer.from("B".repeat(EXTERNAL_FILE_SIZE), "utf8");
  const cacheZeroASha256 = sha256(cacheZeroA);
  const cacheZeroBSha256 = sha256(cacheZeroB);
  await fs.mkdir(cacheZeroDir, { recursive: true });
  await fs.writeFile(cacheZeroPath, cacheZeroA);
  const cacheZeroPrimeRead = await readRemoteHash(
    "probe:external-cache-zero/visibility.txt",
    cacheZeroPrimeReadPath
  );
  await fs.writeFile(cacheZeroPath, cacheZeroB);
  const cacheZeroAfterOverwriteRead = await readRemoteHash(
    "probe:external-cache-zero/visibility.txt",
    cacheZeroAfterReadPath
  );
  const cacheZeroPrimeMatched =
    cacheZeroPrimeRead.hash === cacheZeroASha256 &&
    cacheZeroPrimeRead.contentUtf8 === cacheZeroA.toString("utf8");
  const cacheZeroAfterOverwriteMatched =
    cacheZeroAfterOverwriteRead.hash === cacheZeroBSha256 &&
    cacheZeroAfterOverwriteRead.contentUtf8 === cacheZeroB.toString("utf8");
  const cacheZeroExperimentPassed =
    cacheZeroPrimeMatched && cacheZeroAfterOverwriteMatched;
  const afterVisible = afterExpiry.names.includes("visibility.bin");

  return {
    status:
      afterVisible && initialReadMatched && cacheZeroExperimentPassed
        ? "passed"
        : "blocked",
    configuration: {
      initialDirCacheTime: SERVER_SETTINGS.dirCacheTime,
      pollInterval: SERVER_SETTINGS.pollInterval,
      waitAfterCreateMs: EXTERNAL_CACHE_WAIT_MS,
      diagnosticDirCacheTime: cacheDiagnostic.settings.dirCacheTime
    },
    sizeBytes: initial.length,
    initialSha256,
    rewrittenSha256,
    prime,
    immediate,
    afterCacheExpiry: afterExpiry,
    immediatelyVisible: immediate.names.includes("visibility.bin"),
    afterCacheExpiryVisible: afterVisible,
    initialRead,
    rewrittenRead,
    initialReadMatched,
    rewrittenReadMatchedWithDefaultCache: defaultCacheReadMatched,
    initialCacheRewriteReadFailed: !defaultCacheReadMatched,
    cacheZeroIndependentExperiment: {
      serverStartedWithDirCacheTimeZero: true,
      restartedBetweenPrimeReadAndOverwrite: false,
      primeRead: cacheZeroPrimeRead,
      afterOverwriteRead: cacheZeroAfterOverwriteRead,
      expectedPrimeContent: cacheZeroA.toString("utf8"),
      expectedOverwriteContent: cacheZeroB.toString("utf8"),
      expectedPrimeSha256: cacheZeroASha256,
      expectedOverwriteSha256: cacheZeroBSha256,
      primeMatched: cacheZeroPrimeMatched,
      afterOverwriteMatched: cacheZeroAfterOverwriteMatched,
      passed: cacheZeroExperimentPassed
    },
    cacheDiagnostic,
    interpretation:
      "The cache-zero result comes from a new server that used dir-cache-time=0 from startup. It did not restart between the prime read and the same-size overwrite, and remains server-specific evidence rather than a general SFTP guarantee."
  };
}
async function probeRootEscapeRejection() {
  const marker = Buffer.from("outside-root-marker\n", "utf8");
  const markerPath = path.join(outsideRoot, "escape-marker.txt");
  rootEscapeLinkPath = path.join(serveRoot, "escape-link");
  await fs.mkdir(outsideRoot, { recursive: true });
  await fs.writeFile(markerPath, marker);

  try {
    await fs.symlink(
      outsideRoot,
      rootEscapeLinkPath,
      process.platform === "win32" ? "junction" : "dir"
    );
  } catch (error) {
    return {
      status: "unavailable",
      linkType: process.platform === "win32" ? "junction" : "directory-symlink",
      linkCreationSucceeded: false,
      linkCreationErrorCode: error?.code ?? null,
      linkCreationError: sanitizedError(error),
      remoteListing: null,
      remoteRead: null,
      outsideMarkerAccessibleRemotely: null,
      limitation:
        "Windows denied local link creation, so the SFTP root escape rejection path could not be exercised."
    };
  }

  const localJunctionRead = await fs
    .readFile(path.join(rootEscapeLinkPath, "escape-marker.txt"))
    .then((value) => sha256(value) === sha256(marker))
    .catch(() => false);
  const listing = await listRemoteNames("probe:escape-link");
  const readPath = path.join(workRoot, "escape-readback.txt");
  const read = await readRemoteHash(
    "probe:escape-link/escape-marker.txt",
    readPath
  );
  const listedMarker = listing.names.includes("escape-marker.txt");
  const readMarker = read.hash === sha256(marker);
  const accessible = listedMarker || readMarker;

  return {
    status: accessible ? "failed" : "passed",
    linkType: process.platform === "win32" ? "junction" : "directory-symlink",
    linkCreationSucceeded: true,
    linkTargetInsideServedRoot: false,
    localJunctionReadSucceeded: localJunctionRead,
    remoteListing: listing,
    remoteRead: read,
    markerListedRemotely: listedMarker,
    markerReadRemotely: readMarker,
    outsideMarkerAccessibleRemotely: accessible,
    limitation:
      "This checks the rclone serve sftp default VFS link behavior on Windows. It does not test a separately configured production SFTP server."
  };
}

function calculateStatus() {
  const statuses = Object.entries(evidence.probes)
    .filter(([, probe]) => probe && typeof probe.status === "string")
    .map(([name, probe]) => [name, probe.status]);
  const failed = statuses.filter(([, status]) => status === "failed");
  const blocked = statuses.filter(([, status]) => status === "blocked");
  const unavailable = statuses.filter(([, status]) => status === "unavailable");

  if (evidence.failures.length > 0 || failed.length > 0) {
    return "failed";
  }
  if (blocked.length > 0) {
    return "blocked";
  }
  if (unavailable.length > 0) {
    return "passed-with-limits";
  }
  return "passed";
}

async function removeRootEscapeLink() {
  if (!rootEscapeLinkPath) {
    return { attempted: false, removed: true };
  }
  const stat = await fs.lstat(rootEscapeLinkPath).catch(() => null);
  if (!stat) {
    return { attempted: false, removed: true };
  }
  if (!stat.isSymbolicLink()) {
    throw new Error("root escape path is not a symbolic link or junction");
  }
  await fs.unlink(rootEscapeLinkPath).catch(async () => {
    await fs.rmdir(rootEscapeLinkPath);
  });
  const stillExists = await fs
    .lstat(rootEscapeLinkPath)
    .then(() => true)
    .catch(() => false);
  return { attempted: true, removed: !stillExists };
}

async function safeRemoveWorkRoot() {
  if (!workRoot) {
    return { removed: false, reason: "work root was not created" };
  }
  const resolvedWorkRoot = path.resolve(workRoot);
  const resolvedRunDir = path.resolve(runDir);
  assertPathInside(resolvedRunDir, resolvedWorkRoot, false);
  if (
    path.dirname(normalizeForComparison(resolvedWorkRoot)) !==
    normalizeForComparison(resolvedRunDir)
  ) {
    throw new Error("work root is not a direct child of the evidence directory");
  }
  const stat = await fs.lstat(resolvedWorkRoot);
  if (stat.isSymbolicLink()) {
    throw new Error("work root itself is a symbolic link");
  }
  await fs.rm(resolvedWorkRoot, {
    recursive: true,
    force: false,
    maxRetries: 5,
    retryDelay: 200
  });
  const stillExists = await fs
    .lstat(resolvedWorkRoot)
    .then(() => true)
    .catch(() => false);
  return {
    removed: !stillExists,
    targetWasAbsolute: true,
    targetWasInsideEvidenceRoot: true,
    targetWasNotSymlink: true,
    stillExists
  };
}

function reportReadme(evidenceValue) {
  const probes = evidenceValue.probes;
  const rows = Object.entries(probes)
    .map(([name, probe]) => `| ${name} | ${probe?.status ?? "missing"} |`)
    .join("\n");
  const copyProbe = probes.copyUploadVisibility;
  const bisyncUploadProbe = probes.bisyncUploadVisibility;
  const checksumProbe = probes.sameSizeChecksum;
  const bisyncCollisionProbe = probes.bisyncSameSizeCollision;
  const externalProbe = probes.externalVisibility;
  const rootEscapeProbe = probes.rootEscapeRejection;
  const proxyProbe = probes.backendDeclarations;

  return [
    "# Syncraft P2 SFTP adapter probe",
    "",
    `- Run ID: \`${evidenceValue.runId}\``,
    `- Status: **${evidenceValue.status}**`,
    `- Started: ${evidenceValue.startedAt}`,
    `- Finished: ${evidenceValue.finishedAt}`,
    `- Scope: Windows-local loopback SFTP only`,
    "",
    "## Boundaries",
    "",
    ...evidenceValue.boundaries.map((line) => `- ${line}`),
    "",
    "This evidence does not establish N1 ARM64, public network, proxy routing, or production server behavior.",
    "",
    "## Environment",
    "",
    `- rclone: ${evidenceValue.binary?.version ?? "unavailable"}`,
    `- rclone SHA-256 matches lock: ${evidenceValue.binary?.hashMatchesLockedBinary ?? "unavailable"}`,
    `- ssh-keygen: ${evidenceValue.sshKeygen?.versionOutput ?? "unavailable"}`,
    `- Node.js: ${evidenceValue.environment.nodeVersion}`,
    `- Platform: ${evidenceValue.environment.platform}/${evidenceValue.environment.arch}`,
    "",
    "## Probe results",
    "",
    "| Probe | Status |",
    "|---|---|",
    rows,
    "",
    "## Key observations",
    "",
    `- Copy upload final-name partial exposure: ${copyProbe?.partialFinalVisible ?? "unavailable"}.`,
    `- Bisync upload final-name partial exposure: ${bisyncUploadProbe?.partialFinalVisible ?? "unavailable"}.`,
    `- Same-size, same-second check detected difference: ${checksumProbe?.detectedDifference ?? "unavailable"}.`,
    `- Same-size, same-second copy --checksum repaired: ${checksumProbe?.repaired ?? "unavailable"}.`,
    `- Bisync default comparison converged both sides to rewritten content: ${bisyncCollisionProbe?.defaultComparison?.convergedToRewritten ?? "unavailable"}.`,
    `- Bisync default canaries remained unchanged: ${bisyncCollisionProbe?.defaultComparison?.canariesRemainUnchanged ?? "unavailable"}.`,
    `- Bisync checksum comparison converged both sides to rewritten content: ${bisyncCollisionProbe?.checksumComparison?.convergedToRewritten ?? "unavailable"}.`,
    `- Bisync checksum canaries remained unchanged: ${bisyncCollisionProbe?.checksumComparison?.canariesRemainUnchanged ?? "unavailable"}.`,
    `- External file visible after cache expiry: ${externalProbe?.afterCacheExpiryVisible ?? "unavailable"}.`,
    `- Independent dir-cache-time=0 A-to-B experiment passed: ${externalProbe?.cacheZeroIndependentExperiment?.passed ?? "unavailable"}.`,
    `- Outside-root marker accessible through remote link: ${rootEscapeProbe?.outsideMarkerAccessibleRemotely ?? "unavailable"}.`,
    `- SOCKS proxy option declared: ${proxyProbe?.socksProxy?.declared ?? "unavailable"}.`,
    `- HTTP CONNECT proxy option declared: ${proxyProbe?.httpProxy?.declared ?? "unavailable"}.`,
    "",
    "## Cleanup",
    "",
    `- Server process exited cleanly: ${evidenceValue.server?.processCleanup?.exited ?? "unavailable"}.`,
    `- Server PID no longer alive: ${evidenceValue.server?.processCleanup?.pidStillAlive === false}.`,
    `- Temporary keys, cache, config, served data, and link data removed: ${evidenceValue.cleanup?.filesystemCleanup?.removed ?? "unavailable"}.`,
    "",
    "The retained `report.json` contains sanitized probe output. Private key contents are never written to the report or process arguments.",
    ""
  ].join("\n");
}

async function writeEvidence() {
  const reportPath = path.join(runDir, "report.json");
  const readmePath = path.join(runDir, "README.md");
  evidence.evidenceFiles = {
    report: repoRelative(reportPath),
    readme: repoRelative(readmePath)
  };
  await fs.writeFile(reportPath, `${JSON.stringify(evidence, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600
  });
  await fs.writeFile(readmePath, reportReadme(evidence), {
    encoding: "utf8",
    mode: 0o600
  });
}

async function prepareRunDirectory() {
  await fs.mkdir(TASK_ROOT, { recursive: true });
  if (options.outDir) {
    runDir = path.resolve(options.outDir);
    assertPathInside(TASK_ROOT, runDir, true);
  } else {
    const timestamp = new Date()
      .toISOString()
      .replaceAll(":", "")
      .replaceAll(".", "-");
    runDir = path.join(TASK_ROOT, timestamp);
  }
  const reportExists = await fs
    .stat(path.join(runDir, "report.json"))
    .then(() => true)
    .catch(() => false);
  if (reportExists) {
    throw new Error("refusing to overwrite an existing report.json");
  }
  await fs.mkdir(runDir, { recursive: true });
  workRoot = path.join(runDir, `.work-${randomUUID()}`);
  serveRoot = path.join(workRoot, "served-root");
  outsideRoot = path.join(workRoot, "outside-root");
  configPath = path.join(workRoot, "rclone.conf");
  await fs.mkdir(serveRoot, { recursive: true });
  await fs.mkdir(path.join(workRoot, "rclone-cache"), { recursive: true });
  await fs.mkdir(path.join(workRoot, "rclone-temp"), { recursive: true });
}

async function main() {
  options = parseArguments(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }
  await prepareRunDirectory();
  await probeBinaryAndToolchain();

  serverPort = await allocateLoopbackPort();
  const sshConfiguration = await prepareSshConfiguration();
  sshRuntime = sshConfiguration;
  const server = startServer(
    sshConfiguration.authorizedKeysPath,
    sshConfiguration.hostKey.privateKeyPath
  );
  serverChild = server.child;
  const startupMs = await waitForPort(serverPort);
  if (serverChild.exitCode !== null) {
    throw new Error(`rclone serve sftp exited during startup: ${server.getOutput()}`);
  }
  evidence.server = {
    loopbackOnly: true,
    host: LOOPBACK_HOST,
    port: serverPort,
    startupMs,
    settings: { ...SERVER_SETTINGS },
    authentication: sshConfiguration.authentication,
    hostKeyValidation: sshConfiguration.knownHostsValidation,
    hostKeyFingerprint: sshConfiguration.hostKey.fingerprint,
    clientKeyFingerprint: sshConfiguration.clientKey.fingerprint,
    privateKeyMaterialPersistedInReport: false,
    privateKeyMaterialPassedInArgv: false
  };
  evidence.configuration = {
    isolatedRcloneConfig: true,
    isolatedRcloneCache: true,
    isolatedRcloneTemp: true,
    sshAgentDisabledForChildren: true,
    clientUsesExplicitKeyFile: true,
    clientUsesExplicitKnownHostsFile: true,
    proxyNetworkTested: false
  };

  const orderedProbes = [
    ["backendDeclarations", probeBackendDeclarations],
    ["sftpFeatures", probeSftpFeatures],
    ["copyUploadVisibility", probeCopyUploadVisibility],
    ["bisyncUploadVisibility", probeBisyncUploadVisibility],
    ["sameSizeChecksum", probeSameSizeChecksum],
    ["bisyncSameSizeCollision", probeBisyncSameSizeCollision],
    ["externalVisibility", probeExternalVisibility],
    ["rootEscapeRejection", probeRootEscapeRejection]
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
  if (options?.help) {
    process.exitCode = 0;
  }
} catch (error) {
  evidence.status = "failed";
  addFailure("harness", error);
} finally {
  if (options?.help) {
    process.exit(0);
  }
  const cleanupFailures = [];
  try {
    const processCleanup = await stopServer(serverChild);
    evidence.server = {
      ...(evidence.server || {}),
      processCleanup
    };
    if (!processCleanup.exited || processCleanup.pidStillAlive) {
      cleanupFailures.push("rclone serve sftp process did not exit cleanly");
    }
  } catch (error) {
    cleanupFailures.push(`process cleanup: ${sanitizedError(error)}`);
  }

  try {
    const linkCleanup = await removeRootEscapeLink();
    evidence.cleanup = { ...(evidence.cleanup || {}), linkCleanup };
    if (!linkCleanup.removed) {
      cleanupFailures.push("root escape junction was not removed");
    }
  } catch (error) {
    cleanupFailures.push(`link cleanup: ${sanitizedError(error)}`);
  }

  try {
    const filesystemCleanup = await safeRemoveWorkRoot();
    evidence.cleanup = {
      ...(evidence.cleanup || {}),
      filesystemCleanup
    };
    if (!filesystemCleanup.removed) {
      cleanupFailures.push("isolated work root was not removed");
    }
  } catch (error) {
    cleanupFailures.push(`filesystem cleanup: ${sanitizedError(error)}`);
  }

  for (const message of cleanupFailures) {
    addFailure("cleanup", new Error(message));
  }
  evidence.cleanup = {
    ...(evidence.cleanup || {}),
    failures: cleanupFailures,
    retainedFiles: ["report.json", "README.md"]
  };

  evidence.finishedAt = nowIso();
  evidence.status = calculateStatus();
  evidence.conclusion = {
    probeStatus: evidence.status,
    windowsLocalEvidenceOnly: true,
    canEstablishP2Release: false,
    canEstablishP1Acceptance: false,
    canProveN1Arm64Behavior: false,
    canProvePublicNetworkRouting: false,
    canProveProxyAuthenticationOrRouting: false
  };

  if (!runDir) {
    console.error(
      JSON.stringify(
        {
          status: "failed",
          error: evidence.failures.at(-1)?.message ?? "run directory was not created"
        },
        null,
        2
      )
    );
    process.exitCode = 2;
  } else {
    try {
      await writeEvidence();
      console.log(
        JSON.stringify(
          {
            status: evidence.status,
            reportPath: evidence.evidenceFiles.report,
            readmePath: evidence.evidenceFiles.readme,
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
            workRootRemoved:
              evidence.cleanup?.filesystemCleanup?.removed === true
          },
          null,
          2
        )
      );
      if (evidence.status !== "passed") {
        process.exitCode = evidence.status === "failed" ? 2 : 3;
      }
    } catch (error) {
      console.error(sanitizedError(error));
      process.exitCode = 2;
    }
  }
}
