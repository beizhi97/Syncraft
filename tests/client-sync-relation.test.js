import test from "node:test";
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  applySyncRelationToJob,
  bisyncStateKey,
  buildSyncRelation,
  findBisyncStateEntry,
  legacySyncJobFingerprint,
  markBisyncInitializedState,
  normalizeSyncLocalRoot,
  resolveBisyncMigration,
  resolveLegacyBisyncCompatibility,
  sameSyncRelationBaseline,
  syncRelationConnectionChanged,
  syncRelationRuntimeId
} from "../client/src/syncRelation.js";

const execFileAsync = promisify(execFile);
const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const rclonePath = join(projectRoot, "client", "resources", "bin", "win32", "rclone.exe");

function makeProfile(overrides = {}) {
  return {
    clientName: "pc-one",
    source: { type: "claim", server: "https://sync.example.test:2025" },
    tunnel: {
      parsed: {
        server: "tunnel.example.test",
        port: 45678
      }
    },
    storage: {
      endpoint: "http://minio-one:9000",
      remoteName: "profile-alias-one",
      bucket: "home-sync",
      prefix: "devices/pc-one"
    },
    defaults: {
      localProxyPort: 18081,
      transfers: 4,
      streams: 8,
      checkers: 8
    },
    ...overrides
  };
}

function makeJob(overrides = {}) {
  return {
    name: "projects",
    localPath: "D:\\Projects",
    direction: "bidirectional",
    clientName: "pc-one",
    remoteName: "legacy-alias",
    storageBackend: "s3",
    bucketName: "home-sync",
    remotePrefix: "devices/pc-one/projects",
    remoteFolder: "projects",
    serverSpace: "device",
    localProxyPort: 18081,
    transfers: 4,
    streams: 8,
    checkers: 8,
    ...overrides
  };
}

function makeSftpJob(overrides = {}) {
  const job = makeJob({
    ...overrides,
    storageBackend: "sftp",
    rootPath: Object.hasOwn(overrides, "rootPath")
      ? overrides.rootPath
      : "shares/pc-one/projects"
  });
  delete job.bucketName;
  delete job.remotePath;
  delete job.remotePrefix;
  return job;
}

function makeSftpTransport(overrides = {}) {
  return {
    host: "sftp.sync.example.test",
    port: 2222,
    user: "sync-device",
    socksProxy: "127.0.0.1:18081",
    knownHostsFile: "C:\\App\\data\\known_hosts",
    keyFile: "C:\\App\\data\\sync-device.key",
    hostKeyFingerprint: `SHA256:${"A".repeat(43)}`,
    credentialRevision: "cred_sftp_1",
    ...overrides
  };
}

function trustedBinding(overrides = {}) {
  return {
    serverId: "server-attested-1",
    deviceId: "device-attested-1",
    shareId: "share-attested-1",
    rootId: "root-attested-1",
    relationId: "relation-attested-1",
    baselineEpoch: 3,
    channelRevision: "channel-r1",
    credentialRevision: "credential-r1",
    rootAttestation: "root-proof-r1",
    scope: "device",
    authorization: {
      directions: ["bidirectional", "download"],
      allowDelete: true
    },
    root: {
      backend: "s3",
      bucketName: "home-sync",
      path: "devices/pc-one/projects"
    },
    ...overrides
  };
}

function sftpTrustedBinding(overrides = {}) {
  return trustedBinding({
    rootId: "root-sftp-attested-1",
    relationId: "relation-sftp-attested-1",
    root: {
      backend: "sftp",
      bucketName: "",
      path: "shares/pc-one/projects"
    },
    ...overrides
  });
}

test("trusted relation keeps server IDs and semantics across channel and performance changes", () => {
  const binding = trustedBinding();
  const initial = buildSyncRelation(makeProfile(), makeJob(), { trustedBinding: binding });
  const changedConnection = buildSyncRelation(makeProfile({
    source: { type: "claim", server: "https://new-management.example.test:2025" },
    tunnel: {
      parsed: {
        server: "new-tunnel.example.test",
        port: 45679
      }
    },
    storage: {
      endpoint: "http://minio-two:9000",
      remoteName: "profile-alias-two",
      bucket: "home-sync",
      prefix: "devices/pc-one"
    },
    defaults: {
      localProxyPort: 18123,
      transfers: 12,
      streams: 16,
      checkers: 24
    }
  }), makeJob({
    localProxyPort: 18123,
    transfers: 12,
    streams: 16,
    checkers: 24
  }), {
    trustedBinding: {
      ...binding,
      channelRevision: "channel-r2",
      credentialRevision: "credential-r2"
    }
  });

  assert.equal(initial.relationId, "relation-attested-1");
  assert.equal(initial.baselineEpoch, 3);
  assert.equal(initial.serverIdentityProven, true);
  assert.equal(initial.rootAttested, true);
  assert.equal(sameSyncRelationBaseline(initial, changedConnection), true);
  assert.equal(changedConnection.baselineId, initial.baselineId);
  assert.equal(changedConnection.relationId, initial.relationId);
  assert.equal(changedConnection.rclone.remoteAlias, initial.rclone.remoteAlias);
  assert.equal(syncRelationConnectionChanged(initial, changedConnection), true);
  assert.equal(changedConnection.revisions.channelRevision, "channel-r2");
  assert.equal(changedConnection.revisions.credentialRevision, "credential-r2");
});

