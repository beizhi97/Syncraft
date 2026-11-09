#!/usr/bin/env node

import { spawn } from "node:child_process";
import {
  createHash,
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
  "development-2026-10-20",
  "p2-sftp-auth-proxy"
);
const SSH_KEYGEN_PATH = path.join(
  process.env.SystemRoot || "C:\\Windows",
  "System32",
  "OpenSSH",
  "ssh-keygen.exe"
);
const SSH_PATH = path.join(
  path.dirname(SSH_KEYGEN_PATH),
  "ssh.exe"
);
const CSC_PATH = path.join(
  process.env.SystemRoot || "C:\\Windows",
  "Microsoft.NET",
  "Framework64",
  "v4.0.30319",
  "csc.exe"
);
const TASKKILL_PATH = path.join(
  process.env.SystemRoot || "C:\\Windows",
  "System32",
  "taskkill.exe"
);

const LOOPBACK_HOST = "127.0.0.1";
const USER_A = "probe-a";
const USER_B = "probe-b";
const SERVER_SETTINGS = Object.freeze({
  dirCacheTime: "1s",
  pollInterval: "0",
  vfsCacheMode: "off",
  logLevel: "DEBUG"
});
const CLIENT_TIMEOUT_MS = 20_000;

const evidence = {
  schemaVersion: 1,
  kind: "syncraft-p2-sftp-auth-proxy-probe",
  status: "running",
  startedAt: new Date().toISOString(),
  finishedAt: null,
  runId: randomUUID(),
  boundaries: [
    "Windows-local loopback evidence only",
    "Does not prove N1 ARM64 behavior",
    "Does not prove public-network or production behavior",
    "Does not establish P1 acceptance or P2 release",
    "No five-minute auth-proxy cache expiry wait",
    "Existing authenticated-session revocation is not exercised"
  ],
  environment: {
    platform: process.platform,
    arch: process.arch,
    osRelease: os.release(),
    nodeVersion: process.version
  },
  binary: null,
  sshTooling: null,
  declaredProtocol: null,
  fixture: null,
  helper: null,
  server: null,
  probes: {},
  helperInvocations: [],
  failures: [],
  cleanup: null,
  conclusion: null
};

const secrets = [];
let options;
let runDir;
let workRoot;
let helperConfigPath;
let helperInvocationLogPath;
let serverChild;
let serverOutput = "";
let serverPort;
let runtime;

function printHelp() {
  console.log(
    [
      "Usage: node scripts/probe-sftp-auth-proxy.mjs [--rclone <path>] [--out-dir <path>]",
      "",
      "Runs a bounded Windows-local auth-proxy experiment with two users and two roots.",
      "Default evidence root:",
      "  .tmp/development-2026-10-20/p2-sftp-auth-proxy/<timestamp>/",
      "A custom --out-dir must resolve inside that task root."
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

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
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
  env.RCLONE_CACHE_DIR = path.join(workRoot, "rclone-cache");
  env.RCLONE_TEMP_DIR = path.join(workRoot, "rclone-temp");
  return { ...env, ...extra };
}

function closeChildPipes(child) {
  for (const stream of [child.stdin, child.stdout, child.stderr]) {
    if (stream && !stream.destroyed) {
      stream.destroy();
    }
  }
}

function waitForSpawnedProcess(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({
      exited: true,
      exitCode: child.exitCode,
      signalCode: child.signalCode
    });
  }
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      finish({
        exited: false,
        exitCode: child.exitCode,
        signalCode: child.signalCode
      });
    }, timeoutMs);
    child.once("error", (error) => {
      finish({
        exited: false,
        exitCode: null,
        signalCode: null,
        error: sanitizedError(error)
      });
    });
    child.once("exit", (exitCode, signalCode) => {
      finish({ exited: true, exitCode, signalCode });
    });
  });
}

