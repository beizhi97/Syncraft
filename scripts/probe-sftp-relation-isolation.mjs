#!/usr/bin/env node

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runProcess, sha256 } from "./probe-sftp-auth-proxy.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, "..");
const TASK_ROOT = path.join(
  REPO_ROOT,
  ".tmp",
  "development-2026-10-20",
  "p2-sftp-relation-isolation"
);
const RCLONE_PATH = path.join(
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
const SSH_KEYGEN_PATH = path.join(
  process.env.SystemRoot || "C:\\Windows",
  "System32",
  "OpenSSH",
  "ssh-keygen.exe"
);
const SSH_PATH = path.join(path.dirname(SSH_KEYGEN_PATH), "ssh.exe");
const TASKKILL_PATH = path.join(
  process.env.SystemRoot || "C:\\Windows",
  "System32",
  "taskkill.exe"
);

let runDir;
let workRoot;
let relations = [];
let activeSshChild = null;
const serverChildren = new Map();
const serverOutputs = new Map();
const evidence = {
  schemaVersion: 1,
  kind: "syncraft-p2-sftp-relation-isolation-two-relations",
  status: "running",
  startedAt: new Date().toISOString(),
  finishedAt: null,
  runId: randomUUID(),
  scope: "Windows-local loopback; two relations; isolated reads and cross-key denial",
  boundaries: [
    "Process-stop prototype only",
    "ssh -N proves the authenticated SSH transport closes; it does not prove closure of an active SFTP file-read/write session",
    "No persistent revocation or supervisor is implemented",
    "No production authorization model is established",
    "Windows-local evidence does not prove N1 ARM64 behavior"
  ],
  binary: null,
  fixture: null,
  server: null,
  read: null,
  cleanup: null,
  failures: []
};

function repoRelative(filePath) {
  return path.relative(REPO_ROOT, filePath).replaceAll("\\", "/");
}

function normalized(filePath) {
  const resolved = path.resolve(filePath);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function assertInside(rootPath, candidatePath, allowEqual = false) {
  const relative = path.relative(normalized(rootPath), normalized(candidatePath));
  if (relative === "" && allowEqual) {
    return;
  }
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("path escaped the designated relation-isolation root");
  }
}

function baseEnvironment(relationLabel = "control", extra = {}) {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    const upper = key.toUpperCase();
    if (
      upper.startsWith("RCLONE_")
      || key === "SSH_AUTH_SOCK"
      || key === "SSH_AGENT_PID"
    ) {
      continue;
    }
    env[key] = value;
  }
  const runtimeRoot = path.join(workRoot, "runtime", relationLabel);
  env.RCLONE_CONFIG = path.join(runtimeRoot, "empty.conf");
  env.RCLONE_CACHE_DIR = path.join(runtimeRoot, "cache");
  env.RCLONE_TEMP_DIR = path.join(runtimeRoot, "temp");
  return { ...env, ...extra };
}

function pidAppearsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

async function waitForExit(child, timeoutMs) {
  if (!child || child.exitCode !== null || child.signalCode !== null) {
    return true;
  }
  return Promise.race([
    new Promise((resolve) => child.once("exit", () => resolve(true))),
    new Promise((resolve) => setTimeout(() => resolve(false), timeoutMs))
  ]);
}

async function sha256File(filePath) {
  const handle = await fs.open(filePath, "r");
  const hash = (await import("node:crypto")).createHash("sha256");
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

async function runRequired(binary, args, timeoutMs = 20_000) {
  const result = await runProcess(binary, args, {
    env: baseEnvironment(),
    timeoutMs
  });
  if (result.exitCode !== 0) {
    throw new Error(
      `${path.basename(binary)} exited ${result.exitCode}: ${result.stderr || result.stdout}`
    );
  }
  return result;
}

async function generateKey(filePath) {
  await runRequired(
    SSH_KEYGEN_PATH,
    ["-q", "-t", "ed25519", "-N", "", "-f", filePath]
  );
  return {
    privatePath: filePath,
    publicPath: `${filePath}.pub`
  };
}

async function allocatePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : null;
  await new Promise((resolve) => server.close(resolve));
  if (!port) {
    throw new Error("failed to allocate a loopback port");
  }
  return port;
}

