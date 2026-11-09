import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  access,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { gunzipSync, gzipSync } from "node:zlib";

import {
  packageNativeRuntime
} from "../scripts/package-native-runtime.mjs";

const root = join(import.meta.dirname, "..");
const defaultReceiptPath = join(
  root,
  ".tmp",
  "development-2026-10-21",
  "p2-owner-admission",
  "snapshot-linux-execution-da83dc4a6dc1f14a",
  "parent-limited-arm64-snapshot-acceptance-r1.json"
);
const defaultArchivePath = join(
  root,
  ".tmp",
  "development-2026-10-21",
  "p2-owner-admission",
  "snapshot-linux-execution-da83dc4a6dc1f14a",
  "evidence.tar.gz"
);
const committedNativeRoot = join(
  root,
  "server",
  "runtime",
  "native",
  "linux-arm64"
);
const archiveMemberPrefix =
  "evidence/exported-tmp/development-2026-10-21/p2-owner-admission/owner-state-snapshot-implementation-r1/build/run-cLPoEd";
const defaultReceiptSha256 =
  "f3d229cf865fcf003ed13cef7f5ac2395fafb8d7c495a3e3b59fbea0db2473df";
const defaultArchiveSha256 =
  "8678c8b65f8873f48d2345a9e69f1871ab70080de2dac14abf308a017f60345c";
const artifactSha256 =
  "2d6ea2c63f7eedb8b2e3ecc95ef00499e6f8fdd4ae31125adb76c3f43462dd97";

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function createTarMember(prefix, name, content) {
  const header = Buffer.alloc(512, 0);
  header.write(name, 0, 100, "utf8");
  header.write(`${content.length.toString(8).padStart(11, "0")}\0`, 124, 12, "ascii");
  header[156] = "0".charCodeAt(0);
  header.write(prefix, 345, 155, "utf8");
  const paddedSize = Math.ceil(content.length / 512) * 512;
  const data = Buffer.alloc(paddedSize, 0);
  content.copy(data);
  return Buffer.concat([header, data]);
}

async function resolveTestFixture(directory) {
  try {
    await access(defaultReceiptPath);
    await access(defaultArchivePath);
    return {
      receiptPath: defaultReceiptPath,
      archivePath: defaultArchivePath,
      receiptSha256: defaultReceiptSha256,
      archiveSha256: defaultArchiveSha256
    };
  } catch {
    const artifactBytes = await readFile(join(committedNativeRoot, "sfsc_owner_lock.node"));
    const manifestBytes = await readFile(join(committedNativeRoot, "manifest.json"));
    const tar = Buffer.concat([
      createTarMember(archiveMemberPrefix, "sfsc_owner_lock.node", artifactBytes),
      createTarMember(archiveMemberPrefix, "manifest.json", manifestBytes),
      Buffer.alloc(1024, 0)
    ]);
    const archiveBytes = gzipSync(tar, { mtime: 0 });
    const archiveSha = sha256(archiveBytes);
    const archiveFile = join(directory, "snapshot-linux-execution-da83dc4a6dc1f14a-evidence.tar.gz");
    await writeFile(archiveFile, archiveBytes);
    const receipt = {
      privateOwnerStateSnapshotArm64SubgateAccepted: true,
      p2Complete: false,
      productionWiringAccepted: false,
      references: [{
        path: ".tmp/development-2026-10-21/p2-owner-admission/snapshot-linux-execution-da83dc4a6dc1f14a/evidence.tar.gz",
        sizeBytes: archiveBytes.length,
        sha256: archiveSha
      }]
    };
    const receiptBytes = Buffer.from(JSON.stringify(receipt, null, 2));
    const receiptFile = join(directory, "parent-limited-arm64-snapshot-acceptance-r1.json");
    await writeFile(receiptFile, receiptBytes);
    return {
      receiptPath: receiptFile,
      archivePath: archiveFile,
      receiptSha256: sha256(receiptBytes),
      archiveSha256: archiveSha
    };
  }
}