test("S3 and WebDAV relation descriptions retain their pre-change golden identities", () => {
  const s3 = buildSyncRelation(makeProfile(), makeJob(), {
    trustedBinding: trustedBinding()
  });
  assert.deepEqual(s3.engine, {
    type: "rclone-bisync",
    toolVersion: "1.74.3",
    semanticsVersion: 1,
    comparison: {
      compare: ["size", "modtime"],
      checkAccess: true,
      checkFirst: true,
      checkSync: true,
      conflictLoser: "num",
      conflictResolve: "none",
      conflictSuffix: "conflict",
      recover: false,
      resilient: true
    }
  });
  assert.equal(s3.baselineId, "7e1d61590be07da4d11b9d04e24fa977bf10e5a8bec3fefe41ae08244044915b");
  assert.equal(s3.rclone.remoteAlias, "sfsc_341d69c7ad8e6b2b82e1");
  assert.equal(s3.rclone.remotePath, "sfsc_341d69c7ad8e6b2b82e1:home-sync/devices/pc-one/projects");

  const webdav = buildSyncRelation(makeProfile({
    storage: {
      endpoint: "https://dav.example.test",
      remoteName: "profile-alias-one",
      bucket: "",
      prefix: "shares/pc-one"
    }
  }), makeJob({
    storageBackend: "webdav",
    bucketName: "",
    remotePrefix: "shares/pc-one/projects"
  }), {
    trustedBinding: trustedBinding({
      rootId: "root-attested-webdav",
      relationId: "relation-attested-webdav",
      rootAttestation: "root-proof-webdav",
      root: {
        backend: "webdav",
        bucketName: "",
        path: "shares/pc-one/projects"
      }
    })
  });
  assert.deepEqual(webdav.engine, s3.engine);
  assert.equal(webdav.baselineId, "7451cb1cccd6fe740f7062a4a99ae456e211aeef6c529dacf99efe10cca4ff2b");
  assert.equal(webdav.rclone.remoteAlias, "sfsc_59ba3e8297a2605abb52");
  assert.equal(webdav.rclone.remotePath, "sfsc_59ba3e8297a2605abb52:shares/pc-one/projects");
});

test("SFTP uses checksum semantics while connection and credential changes keep the baseline", () => {
  const profile = makeProfile();
  const job = makeSftpJob();
  const binding = sftpTrustedBinding();
  const initialTransport = makeSftpTransport();
  const initial = buildSyncRelation(profile, job, {
    trustedBinding: binding,
    sftpTransport: initialTransport
  });
  const s3 = buildSyncRelation(profile, makeJob(), {
    trustedBinding: trustedBinding()
  });

  assert.equal(initial.backend, "sftp");
  assert.equal(initial.engine.semanticsVersion, 2);
  assert.deepEqual(initial.engine.comparison.compare, ["size", "modtime", "checksum"]);
  assert.equal(initial.engine.comparison.checksum, true);
  assert.deepEqual(initial.engine.reservedExcludes, [
    "/.syncraft-root.json",
    "/.syncraft-root.stage-*"
  ]);
  assert.notEqual(initial.baselineId, s3.baselineId);
  assert.equal(initial.remoteRoot.path, "shares/pc-one/projects");
  assert.equal(initial.rclone.remotePath, `${initial.rclone.remoteAlias}:shares/pc-one/projects`);
  assert.deepEqual(initial.connection, {
    serverClaim: "https://sync.example.test:2025",
    tunnelEndpoint: "tunnel.example.test:45678",
    sftpEndpoint: "sftp.sync.example.test:2222",
    sftpUser: "sync-device",
    socksProxy: "127.0.0.1:18081",
    knownHostsFileRef: "C:\\App\\data\\known_hosts",
    keyFileRef: "C:\\App\\data\\sync-device.key",
    hostKeyFingerprint: `SHA256:${"A".repeat(43)}`,
    transportCredentialRevision: "cred_sftp_1",
    channelRevision: "channel-r1",
    credentialRevision: "credential-r1"
  });

  const changed = buildSyncRelation(profile, job, {
    trustedBinding: {
      ...binding,
      channelRevision: "channel-r2",
      credentialRevision: "credential-r2"
    },
    sftpTransport: makeSftpTransport({
      host: "sftp-two.sync.example.test",
      port: 2223,
      socksProxy: "127.0.0.2:18082",
      knownHostsFile: "C:\\App\\data\\known_hosts-r2",
      keyFile: "C:\\App\\data\\sync-device-r2.key",
      hostKeyFingerprint: `SHA256:${"B".repeat(43)}`,
      credentialRevision: "cred_sftp_2"
    })
  });
  assert.equal(changed.baselineId, initial.baselineId);
  assert.equal(changed.rclone.remoteAlias, initial.rclone.remoteAlias);
  assert.equal(sameSyncRelationBaseline(initial, changed), true);
  assert.equal(syncRelationConnectionChanged(initial, changed), true);
  assert.equal(changed.connection.sftpEndpoint, "sftp-two.sync.example.test:2223");
  assert.equal(changed.connection.transportCredentialRevision, "cred_sftp_2");
  assert.equal(changed.connection.credentialRevision, "credential-r2");
});