async function waitForPort(port, timeoutMs = 15_000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await portAcceptsConnection(port)) {
      return Date.now() - startedAt;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`SFTP server did not listen on 127.0.0.1:${port}`);
}

async function portAcceptsConnection(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: "127.0.0.1", port });
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
    socket.setTimeout(250, () => {
      socket.destroy();
      resolve(false);
    });
  });
}

async function waitForPortClosed(port, timeoutMs = 5_000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (!(await portAcceptsConnection(port))) {
      return Date.now() - startedAt;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`SFTP listener remained open on 127.0.0.1:${port}`);
}

async function prepareRunDirectory() {
  await fs.mkdir(TASK_ROOT, { recursive: true });
  const timestamp = new Date().toISOString().replaceAll(":", "").replaceAll(".", "-");
  runDir = path.join(TASK_ROOT, timestamp);
  await fs.mkdir(runDir, { recursive: false });
  workRoot = path.join(runDir, `.work-${randomUUID()}`);
  await fs.mkdir(workRoot, { recursive: false });
  assertInside(runDir, workRoot);
}

async function prepareFixture() {
  const lock = JSON.parse(await fs.readFile(LOCK_PATH, "utf8"));
  const expectedSha256 = lock.tools?.rclone?.sha256;
  const actualSha256 = await sha256File(RCLONE_PATH);
  if (
    lock.tools?.rclone?.version !== "1.74.3"
    || actualSha256 !== expectedSha256
  ) {
    throw new Error("locked rclone 1.74.3 binary hash mismatch");
  }

  const roots = path.join(workRoot, "roots");
  const keys = path.join(workRoot, "keys");
  const clients = path.join(workRoot, "clients");
  await Promise.all([
    fs.mkdir(roots, { recursive: true }),
    fs.mkdir(keys, { recursive: true }),
    fs.mkdir(clients, { recursive: true })
  ]);
  evidence.binary = {
    path: repoRelative(RCLONE_PATH),
    version: lock.tools.rclone.version,
    expectedSha256,
    actualSha256,
    hashMatches: actualSha256 === expectedSha256
  };
  const definitions = [
    {
      label: "relation-a",
      user: "relation-a",
      fileName: "relation-a-only.txt",
      content: "relation A isolated content\n"
    },
    {
      label: "relation-b",
      user: "relation-b",
      fileName: "relation-b-only.txt",
      content: "relation B isolated content\n"
    }
  ];
  const prepared = [];
  for (const definition of definitions) {
    const relationRoot = path.join(roots, definition.label);
    await fs.mkdir(relationRoot);
    await fs.writeFile(
      path.join(relationRoot, definition.fileName),
      definition.content,
      { encoding: "utf8", mode: 0o600 }
    );
    const hostKey = await generateKey(
      path.join(keys, `${definition.label}-host_ed25519`)
    );
    const clientKey = await generateKey(
      path.join(keys, `${definition.label}-client_ed25519`)
    );
    const authorizedKeysPath = path.join(
      keys,
      `${definition.label}-authorized_keys`
    );
    await fs.writeFile(
      authorizedKeysPath,
      `${(await fs.readFile(clientKey.publicPath, "utf8")).trim()}\n`,
      { encoding: "utf8", mode: 0o600 }
    );
    const hostPublicKey = (await fs.readFile(hostKey.publicPath, "utf8"))
      .trim()
      .split(/\s+/)
      .slice(0, 2)
      .join(" ");
    const port = await allocatePort();
    const knownHostsPath = path.join(keys, `${definition.label}-known_hosts`);
    await fs.writeFile(
      knownHostsPath,
      `[127.0.0.1]:${port} ${hostPublicKey}\n`,
      { encoding: "utf8", mode: 0o600 }
    );
    const configPath = path.join(clients, `${definition.label}.conf`);
    await fs.writeFile(
      configPath,
      [
        `[${definition.label}]`,
        "type = sftp",
        "host = 127.0.0.1",
        `port = ${port}`,
        `user = ${definition.user}`,
        `key_file = ${clientKey.privatePath.replaceAll("\\", "/")}`,
        `known_hosts_file = ${knownHostsPath.replaceAll("\\", "/")}`,
        "shell_type = unix",
        ""
      ].join("\r\n"),
      { encoding: "utf8", mode: 0o600 }
    );
    await fs.mkdir(path.join(workRoot, "runtime", definition.label, "cache"), {
      recursive: true
    });
    await fs.mkdir(path.join(workRoot, "runtime", definition.label, "temp"), {
      recursive: true
    });
    prepared.push({
      ...definition,
      relationRoot,
      hostKey,
      clientKey,
      authorizedKeysPath,
      knownHostsPath,
      configPath,
      port
    });
  }

  for (const source of prepared) {
    for (const target of prepared) {
      if (source.label === target.label) {
        continue;
      }
      const crossConfigPath = path.join(
        clients,
        `${source.label}-key-to-${target.label}.conf`
      );
      await fs.writeFile(
        crossConfigPath,
        [
          `[${source.label}-key-to-${target.label}]`,
          "type = sftp",
          "host = 127.0.0.1",
          `port = ${target.port}`,
          `user = ${target.user}`,
          `key_file = ${source.clientKey.privatePath.replaceAll("\\", "/")}`,
          `known_hosts_file = ${target.knownHostsPath.replaceAll("\\", "/")}`,
          "shell_type = unix",
          ""
        ].join("\r\n"),
        { encoding: "utf8", mode: 0o600 }
      );
      source.crossConfigs = {
        ...(source.crossConfigs || {}),
        [target.label]: crossConfigPath
      };
    }
  }

  evidence.fixture = {
    relations: prepared.map((relation) => ({
      label: relation.label,
      user: relation.user,
      fileName: relation.fileName,
      contentSha256: sha256(Buffer.from(relation.content, "utf8"))
    })),
    rootsAreDistinct:
      normalized(prepared[0].relationRoot) !== normalized(prepared[1].relationRoot),
    hostKeysAreDistinct:
      normalized(prepared[0].hostKey.privatePath)
      !== normalized(prepared[1].hostKey.privatePath),
    clientKeysAreDistinct:
      normalized(prepared[0].clientKey.privatePath)
      !== normalized(prepared[1].clientKey.privatePath),
    privateKeyMaterialPersisted: false
  };
  return prepared;
}

