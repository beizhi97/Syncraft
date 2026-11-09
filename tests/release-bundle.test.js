import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { inflateRawSync } from "node:zlib";
import test from "node:test";
import { createReleaseZip, readZipEntryUnixMetadata } from "../scripts/lib/release-zip.mjs";

const projectRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const fixtureRoot = join(projectRoot, "tests", "fixtures", "release-bundle-mode");
const fixtureZip = join(projectRoot, "tests", "fixtures", "release-bundle-mode-fixture.zip");
const archiveRoot = "release-bundle-mode-fixture";

async function fixtureFiles(root, current = root) {
  const files = [];
  for (const entry of await readdir(current, { withFileTypes: true })) {
    const fullPath = join(current, entry.name);
    if (entry.isDirectory()) {
      files.push(...await fixtureFiles(root, fullPath));
    } else if (entry.isFile()) {
      files.push(relative(root, fullPath).split(sep).join("/"));
    }
  }
  return files.sort();
}

function readEntryData(zipData, name) {
  const endOffset = findEndOfCentralDirectory(zipData);
  assert.notEqual(endOffset, -1, "ZIP end record exists");
  const entryCount = zipData.readUInt16LE(endOffset + 10);
  let offset = zipData.readUInt32LE(endOffset + 16);
  for (let index = 0; index < entryCount; index += 1) {
    assert.equal(zipData.readUInt32LE(offset), 0x02014b50, "central directory entry signature");
    const nameLength = zipData.readUInt16LE(offset + 28);
    const extraLength = zipData.readUInt16LE(offset + 30);
    const commentLength = zipData.readUInt16LE(offset + 32);
    const entryName = zipData.subarray(offset + 46, offset + 46 + nameLength).toString("utf8");
    if (entryName === name) {
      const method = zipData.readUInt16LE(offset + 10);
      const compressedSize = zipData.readUInt32LE(offset + 20);
      const localOffset = zipData.readUInt32LE(offset + 42);
      const localNameLength = zipData.readUInt16LE(localOffset + 26);
      const localExtraLength = zipData.readUInt16LE(localOffset + 28);
      const dataStart = localOffset + 30 + localNameLength + localExtraLength;
      const compressed = zipData.subarray(dataStart, dataStart + compressedSize);
      if (method === 0) return compressed;
      assert.equal(method, 8, "fixture entries use DEFLATE");
      return inflateRawSync(compressed);
    }
    offset += 46 + nameLength + extraLength + commentLength;
  }
  assert.fail(`ZIP entry missing: ${name}`);
}

function findEndOfCentralDirectory(data) {
  for (let offset = data.length - 22; offset >= Math.max(0, data.length - 22 - 0xffff); offset -= 1) {
    if (data.readUInt32LE(offset) === 0x06054b50) return offset;
  }
  return -1;
}

async function assertModeFixture(zipData) {
  const files = await fixtureFiles(fixtureRoot);
  const launcher = `${archiveRoot}/server/runtime/sfsc-runtime-launcher`;
  const ordinary = `${archiveRoot}/server/ordinary.txt`;
  const rootfsRun = `${archiveRoot}/server/rootfs/etc/s6-overlay/s6-rc.d/sfsc-node/run`;
  const rootfsFinish = `${archiveRoot}/server/rootfs/etc/s6-overlay/s6-rc.d/sfsc-node/finish`;
  const native = `${archiveRoot}/server/runtime/native/linux-arm64/relation/fixture-native`;

  for (const [name, expectedPermissions] of [
    [launcher, 0o755],
    [ordinary, 0o644],
    [rootfsRun, 0o755],
    [rootfsFinish, 0o755],
    [native, 0o755]
  ]) {
    const metadata = readZipEntryUnixMetadata(zipData, name);
    assert.deepEqual(metadata, {
      creatorPlatform: 3,
      unixMode: (0o100000 | expectedPermissions),
      fileType: 0o100000,
      permissions: expectedPermissions
    }, `${name} Unix permissions`);
  }

  for (const path of files) {
    const entryName = `${archiveRoot}/${path}`;
    const source = await readFile(join(fixtureRoot, ...path.split("/")));
    const archived = readEntryData(zipData, entryName);
    assert.equal(createHash("sha256").update(archived).digest("hex"), createHash("sha256").update(source).digest("hex"), `${entryName} payload SHA-256`);
  }
}

test("release ZIP preserves Unix executable modes for the server runtime fixture", async (t) => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "sfsc-release-zip-test-"));
  t.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  const outputZip = join(temporaryRoot, "mode-fixture.zip");

  await createReleaseZip({ sourceDirectory: fixtureRoot, outputFile: outputZip, archiveRoot });
  await assertModeFixture(await readFile(outputZip));
  await assertModeFixture(await readFile(fixtureZip));
});