test("SFTP empty rootPath consistently represents the trusted relation virtual root", () => {
  const relation = buildSyncRelation(makeProfile(), makeSftpJob({ rootPath: "" }), {
    trustedBinding: sftpTrustedBinding({
      root: {
        backend: "sftp",
        bucketName: "",
        path: ""
      }
    }),
    sftpTransport: makeSftpTransport()
  });

  assert.equal(relation.remoteRoot.path, "");
  assert.equal(relation.remoteRoot.rootId, "root-sftp-attested-1");
  assert.equal(relation.rootAttested, true);
  assert.equal(relation.migration.state, "ready");
  assert.equal(relation.rclone.remotePath, `${relation.rclone.remoteAlias}:`);
  assert.equal(
    applySyncRelationToJob(makeSftpJob({ rootPath: "" }), relation).rootPath,
    ""
  );
});

test("SFTP requires exact backend spelling and ignores residual bucket identity", () => {
  const options = {
    trustedBinding: sftpTrustedBinding(),
    sftpTransport: makeSftpTransport()
  };
  for (const storageBackend of ["SFTP", "Sftp", "sFtp", " sftp", "sftp "]) {
    assert.throws(
      () => buildSyncRelation(makeProfile(), {
        ...makeSftpJob(),
        storageBackend
      }, options),
      (error) => error.message === 'SFTP storageBackend must be exactly "sftp"',
      storageBackend
    );
  }

  const withBucket = buildSyncRelation(makeProfile(), makeSftpJob({
    bucketName: "residual-s3-bucket"
  }), options);
  const withoutBucket = buildSyncRelation(makeProfile(), makeSftpJob(), options);
  assert.equal(withBucket.remoteRoot.bucketName, "");
  assert.equal(withBucket.baselineId, withoutBucket.baselineId);
  assert.equal(withBucket.rclone.remotePath, withoutBucket.rclone.remotePath);

  const legacyS3 = buildSyncRelation(makeProfile(), makeJob({
    storageBackend: " S3 "
  }), {
    trustedBinding: trustedBinding()
  });
  const exactS3 = buildSyncRelation(makeProfile(), makeJob(), {
    trustedBinding: trustedBinding()
  });
  assert.equal(legacyS3.baselineId, exactS3.baselineId);

  const legacyWebdav = buildSyncRelation(makeProfile(), makeJob({
    storageBackend: "WebDAV",
    bucketName: "",
    remotePrefix: "shares/pc-one/projects"
  }), {
    trustedBinding: trustedBinding({
      rootId: "root-attested-webdav",
      relationId: "relation-attested-webdav",
      root: {
        backend: "webdav",
        bucketName: "",
        path: "shares/pc-one/projects"
      }
    })
  });
  const exactWebdav = buildSyncRelation(makeProfile(), makeJob({
    storageBackend: "webdav",
    bucketName: "",
    remotePrefix: "shares/pc-one/projects"
  }), {
    trustedBinding: trustedBinding({
      rootId: "root-attested-webdav",
      relationId: "relation-attested-webdav",
      root: {
        backend: "webdav",
        bucketName: "",
        path: "shares/pc-one/projects"
      }
    })
  });
  assert.equal(legacyWebdav.baselineId, exactWebdav.baselineId);
});

