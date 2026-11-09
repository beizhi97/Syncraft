#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
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
  "p2-sftp-reserved-paths"
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
const SFTP_PATH = path.join(path.dirname(SSH_KEYGEN_PATH), "sftp.exe");
const TASKKILL_PATH = path.join(
  process.env.SystemRoot || "C:\\Windows",
  "System32",
  "taskkill.exe"
);

const RESERVED_FILES = [
  ".syncraft-root.json",
  ".syncraft-root.stage-probe"
];
let runDir;
let workRoot;
let serverChild;
let serverOutput = "";
const evidence = {
  schemaVersion: 1,
  kind: "syncraft-p2-sftp-reserved-paths-probe",
  status: "running",
  startedAt: new Date().toISOString(),
  finishedAt: null,
  runId: randomUUID(),
  scope: "Windows-local loopback; exact reserved-path reads and copyto attempts",
  boundaries: [
    "Observed filter behavior only; no general security boundary is established",
    "OpenSSH sftp -b get/put operations do not depend on rclone list filtering",
    "Does not cover aliases, alternate encodings, races, crashes, or N1 ARM64",
    "A finding that a reserved path is readable or writable is not a pass"
  ],
  binary: null,
  fixture: null,
  server: null,
  control: null,
  reservedPaths: {},
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

async function assertNoReparseAncestors(targetPath) {
  const resolved = path.resolve(targetPath);
  const root = path.parse(resolved).root;
  const segments = resolved
    .slice(root.length)
    .split(path.sep)
    .filter(Boolean);
  let current = root;
  const checked = [];
  for (const segment of segments) {
    current = path.join(current, segment);
    let stat;
    try {
      stat = await fs.lstat(current);
    } catch (error) {
      if (error?.code === "ENOENT") {
        break;
      }
      throw error;
    }
    if (stat.isSymbolicLink()) {
      throw new Error(`reparse or symbolic link ancestor detected: ${current}`);
    }
    checked.push(current);
  }
  return {
    checkedExistingAncestors: checked.length,
    method: "Node lstat isSymbolicLink on each existing ancestor"
  };
}

function baseEnvironment(extra = {}) {
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
  const runtimeRoot = path.join(workRoot, "runtime");
  env.RCLONE_CONFIG = path.join(runtimeRoot, "empty.conf");
  env.RCLONE_CACHE_DIR = path.join(runtimeRoot, "cache");
  env.RCLONE_TEMP_DIR = path.join(runtimeRoot, "temp");
  return { ...env, ...extra };
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
    const connected = await new Promise((resolve) => {
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
    if (connected) {
      return Date.now() - startedAt;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`SFTP server did not listen on 127.0.0.1:${port}`);
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

async function prepareRunDirectory() {
  const taskRootCheck = await assertNoReparseAncestors(TASK_ROOT);
  await fs.mkdir(TASK_ROOT, { recursive: true });
  await assertNoReparseAncestors(TASK_ROOT);
  const timestamp = new Date().toISOString().replaceAll(":", "").replaceAll(".", "-");
  runDir = path.join(TASK_ROOT, timestamp);
  await fs.mkdir(runDir, { recursive: false });
  workRoot = path.join(runDir, `.work-${randomUUID()}`);
  await fs.mkdir(workRoot, { recursive: false });
  await assertNoReparseAncestors(workRoot);
  evidence.boundaries.push(
    `Reparse ancestor check before write: ${taskRootCheck.method}`
  );
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

  const root = path.join(workRoot, "root");
  const keys = path.join(workRoot, "keys");
  const clients = path.join(workRoot, "clients");
  const sources = path.join(workRoot, "sources");
  const batches = path.join(workRoot, "batches");
  await Promise.all([
    fs.mkdir(root, { recursive: true }),
    fs.mkdir(keys, { recursive: true }),
    fs.mkdir(clients, { recursive: true }),
    fs.mkdir(sources, { recursive: true }),
    fs.mkdir(batches, { recursive: true }),
    fs.mkdir(path.join(workRoot, "runtime", "cache"), { recursive: true }),
    fs.mkdir(path.join(workRoot, "runtime", "temp"), { recursive: true })
  ]);
  await assertNoReparseAncestors(root);

  const initial = {
    [RESERVED_FILES[0]]: "real marker content\n",
    [RESERVED_FILES[1]]: "real stage content\n",
    "canary.txt": "canary original content\n"
  };
  const rcloneReplacement = "rclone copyto overwrite content\n";
  const rawReplacement = "OpenSSH sftp put overwrite content\n";
  for (const [fileName, content] of Object.entries(initial)) {
    await fs.writeFile(path.join(root, fileName), content, {
      encoding: "utf8",
      mode: 0o600
    });
  }
  const rcloneOverwriteSource = path.join(sources, "rclone-overwrite.txt");
  const rawOverwriteSource = path.join(sources, "sftp-put-overwrite.txt");
  const canarySource = path.join(sources, "canary-updated.txt");
  await fs.writeFile(rcloneOverwriteSource, rcloneReplacement, "utf8");
  await fs.writeFile(rawOverwriteSource, rawReplacement, "utf8");
  await fs.writeFile(canarySource, "canary updated content\n", "utf8");

  const hostKey = await generateKey(path.join(keys, "host_ed25519"));
  const clientKey = await generateKey(path.join(keys, "client_ed25519"));
  const authorizedKeysPath = path.join(keys, "authorized_keys");
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
  const knownHostsPath = path.join(keys, "known_hosts");
  await fs.writeFile(
    knownHostsPath,
    `[127.0.0.1]:${port} ${hostPublicKey}\n`,
    { encoding: "utf8", mode: 0o600 }
  );
  const configPath = path.join(clients, "reserved-paths.conf");
  await fs.writeFile(
    configPath,
    [
      "[reserved-paths]",
      "type = sftp",
      "host = 127.0.0.1",
      `port = ${port}`,
      "user = reserved-paths",
      `key_file = ${clientKey.privatePath.replaceAll("\\", "/")}`,
      `known_hosts_file = ${knownHostsPath.replaceAll("\\", "/")}`,
      "shell_type = unix",
      "md5sum_command = md5sum",
      "sha1sum_command = sha1sum",
      ""
    ].join("\r\n"),
    { encoding: "utf8", mode: 0o600 }
  );

  evidence.binary = {
    path: repoRelative(RCLONE_PATH),
    expectedVersion: lock.tools.rclone.version,
    expectedSha256,
    actualSha256,
    hashMatches: actualSha256 === expectedSha256
  };
  evidence.fixture = {
    user: "reserved-paths",
    reservedFiles: RESERVED_FILES,
    initialSha256: Object.fromEntries(
      Object.entries(initial).map(([fileName, content]) => [
        fileName,
        sha256(Buffer.from(content, "utf8"))
      ])
    ),
    privateKeyMaterialPersisted: false
  };
  return {
    user: "reserved-paths",
    root,
    initial,
    rcloneReplacement,
    rawReplacement,
    rcloneOverwriteSource,
    rawOverwriteSource,
    canarySource,
    batches,
    hostKey,
    clientKey,
    authorizedKeysPath,
    knownHostsPath,
    configPath,
    port
  };
}

function startServer(fixture) {
  const args = [
    "serve",
    "sftp",
    `:local:${fixture.root}`,
    "--addr",
    `127.0.0.1:${fixture.port}`,
    "--authorized-keys",
    fixture.authorizedKeysPath,
    "--key",
    fixture.hostKey.privatePath,
    "--dir-cache-time",
    "0",
    "--poll-interval",
    "0",
    "--vfs-cache-mode",
    "off",
    "--exclude",
    "/.syncraft-root.json",
    "--exclude",
    "/.syncraft-root.stage-*",
    "--log-level",
    "DEBUG"
  ];
  const child = spawn(RCLONE_PATH, args, {
    cwd: REPO_ROOT,
    env: baseEnvironment(),
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"]
  });
  const append = (chunk) => {
    if (serverOutput.length < 150_000) {
      serverOutput += chunk.toString("utf8").slice(0, 150_000 - serverOutput.length);
    }
  };
  child.stdout.on("data", append);
  child.stderr.on("data", append);
  return child;
}

function classifyFailure(stderr) {
  if (/unable to authenticate|Permission denied \(publickey|no supported methods remain/i.test(stderr)) {
    return "authentication";
  }
  if (/connection refused|ECONNREFUSED|connectex|dial tcp|i\/o timeout|connection reset|network is unreachable/i.test(stderr)) {
    return "network";
  }
  if (/config file|didn't find section|invalid config|failed to create file system|no such remote/i.test(stderr)) {
    return "config";
  }
  if (/file does not exist|object not found|no such file|directory not found|error reading source root|not found|permission denied/i.test(stderr)) {
    return "path-rejected";
  }
  return "other";
}

async function runRclone(fixture, args, timeoutMs = 20_000) {
  return runProcess(RCLONE_PATH, args, {
    env: baseEnvironment({ RCLONE_CONFIG: fixture.configPath }),
    timeoutMs
  });
}

function resultBase(result) {
  return {
    exitCode: result.exitCode,
    signalCode: result.signalCode,
    classification: result.exitCode === 0 ? "success" : classifyFailure(result.stderr),
    stderr: result.stderr
  };
}

async function probeReservedRead(fixture, fileName) {
  const result = await runRclone(fixture, [
    "cat",
    `reserved-paths:${fileName}`,
    "--retries",
    "1",
    "--low-level-retries",
    "1"
  ]);
  const expectedSha256 = evidence.fixture.initialSha256[fileName];
  const observedSha256 = sha256(Buffer.from(result.stdout, "utf8"));
  const base = resultBase(result);
  let status = "blocked";
  if (base.classification === "path-rejected") {
    status = "passed";
  } else if (base.classification === "success" && observedSha256 === expectedSha256) {
    status = "finding-readable";
  }
  return {
    ...base,
    status,
    expectedSha256,
    observedSha256,
    contentMatchedOriginal: observedSha256 === expectedSha256
  };
}

async function probeReservedWrite(fixture, fileName) {
  const filePath = path.join(fixture.root, fileName);
  const beforeSha256 = await sha256File(filePath);
  const result = await runRclone(fixture, [
    "copyto",
    fixture.rcloneOverwriteSource,
    `reserved-paths:${fileName}`,
    "--retries",
    "1",
    "--low-level-retries",
    "1"
  ]);
  const afterSha256 = await sha256File(filePath);
  const base = resultBase(result);
  const changed = beforeSha256 !== afterSha256;
  let status = "blocked";
  if (changed) {
    status = "finding-overwritten";
  } else if (base.classification === "path-rejected") {
    status = "passed";
  } else if (base.classification === "success") {
    status = "finding-write-not-observed";
  }
  return {
    ...base,
    status,
    beforeSha256,
    afterSha256,
    contentChanged: changed
  };
}

function batchQuote(filePath) {
  return `"${filePath.replaceAll("\\", "/").replaceAll('"', '""')}"`;
}

async function runOpenSshSftp(fixture, commands) {
  const batchPath = path.join(
    fixture.batches,
    `operation-${randomUUID()}.batch`
  );
  await fs.writeFile(batchPath, `${commands.join("\n")}\n`, {
    encoding: "utf8",
    mode: 0o600
  });
  return runProcess(
    SFTP_PATH,
    [
      "-F",
      "NUL",
      "-b",
      batchPath,
      "-i",
      fixture.clientKey.privatePath,
      "-o",
      "BatchMode=yes",
      "-o",
      "IdentitiesOnly=yes",
      "-o",
      "StrictHostKeyChecking=yes",
      "-o",
      `UserKnownHostsFile=${fixture.knownHostsPath}`,
      "-o",
      "ConnectTimeout=10",
      "-P",
      String(fixture.port),
      `${fixture.user}@127.0.0.1`
    ],
    {
      env: baseEnvironment(),
      timeoutMs: 20_000
    }
  );
}

async function probeRawReservedGet(fixture, fileName) {
  const outputPath = path.join(
    fixture.batches,
    `sftp-get-${randomUUID()}.bin`
  );
  await fs.rm(outputPath, { force: true });
  const result = await runOpenSshSftp(fixture, [
    `get ${batchQuote(`/${fileName}`)} ${batchQuote(outputPath)}`
  ]);
  const observedSha256 = await sha256File(outputPath).catch(() => null);
  const expectedSha256 = evidence.fixture.initialSha256[fileName];
  const base = resultBase(result);
  let status = "blocked";
  if (observedSha256 === expectedSha256) {
    status = "finding-readable";
  } else if (base.classification === "path-rejected" && observedSha256 === null) {
    status = "passed";
  }
  return {
    ...base,
    status,
    expectedSha256,
    observedSha256,
    localFileCreated: observedSha256 !== null,
    contentMatchedOriginal: observedSha256 === expectedSha256
  };
}

async function probeRawReservedPut(fixture, fileName) {
  const filePath = path.join(fixture.root, fileName);
  const beforeSha256 = await sha256File(filePath);
  const result = await runOpenSshSftp(fixture, [
    `put ${batchQuote(fixture.rawOverwriteSource)} ${batchQuote(`/${fileName}`)}`
  ]);
  const afterSha256 = await sha256File(filePath);
  const base = resultBase(result);
  const changed = beforeSha256 !== afterSha256;
  let status = "blocked";
  if (changed) {
    status = "finding-overwritten";
  } else if (base.classification === "path-rejected") {
    status = "passed";
  } else if (base.classification === "success") {
    status = "finding-write-not-observed";
  }
  return {
    ...base,
    status,
    beforeSha256,
    afterSha256,
    contentChanged: changed
  };
}

async function probeCanary(fixture) {
  const beforeRead = await runRclone(fixture, [
    "cat",
    "reserved-paths:canary.txt",
    "--retries",
    "1",
    "--low-level-retries",
    "1"
  ]);
  const write = await runRclone(fixture, [
    "copyto",
    fixture.canarySource,
    "reserved-paths:canary.txt",
    "--retries",
    "1",
    "--low-level-retries",
    "1"
  ]);
  const afterRead = await runRclone(fixture, [
    "cat",
    "reserved-paths:canary.txt",
    "--retries",
    "1",
    "--low-level-retries",
    "1"
  ]);
  const expectedBefore = evidence.fixture.initialSha256["canary.txt"];
  const expectedAfter = sha256(Buffer.from("canary updated content\n", "utf8"));
  const beforeMatched = beforeRead.exitCode === 0
    && sha256(Buffer.from(beforeRead.stdout, "utf8")) === expectedBefore;
  const writeSucceeded = write.exitCode === 0;
  const afterMatched = afterRead.exitCode === 0
    && sha256(Buffer.from(afterRead.stdout, "utf8")) === expectedAfter;
  return {
    status: beforeMatched && writeSucceeded && afterMatched ? "passed" : "failed",
    beforeRead: resultBase(beforeRead),
    write: resultBase(write),
    afterRead: resultBase(afterRead),
    beforeMatched,
    writeSucceeded,
    afterMatched
  };
}

async function stopServer() {
  if (!serverChild || serverChild.exitCode !== null || serverChild.signalCode !== null) {
    return { attempted: false, exited: true, pidStillAlive: false };
  }
  const pid = serverChild.pid;
  serverChild.kill("SIGTERM");
  let exited = await waitForExit(serverChild, 3_000);
  if (!exited && Number.isInteger(pid)) {
    await runProcess(
      TASKKILL_PATH,
      ["/PID", String(pid), "/T", "/F"],
      { env: baseEnvironment(), timeoutMs: 10_000 }
    ).catch(() => {});
    exited = await waitForExit(serverChild, 3_000);
  }
  return {
    attempted: true,
    pid,
    target: "spawned-pid-subtree",
    exited,
    pidStillAlive: Number.isInteger(pid) ? pidAppearsAlive(pid) : false
  };
}

async function removeWorkRoot() {
  if (!workRoot) {
    return { removed: false, reason: "work root was not created" };
  }
  const reparseCheck = await assertNoReparseAncestors(workRoot);
  const stat = await fs.lstat(workRoot);
  if (stat.isSymbolicLink()) {
    throw new Error("work root is a symbolic link");
  }
  await fs.rm(workRoot, {
    recursive: true,
    force: false,
    maxRetries: 5,
    retryDelay: 200
  });
  return {
    removed: !(await fs.lstat(workRoot).then(() => true).catch(() => false)),
    reparseCheck
  };
}

function calculateStatus() {
  if (evidence.failures.length > 0 || evidence.control?.status !== "passed") {
    return "failed";
  }
  const reservedResults = Object.values(evidence.reservedPaths);
  if (
    reservedResults.some((result) =>
      [
        result.read?.status,
        result.write?.status,
        result.rawGet?.status,
        result.rawPut?.status
      ].some((status) =>
        status === "blocked"
      )
    )
  ) {
    return "blocked";
  }
  if (
    reservedResults.some((result) =>
      [
        result.read?.status,
        result.write?.status,
        result.rawGet?.status,
        result.rawPut?.status
      ].some((status) =>
        status?.startsWith("finding-")
      )
    )
  ) {
    return "passed-with-findings";
  }
  return "passed";
}

async function main() {
  if (process.platform !== "win32") {
    throw new Error("reserved-path probe requires Windows");
  }
  await prepareRunDirectory();
  const fixture = await prepareFixture();
  serverChild = startServer(fixture);
  const startupMs = await waitForPort(fixture.port);
  evidence.server = {
    host: "127.0.0.1",
    port: fixture.port,
    startupMs,
    writable: true,
    dirCacheTime: "0",
    pollInterval: "0",
    vfsCacheMode: "off",
    excludePatterns: [
      "/.syncraft-root.json",
      "/.syncraft-root.stage-*"
    ]
  };
  evidence.control = await probeCanary(fixture);
  for (const fileName of RESERVED_FILES) {
    evidence.reservedPaths[fileName] = {
      rawGet: await probeRawReservedGet(fixture, fileName)
    };
  }
  for (const fileName of RESERVED_FILES) {
    evidence.reservedPaths[fileName].read =
      await probeReservedRead(fixture, fileName);
  }
  for (const fileName of RESERVED_FILES) {
    evidence.reservedPaths[fileName].rawPut =
      await probeRawReservedPut(fixture, fileName);
  }
  for (const fileName of RESERVED_FILES) {
    evidence.reservedPaths[fileName].write =
      await probeReservedWrite(fixture, fileName);
  }
}

try {
  await main();
} catch (error) {
  evidence.failures.push({
    scope: "harness",
    message: error instanceof Error ? error.message : String(error)
  });
} finally {
  try {
    const processCleanup = await stopServer();
    evidence.server = {
      ...(evidence.server || {}),
      processCleanup
    };
    if (processCleanup.exited !== true || processCleanup.pidStillAlive === true) {
      evidence.failures.push({
        scope: "cleanup",
        message: "server PID still alive"
      });
    }
  } catch (error) {
    evidence.failures.push({
      scope: "cleanup",
      message: `server cleanup: ${String(error)}`
    });
  }
  try {
    const filesystemCleanup = await removeWorkRoot();
    evidence.cleanup = {
      ...(evidence.cleanup || {}),
      ...filesystemCleanup,
      filesystemCleanup
    };
    if (!filesystemCleanup.removed) {
      evidence.failures.push({
        scope: "cleanup",
        message: "work root still exists"
      });
    }
  } catch (error) {
    evidence.cleanup = {
      ...(evidence.cleanup || {}),
      removed: false,
      filesystemCleanup: { removed: false, error: String(error) }
    };
    evidence.failures.push({
      scope: "cleanup",
      message: `filesystem cleanup: ${String(error)}`
    });
  }
  evidence.server = {
    ...(evidence.server || {}),
    logTail: serverOutput.slice(-12_000)
  };
  evidence.finishedAt = new Date().toISOString();
  evidence.status = calculateStatus();
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
    controlStatus: evidence.control?.status ?? null,
    reservedPaths: Object.fromEntries(
      Object.entries(evidence.reservedPaths).map(([fileName, result]) => [
        fileName,
        {
          rawGet: result.rawGet?.status,
          read: result.read?.status,
          rawPut: result.rawPut?.status,
          write: result.write?.status
        }
      ])
    ),
    serverExited:
      evidence.server?.processCleanup?.exited === true
      && evidence.server?.processCleanup?.pidStillAlive === false,
    workRootRemoved: evidence.cleanup?.removed === true,
    failures: evidence.failures.length
  }, null, 2));
  if (evidence.status === "failed" || evidence.status === "blocked") {
    process.exitCode = 2;
  } else if (evidence.status === "passed-with-findings") {
    process.exitCode = 3;
  }
}