function startServer(relation) {
  const args = [
    "serve",
    "sftp",
    `:local:${relation.relationRoot}`,
    "--addr",
    `127.0.0.1:${relation.port}`,
    "--authorized-keys",
    relation.authorizedKeysPath,
    "--key",
    relation.hostKey.privatePath,
    "--dir-cache-time",
    "0",
    "--poll-interval",
    "0",
    "--vfs-cache-mode",
    "off",
    "--read-only",
    "--log-level",
    "DEBUG"
  ];
  const child = spawn(RCLONE_PATH, args, {
    cwd: REPO_ROOT,
    env: baseEnvironment(relation.label),
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"]
  });
  const append = (chunk) => {
    const current = serverOutputs.get(relation.label) || "";
    if (current.length < 100_000) {
      serverOutputs.set(
        relation.label,
        current + chunk.toString("utf8").slice(0, 100_000 - current.length)
      );
    }
  };
  child.stdout.on("data", append);
  child.stderr.on("data", append);
  return child;
}

async function readRelation(relation, evidenceLabel = relation.label) {
  const result = await runProcess(
    RCLONE_PATH,
    [
      "cat",
      `${relation.user}:${relation.fileName}`,
      "--retries",
      "1",
      "--low-level-retries",
      "1"
    ],
    {
      env: baseEnvironment(relation.label, { RCLONE_CONFIG: relation.configPath }),
      timeoutMs: 20_000
    }
  );
  const matched = result.exitCode === 0 && result.stdout === relation.content;
  evidence.reads = {
    ...(evidence.reads || {}),
    [evidenceLabel]: {
    status: matched ? "passed" : "failed",
    exitCode: result.exitCode,
    expectedContentSha256: sha256(Buffer.from(relation.content, "utf8")),
    observedContentSha256: sha256(Buffer.from(result.stdout, "utf8")),
    contentMatched: matched,
    stderr: result.stderr
    }
  };
  if (!matched) {
    throw new Error(`${relation.label} read did not return the expected fixture`);
  }
  return evidence.reads[evidenceLabel];
}

