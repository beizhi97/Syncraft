const LEGACY_BISYNC_ENGINE = Object.freeze({
  type: "rclone-bisync",
  toolVersion: "1.74.3",
  semanticsVersion: 1,
  comparison: Object.freeze({
    compare: Object.freeze(["size", "modtime"]),
    checkAccess: true,
    checkFirst: true,
    checkSync: true,
    conflictLoser: "num",
    conflictResolve: "none",
    conflictSuffix: "conflict",
    recover: false,
    resilient: true
  })
});

const SFTP_BISYNC_ENGINE = Object.freeze({
  type: "rclone-bisync",
  toolVersion: "1.74.3",
  semanticsVersion: 2,
  comparison: Object.freeze({
    compare: Object.freeze(["size", "modtime", "checksum"]),
    checksum: true,
    checkAccess: true,
    checkFirst: true,
    checkSync: true,
    conflictLoser: "num",
    conflictResolve: "none",
    conflictSuffix: "conflict",
    recover: false,
    resilient: true
  }),
  reservedExcludes: Object.freeze([
    "/.syncraft-root.json",
    "/.syncraft-root.stage-*"
  ])
});

export class SyncEngineSelectionError extends Error {
  constructor() {
    super("Unsupported sync storage backend");
    this.name = "SyncEngineSelectionError";
    this.code = "sync_engine_unsupported";
  }
}

export function selectBisyncEngine(backend) {
  const normalized = String(backend || "").trim().toLowerCase();
  if (normalized === "s3" || normalized === "webdav") {
    return LEGACY_BISYNC_ENGINE;
  }
  if (normalized === "sftp") {
    return SFTP_BISYNC_ENGINE;
  }
  throw new SyncEngineSelectionError();
}