async function terminateProcessTree(child) {
  const pid = child.pid;
  if (!Number.isInteger(pid)) {
    return {
      attempted: false,
      reason: "spawned process has no numeric PID"
    };
  }
  if (child.exitCode !== null || child.signalCode !== null) {
    return {
      attempted: false,
      reason: "spawned process already exited",
      pid,
      parentExited: true
    };
  }

  const killer = spawn(
    TASKKILL_PATH,
    ["/PID", String(pid), "/T", "/F"],
    {
      windowsHide: true,
      stdio: "ignore"
    }
  );
  const taskkill = await waitForSpawnedProcess(killer, 10_000);
  if (!taskkill.exited) {
    try {
      killer.kill("SIGKILL");
    } catch {
      // The bounded timeout still settles even if the fallback cannot signal.
    }
  }

  let parentExited = await waitForExit(child, 2_000);
  let fallbackSignalSent = false;
  if (!parentExited) {
    fallbackSignalSent = true;
    try {
      child.kill("SIGKILL");
    } catch {
      // taskkill already targeted only this spawned PID subtree.
    }
    parentExited = await waitForExit(child, 1_000);
  }

  return {
    attempted: true,
    pid,
    target: "spawned-pid-subtree",
    taskkill,
    fallbackSignalSent,
    parentExited
  };
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
      if (settled) {
        return;
      }
      timedOut = true;
      clearTimeout(timer);
      void terminateProcessTree(child)
        .catch((error) => ({
          attempted: false,
          error: sanitizedError(error)
        }))
        .then((termination) => {
          if (settled) {
            return;
          }
          settled = true;
          closeChildPipes(child);
          const error = new Error(`process timed out after ${timeoutMs}ms`);
          error.code = "ETIMEDOUT";
          error.timeoutMs = timeoutMs;
          error.termination = termination;
          reject(error);
        });
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
      if (settled || timedOut) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      closeChildPipes(child);
      reject(error);
    });
    child.once("close", (exitCode, signalCode) => {
      if (settled || timedOut) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve({
        exitCode,
        signalCode,
        stdout: redact(stdout),
        stderr: redact(stderr)
      });
    });

    child.stdin.on("error", () => {
      // EPIPE is expected when a bounded timeout terminates the process tree.
    });
    if (input === null) {
      child.stdin.end();
    } else {
      child.stdin.end(input);
    }
  });
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
  if (!child || child.exitCode !== null || child.signalCode !== null) {
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
      TASKKILL_PATH,
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

async function publicKeyEvidence(key) {
  const line = (await fs.readFile(key.publicKeyPath, "utf8")).trim();
  const fields = line.split(/\s+/);
  const material = fields[1] || fields[0];
  return {
    fingerprint: key.fingerprint,
    sha256: sha256(material),
    material
  };
}

async function writeHelperConfig(state) {
  const config = {
    schemaVersion: 1,
    users: state
  };
  await fs.writeFile(helperConfigPath, `${JSON.stringify(config, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600
  });
}

function helperSource() {
  return `#!/usr/bin/env node
import { appendFileSync, readFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";

const configPath = process.env.SYNCRAFT_AUTH_PROXY_CONFIG;
const logPath = process.env.SYNCRAFT_AUTH_PROXY_LOG;

function keyMaterial(value) {
  const fields = String(value || "").trim().split(/\\s+/);
  return fields[1] || fields[0] || "";
}

function logInvocation(entry) {
  appendFileSync(logPath, JSON.stringify({
    invocationId: randomUUID(),
    at: new Date().toISOString(),
    ...entry
  }) + "\\n", { encoding: "utf8", mode: 0o600 });
}

let request;
try {
  request = JSON.parse(readFileSync(0, "utf8"));
} catch (error) {
  console.error("auth-proxy input is not valid JSON");
  process.exit(3);
}

const user = typeof request.user === "string" ? request.user : "";
const publicKey = keyMaterial(request.public_key);
const publicKeySha256 = createHash("sha256").update(publicKey).digest("hex");
let config;
try {
  config = JSON.parse(readFileSync(configPath, "utf8"));
} catch (error) {
  logInvocation({ user, publicKeySha256, authorized: false, reason: "config_unavailable" });
  console.error("auth-proxy configuration is unavailable");
  process.exit(4);
}

const entry = config.users?.[user];
if (!entry || entry.active !== true || entry.publicKeySha256 !== publicKeySha256) {
  logInvocation({
    user,
    publicKeySha256,
    authorized: false,
    reason: !entry ? "unknown_user" : entry.active !== true ? "revoked" : "key_mismatch"
  });
  console.error("auth-proxy authorization denied");
  process.exit(2);
}

logInvocation({ user, publicKeySha256, authorized: true, reason: null });
process.stdout.write(JSON.stringify({
  type: "local",
  _root: entry.root
}) + "\\n");
`;
}

function csharpStringLiteral(value) {
  return JSON.stringify(String(value));
}

async function compileHelperWrapper(
  nodePath,
  helperPath,
  wrapperPath,
  sourcePath,
  env = baseEnvironment()
) {
  const argumentString = `"${helperPath.replaceAll('"', '\\"')}"`;
  const source = [
    "using System;",
    "using System.Diagnostics;",
    "using System.Threading.Tasks;",
    "class Program {",
    "  static int Main() {",
    "    try {",
    "      Console.InputEncoding = new System.Text.UTF8Encoding(false);",
    "      var start = new ProcessStartInfo();",
    `      start.FileName = ${csharpStringLiteral(nodePath)};`,
    `      start.Arguments = ${csharpStringLiteral(argumentString)};`,
    "      start.UseShellExecute = false;",
    "      start.CreateNoWindow = true;",
    "      start.RedirectStandardInput = true;",
    "      start.RedirectStandardOutput = true;",
    "      start.RedirectStandardError = true;",
    "      using (var process = Process.Start(start)) {",
    "        if (process == null) {",
    "          Console.Error.WriteLine(\"auth-proxy wrapper: helper process did not start\");",
    "          return 127;",
    "        }",
    "        var stdoutTask = process.StandardOutput.BaseStream.CopyToAsync(Console.OpenStandardOutput());",
    "        var stderrTask = process.StandardError.BaseStream.CopyToAsync(Console.OpenStandardError());",
    "        Console.OpenStandardInput().CopyTo(process.StandardInput.BaseStream);",
    "        process.StandardInput.BaseStream.Flush();",
    "        process.StandardInput.BaseStream.Close();",
    "        process.WaitForExit();",
    "        Task.WaitAll(stdoutTask, stderrTask);",
    "        return process.ExitCode;",
    "      }",
    "    } catch (Exception error) {",
    "      Console.Error.WriteLine(\"auth-proxy wrapper: \" + error.Message);",
    "      return 127;",
    "    }",
    "  }",
    "}",
    ""
  ].join("\r\n");
  await fs.writeFile(sourcePath, source, { encoding: "utf8", mode: 0o600 });
  return runRequired(
    CSC_PATH,
    ["/nologo", "/target:exe", `/out:${wrapperPath}`, sourcePath],
    { env, timeoutMs: 30_000 }
  );
}

async function prepareFixture() {
  const rootsRoot = path.join(workRoot, "roots");
  const keysRoot = path.join(workRoot, "keys");
  const helperRoot = path.join(workRoot, "helper");
  const clientsRoot = path.join(workRoot, "clients");
  const placeholderRoot = path.join(workRoot, "placeholder");
  await Promise.all([
    fs.mkdir(rootsRoot, { recursive: true }),
    fs.mkdir(keysRoot, { recursive: true }),
    fs.mkdir(helperRoot, { recursive: true }),
    fs.mkdir(clientsRoot, { recursive: true }),
    fs.mkdir(placeholderRoot, { recursive: true })
  ]);

  const rootA = path.join(rootsRoot, "user-a");
  const rootB = path.join(rootsRoot, "user-b");
  await Promise.all([
    fs.mkdir(rootA, { recursive: true }),
    fs.mkdir(rootB, { recursive: true })
  ]);
  const fileA = "user-a-only.txt";
  const fileB = "user-b-only.txt";
  const contentA = "root A content\n";
  const contentB = "root B content\n";
  await Promise.all([
    fs.writeFile(path.join(rootA, fileA), contentA, { encoding: "utf8", mode: 0o600 }),
    fs.writeFile(path.join(rootB, fileB), contentB, { encoding: "utf8", mode: 0o600 })
  ]);

  const hostKey = await generateEd25519Key(path.join(keysRoot, "host_ed25519"));
  const keyA = await generateEd25519Key(path.join(keysRoot, "client-a_ed25519"));
  const keyB = await generateEd25519Key(path.join(keysRoot, "client-b_ed25519"));
  const wrongKey = await generateEd25519Key(path.join(keysRoot, "client-wrong_ed25519"));
  for (const key of [hostKey, keyA, keyB, wrongKey]) {
    secrets.push(key.privateKeyPath);
  }

  const [keyAEvidence, keyBEvidence, wrongKeyEvidence] = await Promise.all([
    publicKeyEvidence(keyA),
    publicKeyEvidence(keyB),
    publicKeyEvidence(wrongKey)
  ]);

  const authorizedKeysPath = path.join(keysRoot, "authorized_keys");
  const wrongPublicKey = (await fs.readFile(wrongKey.publicKeyPath, "utf8")).trim();
  await fs.writeFile(authorizedKeysPath, `${wrongPublicKey}\n`, {
    encoding: "utf8",
    mode: 0o600
  });

  const hostPublicKey = (await fs.readFile(hostKey.publicKeyPath, "utf8")).trim();
  const hostPublicFields = hostPublicKey.split(/\s+/).slice(0, 2).join(" ");
  const knownHostsPath = path.join(keysRoot, "known_hosts");
  await fs.writeFile(
    knownHostsPath,
    `[${LOOPBACK_HOST}]:${serverPort} ${hostPublicFields}\n`,
    { encoding: "utf8", mode: 0o600 }
  );

  helperConfigPath = path.join(helperRoot, "authorization.json");
  helperInvocationLogPath = path.join(helperRoot, "invocations.jsonl");
  const helperPath = path.join(helperRoot, "auth-proxy-helper.mjs");
  const wrapperSourcePath = path.join(helperRoot, "auth-proxy-wrapper.cs");
  const wrapperPath = path.join(helperRoot, "auth-proxy-wrapper.exe");
  await fs.writeFile(helperPath, helperSource(), { encoding: "utf8", mode: 0o600 });
  await fs.writeFile(helperInvocationLogPath, "", { encoding: "utf8", mode: 0o600 });
  await writeHelperConfig({
    [USER_A]: {
      active: true,
      publicKeySha256: keyAEvidence.sha256,
      root: rootA
    },
    [USER_B]: {
      active: true,
      publicKeySha256: keyBEvidence.sha256,
      root: rootB
    }
  });

  await compileHelperWrapper(process.execPath, helperPath, wrapperPath, wrapperSourcePath);

  const helperEnvironment = baseEnvironment({
    SYNCRAFT_AUTH_PROXY_CONFIG: helperConfigPath,
    SYNCRAFT_AUTH_PROXY_LOG: helperInvocationLogPath
  });
  const helperSelfTest = await runProcess(wrapperPath, [], {
    env: helperEnvironment,
    input: JSON.stringify({ user: USER_A, public_key: keyAEvidence.material }),
    timeoutMs: 10_000
  });
  const selfTestInvocations = await readHelperInvocations();
  await fs.writeFile(helperInvocationLogPath, "", { encoding: "utf8", mode: 0o600 });

  const clientConfigs = {};
  for (const scenario of [
    { name: "user-a", user: USER_A, key: keyA },
    { name: "user-b", user: USER_B, key: keyB },
    { name: "wrong-a", user: USER_A, key: wrongKey }
  ]) {
    const configPath = path.join(clientsRoot, `${scenario.name}.conf`);
    const config = [
      "[probe]",
      "type = sftp",
      `host = ${LOOPBACK_HOST}`,
      `port = ${serverPort}`,
      `user = ${scenario.user}`,
      `key_file = ${normalizeConfigPath(scenario.key.privateKeyPath)}`,
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
    clientConfigs[scenario.name] = configPath;
  }

  evidence.fixture = {
    users: [
      {
        user: USER_A,
        rootLabel: "user-a",
        file: fileA,
        expectedContentSha256: sha256(Buffer.from(contentA, "utf8")),
        publicKeyFingerprint: keyAEvidence.fingerprint,
        publicKeySha256: keyAEvidence.sha256
      },
      {
        user: USER_B,
        rootLabel: "user-b",
        file: fileB,
        expectedContentSha256: sha256(Buffer.from(contentB, "utf8")),
        publicKeyFingerprint: keyBEvidence.fingerprint,
        publicKeySha256: keyBEvidence.sha256
      }
    ],
    wrongKeyFingerprint: wrongKeyEvidence.fingerprint,
    wrongKeySha256: wrongKeyEvidence.sha256,
    rootsAreDistinct: path.resolve(rootA) !== path.resolve(rootB),
    authorizedKeysContainsOnlyWrongKey: true,
    privateKeyMaterialPersistedInReport: false,
    privateKeyMaterialPassedInArgv: false
  };
  evidence.helper = {
    wrapperKind: "compiled-windows-exe",
    wrapperCreatedOnlyInTaskWorkRoot: true,
    helperProtocol: "JSON stdin; JSON backend config stdout",
    helperChecksUserAndPublicKey: true,
    invocationLogContainsPublicKeyHashOnly: true,
    selfTest: {
      exitCode: helperSelfTest.exitCode,
      outputParsed:
        (() => {
          try {
            const parsed = JSON.parse(helperSelfTest.stdout);
            return parsed.type === "local"
              && typeof parsed._root === "string"
              && parsed._root.length > 0;
          } catch {
            return false;
          }
        })(),
      invocationCount: selfTestInvocations.length,
      loggedAuthorized: selfTestInvocations[0]?.authorized === true
    }
  };
  if (
    helperSelfTest.exitCode !== 0
    || !evidence.helper.selfTest.outputParsed
    || !evidence.helper.selfTest.loggedAuthorized
  ) {
    throw new Error(`auth-proxy helper self-test failed: ${helperSelfTest.stderr}`);
  }

  runtime = {
    roots: { [USER_A]: rootA, [USER_B]: rootB },
    files: {
      [USER_A]: fileA,
      [USER_B]: fileB
    },
    contents: {
      [USER_A]: contentA,
      [USER_B]: contentB
    },
    keys: { a: keyA, b: keyB, wrong: wrongKey },
    keyEvidence: {
      a: keyAEvidence,
      b: keyBEvidence,
      wrong: wrongKeyEvidence
    },
    clientConfigs,
    authorizedKeysPath,
    hostPrivateKeyPath: hostKey.privateKeyPath,
    hostKeyFingerprint: hostKey.fingerprint,
    knownHostsPath,
    helperPath,
    wrapperPath,
    placeholderRoot
  };
}

async function readHelperInvocations() {
  const text = await fs.readFile(helperInvocationLogPath, "utf8").catch(() => "");
  return text
    .split(/\r?\n/)
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line)];
      } catch {
        return [];
      }
    });
}

async function invocationSnapshot() {
  const invocations = await readHelperInvocations();
  return {
    count: invocations.length,
    last: invocations.at(-1) ?? null
  };
}

async function runClient(configPath, remotePath, label) {
  const cacheRoot = path.join(
    workRoot,
    "client-runs",
    `${label}-${randomUUID()}`
  );
  await fs.mkdir(cacheRoot, { recursive: true });
  const env = baseEnvironment({
    RCLONE_CONFIG: configPath,
    RCLONE_CACHE_DIR: path.join(cacheRoot, "cache"),
    RCLONE_TEMP_DIR: path.join(cacheRoot, "temp")
  });
  const result = await runRclone(
    [
      "cat",
      remotePath,
      "--retries",
      "1",
      "--low-level-retries",
      "1",
      "--timeout",
      "10s",
      "--contimeout",
      "10s"
    ],
    {
      env,
      timeoutMs: CLIENT_TIMEOUT_MS,
      maxOutputBytes: 30_000
    }
  );
  return {
    label,
    exitCode: result.exitCode,
    signalCode: result.signalCode,
    stdout: result.stdout,
    stdoutSha256: sha256(Buffer.from(result.stdout, "utf8")),
    stderr: result.stderr
  };
}

function setProbe(name, value) {
  evidence.probes[name] = value;
}

function addFailure(scope, error) {
  evidence.failures.push({
    scope,
    at: nowIso(),
    message: sanitizedError(error)
  });
}

async function probeBinaryAndHelp() {
  const lock = JSON.parse(await fs.readFile(LOCK_PATH, "utf8"));
  const expectedSha256 = lock.tools?.rclone?.sha256;
  const actualSha256 = await sha256File(options.rclonePath);
  const version = await runRcloneRequired(["version"], { timeoutMs: 10_000 });
  const help = await runRcloneRequired(["serve", "sftp", "--help"], {
    timeoutMs: 20_000,
    maxOutputBytes: 250_000
  });
  const versionLine = version.stdout.trim().split(/\r?\n/)[0] || null;
  const keygenVersion = await runProcess(SSH_PATH, ["-V"], { timeoutMs: 10_000 });

  evidence.binary = {
    path: repoRelative(options.rclonePath),
    expectedVersion: lock.tools?.rclone?.version ?? null,
    expectedSha256,
    actualSha256,
    hashMatchesLockedBinary: actualSha256 === expectedSha256,
    version: versionLine,
    versionMatchesLock: versionLine === `rclone v${lock.tools?.rclone?.version}`
  };
  evidence.sshTooling = {
    keygenPath: SSH_KEYGEN_PATH,
    sshPath: SSH_PATH,
    versionExitCode: keygenVersion.exitCode,
    versionOutput: (keygenVersion.stdout || keygenVersion.stderr).trim() || null
  };
  evidence.declaredProtocol = {
    serverHelpSha256: sha256(Buffer.from(help.stdout, "utf8")),
    authProxyFlagDeclared: help.stdout.includes("--auth-proxy"),
    publicKeyInputDeclared: help.stdout.includes("\"public_key\""),
    rootParameterRequiredDeclared: help.stdout.includes("_root"),
    authorizedKeysIgnoredDeclared:
      help.stdout.includes("authorized keys option will be")
      && help.stdout.includes("ignored"),
    perUserCacheDeclared: help.stdout.includes("internal cache is keyed on `user`"),
    fiveMinuteExpiryDeclared: help.stdout.includes("takes 5 mins"),
    boundedHelpEvidenceOnly: true
  };
  if (!evidence.binary.hashMatchesLockedBinary) {
    throw new Error("rclone binary SHA-256 does not match binaries.lock.json");
  }
  if (!evidence.binary.versionMatchesLock) {
    throw new Error("rclone binary version does not match binaries.lock.json");
  }
  if (
    !evidence.declaredProtocol.authProxyFlagDeclared ||
    !evidence.declaredProtocol.publicKeyInputDeclared ||
    !evidence.declaredProtocol.rootParameterRequiredDeclared
  ) {
    throw new Error("locked rclone help does not expose the expected auth-proxy protocol");
  }
}

function startServer() {
  const args = [
    "serve",
    "sftp",
    "--addr",
    `${LOOPBACK_HOST}:${serverPort}`,
    "--auth-proxy",
    runtime.wrapperPath,
    "--authorized-keys",
    runtime.authorizedKeysPath,
    "--key",
    runtime.hostPrivateKeyPath,
    "--dir-cache-time",
    SERVER_SETTINGS.dirCacheTime,
    "--poll-interval",
    SERVER_SETTINGS.pollInterval,
    "--vfs-cache-mode",
    SERVER_SETTINGS.vfsCacheMode,
    "--log-level",
    SERVER_SETTINGS.logLevel
  ];
  const child = spawn(options.rclonePath, args, {
    cwd: REPO_ROOT,
    env: baseEnvironment({
      SYNCRAFT_AUTH_PROXY_CONFIG: helperConfigPath,
      SYNCRAFT_AUTH_PROXY_LOG: helperInvocationLogPath
    }),
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"]
  });
  serverOutput = "";
  const append = (chunk) => {
    if (serverOutput.length < 200_000) {
      serverOutput += chunk.toString("utf8").slice(0, 200_000 - serverOutput.length);
    }
  };
  child.stdout.on("data", append);
  child.stderr.on("data", append);
  return child;
}

async function probeWrongKey(label = "wrong-key-a", phase = "cold-cache") {
  const before = await invocationSnapshot();
  const result = await runClient(
    runtime.clientConfigs["wrong-a"],
    `probe:${runtime.files[USER_A]}`,
    label
  );
  const after = await invocationSnapshot();
  const invocationDelta = after.count - before.count;
  const denied = result.exitCode !== 0;
  const helperInvoked = invocationDelta > 0;
  const helperAuthorizationDenied =
    helperInvoked && after.last?.authorized === false;
  const helperRequirementSatisfied = phase === "cold-cache"
    ? helperInvoked && helperAuthorizationDenied
    : true;
  return {
    status: denied && helperRequirementSatisfied ? "passed" : "failed",
    phase,
    expected: "wrong key is denied",
    denied,
    clientExitCode: result.exitCode,
    helperInvocationDelta: invocationDelta,
    helperInvoked,
    helperLastInvocationDuringAttempt: helperInvoked ? after.last : null,
    helperLogLastInvocation: after.last,
    helperAuthorizationDenied,
    cacheBypassObserved: !helperInvoked,
    authorizedKeysContainedWrongKey: true,
    authorizedKeysIgnoredObserved: denied && helperInvoked,
    returnedUserAContent: result.stdout === runtime.contents[USER_A],
    clientError: result.stderr
  };
}

async function probeUserRead(user, configName, label) {
  const before = await invocationSnapshot();
  const result = await runClient(
    runtime.clientConfigs[configName],
    `probe:${runtime.files[user]}`,
    label
  );
  const after = await invocationSnapshot();
  const invocationDelta = after.count - before.count;
  const expectedContent = runtime.contents[user];
  const contentMatched = result.stdout === expectedContent;
  return {
    status:
      result.exitCode === 0
      && contentMatched
      && invocationDelta > 0
      && after.last?.authorized === true
        ? "passed"
        : "failed",
    user,
    expectedContentSha256: sha256(Buffer.from(expectedContent, "utf8")),
    observedContentSha256: result.stdoutSha256,
    contentMatched,
    clientExitCode: result.exitCode,
    helperInvocationDelta: invocationDelta,
    helperLastInvocation: after.last,
    clientError: result.stderr
  };
}

async function probeCrossRoot(user, configName, otherUser) {
  const result = await runClient(
    runtime.clientConfigs[configName],
    `probe:${runtime.files[otherUser]}`,
    `cross-${user}`
  );
  return {
    status: result.exitCode !== 0 ? "passed" : "failed",
    user,
    attemptedOtherUserFile: runtime.files[otherUser],
    denied: result.exitCode !== 0,
    clientExitCode: result.exitCode,
    clientError: result.stderr
  };
}

async function revokeUser(user) {
  const current = JSON.parse(await fs.readFile(helperConfigPath, "utf8"));
  current.users[user].active = false;
  await writeHelperConfig(current.users);
}

async function probeImmediateRevocation() {
  await revokeUser(USER_A);
  const before = await invocationSnapshot();
  const result = await runClient(
    runtime.clientConfigs["user-a"],
    `probe:${runtime.files[USER_A]}`,
    "revoked-user-a"
  );
  const after = await invocationSnapshot();
  const invocationDelta = after.count - before.count;
  const readStillSucceeded = result.exitCode === 0;

  let status = "blocked";
  if (readStillSucceeded && invocationDelta === 0) {
    status = "observed-cache-bypass";
  } else if (!readStillSucceeded && invocationDelta > 0 && after.last?.authorized === false) {
    status = "passed";
  }

  return {
    status,
    user: USER_A,
    helperAuthorizationRevoked: true,
    waitForFiveMinuteCacheExpiry: false,
    helperInvocationDelta: invocationDelta,
    helperLastInvocation: after.last,
    newConnectionReadSucceeded: readStillSucceeded,
    newConnectionExitCode: result.exitCode,
    immediateRevocationEnforced:
      !readStillSucceeded && invocationDelta > 0 && after.last?.authorized === false,
    cachedBackendObservedAfterRevocation:
      readStillSucceeded && invocationDelta === 0,
    clientError: result.stderr,
    existingSessionRevocation: {
      status: "unverified",
      reason: "This bounded probe did not keep an authenticated data session open across revocation."
    }
  };
}

async function probeUserBStillWorksAfterRevocation() {
  const before = await invocationSnapshot();
  const result = await runClient(
    runtime.clientConfigs["user-b"],
    `probe:${runtime.files[USER_B]}`,
    "user-b-after-a-revocation"
  );
  const after = await invocationSnapshot();
  return {
    status:
      result.exitCode === 0 && result.stdout === runtime.contents[USER_B]
        ? "passed"
        : "failed",
    clientExitCode: result.exitCode,
    contentMatched: result.stdout === runtime.contents[USER_B],
    helperInvocationDelta: after.count - before.count,
    clientError: result.stderr
  };
}

function calculateStatus() {
  if (evidence.failures.length > 0) {
    return "failed";
  }
  const required = [
    "wrongKeyDenied",
    "userARead",
    "wrongKeyAfterUserARead",
    "userBRead",
    "crossRootA",
    "crossRootB",
    "userBStillWorksAfterARevocation"
  ];
  if (required.some((name) => evidence.probes[name]?.status !== "passed")) {
    return "blocked";
  }
  if (evidence.probes.immediateRevocation?.status === "blocked") {
    return "blocked";
  }
  if (evidence.probes.immediateRevocation?.status === "observed-cache-bypass") {
    return "passed-with-findings";
  }
  return "passed";
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
  const rows = Object.entries(evidence.probes)
    .map(([name, probe]) => `| ${name} | ${probe?.status ?? "missing"} |`)
    .join("\n");
  const readme = [
    "# Syncraft P2 SFTP auth-proxy probe",
    "",
    `- Run ID: \`${evidence.runId}\``,
    `- Status: **${evidence.status}**`,
    `- Started: ${evidence.startedAt}`,
    `- Finished: ${evidence.finishedAt}`,
    "- Scope: Windows-local loopback with two users and two roots",
    "",
    "## Boundaries",
    "",
    ...evidence.boundaries.map((line) => `- ${line}`),
    "",
    "## Probe results",
    "",
    "| Probe | Status |",
    "|---|---|",
    rows,
    "",
    "## Immediate revocation observation",
    "",
    `- Helper invocation delta after revocation: ${evidence.probes.immediateRevocation?.helperInvocationDelta ?? "unavailable"}`,
    `- New connection read succeeded after revocation: ${evidence.probes.immediateRevocation?.newConnectionReadSucceeded ?? "unavailable"}`,
    `- Immediate revocation enforced: ${evidence.probes.immediateRevocation?.immediateRevocationEnforced ?? "unavailable"}`,
    `- Cached backend observed: ${evidence.probes.immediateRevocation?.cachedBackendObservedAfterRevocation ?? "unavailable"}`,
    "- Existing-session revocation: unverified",
    "",
    "## Wrong-key cache checks",
    "",
    `- Cold cache: helper invocation delta ${evidence.probes.wrongKeyDenied?.helperInvocationDelta ?? "unavailable"}; denied ${evidence.probes.wrongKeyDenied?.denied ?? "unavailable"}`,
    `- After user A success: helper invocation delta ${evidence.probes.wrongKeyAfterUserARead?.helperInvocationDelta ?? "unavailable"}; denied ${evidence.probes.wrongKeyAfterUserARead?.denied ?? "unavailable"}; cache bypass observed ${evidence.probes.wrongKeyAfterUserARead?.cacheBypassObserved ?? "unavailable"}`,
    "",
    "No five-minute cache expiry wait was performed. This report does not prove N1 behavior or production suitability.",
    ""
  ].join("\n");
  await fs.writeFile(readmePath, readme, {
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
  await Promise.all([
    fs.mkdir(workRoot, { recursive: true }),
    fs.mkdir(path.join(workRoot, "rclone-cache"), { recursive: true }),
    fs.mkdir(path.join(workRoot, "rclone-temp"), { recursive: true })
  ]);
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

async function main() {
  options = parseArguments(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }
  if (process.platform !== "win32") {
    throw new Error("this auth-proxy probe requires Windows");
  }
  await prepareRunDirectory();
  await probeBinaryAndHelp();
  serverPort = await allocateLoopbackPort();
  await prepareFixture();

  serverChild = startServer();
  const startupMs = await waitForPort(serverPort);
  await delay(150);
  if (serverChild.exitCode !== null) {
    throw new Error(`rclone serve sftp exited during startup: ${redact(serverOutput)}`);
  }
  evidence.server = {
    loopbackOnly: true,
    host: LOOPBACK_HOST,
    port: serverPort,
    startupMs,
    settings: { ...SERVER_SETTINGS },
    authProxyConfigured: true,
    authorizedKeysAlsoConfiguredToTestIgnoredDeclaration: true,
    hostKeyFingerprint: runtime.hostKeyFingerprint,
    processCleanup: null
  };

  const orderedProbes = [
    ["wrongKeyDenied", () => probeWrongKey("wrong-key-a-cold", "cold-cache")],
    ["userARead", () => probeUserRead(USER_A, "user-a", "user-a-read")],
    [
      "wrongKeyAfterUserARead",
      () => probeWrongKey("wrong-key-a-after-user-a-read", "after-user-a-success")
    ],
    ["userBRead", () => probeUserRead(USER_B, "user-b", "user-b-read")],
    ["crossRootA", () => probeCrossRoot(USER_A, "user-a", USER_B)],
    ["crossRootB", () => probeCrossRoot(USER_B, "user-b", USER_A)],
    ["immediateRevocation", probeImmediateRevocation],
    ["userBStillWorksAfterARevocation", probeUserBStillWorksAfterRevocation]
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

async function runHarness() {
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

  evidence.helperInvocations = helperInvocationLogPath
    ? await readHelperInvocations().catch(() => [])
    : [];

  try {
    const filesystemCleanup = await safeRemoveWorkRoot();
    evidence.cleanup = { filesystemCleanup };
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
  evidence.server = {
    ...(evidence.server || {}),
    logTail: redact(serverOutput).slice(-12_000)
  };
  evidence.finishedAt = nowIso();
  evidence.status = calculateStatus();
  evidence.conclusion = {
    probeStatus: evidence.status,
    authProxyImmediateRevocationEnforced:
      evidence.probes.immediateRevocation?.immediateRevocationEnforced ?? null,
    authProxyCachedBackendObservedAfterRevocation:
      evidence.probes.immediateRevocation?.cachedBackendObservedAfterRevocation ?? null,
    fiveMinuteCacheExpiryTested: false,
    existingSessionRevocationTested: false,
    windowsLocalEvidenceOnly: true,
    canEstablishP2Release: false,
    canEstablishP1Acceptance: false,
    canProveN1Arm64Behavior: false,
    candidateAlternativeNotImplemented: {
      name: "per-relation loopback SFTP process",
      rationale:
        "Stop the relation-specific process to terminate cached and existing sessions if auth-proxy cache prevents immediate revocation.",
      testedInThisProbe: false
    }
  };

  if (!runDir) {
    console.error(JSON.stringify({
      status: "failed",
      error: evidence.failures.at(-1)?.message ?? "run directory was not created"
    }, null, 2));
    process.exitCode = 2;
  } else {
    try {
      await writeEvidence();
      console.log(JSON.stringify({
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
          evidence.server?.processCleanup?.exited === true
          && evidence.server?.processCleanup?.pidStillAlive === false,
        workRootRemoved: evidence.cleanup?.filesystemCleanup?.removed === true
      }, null, 2));
      if (evidence.status === "failed" || evidence.status === "blocked") {
        process.exitCode = 2;
      } else if (evidence.status === "passed-with-findings") {
        process.exitCode = 3;
      }
    } catch (error) {
      console.error(sanitizedError(error));
      process.exitCode = 2;
    }
  }
}
}

export {
  compileHelperWrapper,
  helperSource,
  runProcess,
  sha256
};

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : null;
const scriptPath = fileURLToPath(import.meta.url);
if (
  invokedPath
  && normalizeForComparison(invokedPath) === normalizeForComparison(scriptPath)
) {
  await runHarness();
}
