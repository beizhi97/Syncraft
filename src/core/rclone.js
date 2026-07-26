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

  const remoteConfig = buildRcloneRemoteConfig(storage, job, rcloneBin, rcloneConfigPath);
  // Positional arguments are the one place a leading `-` turns data into flags.
  // sanitizeRemoteName and validateSyncLocalPath both prevent it upstream; this
  // assertion makes a future regression in either fail loudly instead of
  // silently handing rclone extra options.
  for (const positional of [source, target]) {
    if (String(positional || "").startsWith("-")) {
      throw new Error(`Refusing to run rclone with a flag-like path argument: ${positional}`);
    }
  }
  const env = {
    HTTP_PROXY: proxyUrl,
    HTTPS_PROXY: proxyUrl,
    ALL_PROXY: proxyUrl,
    NO_PROXY: "127.0.0.1,localhost",
    ...remoteConfig.env
  };

  return {
    executable: rcloneBin,
    args,
    env,
    displayCommand: renderCommand(rcloneBin, args, env),
    remoteConfig,
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
  const envLines = Object.entries(env).map(([key, value]) => {
    const displayValue = isSensitiveEnvKey(key) ? maskSecretValue(value) : value;
    return `$env:${key}="${displayValue}"`;
  });
  const command = [executable, ...args.map(quoteArg)].join(" ");
  return [...envLines, command].join("\n");
}

function buildRcloneRemoteConfig(storage, job, rcloneBin, rcloneConfigPath) {
  // These fallbacks only serve the stateless server-side /api/jobs/preview
  // compatibility endpoint, where a caller may omit credentials and gets a
  // display-safe preview back. Client execution paths never rely on them:
  // buildJobFromProfile() fills accessKeyId/secretAccessKey from the hydrated
  // profile (vault-missing throws secret_vault_missing first), and the
  // CHANGE_ME placeholder cannot authenticate against a provisioned MinIO.
  const accessKeyId = job.accessKeyId || job.s3AccessKeyId || "company-pc1";
  const secretAccessKey = job.secretAccessKey || job.s3SecretAccessKey || "CHANGE_ME_CLIENT_SECRET";
  // Keep the secret out of process argv. rclone reads it from
  // RCLONE_CONFIG_<REMOTE>_SECRET_ACCESS_KEY when the remote is used.
  const secretEnvKey = rcloneConfigEnvKey(storage.remoteName, "SECRET_ACCESS_KEY");
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
    "endpoint",
    storage.endpoint,
    "region",
    storage.region
  ];

  if (rcloneConfigPath) {
    args.push("--config", rcloneConfigPath);
  }

  const env = {
    [secretEnvKey]: secretAccessKey
  };
  return {
    executable: rcloneBin,
    args,
    env,
    displayCommand: renderCommand(rcloneBin, args, env)
  };
}

export function rcloneConfigEnvKey(remoteName, field) {
  const remote = String(remoteName || "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  if (!remote) {
    throw new Error("Remote name is required for rclone env config");
  }
  const keyField = String(field || "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  if (!keyField) {
    throw new Error("rclone env config field is required");
  }
  return `RCLONE_CONFIG_${remote}_${keyField}`;
}

function isSensitiveEnvKey(key) {
  const text = String(key || "").toUpperCase();
  if (!text) {
    return false;
  }
  if (text.endsWith("ACCESS_KEY_ID") || text.endsWith("_ACCESS_KEY_ID")) {
    return false;
  }
  return /SECRET|PASSWORD|TOKEN|PRIVATE_KEY|API_KEY/.test(text)
    || text.endsWith("SECRET_ACCESS_KEY");
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
