import { createHash } from "node:crypto";
import {
  chmod,
  copyFile,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";

const root = fileURLToPath(new URL("..", import.meta.url));
const DEFAULT_RECEIPT = join(
  root,
  ".tmp",
  "development-2026-10-21",
  "p2-owner-admission",
  "snapshot-linux-execution-da83dc4a6dc1f14a",
  "parent-limited-arm64-snapshot-acceptance-r1.json"
);
const DEFAULT_ARCHIVE = join(
  root,
  ".tmp",
  "development-2026-10-21",
  "p2-owner-admission",
  "snapshot-linux-execution-da83dc4a6dc1f14a",
  "evidence.tar.gz"
);
const DEFAULT_OUTPUT = join(
  root,
  "server",
  "runtime",
  "native",
  "linux-arm64"
);
const DEFAULT_RECEIPT_SHA256 =
  "f3d229cf865fcf003ed13cef7f5ac2395fafb8d7c495a3e3b59fbea0db2473df";
const DEFAULT_ARCHIVE_SHA256 =
  "8678c8b65f8873f48d2345a9e69f1871ab70080de2dac14abf308a017f60345c";
const ARTIFACT_SHA256 =
  "2d6ea2c63f7eedb8b2e3ecc95ef00499e6f8fdd4ae31125adb76c3f43462dd97";
const ARTIFACT_SIZE = 79_024;
const ARTIFACT_MEMBER =
  "evidence/exported-tmp/development-2026-10-21/p2-owner-admission/owner-state-snapshot-implementation-r1/build/run-cLPoEd/sfsc_owner_lock.node";
const MANIFEST_MEMBER =
  "evidence/exported-tmp/development-2026-10-21/p2-owner-admission/owner-state-snapshot-implementation-r1/build/run-cLPoEd/manifest.json";
const DIGEST = /^[a-f0-9]{64}$/;

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function exactManifest(value) {
  const expected = {
    schemaVersion: "2",
    nativeApiRevision: "2",
    nodeMajor: 22,
    napiVersion: 8,
    platform: "linux",
    arch: "arm64",
    libc: "musl",
    artifactFile: "sfsc_owner_lock.node",
    artifactSizeBytes: ARTIFACT_SIZE,
    artifactSha256: ARTIFACT_SHA256
  };
  if (value === null
    || typeof value !== "object"
    || Array.isArray(value)
    || Object.keys(value).sort().join(",") !== Object.keys(expected).sort().join(",")) {
    throw new Error("accepted native manifest schema does not match");
  }
  for (const [key, wanted] of Object.entries(expected)) {
    if (value[key] !== wanted) {
      throw new Error(`accepted native manifest ${key} does not match`);
    }
  }
  return Object.freeze(value);
}

function parsePaxRecords(bytes, label) {
  const records = new Map();
  let offset = 0;
  while (offset < bytes.length) {
    const space = bytes.indexOf(0x20, offset);
    if (space < 0) {
      throw new Error(`accepted archive has an invalid ${label} length`);
    }
    const lengthText = bytes.subarray(offset, space).toString("ascii");
    if (!/^[0-9]+$/.test(lengthText)) {
      throw new Error(`accepted archive has an invalid ${label} length`);
    }
    const length = Number.parseInt(lengthText, 10);
    const end = offset + length;
    if (!Number.isSafeInteger(length)
      || length <= space - offset + 1
      || end > bytes.length
      || bytes[end - 1] !== 0x0a) {
      throw new Error(`accepted archive has an invalid ${label} record`);
    }
    const record = bytes.subarray(space + 1, end - 1).toString("utf8");
    const equals = record.indexOf("=");
    if (equals <= 0) {
      throw new Error(`accepted archive has an invalid ${label} field`);
    }
    const key = record.slice(0, equals);
    if (!/^[A-Za-z0-9_.-]+$/.test(key) || records.has(key)) {
      throw new Error(`accepted archive has an invalid ${label} key`);
    }
    records.set(key, record.slice(equals + 1));
    offset = end;
  }
  return records;
}

function tarEntry(tar, member) {
  let offset = 0;
  let found = null;
  let nextPax = new Map();
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every(byte => byte === 0)) {
      break;
    }
    const name = header.subarray(0, 100).toString("utf8").replace(/\0.*$/, "");
    const prefix = header.subarray(345, 500).toString("utf8").replace(/\0.*$/, "");
    const path = prefix ? `${prefix}/${name}` : name;
    const sizeText = header.subarray(124, 136).toString("ascii").replace(/\0.*$/, "").trim();
    const size = Number.parseInt(sizeText || "0", 8);
    const type = String.fromCharCode(header[156] || 48);
    if (!Number.isSafeInteger(size) || size < 0) {
      throw new Error("tar member size is invalid");
    }
    const dataStart = offset + 512;
    const dataEnd = dataStart + size;
    if (dataEnd > tar.length) {
      throw new Error("tar member exceeds archive bytes");
    }
    const data = tar.subarray(dataStart, dataEnd);
    const pax = nextPax;
    nextPax = new Map();
    if (type === "x") {
      nextPax = parsePaxRecords(data, "PAX");
      offset = dataStart + Math.ceil(size / 512) * 512;
      continue;
    }
    if (type === "g") {
      parsePaxRecords(data, "global PAX");
      offset = dataStart + Math.ceil(size / 512) * 512;
      continue;
    }
    const exactPath = pax.get("path") || path;
    if (exactPath === member) {
      if (found || !["0", "\0"].includes(type)) {
        throw new Error(`accepted archive contains an invalid or duplicate ${member}`);
      }
      found = Buffer.from(data);
    }
    offset = dataStart + Math.ceil(size / 512) * 512;
  }
  if (!found) {
    throw new Error(`accepted archive does not contain ${member}`);
  }
  return found;
}

