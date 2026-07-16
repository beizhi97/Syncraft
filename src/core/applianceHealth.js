import { access, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import { join } from "node:path";

export async function checkApplianceHealth(options = {}) {
  const dataDir = options.dataDir || process.env.SERVER_DATA_ROOT || "/data/app";
  const singboxControlDir = options.singboxControlDir || process.env.SINGBOX_CONTROL_DIR || "/data/control";
  const singboxPort = positiveNumber(options.singboxPort || process.env.SINGBOX_LISTEN_PORT || process.env.VLESS_PORT, 45678);
  const rcloneBin = options.rcloneBin || process.env.RCLONE_BIN || "/usr/local/bin/rclone";
  const storageEndpoint = options.storageEndpoint || process.env.S3_ENDPOINT || "http://127.0.0.1:9000";
  const readPid = options.readPid || (() => readSingboxPid(join(singboxControlDir, "singbox.pid")));
  const isProcessAlive = options.isProcessAlive || processAlive;
  const probeTcp = options.probeTcp || isTcpPortListening;
  const probePath = options.probePath || pathProbe;
  const probeStorage = options.probeStorage || storageProbe;

  const [pid, portReady, dataWritable, rcloneReady, endpointReachable] = await Promise.all([
    readPid().catch(() => null),
    probeTcp("127.0.0.1", singboxPort).catch(() => false),
    probePath(dataDir, constants.R_OK | constants.W_OK).catch(() => false),
    probePath(rcloneBin, constants.R_OK | constants.X_OK).catch(() => false),
    probeStorage(storageEndpoint).catch(() => false)
  ]);
  const singboxAlive = Number.isInteger(pid) && pid > 0 && isProcessAlive(pid);
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
      pid: Number.isInteger(pid) ? pid : null
    },
    rclone: {
      ok: Boolean(rcloneReady),
      binaryReady: Boolean(rcloneReady)
    },
    storage: {
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

async function isTcpPortListening(_host, port) {
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