async function probeCrossKey(source, target) {
  const result = await runProcess(
    RCLONE_PATH,
    [
      "cat",
      `${source.label}-key-to-${target.label}:${target.fileName}`,
      "--retries",
      "1",
      "--low-level-retries",
      "1"
    ],
    {
      env: baseEnvironment(source.label, {
        RCLONE_CONFIG: source.crossConfigs[target.label]
      }),
      timeoutMs: 20_000
    }
  );
  const authenticationDenied =
    result.exitCode !== 0
    && result.stderr.includes("unable to authenticate");
  evidence.crossKeys = {
    ...(evidence.crossKeys || {}),
    [`${source.label}-key-to-${target.label}`]: {
      status: authenticationDenied ? "passed" : "failed",
      sourceKey: source.label,
      targetServer: target.label,
      denied: authenticationDenied,
      authenticationDenied,
      exitCode: result.exitCode,
      stderr: result.stderr
    }
  };
}

function waitForSshAuthentication(child, timeoutMs = 15_000) {
  let stderr = "";
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error, value) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      child.stderr.off("data", onData);
      child.off("error", onError);
      child.off("exit", onExit);
      if (error) {
        reject(error);
      } else {
        resolve(value);
      }
    };
    const check = () => {
      const authenticatedTo = stderr.includes("Authenticated to");
      const publicKeyObserved = /using\s+"?publickey"?/i.test(stderr);
      if (authenticatedTo && publicKeyObserved) {
        finish(null, {
          authenticated: true,
          authenticatedTo,
          publicKeyObserved,
          stderrTail: stderr.slice(-12_000)
        });
      }
    };
    const onData = (chunk) => {
      if (stderr.length < 100_000) {
        stderr += chunk.toString("utf8").slice(0, 100_000 - stderr.length);
      }
      check();
    };
    const onError = (error) => finish(error);
    const onExit = (exitCode, signalCode) => {
      finish(new Error(
        `SSH exited before authentication: ${exitCode}/${signalCode}: ${stderr}`
      ));
    };
    const timer = setTimeout(() => {
      finish(new Error("SSH authentication evidence timed out"));
    }, timeoutMs);
    child.stderr.on("data", onData);
    child.once("error", onError);
    child.once("exit", onExit);
  });
}

async function probeExistingSessionStop(relationA, relationB) {
  activeSshChild = spawn(
    SSH_PATH,
    [
      "-F",
      "NUL",
      "-vv",
      "-N",
      "-o",
      "BatchMode=yes",
      "-o",
      "IdentitiesOnly=yes",
      "-o",
      "StrictHostKeyChecking=yes",
      "-o",
      `UserKnownHostsFile=${relationA.knownHostsPath}`,
      "-i",
      relationA.clientKey.privatePath,
      "-p",
      String(relationA.port),
      `${relationA.user}@127.0.0.1`
    ],
    {
      cwd: REPO_ROOT,
      env: baseEnvironment(relationA.label),
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    }
  );
  const authentication = await waitForSshAuthentication(activeSshChild);
  await new Promise((resolve) => setTimeout(resolve, 250));
  const aliveBeforeStop =
    activeSshChild.exitCode === null
    && activeSshChild.signalCode === null
    && Number.isInteger(activeSshChild.pid)
    && pidAppearsAlive(activeSshChild.pid);
  const aServerChild = serverChildren.get(relationA.label);
  const serverAliveBeforeStop =
    Boolean(aServerChild)
    && aServerChild.exitCode === null
    && aServerChild.signalCode === null
    && Number.isInteger(aServerChild.pid)
    && pidAppearsAlive(aServerChild.pid);
  const stopStartedAt = Date.now();
  const processCleanup = await stopServer(relationA.label);
  const stopDurationMs = Date.now() - stopStartedAt;
  evidence.server.relations[relationA.label].processCleanup = processCleanup;
  const sshExited = await waitForExit(activeSshChild, 8_000);
  const listenerClosedMs = await waitForPortClosed(relationA.port);
  const newAResult = await runProcess(
    RCLONE_PATH,
    [
      "cat",
      `${relationA.user}:${relationA.fileName}`,
      "--retries",
      "1",
      "--low-level-retries",
      "1"
    ],
    {
      env: baseEnvironment(relationA.label, {
        RCLONE_CONFIG: relationA.configPath
      }),
      timeoutMs: 10_000
    }
  );
  const relationBRead = await readRelation(
    relationB,
    `${relationB.label}-after-${relationA.label}-stop`
  );
  const passed =
    authentication.authenticated
    && aliveBeforeStop
    && serverAliveBeforeStop
    && processCleanup.attempted === true
    && processCleanup.exited
    && !processCleanup.pidStillAlive
    && sshExited
    && newAResult.exitCode !== 0
    && relationBRead.contentMatched;
  evidence.afterAStop = {
    status: passed ? "passed" : "failed",
    sshAuthentication: authentication,
    sshPid: activeSshChild.pid,
    aliveBeforeStop,
    serverAliveBeforeStop,
    sshExited,
    sshExitCode: activeSshChild.exitCode,
    sshSignalCode: activeSshChild.signalCode,
    serverProcessCleanup: processCleanup,
    stopDurationMs,
    aListenerClosedMs: listenerClosedMs,
    aNewConnection: {
      denied: newAResult.exitCode !== 0,
      exitCode: newAResult.exitCode,
      stderr: newAResult.stderr
    },
    relationBRead
  };
  if (!passed) {
    throw new Error("existing A session or new A connection remained usable after A stop");
  }
}