test("SFTP relation rejects host paths, remotePath overrides, and secret material", () => {
  const options = {
    trustedBinding: sftpTrustedBinding(),
    sftpTransport: makeSftpTransport()
  };
  for (const rootPath of [
    "/home/sync",
    "C:\\sync",
    "../sync",
    ".",
    "shares/./projects",
    "shares//projects",
    "shares/projects/",
    " ",
    "shares/\nprojects"
  ]) {
    assert.throws(
      () => buildSyncRelation(makeProfile(), makeSftpJob({ rootPath }), options),
      /SFTP rootPath/
    );
  }
  for (const rootPath of [undefined, null, false, 0, [], {}]) {
    assert.throws(
      () => buildSyncRelation(makeProfile(), makeSftpJob({ rootPath }), options),
      /SFTP rootPath/
    );
  }
  for (const override of [
    { remotePath: "sftp-alias:other/root" },
    { remotePrefix: "other/root" }
  ]) {
    assert.throws(
      () => buildSyncRelation(makeProfile(), {
        ...makeSftpJob(),
        ...override
      }, options),
      /rootPath/
    );
  }
  const rawSecret = "SFTP_RELATION_RAW_SECRET_MUST_NOT_ECHO";
  for (const [job, changedOptions] of [
    [{ ...makeSftpJob(), password: rawSecret }, options],
    [makeSftpJob(), {
      ...options,
      sftpTransport: { ...options.sftpTransport, privateKey: rawSecret }
    }]
  ]) {
    assert.throws(
      () => buildSyncRelation(makeProfile(), job, changedOptions),
      (error) => (
        error.message === "SFTP secret material must stay outside jobs and transport options"
        && !error.message.includes(rawSecret)
      )
    );
  }

  const pemSentinel = "SFTP_RELATION_PEM_VALUE_MUST_NOT_ECHO";
  const privateKeyPem = `-----BEGIN OPENSSH PRIVATE KEY-----\n${pemSentinel}\n-----END OPENSSH PRIVATE KEY-----`;
  for (const field of ["clientName", "localPath"]) {
    assert.throws(
      () => buildSyncRelation(makeProfile(), {
        ...makeSftpJob(),
        [field]: privateKeyPem
      }, options),
      (error) => (
        error.message === "SFTP secret material must stay outside jobs and transport options"
        && !error.message.includes(pemSentinel)
        && !error.message.includes("PRIVATE KEY")
      ),
      field
    );
  }
});

test("profile claims remain unverified and cannot make endpoint changes trusted", () => {
  const initial = buildSyncRelation(makeProfile({
    serverId: "claimed-by-payload",
    identity: {
      serverId: "claimed-by-payload",
      serverIdAttested: true
    }
  }), makeJob());
  const endpointChanged = buildSyncRelation(makeProfile({
    serverId: "claimed-by-payload",
    identity: {
      serverId: "claimed-by-payload",
      serverIdAttested: true
    },
    storage: {
      endpoint: "http://minio-two:9000",
      remoteName: "profile-alias-two",
      bucket: "home-sync",
      prefix: "devices/pc-one"
    }
  }), makeJob());

  assert.equal(initial.serverIdentityProven, false);
  assert.equal(initial.rootAttested, false);
  assert.equal(initial.identityAssurance, "unverified-profile-claims");
  assert.equal(sameSyncRelationBaseline(initial, endpointChanged), true);
  assert.equal(syncRelationConnectionChanged(initial, endpointChanged), true);
});

test("semantic relation changes cannot reuse a prior baseline", () => {
  const binding = trustedBinding();
  const initial = buildSyncRelation(makeProfile(), makeJob(), { trustedBinding: binding });
  for (const [label, job, bindingOverride] of [
    ["actual root path", makeJob({ remotePrefix: "devices/pc-one/other" }), {
      root: { backend: "s3", bucketName: "home-sync", path: "devices/pc-one/other" }
    }],
    ["authorization", makeJob(), {
      authorization: { directions: ["download"], allowDelete: false }
    }],
    ["comparison semantics", makeJob({ exclude: ["**/cache/**"] }), {}],
    ["relation identity", makeJob(), { relationId: "relation-attested-2" }],
    ["baseline epoch", makeJob(), { baselineEpoch: 4 }]
  ]) {
    const changed = buildSyncRelation(makeProfile(), job, {
      trustedBinding: { ...binding, ...bindingOverride }
    });
    assert.equal(sameSyncRelationBaseline(initial, changed), false, label);
  }
});

test("trusted bindings validate actual root and support non-S3 roots", () => {
  const mismatch = buildSyncRelation(makeProfile(), makeJob(), {
    trustedBinding: trustedBinding({
      root: {
        backend: "s3",
        bucketName: "other-bucket",
        path: "devices/pc-one/projects"
      }
    })
  });
  assert.equal(mismatch.migration.state, "review_required");
  assert.deepEqual(mismatch.migration.reasons, ["trusted_binding_root_mismatch"]);

  const webdav = buildSyncRelation(makeProfile(), makeJob({
    storageBackend: "webdav",
    bucketName: "",
    remotePrefix: "shares/projects"
  }), {
    trustedBinding: trustedBinding({
      root: {
        backend: "webdav",
        bucketName: "",
        path: "shares/projects"
      }
    })
  });
  assert.equal(webdav.migration.state, "ready");
  assert.equal(webdav.rootAttested, true);
  assert.equal(webdav.rclone.remotePath, `${webdav.rclone.remoteAlias}:shares/projects`);

  const webdavRoot = buildSyncRelation(makeProfile(), makeJob({
    storageBackend: "webdav",
    bucketName: "",
    remotePrefix: ""
  }), {
    trustedBinding: trustedBinding({
      root: {
        backend: "webdav",
        bucketName: "",
        path: ""
      }
    })
  });
  assert.equal(webdavRoot.migration.state, "ready");
  assert.equal(webdavRoot.rootAttested, true);
  assert.equal(webdavRoot.remoteRoot.path, "");
  assert.equal(webdavRoot.rclone.remotePath, `${webdavRoot.rclone.remoteAlias}:`);

  const s3Root = buildSyncRelation(makeProfile(), makeJob({
    remotePrefix: ""
  }), {
    trustedBinding: trustedBinding({
      root: {
        backend: "s3",
        bucketName: "home-sync",
        path: ""
      }
    })
  });
  assert.equal(s3Root.migration.state, "ready");
  assert.equal(s3Root.remoteRoot.path, "");

  const exactPath = buildSyncRelation(makeProfile(), makeJob({
    storageBackend: "webdav",
    bucketName: "",
    remotePrefix: "shares/projects"
  }), {
    trustedBinding: trustedBinding({
      root: {
        backend: "webdav",
        bucketName: "",
        path: " shares/projects "
      }
    })
  });
  assert.equal(exactPath.migration.state, "review_required");
  assert.deepEqual(exactPath.migration.reasons, ["trusted_binding_root_mismatch"]);
});

