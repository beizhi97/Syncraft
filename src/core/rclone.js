import {
  assertNoSftpSecretMaterial,
  buildStorageRemotePath,
  describeStorageTarget,
  normalizeSftpTransport
} from "./storage.js";
import { normalizeBandwidthLimit } from "./bandwidth.js";
import { normalizePositiveInteger, normalizeTcpPort } from "./numbers.js";
import { selectBisyncEngine } from "./syncEngine.js";
import { resolve as resolvePath } from "node:path";

export function toRcloneBisyncResyncMode(initialMode) {
  if (initialMode === "local") return "path1";
  if (initialMode === "remote") return "path2";
  if (initialMode === "newer") return "newer";
  throw new TypeError("Unsupported bidirectional initial mode");
}

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
  const storage = describeStorageTarget(job);
  const backend = storage.storageBackend;
  const engine = selectBisyncEngine(backend);
  const sftpTransport = backend === "sftp"
    ? prepareSftpTransport(job, options)
    : null;
  const remotePath = resolveRemotePath(job, storage, backend);
  const recoveryPlan = action === "bisync"
    ? buildBisyncRecoveryPlan(job, remotePath, options.recoveryPreflight)
    : null;
  const source = resolveSource(job, remotePath);
  const target = resolveTarget(job, remotePath);
  const bandwidthLimit = normalizeBandwidthLimit(job.bandwidthLimit || "off");
  const transfers = normalizePositiveInteger(job.transfers, { field: "job.transfers", defaultValue: 4 });
  const checkers = normalizePositiveInteger(job.checkers, { field: "job.checkers", defaultValue: 8 });
  const streams = normalizePositiveInteger(job.streams, { field: "job.streams", defaultValue: 8 });
  const retries = normalizePositiveInteger(job.retries, { field: "job.retries", defaultValue: 3 });
  const lowLevelRetries = normalizePositiveInteger(job.lowLevelRetries, { field: "job.lowLevelRetries", defaultValue: 10 });
  const s3UploadConcurrency = backend === "s3"
    ? normalizePositiveInteger(job.s3UploadConcurrency, {
        field: "job.s3UploadConcurrency",
        defaultValue: streams
      })
    : null;

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

  if (backend === "s3") {
    args.push(
      "--s3-upload-concurrency",
      String(s3UploadConcurrency),
      "--s3-chunk-size",
      job.s3ChunkSize || "16M"
    );
  }
  if (backend === "sftp") {
    // The backend flag wins over an inherited RCLONE_SFTP_SOCKS_PROXY value.
    // Keep the remote-scoped env too, so config creation and backend use agree.
    args.push("--sftp-socks-proxy", sftpTransport.socksProxy);
  }

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
    // Keep the existing engine contract in the argv so the baseline identity
    // and actual conflict behavior cannot drift apart.
    args.push(
      "--check-access",
      "--resilient",
      "--conflict-resolve",
      engine.comparison.conflictResolve,
      "--conflict-loser",
      engine.comparison.conflictLoser,
      "--conflict-suffix",
      engine.comparison.conflictSuffix
    );
    if (backend === "sftp") {
      const rootId = job.syncRelation?.rootId;
      if (typeof rootId !== "string" || !/^root_[A-Za-z0-9_-]{16,128}$/.test(rootId)) {
        throw new Error("SFTP bidirectional sync requires a trusted root ID for its access marker");
      }
      args.push("--check-filename", `.syncraft-access-${rootId}`);
      args.push("--compare", engine.comparison.compare.join(","), "--checksum");
    }
    if (bisyncWorkdir) {
      args.push("--workdir", bisyncWorkdir);
    }
    if (recoveryPlan) {
      args.push(
        "--backup-dir1", recoveryPlan.backupDir1,
        "--backup-dir2", recoveryPlan.backupDir2
      );
      for (const pattern of recoveryPlan.excludePatterns) {
        args.push("--exclude", pattern);
      }
    }
  }
  if (bandwidthLimit !== "off") {
    args.push("--bwlimit", bandwidthLimit);
  }
  const excludePatterns = [
    ...(Array.isArray(job.exclude) ? job.exclude : []),
    ...(backend === "sftp" ? engine.reservedExcludes : [])
  ];
  for (const pattern of new Set(excludePatterns.filter(Boolean))) {
    if (pattern) {
      args.push("--exclude", pattern);
    }
  }

  const remoteConfig = backend === "sftp"
    ? buildSftpRcloneRemoteConfig(storage, sftpTransport, rcloneBin, rcloneConfigPath)
    : buildRcloneRemoteConfig(storage, job, rcloneBin, rcloneConfigPath);
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
      usesProcessScopedProxy: backend === "sftp" ? false : true,
      mutatesSystemProxy: false,
      mutatesRoutes: false,
      tunRequired: false,
      muxRequired: false,
      deleteProtection: !destructiveSync
    }
  };
}