async function stopServer(relationLabel) {
  const child = serverChildren.get(relationLabel);
  if (!child || child.exitCode !== null || child.signalCode !== null) {
    return { attempted: false, exited: true, pidStillAlive: false };
  }
  const pid = child.pid;
  child.kill("SIGTERM");
  let exited = await waitForExit(child, 3_000);
  if (!exited && Number.isInteger(pid)) {
    await runProcess(
      TASKKILL_PATH,
      ["/PID", String(pid), "/T", "/F"],
      { env: baseEnvironment("control"), timeoutMs: 10_000 }
    ).catch(() => {});
    exited = await waitForExit(child, 3_000);
  }
  return {
    attempted: true,
    pid,
    target: "spawned-pid-subtree",
    exited,
    pidStillAlive: Number.isInteger(pid) ? pidAppearsAlive(pid) : false
  };
}

async function cleanupSshChild() {
  if (
    !activeSshChild
    || activeSshChild.exitCode !== null
    || activeSshChild.signalCode !== null
  ) {
    return { attempted: false, exited: true, pidStillAlive: false };
  }
  const pid = activeSshChild.pid;
  activeSshChild.kill("SIGTERM");
  let exited = await waitForExit(activeSshChild, 3_000);
  if (!exited && Number.isInteger(pid)) {
    await runProcess(
      TASKKILL_PATH,
      ["/PID", String(pid), "/T", "/F"],
      { env: baseEnvironment("control"), timeoutMs: 10_000 }
    ).catch(() => {});
    exited = await waitForExit(activeSshChild, 3_000);
  }
  return {
    attempted: true,
    pid,
    target: "spawned-ssh-pid-subtree",
    exited,
    pidStillAlive: Number.isInteger(pid) ? pidAppearsAlive(pid) : false
  };
}

async function removeWorkRoot() {
  if (!workRoot) {
    return { removed: false, reason: "work root was not created" };
  }
  assertInside(runDir, workRoot);
  const stat = await fs.lstat(workRoot);
  if (stat.isSymbolicLink()) {
    throw new Error("work root is a symbolic link");
  }
  await fs.rm(workRoot, { recursive: true, force: false, maxRetries: 5, retryDelay: 200 });
  return {
    removed: !(await fs.lstat(workRoot).then(() => true).catch(() => false)),
    targetWasInsideRunDirectory: true,
    targetWasNotSymlink: true
  };
}