test("bisync state lookup requires complete identity and semantic fields", () => {
  const relation = buildSyncRelation(makeProfile(), makeJob(), {
    trustedBinding: trustedBinding()
  });
  const state = markBisyncInitializedState({}, relation, {
    initializedAt: "2026-10-19T12:00:00.000Z",
    workdir: "C:\\runtime\\bisync\\relation"
  });
  assert.ok(findBisyncStateEntry(state, relation));

  for (const mutate of [
    (entry) => { delete entry.relationId; },
    (entry) => { delete entry.remoteRoot; },
    (entry) => { entry.baselineEpoch += 1; },
    (entry) => { entry.engine.comparison.checkSync = false; },
    (entry) => { entry.authorization.directions = ["download"]; },
    (entry) => { entry.remotePath = `${entry.remoteAlias}:other/path`; }
  ]) {
    const damaged = structuredClone(state);
    mutate(damaged.baselines[bisyncStateKey(relation)]);
    assert.equal(findBisyncStateEntry(damaged, relation), null);
  }
});

test("legacy bisync state is reusable only with the exact stored execution and workdir", () => {
  const relation = buildSyncRelation(makeProfile(), makeJob());
  const storedJob = makeJob();
  const legacyFingerprint = legacySyncJobFingerprint(storedJob);
  const runtimeBisyncRoot = "C:\\runtime";
  const runtimeId = legacyRuntimeId(legacyFingerprint);
  const workdir = join(runtimeBisyncRoot, "bisync", runtimeId);
  const legacy = resolveBisyncMigration(relation, {
    [legacyFingerprint]: {
      initializedAt: "2026-01-01T00:00:00.000Z",
      workdir
    }
  }, {
    runtimeBisyncRoot,
    runtimeDirectoryIds: new Set([runtimeId]),
    legacyJob: {
      storedJob,
      candidateJob: storedJob
    }
  });
  assert.equal(legacy.migration.state, "legacy_compatible");
  assert.equal(legacy.rclone.remoteAlias, "legacy-alias");
  assert.equal(normalizeSyncLocalRoot(legacy.rclone.workdir), normalizeSyncLocalRoot(workdir));

  const changedThreads = resolveLegacyBisyncCompatibility(relation, {
    state: {
      [legacyFingerprint]: {
        initializedAt: "2026-01-01T00:00:00.000Z",
        workdir
      }
    },
    storedJob,
    candidateJob: { ...storedJob, streams: 16 },
    runtimeBisyncRoot,
    runtimeDirectoryIds: new Set([runtimeId])
  });
  assert.equal(changedThreads.migration.state, "migration_required");
  assert.deepEqual(changedThreads.migration.reasons, ["legacy_execution_parameters_changed"]);

  const wrongWorkdir = resolveLegacyBisyncCompatibility(relation, {
    state: {
      [legacyFingerprint]: {
        initializedAt: "2026-01-01T00:00:00.000Z",
        workdir: join(runtimeBisyncRoot, "bisync", "other")
      }
    },
    storedJob,
    candidateJob: storedJob,
    runtimeBisyncRoot,
    runtimeDirectoryIds: new Set([runtimeId])
  });
  assert.equal(wrongWorkdir.migration.state, "migration_required");
  assert.deepEqual(wrongWorkdir.migration.reasons, ["legacy_workdir_mismatch"]);
});

