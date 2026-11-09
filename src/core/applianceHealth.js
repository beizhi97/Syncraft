import { access, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import { join } from "node:path";
import { createConnection } from "node:net";

export async function checkApplianceHealth(options = {}) {
  const dataDir = options.dataDir || process.env.SERVER_DATA_ROOT || "/data/app";
  const singboxControlDir = options.singboxControlDir || process.env.SINGBOX_CONTROL_DIR || "/data/control";
  const singboxHost = String(options.singboxHost || process.env.SINGBOX_PROBE_HOST || "127.0.0.1").trim() || "127.0.0.1";
  const singboxPort = positiveNumber(options.singboxPort || process.env.SINGBOX_LISTEN_PORT || process.env.VLESS_PORT, 45678);
  const rcloneBin = options.rcloneBin || process.env.RCLONE_BIN || "/usr/local/bin/rclone";
  const storageEndpoint = options.storageEndpoint || process.env.S3_ENDPOINT || "http://127.0.0.1:9000";
  const storageMode = options.storageMode || process.env.SFSC_STORAGE_MODE || "s3";
  const directoryMode = storageMode === "directory";
  const directoryRoot = options.directoryRoot || process.env.SFSC_DIRECTORY_ROOT || "";
  const readPid = options.readPid || (() => readSingboxPid(join(singboxControlDir, "singbox.pid")));
  const isProcessAlive = options.isProcessAlive || processAlive;
  const probeTcp = options.probeTcp || isTcpPortListening;
  const probePath = options.probePath || pathProbe;
  const probeStorage = options.probeStorage || storageProbe;

  const [pid, portReady, dataWritable, rcloneReady, endpointReachable, directoryRootWritable] = await Promise.all([
    readPid().catch(() => null),
    probeTcp(singboxHost, singboxPort).catch(() => false),
    probePath(dataDir, constants.R_OK | constants.W_OK).catch(() => false),
    probePath(rcloneBin, constants.R_OK | constants.X_OK).catch(() => false),
    directoryMode ? Promise.resolve(null) : probeStorage(storageEndpoint).catch(() => false),
    directoryMode && directoryRoot
      ? probePath(directoryRoot, constants.R_OK | constants.W_OK).catch(() => false)
      : Promise.resolve(!directoryMode)
  ]);
  // In the all-in-one appliance, the PID and Node process share one namespace.
  // In Compose, sing-box runs in a separate container, so its PID cannot be
  // verified with process.kill() from sync-server. A successful TCP connection
  // to the explicitly configured remote probe host is the liveness evidence.
  const processProbe = isLoopbackHost(singboxHost) ? "pid" : "tcp";
  const singboxAlive = processProbe === "tcp"
    ? Boolean(portReady)
    : Number.isInteger(pid) && pid > 0 && isProcessAlive(pid);
  const checks = {
    node: {
      ok: true,
      pid: process.pid,
      version: process.version
    },
    singbox: {
      ok: Boolean(singboxAlive && portReady),
      processAlive: Boolean(singboxAlive),
      portReady: Boolean(portReady),
      pid: Number.isInteger(pid) ? pid : null,
      host: singboxHost,
      processProbe
    },
    rclone: {
      ok: Boolean(rcloneReady),
      binaryReady: Boolean(rcloneReady)
    },
    storage: directoryMode
      ? {
          ok: Boolean(dataWritable && directoryRootWritable),
          dataWritable: Boolean(dataWritable),
          directoryRootWritable: Boolean(directoryRootWritable),
          mode: "directory"
        }
      : {
          ok: Boolean(dataWritable && endpointReachable),
          dataWritable: Boolean(dataWritable),
          endpointReachable: Boolean(endpointReachable)
        }
  };

  return {
    ok: Object.values(checks).every((check) => check.ok),
    app: "singbox-folder-sync-appliance",
    checkedAt: new Date().toISOString(),
    checks
  };
}

async function readSingboxPid(path) {
  const value = Number((await readFile(path, "utf8")).trim());
  return Number.isInteger(value) && value > 0 ? value : null;
}

function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function pathProbe(path, mode) {
  await access(path, mode);
  return true;
}

async function isTcpPortListening(host, port) {
  if (!isLoopbackHost(host)) {
    return connectTcp(host, port);
  }
  const portHex = Number(port).toString(16).toUpperCase().padStart(4, "0");
  const tables = await Promise.all([
    readFile("/proc/net/tcp", "utf8").catch(() => ""),
    readFile("/proc/net/tcp6", "utf8").catch(() => "")
  ]);
  return tables.some((table) => table
    .split("\n")
    .slice(1)
    .some((line) => {
      const fields = line.trim().split(/\s+/);
      const localPort = fields[1]?.split(":").at(-1)?.toUpperCase();
      return localPort === portHex && fields[3] === "0A";
    }));
}

function connectTcp(host, port) {
  return new Promise((resolve) => {
    const socket = createConnection({ host, port });
    let settled = false;
    const finish = (ready) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(ready);
    };
    socket.setTimeout(1_000);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
  });
}

function isLoopbackHost(host) {
  const normalized = String(host || "").trim().toLowerCase();
  return normalized === "127.0.0.1" || normalized === "localhost" || normalized === "::1" || normalized === "[::1]";
}

async function storageProbe(endpoint) {
  const healthUrl = new URL("/minio/health/live", ensureTrailingSlash(endpoint));
  const response = await fetch(healthUrl, {
    method: "GET",
    redirect: "manual",
    signal: AbortSignal.timeout(1_500)
  });
  return response.ok;
}

function ensureTrailingSlash(value) {
  return String(value || "").endsWith("/") ? String(value) : `${value}/`;
}

function positiveNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}
