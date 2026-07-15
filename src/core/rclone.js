import { buildStorageRemotePath, describeStorageTarget } from "./storage.js";
import { normalizeBandwidthLimit } from "./bandwidth.js";
import { normalizePositiveInteger, normalizeTcpPort } from "./numbers.js";

export function buildRclonePreview(job, options = {}) {
  const localProxyHost = options.localProxyHost || "127.0.0.1";
  const localProxyPort = normalizeTcpPort(options.localProxyPort, {
    field: "localProxyPort",
    defaultValue: 18081
  });
  const proxyUrl = `socks5://${localProxyHost}:${localProxyPort}`;
  const rcloneBin = options.rcloneBin || "rclone";
  const rcloneConfigPath = options.rcloneConfigPath || "";
  const bisyncWorkdir = options.bisyncWorkdir || "";
  const backupDir = options.backupDir || "";
  const destructiveSync = job.direction !== "bidirectional" && Boolean(job.destructiveSync);
  const action = job.direction === "bidirectional" ? "bisync" : destructiveSync ? "sync" : "copy";
  const remotePath = resolveRemotePath(job);
  const storage = describeStorageTarget(job);
  const source = resolveSource(job, remotePath);
  const target = resolveTarget(job, remotePath);
  const bandwidthLimit = normalizeBandwidthLimit(job.bandwidthLimit || "off");
  const transfers = normalizePositiveInteger(job.transfers, { field: "job.transfers", defaultValue: 4 });
  const checkers = normalizePositiveInteger(job.checkers, { field: "job.checkers", defaultValue: 8 });
  const streams = normalizePositiveInteger(job.streams, { field: "job.streams", defaultValue: 8 });
  const retries = normalizePositiveInteger(job.retries, { field: "job.retries", defaultValue: 3 });
  const lowLevelRetries = normalizePositiveInteger(job.lowLevelRetries, { field: "job.lowLevelRetries", defaultValue: 10 });
  const s3UploadConcurrency = normalizePositiveInteger(job.s3UploadConcurrency, {
    field: "job.s3UploadConcurrency",
    defaultValue: streams
  });

  const args = [
    action,
    source,
    target,
    "-P",
    "--stats=1s",
    "--check-first",
    "--transfers",
    String(transfers),
    "--checkers",
    String(checkers),
    "--multi-thread-streams",
    String(streams),
    "--multi-thread-cutoff",
    job.cutoff || "16M",
    "--retries",
    String(retries),
    "--low-level-retries",
    String(lowLevelRetries)
  ];

  if (rcloneConfigPath) {
    args.push("--config", rcloneConfigPath);
  }

  args.push(
    "--s3-upload-concurrency",
    String(s3UploadConcurrency),
    "--s3-chunk-size",
    job.s3ChunkSize || "16M"
  );

  if (job.dryRun) {
    args.push("--dry-run");
  }
  if (destructiveSync) {
    args.push("--max-delete", String(job.safety?.deleteLimit?.maxFiles || 100));
    if (backupDir) {
      args.push("--backup-dir", backupDir);
    }
  }
  if (action === "bisync") {
    args.push("--check-access", "--resilient");
    if (bisyncWorkdir) {
      args.push("--workdir", bisyncWorkdir);
    }
  }
  if (bandwidthLimit !== "off") {
    args.push("--bwlimit", bandwidthLimit);
  }
  for (const pattern of job.exclude || []) {
    if (pattern) {
      args.push("--exclude", pattern);
    }
  }

  const env = {
    HTTP_PROXY: proxyUrl,
    HTTPS_PROXY: proxyUrl,
    ALL_PROXY: proxyUrl,
    NO_PROXY: "127.0.0.1,localhost"
  };

  return {
    executable: rcloneBin,
    args,
    env,
    displayCommand: renderCommand(rcloneBin, args, env),
    remoteConfig: buildRcloneRemoteConfig(storage, job, rcloneBin, rcloneConfigPath),
    storage,
    remotePath,
    safety: {
      usesProcessScopedProxy: true,
      mutatesSystemProxy: false,
      mutatesRoutes: false,
      tunRequired: false,
      muxRequired: false,
      deleteProtection: !destructiveSync
    }
  };
}

function resolveRemotePath(job) {
  if (job.remotePath) {
    return job.remotePath;
  }
  return buildStorageRemotePath(job);
}

function resolveSource(job, remotePath) {
  if (job.direction === "download") {
    return remotePath;
  }
  return job.localPath;
}

function resolveTarget(job, remotePath) {
  if (job.direction === "download") {
    return job.localPath;
  }
  return remotePath;
}

function renderCommand(executable, args, env) {
  const envLines = Object.entries(env).map(([key, value]) => `$env:${key}="${value}"`);
  const command = [executable, ...args.map(quoteArg)].join(" ");
  return [...envLines, command].join("\n");
}

function buildRcloneRemoteConfig(storage, job, rcloneBin, rcloneConfigPath) {
  const accessKeyId = job.accessKeyId || job.s3AccessKeyId || "company-pc1";
  const secretAccessKey = job.secretAccessKey || job.s3SecretAccessKey || "CHANGE_ME_CLIENT_SECRET";
  const args = [
    "config",
    "create",
    storage.remoteName,
    "s3",
    "provider",
    storage.provider,
    "env_auth",
    "false",
    "access_key_id",
    accessKeyId,
    "secret_access_key",
    secretAccessKey,
    "endpoint",
    storage.endpoint,
    "region",
    storage.region
  ];

  if (rcloneConfigPath) {
    args.push("--config", rcloneConfigPath);
  }

  const displayArgs = maskRcloneConfigArgs(args);
  return {
    executable: rcloneBin,
    args,
    displayCommand: [rcloneBin, ...displayArgs.map(quoteArg)].join(" ")
  };
}

function maskRcloneConfigArgs(args) {
  const masked = [...args];
  const secretIndex = masked.indexOf("secret_access_key");
  if (secretIndex >= 0 && secretIndex + 1 < masked.length) {
    masked[secretIndex + 1] = maskSecretValue(masked[secretIndex + 1]);
  }
  return masked;
}

function maskSecretValue(secret) {
  const text = String(secret || "");
  if (text.length <= 4) {
    return "****";
  }
  return `${text.slice(0, 2)}****${text.slice(-2)}`;
}

function quoteArg(value) {
  const text = String(value);
  if (/^[A-Za-z0-9_./:=@,-]+$/.test(text)) {
    return text;
  }
  return `"${text.replace(/"/g, '\\"')}"`;
}
