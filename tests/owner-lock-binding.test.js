import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  access,
  mkdtemp,
  rm,
  writeFile
} from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { loadOwnerLockBinding } from "../src/service/ownerLockBinding.js";
import {
  assertSafeDirectory,
  ensureSafeDirectory
} from "../scripts/lib/owner-lock-evidence-paths.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const windowsSkip = process.platform === "win32"
  ? false
  : "Windows loader rejection regression";

function digest(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

test("Windows loader rejects incompatibility before require", {
  skip: windowsSkip
}, async t => {
  const tempRootChain = await ensureSafeDirectory(root, [".tmp"]);
  const tempRoot = tempRootChain.canonicalTargetPath;
  const createdCaseRoot = await mkdtemp(
    path.join(tempRoot, "owner-lock-binding-")
  );
  const caseRootChain = await assertSafeDirectory(
    root,
    [".tmp", path.basename(createdCaseRoot)]
  );
  const caseRoot = caseRootChain.canonicalTargetPath;
  t.after(async () => {
    await assertSafeDirectory(root, [".tmp"]);
    const cleanupCaseChain = await assertSafeDirectory(
      root,
      [".tmp", path.basename(caseRoot)]
    );
    const resolvedCaseRoot = cleanupCaseChain.canonicalTargetPath;
    await rm(resolvedCaseRoot, { recursive: true, force: false });
    await assert.rejects(
      access(resolvedCaseRoot),
      error => error?.code === "ENOENT"
    );
  });

  const artifactPath = path.join(caseRoot, "placeholder.node");
  const manifestPath = path.join(caseRoot, "manifest.json");
  const artifactBytes = Buffer.from("not a native addon\n");
  await writeFile(artifactPath, artifactBytes, { flag: "wx" });
  const manifest = {
    schemaVersion: "1",
    nodeMajor: Number(process.versions.node.split(".")[0]),
    napiVersion: 8,
    platform: process.platform === "win32" ? "linux" : "win32",
    arch: process.arch,
    libc: "glibc",
    artifactFile: path.basename(artifactPath),
    artifactSizeBytes: artifactBytes.length,
    artifactSha256: digest(artifactBytes)
  };
  await writeFile(
    manifestPath,
    `${JSON.stringify(manifest, null, 2)}\n`,
    { flag: "wx" }
  );

  assert.throws(
    () => loadOwnerLockBinding({ artifactPath, manifestPath }),
    error => error?.code === "owner_lock_artifact_invalid"
      && error?.reason === "platform_mismatch"
      && error?.reason !== "artifact_load_failed"
  );
});
