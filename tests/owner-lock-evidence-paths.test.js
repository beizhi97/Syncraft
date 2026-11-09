import assert from "node:assert/strict";
import {
  access,
  mkdtemp,
  readFile,
  rename,
  rm,
  symlink,
  writeFile
} from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  assertSafeDirectory,
  ensureSafeDirectory
} from "../scripts/lib/owner-lock-evidence-paths.mjs";

const ERROR_CODE = "owner_lock_evidence_path_invalid";
const root = fileURLToPath(new URL("..", import.meta.url));

async function exists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

async function createSandbox() {
  const tempChain = await ensureSafeDirectory(root, [".tmp"]);
  const tempRoot = tempChain.canonicalTargetPath;
  const outerRoot = await mkdtemp(
    path.join(tempRoot, "owner-lock-evidence-paths-")
  );
  const outerChain = await assertSafeDirectory(
    root,
    [".tmp", path.basename(outerRoot)]
  );
  const sandboxRoot = await ensureSafeDirectory(outerRoot, ["sandbox-root"]);
  const outsideRoot = await ensureSafeDirectory(outerRoot, ["outside-target"]);
  return {
    outerRoot: outerChain.canonicalTargetPath,
    sandboxRoot: sandboxRoot.targetPath,
    outsideRoot: outsideRoot.targetPath
  };
}

async function createDirectoryAlias(target, linkPath) {
  await symlink(
    target,
    linkPath,
    process.platform === "win32" ? "junction" : "dir"
  );
}

async function removeSafeDirectory(parent, name) {
  const fullPath = path.join(parent, name);
  if (!await exists(fullPath)) {
    return;
  }
  await assertSafeDirectory(parent, [name]);
  await rm(fullPath, { recursive: true, force: false });
  await assert.rejects(
    access(fullPath),
    error => error?.code === "ENOENT"
  );
}

async function disposeSandbox(sandbox, aliases = []) {
  for (const aliasPath of aliases) {
    if (await exists(aliasPath)) {
      await rm(aliasPath, { recursive: false, force: false });
    }
  }
  await removeSafeDirectory(sandbox.outerRoot, "sandbox-root");
  await removeSafeDirectory(sandbox.outerRoot, "outside-target");
  await assertSafeDirectory(
    root,
    [".tmp", path.basename(sandbox.outerRoot)]
  );
  await rm(sandbox.outerRoot, { recursive: true, force: false });
  await assert.rejects(
    access(sandbox.outerRoot),
    error => error?.code === "ENOENT"
  );
}

test("creates and revalidates a real directory chain", async t => {
  const sandbox = await createSandbox();
  t.after(() => disposeSandbox(sandbox));

  const created = await ensureSafeDirectory(
    sandbox.sandboxRoot,
    ["one", "two", "three"]
  );
  assert.equal(
    created.canonicalTargetPath,
    path.join(
      sandbox.sandboxRoot,
      "one",
      "two",
      "three"
    )
  );
  const checked = await assertSafeDirectory(
    sandbox.sandboxRoot,
    ["one", "two", "three"]
  );
  assert.equal(checked.targetPath, created.targetPath);
});

test("rejects a junction or symlink ancestor and preserves outside sentinel", async t => {
  const sandbox = await createSandbox();
  const aliasPath = path.join(sandbox.sandboxRoot, "alias");
  t.after(() => disposeSandbox(sandbox, [aliasPath]));

  const sentinelPath = path.join(sandbox.outsideRoot, "sentinel.txt");
  await writeFile(sentinelPath, "outside stays intact\n", {
    flag: "wx",
    mode: 0o600
  });
  await createDirectoryAlias(sandbox.outsideRoot, aliasPath);

  await assert.rejects(
    ensureSafeDirectory(sandbox.sandboxRoot, ["alias", "child"]),
    error => error?.code === ERROR_CODE
      && error?.reason === "directory_alias"
  );
  assert.equal(await readFile(sentinelPath, "utf8"), "outside stays intact\n");
  assert.equal(await exists(path.join(sandbox.outsideRoot, "child")), false);
});

test("cleanup validation rejects a replaced case directory", async t => {
  const sandbox = await createSandbox();
  const casePath = path.join(sandbox.sandboxRoot, "case");
  const savedCasePath = path.join(sandbox.sandboxRoot, "case-saved");
  const sentinelPath = path.join(sandbox.outsideRoot, "sentinel.txt");
  t.after(() => disposeSandbox(sandbox, [casePath]));

  await ensureSafeDirectory(sandbox.sandboxRoot, ["case"]);
  await writeFile(sentinelPath, "outside stays intact\n", {
    flag: "wx",
    mode: 0o600
  });
  await rename(casePath, savedCasePath);
  await createDirectoryAlias(sandbox.outsideRoot, casePath);

  await assert.rejects(
    assertSafeDirectory(sandbox.sandboxRoot, ["case"]),
    error => error?.code === ERROR_CODE
      && error?.reason === "directory_alias"
  );
  assert.equal(await readFile(sentinelPath, "utf8"), "outside stays intact\n");
});

test("rejects aliased roots and unsafe path segments", async t => {
  const sandbox = await createSandbox();
  const rootAlias = path.join(sandbox.outerRoot, "root-alias");
  t.after(() => disposeSandbox(sandbox, [rootAlias]));

  await createDirectoryAlias(sandbox.sandboxRoot, rootAlias);
  await assert.rejects(
    assertSafeDirectory(rootAlias),
    error => error?.code === ERROR_CODE
      && error?.reason === "directory_alias"
  );
  for (const segments of [[".."], ["a/b"], [""], ["a\\b"]]) {
    await assert.rejects(
      assertSafeDirectory(sandbox.sandboxRoot, segments),
      error => error?.code === ERROR_CODE
        && error?.reason === "segments_invalid"
    );
  }
});