async function temporaryDirectory(t) {
  const directory = await mkdtemp(join(tmpdir(), "sfsc-native-package-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test("packages the accepted Linux ARM64 artifact and exact manifest", async t => {
  const directory = await temporaryDirectory(t);
  const { receiptPath, archivePath, receiptSha256, archiveSha256 } =
    await resolveTestFixture(directory);
  const outputRoot = join(directory, "native");
  const result = await packageNativeRuntime({
    receiptPath,
    archivePath,
    outputRoot,
    expectedReceiptSha256: receiptSha256,
    expectedArchiveSha256: archiveSha256
  });
  const artifact = await readFile(join(outputRoot, "sfsc_owner_lock.node"));
  const manifest = JSON.parse(
    await readFile(join(outputRoot, "manifest.json"), "utf8")
  );
  assert.equal(result.artifactSha256, artifactSha256);
  assert.equal(result.artifactSizeBytes, 79_024);
  assert.equal(sha256(artifact), artifactSha256);
  assert.equal(artifact.length, 79_024);
  assert.deepEqual(manifest, {
    schemaVersion: "2",
    nativeApiRevision: "2",
    nodeMajor: 22,
    napiVersion: 8,
    platform: "linux",
    arch: "arm64",
    libc: "musl",
    artifactFile: "sfsc_owner_lock.node",
    artifactSizeBytes: 79_024,
    artifactSha256
  });
  assert.deepEqual(await readdir(outputRoot), [
    "manifest.json",
    "sfsc_owner_lock.node"
  ]);
});

test("rejects a changed acceptance receipt or evidence archive", async t => {
  const directory = await temporaryDirectory(t);
  const { receiptPath, archivePath, receiptSha256, archiveSha256 } =
    await resolveTestFixture(directory);
  const outputRoot = join(directory, "native");
  await assert.rejects(
    packageNativeRuntime({
      receiptPath,
      archivePath,
      outputRoot,
      expectedReceiptSha256: "0".repeat(64),
      expectedArchiveSha256: archiveSha256
    }),
    /acceptance receipt SHA-256 changed/
  );
  await assert.rejects(
    packageNativeRuntime({
      receiptPath,
      archivePath,
      outputRoot,
      expectedReceiptSha256: receiptSha256,
      expectedArchiveSha256: "0".repeat(64)
    }),
    /evidence archive SHA-256 changed/
  );
  await assert.rejects(readdir(outputRoot), { code: "ENOENT" });
});

test("rejects an archive manifest mismatch without creating placeholders", async t => {
  const directory = await temporaryDirectory(t);
  const { receiptPath, archivePath } = await resolveTestFixture(directory);
  const outputRoot = join(directory, "native");
  const compressed = await readFile(archivePath);
  const tar = gunzipSync(compressed);
  const acceptedDigest = Buffer.from(`"artifactSha256": "${artifactSha256}"`);
  const tamperedTar = Buffer.from(tar);
  let occurrences = 0;
  let offset = tamperedTar.indexOf(acceptedDigest);
  while (offset >= 0) {
    tamperedTar[offset + acceptedDigest.length - 2] = "0".charCodeAt(0);
    occurrences += 1;
    offset = tamperedTar.indexOf(
      acceptedDigest,
      offset + acceptedDigest.length
    );
  }
  assert.ok(occurrences >= 1);
  const changed = gzipSync(tamperedTar, { mtime: 0 });
  const changedArchive = join(directory, "evidence.tar.gz");
  await writeFile(changedArchive, changed);
  const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
  receipt.references = [{
    path:
      ".tmp/development-2026-10-21/p2-owner-admission/snapshot-linux-execution-da83dc4a6dc1f14a/evidence.tar.gz",
    sizeBytes: changed.length,
    sha256: sha256(changed)
  }];
  const changedReceipt = join(directory, "acceptance.json");
  const receiptBytes = Buffer.from(JSON.stringify(receipt, null, 2));
  await writeFile(changedReceipt, receiptBytes);
  await assert.rejects(
    packageNativeRuntime({
      receiptPath: changedReceipt,
      archivePath: changedArchive,
      outputRoot,
      expectedReceiptSha256: sha256(receiptBytes),
      expectedArchiveSha256: sha256(changed)
    }),
    /accepted native manifest artifactSha256 does not match/
  );
  await assert.rejects(readdir(outputRoot), { code: "ENOENT" });
});