/**
 * Turn a caller's completed, relation-scoped recovery preflight receipt into
 * explicit rclone backup flags. This function validates receipt shape and
 * identity binding; it does not itself inspect either filesystem or listing.
 */
export function buildBisyncRecoveryPlan(job, remotePath, receipt) {
  if (!receipt) return null;
  const relation = job.syncRelation;
  const relationId = relation?.relationId;
  const baselineId = relation?.baselineId;
  const rootId = relation?.rootId;
  const runId = receipt?.runId;
  if (receipt.type !== "bisync-recovery-preflight"
    || receipt.version !== 1
    || receipt.issuer !== "sync-recovery-preflight"
    || receipt.status !== "ready"
    || !["new-relation", "existing-relation-migration"].includes(receipt.preflightKind)
    || receipt.runNamespaceWasEmpty !== true
    || receipt.priorListingNamespaceWasEmpty !== true
    || (receipt.preflightKind === "new-relation" && receipt.migrationStatus !== "not-applicable")
    || (receipt.preflightKind === "existing-relation-migration"
      && (receipt.migrationStatus !== "recorded" || !receipt.migrationRecordId))
    || typeof relationId !== "string"
    || !/^[A-Za-z0-9_-]{1,128}$/.test(relationId)
    || typeof baselineId !== "string"
    || !baselineId
    || typeof rootId !== "string"
    || !/^root_[A-Za-z0-9_-]{16,128}$/.test(rootId)
    || typeof runId !== "string"
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(runId)
    || receipt.relationId !== relationId
    || receipt.baselineId !== baselineId
    || receipt.rootId !== rootId) {
    throw new Error("Bidirectional recovery requires a ready, relation-bound preflight receipt");
  }
  const namespace = `.syncraft-recovery/${relationId}`;
  const runNamespace = `${namespace}/runs/${runId}`;
  const expectedBackupDir1 = resolvePath(job.localPath, ...runNamespace.split("/"), "path1");
  const expectedBackupDir2 = joinRemotePath(remotePath, `${runNamespace}/path2`);
  const expectedExclude = `/${namespace}/**`;
  if (receipt.namespace !== namespace
    || receipt.backupDir1 !== expectedBackupDir1
    || receipt.backupDir2 !== expectedBackupDir2
    || receipt.excludePattern !== expectedExclude) {
    throw new Error("Bidirectional recovery preflight paths do not match the relation namespace");
  }
  return {
    backupDir1: expectedBackupDir1,
    backupDir2: expectedBackupDir2,
    excludePatterns: [expectedExclude],
    namespace,
    migrationRecordId: receipt.migrationRecordId
  };
}

function joinRemotePath(root, child) {
  const normalizedRoot = String(root).replace(/\/+$/, "");
  return normalizedRoot.endsWith(":")
    ? `${normalizedRoot}${String(child).replace(/^\/+/, "")}`
    : `${normalizedRoot}/${String(child).replace(/^\/+/, "")}`;
}

function resolveRemotePath(job, storage, backend) {
  if (backend !== "sftp" && job.remotePath) {
    return job.remotePath;
  }
  return backend === "sftp" ? storage.remotePath : buildStorageRemotePath(job);
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

function buildSftpRcloneRemoteConfig(storage, transport, rcloneBin, rcloneConfigPath) {
  const args = [
    "config",
    "create",
    storage.remoteName,
    "sftp",
    "host",
    transport.host,
    "port",
    String(transport.port),
    "user",
    transport.user,
    "key_file",
    transport.keyFile,
    "known_hosts_file",
    transport.knownHostsFile,
    "socks_proxy",
    transport.socksProxy,
    "key_use_agent",
    "false",
    "ask_password",
    "false"
  ];
  if (rcloneConfigPath) {
    args.push("--config", rcloneConfigPath);
  }
  const env = sftpRemoteConfigEnvironment(storage.remoteName, transport);
  return {
    executable: rcloneBin,
    args,
    env,
    displayCommand: renderCommand(rcloneBin, args, env)
  };
}

function prepareSftpTransport(job, options) {
  assertNoSftpSecretMaterial(job);
  assertNoSftpSecretMaterial(options);
  return normalizeSftpTransport(options.sftpTransport);
}

function sftpRemoteConfigEnvironment(remoteName, transport) {
  const field = (name) => rcloneConfigEnvKey(remoteName, name);
  return {
    [field("TYPE")]: "sftp",
    [field("HOST")]: transport.host,
    [field("PORT")]: String(transport.port),
    [field("USER")]: transport.user,
    [field("KEY_FILE")]: transport.keyFile,
    [field("KNOWN_HOSTS_FILE")]: transport.knownHostsFile,
    [field("SOCKS_PROXY")]: transport.socksProxy,
    [field("KEY_USE_AGENT")]: "false",
    [field("ASK_PASSWORD")]: "false"
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