async function main() {
  if (process.platform !== "win32") {
    throw new Error("relation-isolation probe requires Windows");
  }
  await prepareRunDirectory();
  relations = await prepareFixture();
  evidence.server = {
    authMode: "static-authorized-keys",
    dirCacheTime: "0",
    pollInterval: "0",
    vfsCacheMode: "off",
    readOnly: true,
    relations: {}
  };
  for (const relation of relations) {
    serverChildren.set(relation.label, startServer(relation));
  }
  for (const relation of relations) {
    const startupMs = await waitForPort(relation.port);
    evidence.server.relations[relation.label] = {
      host: "127.0.0.1",
      port: relation.port,
      startupMs,
      processCleanup: null
    };
  }
  for (const relation of relations) {
    await readRelation(relation);
  }
  await probeCrossKey(relations[0], relations[1]);
  await probeCrossKey(relations[1], relations[0]);
  if (Object.values(evidence.crossKeys || {}).some((probe) => probe.status !== "passed")) {
    throw new Error("cross-relation client key was accepted");
  }
  await probeExistingSessionStop(relations[0], relations[1]);
}

try {
  await main();
  evidence.status = "passed";
} catch (error) {
  evidence.status = "failed";
  evidence.failures.push({
    scope: "harness",
    message: error instanceof Error ? error.message : String(error)
  });
} finally {
  for (const relation of relations) {
    try {
      const processCleanup = await stopServer(relation.label);
      evidence.server = {
        ...(evidence.server || {}),
        relations: {
          ...(evidence.server?.relations || {}),
          [relation.label]: {
            ...(evidence.server?.relations?.[relation.label] || {}),
            processCleanup
          }
        }
      };
      if (processCleanup.exited !== true || processCleanup.pidStillAlive === true) {
        evidence.status = "failed";
        evidence.failures.push({
          scope: "cleanup",
          message: `${relation.label} server PID still alive`
        });
      }
    } catch (error) {
      evidence.status = "failed";
      evidence.failures.push({
        scope: "cleanup",
        message: `${relation.label}: ${String(error)}`
      });
    }
  }
  try {
    const sshChildCleanup = await cleanupSshChild();
    evidence.cleanup = {
      ...(evidence.cleanup || {}),
      sshChildCleanup
    };
    if (
      sshChildCleanup.exited !== true
      || sshChildCleanup.pidStillAlive === true
    ) {
      evidence.status = "failed";
      evidence.failures.push({
        scope: "cleanup",
        message: "SSH test connection PID still alive"
      });
    }
  } catch (error) {
    evidence.status = "failed";
    evidence.failures.push({
      scope: "cleanup",
      message: `SSH test connection: ${String(error)}`
    });
  }
  try {
    const filesystemCleanup = await removeWorkRoot();
    evidence.cleanup = {
      ...(evidence.cleanup || {}),
      ...filesystemCleanup,
      filesystemCleanup
    };
    if (!evidence.cleanup.removed) {
      evidence.status = "failed";
      evidence.failures.push({ scope: "cleanup", message: "work root still exists" });
    }
  } catch (error) {
    evidence.status = "failed";
    evidence.cleanup = {
      ...(evidence.cleanup || {}),
      removed: false,
      filesystemCleanup: { removed: false, error: String(error) }
    };
    evidence.failures.push({ scope: "cleanup", message: String(error) });
  }
  evidence.server = {
    ...(evidence.server || {}),
    logs: Object.fromEntries(
      [...serverOutputs.entries()].map(([label, output]) => [
        label,
        output.slice(-8_000)
      ])
    )
  };
  evidence.finishedAt = new Date().toISOString();
  evidence.reportPath = runDir ? repoRelative(path.join(runDir, "report.json")) : null;
  if (runDir) {
    await fs.writeFile(
      path.join(runDir, "report.json"),
      `${JSON.stringify(evidence, null, 2)}\n`,
      { encoding: "utf8", mode: 0o600 }
    );
  }
  console.log(JSON.stringify({
    status: evidence.status,
    reportPath: evidence.reportPath,
    readStatuses: Object.fromEntries(
      Object.entries(evidence.reads || {}).map(([label, read]) => [
        label,
        read.status
      ])
    ),
    crossKeyStatuses: Object.fromEntries(
      Object.entries(evidence.crossKeys || {}).map(([label, probe]) => [
        label,
        probe.status
      ])
    ),
    serverExited:
      Object.values(evidence.server?.relations || {}).every(
        (relation) =>
          relation.processCleanup?.exited === true
          && relation.processCleanup?.pidStillAlive === false
      ),
    workRootRemoved: evidence.cleanup?.removed === true,
    failures: evidence.failures.length
  }, null, 2));
  if (evidence.status !== "passed") {
    process.exitCode = 2;
  }
}