test("legacy bisync ambiguity is blocked while unrelated runtime directories do not block a new relation", () => {
  const relationOne = buildSyncRelation(makeProfile(), makeJob());
  const relationTwo = buildSyncRelation(makeProfile(), makeJob({
    localPath: "D:\\ProjectsTwo",
    remotePrefix: "devices/pc-one/projects-two",
    remoteFolder: "projects-two"
  }));
  const state = markBisyncInitializedState({}, relationOne, {
    initializedAt: "2026-10-19T12:00:00.000Z",
    workdir: join("C:\\runtime", "bisync", syncRelationRuntimeId(relationOne))
  });
  const relationOneReady = resolveBisyncMigration(relationOne, state, {
    runtimeBisyncRoot: "C:\\runtime",
    runtimeDirectoryIds: new Set([syncRelationRuntimeId(relationOne)])
  });
  const relationTwoReady = resolveBisyncMigration(relationTwo, state, {
    runtimeBisyncRoot: "C:\\runtime",
    runtimeDirectoryIds: new Set([syncRelationRuntimeId(relationOne)])
  });
  assert.equal(relationOneReady.migration.state, "ready");
  assert.equal(relationTwoReady.migration.state, "ready");

  const storedJob = makeJob();
  const firstFingerprint = legacySyncJobFingerprint(storedJob);
  const secondFingerprint = legacySyncJobFingerprint({ ...storedJob, retries: 9 });
  const runtimeBisyncRoot = "C:\\runtime";
  const runtimeId = legacyRuntimeId(firstFingerprint);
  const ambiguous = resolveLegacyBisyncCompatibility(relationOne, {
    state: {
      [firstFingerprint]: {
        initializedAt: "2026-01-01T00:00:00.000Z",
        workdir: join(runtimeBisyncRoot, "bisync", runtimeId)
      },
      [secondFingerprint]: {
        initializedAt: "2026-01-02T00:00:00.000Z",
        workdir: join(runtimeBisyncRoot, "bisync", legacyRuntimeId(secondFingerprint))
      }
    },
    storedJob,
    candidateJob: storedJob,
    runtimeBisyncRoot,
    runtimeDirectoryIds: new Set([runtimeId])
  });
  assert.equal(ambiguous.migration.state, "migration_required");
  assert.deepEqual(ambiguous.migration.reasons, ["ambiguous_legacy_bisync_state"]);

  const unmapped = resolveBisyncMigration(relationOne, {}, {
    runtimeDirectoryIds: new Set([syncRelationRuntimeId(relationOne)])
  });
  assert.equal(unmapped.migration.state, "migration_required");
  assert.deepEqual(unmapped.migration.reasons, ["unmapped_bisync_runtime_state"]);
});

test("local roots use Windows case-insensitive canonical form", () => {
  assert.equal(
    normalizeSyncLocalRoot("D:\\Work\\Folder\\"),
    normalizeSyncLocalRoot("d:/work/folder")
  );
});

test("locked rclone continues bisync through loopback WebDAV endpoint switch using app-generated relation", {
  skip: process.platform !== "win32"
}, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "sfsc-rclone-relation-"));
  const servers = [];
  t.after(async () => {
    for (const proc of servers) {
      if (proc.exitCode === null) {
        proc.kill("SIGTERM");
      }
    }
    await Promise.all(servers.map((proc) => Promise.race([
      once(proc, "exit"),
      new Promise((resolve) => setTimeout(() => {
        if (proc.exitCode === null) {
          proc.kill("SIGKILL");
        }
        resolve();
      }, 2000))
    ]).catch(() => {})));
    await rm(root, { recursive: true, force: true });
  });
  const left = join(root, "left");
  const right = join(root, "right");
  const relation = buildSyncRelation(makeProfile(), makeJob({
    localPath: left,
    direction: "bidirectional",
    storageBackend: "webdav",
    bucketName: "",
    remotePrefix: "shares/projects"
  }), {
    trustedBinding: trustedBinding({
      root: {
        backend: "webdav",
        bucketName: "",
        path: "shares/projects"
      }
    })
  });
  const workdir = join(root, "runtime", "bisync", syncRelationRuntimeId(relation));
  const config = join(root, "rclone.conf");
  await Promise.all([
    mkdir(left, { recursive: true }),
    mkdir(join(right, "shares", "projects"), { recursive: true }),
    mkdir(workdir, { recursive: true })
  ]);
  await Promise.all([
    writeFile(join(left, "RCLONE_TEST"), "shared\n", "utf8"),
    writeFile(join(right, "shares", "projects", "RCLONE_TEST"), "shared\n", "utf8")
  ]);

  const portA = await getFreePort();
  const portB = await getFreePort();
  const serverA = spawn(rclonePath, [
    "serve",
    "webdav",
    right,
    "--addr",
    `127.0.0.1:${portA}`,
    "--log-level",
    "ERROR"
  ], {
    cwd: root,
    stdio: "ignore",
    windowsHide: true,
    env: { ...process.env, NO_PROXY: "127.0.0.1,localhost" }
  });
  const serverB = spawn(rclonePath, [
    "serve",
    "webdav",
    right,
    "--addr",
    `127.0.0.1:${portB}`,
    "--log-level",
    "ERROR"
  ], {
    cwd: root,
    stdio: "ignore",
    windowsHide: true,
    env: { ...process.env, NO_PROXY: "127.0.0.1,localhost" }
  });
  servers.push(serverA, serverB);
  await Promise.all([
    waitForWebdav(portA),
    waitForWebdav(portB)
  ]);
  await writeWebdavConfig(config, portA, relation.rclone.remoteAlias);

  const baseArgs = buildRelationBisyncArgs({
    localPath: left,
    remotePath: relation.rclone.remotePath,
    workdir,
    config
  });
  await execFileAsync(rclonePath, [
    ...baseArgs,
    "--resync",
    "--resync-mode",
    "path1",
    "--verbose"
  ], {
    cwd: root,
    env: { ...process.env, NO_PROXY: "127.0.0.1,localhost" },
    timeout: 30000
  });
  const listingsBefore = await readdir(workdir);
  assert.ok(listingsBefore.some((name) => name.includes(relation.rclone.remoteAlias)));

  await writeFile(join(right, "shares", "projects", "from-endpoint-b.txt"), "continued without resync\n", "utf8");
  await writeWebdavConfig(config, portB, relation.rclone.remoteAlias);

  await execFileAsync(rclonePath, [
    ...baseArgs,
    "--verbose"
  ], {
    cwd: root,
    env: { ...process.env, NO_PROXY: "127.0.0.1,localhost" },
    timeout: 30000
  });
  assert.equal(await readFile(join(left, "from-endpoint-b.txt"), "utf8"), "continued without resync\n");

  await writeFile(join(left, "from-endpoint-a.txt"), "uploaded through endpoint A\n", "utf8");
  await writeWebdavConfig(config, portA, relation.rclone.remoteAlias);
  await execFileAsync(rclonePath, [
    ...baseArgs,
    "--verbose"
  ], {
    cwd: root,
    env: { ...process.env, NO_PROXY: "127.0.0.1,localhost" },
    timeout: 30000
  });
  assert.equal(
    await readFile(join(right, "shares", "projects", "from-endpoint-a.txt"), "utf8"),
    "uploaded through endpoint A\n"
  );

  const listingsAfter = await readdir(workdir);
  for (const listing of listingsBefore) {
    assert.ok(listingsAfter.includes(listing), `original bisync listing was not preserved: ${listing}`);
  }
  assert.ok(listingsAfter.every((name) => name.includes(relation.rclone.remoteAlias)));
});

