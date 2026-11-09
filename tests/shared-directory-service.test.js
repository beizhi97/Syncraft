import assert from "node:assert/strict";
import { createHash, createPublicKey, generateKeyPairSync } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createEnrollmentAuthorityState } from "../src/core/enrollmentAuthority.js";
import { createEnrollmentIdentityId } from "../src/core/enrollmentProtocol.js";
import { prepareDirectoryRootRegistration } from "../src/core/directoryRootGuard.js";
import { openRelationServiceBindingCatalog } from "../src/service/relationServiceBindingCatalog.js";
import { createSharedDirectoryService } from "../src/service/sharedDirectoryService.js";

async function tempCase(t) {
  const root = await mkdtemp(join(tmpdir(), "sfsc-shared-dir-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dataDir = join(root, "data", "relation-service");
  const selected = join(root, "selected");
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  await mkdir(selected, { mode: 0o700 });
  return { root, dataDir, selected, catalogPath: join(dataDir, "catalog.json") };
}

test("first directory registration persists pending state, installs a real marker, and survives service restart", async t => {
  const { selected, catalogPath } = await tempCase(t);
  const service = createSharedDirectoryService({ catalogPath });
  assert.deepEqual(await service.list(), []);
  const result = await service.register({ path: selected });
  assert.equal(result.status, "active");
  const markerBytes = await readFile(join(selected, ".syncraft-root.json"));
  const marker = JSON.parse(markerBytes.toString("utf8"));
  assert.equal(marker.rootId, result.rootId);
  assert.equal(marker.kind, "syncraft-directory-root");
  const catalog = await openRelationServiceBindingCatalog({ path: catalogPath, mode: "require-existing" });
  const state = await catalog.read();
  assert.equal(state.roots[result.rootId].status, "active");
  assert.equal(state.roots[result.rootId].rootIdentity.dev.length > 0, true);
  assert.ok(state.roots[result.rootId].mountEvidence);
  assert.ok(state.roots[result.rootId].markerSync.fileSynced);

  const afterRestart = createSharedDirectoryService({ catalogPath });
  const recovered = await afterRestart.register({ path: selected });
  assert.equal(recovered.rootId, result.rootId);
  assert.deepEqual(await readFile(join(selected, ".syncraft-root.json")), markerBytes);
  assert.equal((await catalog.read()).revision, state.revision);
});

test("readiness inspection verifies the current directory marker and write access", async t => {
  const { selected, catalogPath } = await tempCase(t);
  const service = createSharedDirectoryService({ catalogPath });
  const directory = await service.register({ path: selected });
  assert.deepEqual(await service.inspectActiveRoots(), {
    verifiedRootIds: [directory.rootId], activeRootCount: 1, unverifiedRootCount: 0
  });

  await writeFile(join(selected, ".syncraft-root.json"), "replaced marker\n");
  assert.deepEqual(await service.inspectActiveRoots(), {
    verifiedRootIds: [], activeRootCount: 0, unverifiedRootCount: 1
  });
});

test("a persisted pending root is resumed after service restart", async t => {
  const { dataDir, selected, catalogPath } = await tempCase(t);
  const serverId = createEnrollmentIdentityId("serverId");
  const pending = await prepareDirectoryRootRegistration({
    rootPath: selected,
    serverId,
    shareId: createEnrollmentIdentityId("shareId")
  });
  const pair = generateKeyPairSync("ed25519");
  const hostKeyPath = join(dataDir, "server-host-key.pem");
  await writeFile(hostKeyPath, pair.privateKey.export({ format: "pem", type: "pkcs8" }), { mode: 0o600 });
  await chmod(hostKeyPath, 0o600);
  const hostSha256 = createHash("sha256").update(createPublicKey(pair.privateKey).export({ format: "der", type: "spki" })).digest("hex");
  await openRelationServiceBindingCatalog({
    path: catalogPath,
    mode: "create",
    initialState: {
      schemaVersion: "1",
      kind: "syncraft-relation-service-bindings",
      revision: 0,
      authority: createEnrollmentAuthorityState({ serverId }),
      roots: { [pending.rootId]: pending },
      serverHostKey: { path: hostKeyPath, publicKeySha256: hostSha256 },
      relations: {}
    }
  });
  assert.equal(await readFile(join(selected, ".syncraft-root.json")).then(() => true, () => false), false);
  const restarted = createSharedDirectoryService({ catalogPath });
  const result = await restarted.register({ path: selected });
  assert.equal(result.rootId, pending.rootId);
  assert.equal(result.status, "active");
  assert.equal(JSON.parse(await readFile(join(selected, ".syncraft-root.json"), "utf8")).operationId, pending.operationId);
});

test("unknown marker collision is preserved and never replaced", async t => {
  const { selected, catalogPath } = await tempCase(t);
  const markerPath = join(selected, ".syncraft-root.json");
  const original = Buffer.from("unknown-owner-data\n");
  await writeFile(markerPath, original, { flag: "wx" });
  const service = createSharedDirectoryService({ catalogPath });
  await assert.rejects(service.register({ path: selected }), error => error.code === "directory_root_marker_collision");
  assert.deepEqual(await readFile(markerPath), original);
  assert.equal(await readFile(catalogPath).then(() => true, () => false), false);
});

test("nested roots are rejected in both directions before a second marker is written", async t => {
  const first = await tempCase(t);
  const firstService = createSharedDirectoryService({ catalogPath: first.catalogPath });
  await firstService.register({ path: first.selected });
  const child = join(first.selected, "nested");
  await mkdir(child, { mode: 0o700 });
  await assert.rejects(firstService.register({ path: child }), error => error.code === "directory_root_overlap");
  assert.equal(await readFile(join(child, ".syncraft-root.json")).then(() => true, () => false), false);

  const second = await tempCase(t);
  const parent = join(second.selected, "parent");
  const nested = join(parent, "child");
  await mkdir(nested, { recursive: true, mode: 0o700 });
  const secondService = createSharedDirectoryService({ catalogPath: second.catalogPath });
  await secondService.register({ path: nested });
  await assert.rejects(secondService.register({ path: parent }), error => error.code === "directory_root_overlap");
  assert.equal(await readFile(join(parent, ".syncraft-root.json")).then(() => true, () => false), false);
});

test("directory mode accepts a child of the configured shared root", async t => {
  const { root, dataDir } = await tempCase(t);
  const shared = join(root, "published");
  const selected = join(shared, "team");
  await mkdir(selected, { recursive: true, mode: 0o700 });
  const service = createSharedDirectoryService({ catalogPath: join(dataDir, "catalog.json"), directoryRoot: shared });
  assert.equal((await service.register({ path: selected })).status, "active");
});

test("directory mode rejects a sibling with a matching path prefix before catalog or marker writes", async t => {
  const { root, dataDir } = await tempCase(t);
  const shared = join(root, "published");
  const sibling = join(root, "published-escape");
  await mkdir(shared, { mode: 0o700 });
  await mkdir(sibling, { mode: 0o700 });
  const catalogPath = join(dataDir, "catalog.json");
  const service = createSharedDirectoryService({ catalogPath, directoryRoot: shared });
  await assert.rejects(service.register({ path: sibling }), error => error.code === "directory_root_input_invalid");
  assert.equal(await readFile(catalogPath).then(() => true, () => false), false);
  assert.equal(await readFile(join(sibling, ".syncraft-root.json")).then(() => true, () => false), false);
});

test("directory mode rejects symlink escapes and marks previously registered escaped roots unavailable", async t => {
  const { root, dataDir } = await tempCase(t);
  const shared = join(root, "published");
  const selected = join(shared, "team");
  const external = join(root, "external");
  await mkdir(selected, { recursive: true, mode: 0o700 });
  await mkdir(external, { mode: 0o700 });
  const catalogPath = join(dataDir, "catalog.json");
  const service = createSharedDirectoryService({ catalogPath, directoryRoot: shared });
  const registered = await service.register({ path: selected });
  await rm(selected, { recursive: true });
  try { await symlink(external, selected, "junction"); }
  catch (error) {
    if (["EPERM", "EACCES", "ENOTSUP"].includes(error?.code)) return t.skip(`symlink creation unavailable: ${error.code}`);
    throw error;
  }
  await assert.rejects(service.register({ path: selected }), error => error.code === "directory_root_input_invalid");
  assert.deepEqual(await service.list(), [{
    rootId: registered.rootId, status: "pending", path: selected,
    createdAt: registered.createdAt, activatedAt: registered.activatedAt
  }]);
  assert.deepEqual(await service.inspectActiveRoots(), { verifiedRootIds: [], activeRootCount: 0, unverifiedRootCount: 1 });
  const catalog = await openRelationServiceBindingCatalog({ path: catalogPath, mode: "require-existing" });
  assert.equal((await catalog.read()).roots[registered.rootId].status, "active");
});