function assertReceipt(receipt, archiveBytes) {
  if (receipt?.privateOwnerStateSnapshotArm64SubgateAccepted !== true
    || receipt?.p2Complete !== false
    || receipt?.productionWiringAccepted !== false) {
    throw new Error("owner snapshot acceptance receipt does not retain its accepted non-production scope");
  }
  const reference = receipt.references?.find(entry => (
    entry?.path?.endsWith(
      "snapshot-linux-execution-da83dc4a6dc1f14a/evidence.tar.gz"
    )
  ));
  if (!reference
    || reference.sizeBytes !== archiveBytes.length
    || reference.sha256 !== sha256(archiveBytes)) {
    throw new Error("acceptance receipt does not bind the exact evidence archive");
  }
}

export async function packageNativeRuntime({
  receiptPath = DEFAULT_RECEIPT,
  archivePath = DEFAULT_ARCHIVE,
  outputRoot = DEFAULT_OUTPUT,
  expectedReceiptSha256 = DEFAULT_RECEIPT_SHA256,
  expectedArchiveSha256 = DEFAULT_ARCHIVE_SHA256
} = {}) {
  if (!DIGEST.test(expectedReceiptSha256) || !DIGEST.test(expectedArchiveSha256)) {
    throw new Error("expected receipt and archive SHA-256 values must be lowercase digests");
  }
  const receiptBytes = await readFile(resolve(receiptPath));
  const archiveBytes = await readFile(resolve(archivePath));
  if (sha256(receiptBytes) !== expectedReceiptSha256) {
    throw new Error("owner snapshot acceptance receipt SHA-256 changed");
  }
  if (sha256(archiveBytes) !== expectedArchiveSha256) {
    throw new Error("owner snapshot evidence archive SHA-256 changed");
  }
  let receipt;
  try {
    receipt = JSON.parse(receiptBytes.toString("utf8"));
  } catch {
    throw new Error("owner snapshot acceptance receipt is not valid JSON");
  }
  assertReceipt(receipt, archiveBytes);
  const tar = gunzipSync(archiveBytes);
  const artifact = tarEntry(tar, ARTIFACT_MEMBER);
  const manifestBytes = tarEntry(tar, MANIFEST_MEMBER);
  let manifest;
  try {
    manifest = JSON.parse(manifestBytes.toString("utf8"));
  } catch {
    throw new Error("accepted native manifest is not valid JSON");
  }
  exactManifest(manifest);
  if (artifact.length !== ARTIFACT_SIZE || sha256(artifact) !== ARTIFACT_SHA256) {
    throw new Error("accepted native artifact size or SHA-256 changed");
  }

  const output = resolve(outputRoot);
  await mkdir(output, { recursive: true, mode: 0o755 });
  const artifactTarget = join(output, "sfsc_owner_lock.node");
  const manifestTarget = join(output, "manifest.json");
  const artifactTemp = join(output, ".sfsc_owner_lock.node.tmp");
  const manifestTemp = join(output, ".manifest.json.tmp");
  try {
    await writeFile(artifactTemp, artifact, { mode: 0o644, flag: "w" });
    await writeFile(manifestTemp, manifestBytes, { mode: 0o644, flag: "w" });
    await rename(artifactTemp, artifactTarget);
    await rename(manifestTemp, manifestTarget);
    await chmod(artifactTarget, 0o644);
    await chmod(manifestTarget, 0o644);
  } catch (error) {
    await rm(artifactTemp, { force: true }).catch(() => {});
    await rm(manifestTemp, { force: true }).catch(() => {});
    throw error;
  }
  return Object.freeze({
    receiptPath: resolve(receiptPath),
    receiptSha256: sha256(receiptBytes),
    archivePath: resolve(archivePath),
    archiveSha256: sha256(archiveBytes),
    artifactPath: artifactTarget,
    artifactSha256: sha256(artifact),
    artifactSizeBytes: artifact.length,
    manifestPath: manifestTarget,
    manifestSha256: sha256(manifestBytes),
    platform: manifest.platform,
    arch: manifest.arch,
    libc: manifest.libc,
    nodeMajor: manifest.nodeMajor,
    napiVersion: manifest.napiVersion
  });
}

if (resolve(process.argv[1] || "") === fileURLToPath(import.meta.url)) {
  const result = await packageNativeRuntime();
  console.log(JSON.stringify(result, null, 2));
}