function legacyRuntimeId(fingerprintKey) {
  return createHash("sha256").update(fingerprintKey).digest("hex").slice(0, 24);
}

async function writeWebdavConfig(file, port, remoteAlias) {
  await writeFile(file, [
    `[${remoteAlias}]`,
    "type = webdav",
    `url = http://127.0.0.1:${port}/`,
    "vendor = rclone"
  ].join("\n"), "utf8");
}

function buildRelationBisyncArgs({ localPath, remotePath, workdir, config }) {
  return [
    "bisync",
    localPath,
    remotePath,
    "-P",
    "--stats=1s",
    "--check-first",
    "--transfers",
    "4",
    "--checkers",
    "8",
    "--multi-thread-streams",
    "8",
    "--multi-thread-cutoff",
    "16M",
    "--retries",
    "3",
    "--low-level-retries",
    "10",
    "--config",
    config,
    "--check-access",
    "--resilient",
    "--workdir",
    workdir
  ];
}

async function waitForWebdav(port) {
  const deadline = Date.now() + 5000;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/`, {
        method: "PROPFIND",
        headers: { depth: "0" }
      });
      if (response.status < 500) {
        return;
      }
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw lastError || new Error(`WebDAV server on ${port} did not start`);
}

async function getFreePort() {
  const server = createNetServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();
  server.close();
  await once(server, "close");
  return port;
}

test("same relation with a changed initialized baseline is blocked before legacy reuse", () => {
  const initializedRelation = buildSyncRelation(makeProfile(), makeJob(), {
    trustedBinding: trustedBinding()
  });
  const state = markBisyncInitializedState({}, initializedRelation, {
    initializedAt: "2026-10-19T12:00:00.000Z",
    workdir: join("C:\\runtime", "bisync", syncRelationRuntimeId(initializedRelation))
  });
  const candidate = {
    ...structuredClone(initializedRelation),
    baselineId: "future-engine-baseline",
    engine: {
      ...structuredClone(initializedRelation.engine),
      type: "future-engine"
    }
  };
  const resolved = resolveBisyncMigration(candidate, state, {
    runtimeDirectoryIds: [],
    legacyJob: {
      storedJob: makeJob(),
      candidateJob: makeJob()
    }
  });

  assert.equal(resolved.migration.state, "migration_required");
  assert.deepEqual(resolved.migration.reasons, ["sync_relation_existing_baseline_changed"]);
});

test("damaged exact baseline state is blocked before legacy reuse", () => {
  const relation = buildSyncRelation(makeProfile(), makeJob(), {
    trustedBinding: trustedBinding()
  });
  const state = markBisyncInitializedState({}, relation, {
    initializedAt: "2026-10-19T12:00:00.000Z",
    workdir: join("C:\\runtime", "bisync", syncRelationRuntimeId(relation))
  });
  state.baselines[bisyncStateKey(relation)].engine.type = "mismatched-engine";

  const resolved = resolveBisyncMigration(relation, state, {
    runtimeDirectoryIds: [],
    legacyJob: {
      storedJob: makeJob(),
      candidateJob: makeJob()
    }
  });

  assert.equal(resolved.migration.state, "migration_required");
  assert.deepEqual(resolved.migration.reasons, ["sync_relation_baseline_state_mismatch"]);
});

test("an initialized baseline for a different relation does not block a new candidate", () => {
  const initializedRelation = buildSyncRelation(makeProfile(), makeJob(), {
    trustedBinding: trustedBinding()
  });
  const candidate = buildSyncRelation(makeProfile(), makeJob(), {
    trustedBinding: trustedBinding({ relationId: "relation-attested-2" })
  });
  const state = markBisyncInitializedState({}, initializedRelation, {
    initializedAt: "2026-10-19T12:00:00.000Z",
    workdir: join("C:\\runtime", "bisync", syncRelationRuntimeId(initializedRelation))
  });

  const resolved = resolveBisyncMigration(candidate, state, {
    runtimeDirectoryIds: []
  });

  assert.equal(resolved.migration.state, "ready");
});

test("a complete exact baseline continues despite historical state for the same relation", () => {
  const relation = buildSyncRelation(makeProfile(), makeJob(), {
    trustedBinding: trustedBinding()
  });
  const exactWorkdir = join("C:\\runtime", "bisync", syncRelationRuntimeId(relation));
  const state = markBisyncInitializedState({}, relation, {
    initializedAt: "2026-10-19T12:00:00.000Z",
    workdir: exactWorkdir
  });
  const historical = structuredClone(state.baselines[bisyncStateKey(relation)]);
  historical.baselineId = `${relation.baselineId}-historical`;
  historical.engine.type = "historical-engine";
  state.baselines[`${historical.baselineId}:${historical.baselineEpoch}`] = historical;

  const resolved = resolveBisyncMigration(relation, state, {
    runtimeDirectoryIds: [syncRelationRuntimeId(relation)]
  });

  assert.equal(resolved.migration.state, "ready");
  assert.equal(resolved.rclone.remoteAlias, relation.rclone.remoteAlias);
  assert.equal(normalizeSyncLocalRoot(resolved.rclone.workdir), normalizeSyncLocalRoot(exactWorkdir));
});

test("an initialized S3 baseline blocks an SFTP candidate for the same relation", () => {
  const initializedRelation = buildSyncRelation(makeProfile(), makeJob(), {
    trustedBinding: trustedBinding()
  });
  const state = markBisyncInitializedState({}, initializedRelation, {
    initializedAt: "2026-10-19T12:00:00.000Z",
    workdir: join("C:\\runtime", "bisync", syncRelationRuntimeId(initializedRelation))
  });
  const candidate = buildSyncRelation(makeProfile(), makeSftpJob(), {
    trustedBinding: sftpTrustedBinding({
      serverId: trustedBinding().serverId,
      deviceId: trustedBinding().deviceId,
      shareId: trustedBinding().shareId,
      relationId: trustedBinding().relationId,
      baselineEpoch: trustedBinding().baselineEpoch
    }),
    sftpTransport: makeSftpTransport()
  });

  const resolved = resolveBisyncMigration(candidate, state, {
    runtimeDirectoryIds: [],
    legacyJob: {
      storedJob: makeJob(),
      candidateJob: makeSftpJob()
    }
  });
  assert.equal(resolved.migration.state, "migration_required");
  assert.deepEqual(resolved.migration.reasons, ["sync_relation_existing_baseline_changed"]);
});

test("damaged exact SFTP baseline state is blocked", () => {
  const relation = buildSyncRelation(makeProfile(), makeSftpJob(), {
    trustedBinding: sftpTrustedBinding(),
    sftpTransport: makeSftpTransport()
  });
  const state = markBisyncInitializedState({}, relation, {
    initializedAt: "2026-10-19T12:00:00.000Z",
    workdir: join("C:\\runtime", "bisync", syncRelationRuntimeId(relation))
  });
  state.baselines[bisyncStateKey(relation)].engine.comparison.checksum = false;

  const resolved = resolveBisyncMigration(relation, state, {
    runtimeDirectoryIds: []
  });
  assert.equal(resolved.migration.state, "migration_required");
  assert.deepEqual(resolved.migration.reasons, ["sync_relation_baseline_state_mismatch"]);
});

test("SFTP never reuses legacy compatibility", () => {
  const relation = buildSyncRelation(makeProfile(), makeSftpJob(), {
    trustedBinding: sftpTrustedBinding(),
    sftpTransport: makeSftpTransport()
  });
  assert.equal(resolveLegacyBisyncCompatibility(relation, {
    storedJob: makeJob(),
    candidateJob: makeSftpJob()
  }), null);

  const resolved = resolveBisyncMigration(relation, {}, {
    runtimeDirectoryIds: [],
    legacyJob: {
      storedJob: makeJob(),
      candidateJob: makeSftpJob()
    }
  });
  assert.equal(resolved.migration.state, "ready");
  assert.notEqual(resolved.migration.state, "legacy_compatible");
});
