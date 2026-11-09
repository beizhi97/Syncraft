import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { parseBisyncListing } from "../client/src/syncRecovery.js";
import { toRcloneBisyncResyncMode } from "../src/core/rclone.js";

const execFileAsync = promisify(execFile);
const projectRoot = join(import.meta.dirname, "..");
const rcloneBin = join(projectRoot, "client", "resources", "bin", "win32", "rclone.exe");
const accessMarker = ".syncraft-access-root_0123456789abcdef";

async function run(args) {
  try {
    const result = await execFileAsync(rcloneBin, args, { encoding: "utf8", timeout: 30000 });
    return { ok: true, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    return { ok: false, stdout: String(error.stdout || ""), stderr: String(error.stderr || error.message || "") };
  }
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function withPair(callback) {
  const base = await mkdtemp(join(tmpdir(), "sfsc-bisync-safety-"));
  const path1 = join(base, "path1");
  const path2 = join(base, "path2");
  const workdir = join(base, "workdir");
  await Promise.all([mkdir(path1), mkdir(path2), mkdir(workdir)]);
  await Promise.all([
    writeFile(join(path1, accessMarker), "root marker\n"),
    writeFile(join(path2, accessMarker), "root marker\n")
  ]);
  // The product creates one marker and copies it to the paired root, keeping
  // its timestamp. Give this local-pair fixture the same property so host
  // filesystem write timing does not create an unrelated bisync mismatch.
  const markerTime = new Date("2020-01-02T03:04:05.000Z");
  await Promise.all([
    utimes(join(path1, accessMarker), markerTime, markerTime),
    utimes(join(path2, accessMarker), markerTime, markerTime)
  ]);
  try {
    return await callback({ base, path1, path2, workdir });
  } finally {
    await rm(base, { recursive: true, force: true });
  }
}

function bisyncArgs(path1, path2, workdir, extra = []) {
  return [
    "bisync", path1, path2,
    "--check-access", "--check-filename", accessMarker,
    "--resilient",
    "--compare", "size,modtime,checksum", "--checksum",
    "--workdir", workdir,
    ...extra
  ];
}

test("locked bisync preserves both concurrent versions with the declared engine semantics", async () => {
  await withPair(async ({ base, path1, path2, workdir }) => {
    const sharedName = "collision.txt";
    const baseBytes = Buffer.from("before conflict\n");
    await Promise.all([
      writeFile(join(path1, sharedName), baseBytes),
      writeFile(join(path2, sharedName), baseBytes)
    ]);
    const commonBaseMtime = new Date("2020-01-02T03:04:05.000Z");
    await Promise.all([
      utimes(join(path1, sharedName), commonBaseMtime, commonBaseMtime),
      utimes(join(path2, sharedName), commonBaseMtime, commonBaseMtime)
    ]);
    const initialized = await run(bisyncArgs(path1, path2, workdir, ["--resync", "--resync-mode", "path1"]));
    assert.equal(initialized.ok, true, initialized.stderr);

    const path1Version = Buffer.from("local side edit\n");
    const path2Version = Buffer.from("remote side edit is longer\n");
    await Promise.all([
      writeFile(join(path1, sharedName), path1Version),
      writeFile(join(path2, sharedName), path2Version)
    ]);
    const conflicts = await run(bisyncArgs(path1, path2, workdir, [
      "--conflict-resolve", "none",
      "--conflict-loser", "num",
      "--conflict-suffix", "conflict"
    ]));
    assert.equal(conflicts.ok, true, conflicts.stderr);

    const readTree = async root => {
      const entries = [];
      for (const item of await (await import("node:fs/promises")).readdir(root, { withFileTypes: true })) {
        if (item.isFile() && item.name !== accessMarker) {
          const bytes = await readFile(join(root, item.name));
          entries.push({ name: item.name, sha256: sha256(bytes), text: bytes.toString("utf8") });
        }
      }
      return entries;
    };
    const afterConflict = { path1: await readTree(path1), path2: await readTree(path2) };
    for (const entries of Object.values(afterConflict)) {
      assert.equal(entries.length, 2, JSON.stringify(entries));
      assert.deepEqual(
        entries.map(item => item.sha256).sort(),
        [sha256(path1Version), sha256(path2Version)].sort(),
        JSON.stringify(entries)
      );
      assert.ok(entries.every(item => item.name.startsWith(`${sharedName}.conflict`)), JSON.stringify(entries));
    }

    const deletedName = "delete-me.txt";
    const deletedBytes = Buffer.from("keep this deleted version\n");
    await writeFile(join(path1, deletedName), deletedBytes);
    const createFile = await run(bisyncArgs(path1, path2, workdir));
    assert.equal(createFile.ok, true, createFile.stderr);
    await rm(join(path1, deletedName));
    const recoveryNamespace = join(".syncraft-recovery", "relation-test", "runs");
    const run1 = "54d8894a-5f3f-49c8-bdfb-8bdc3ad2a16d";
    const path1Backup = join(path1, recoveryNamespace, run1, "path1");
    const path2Backup = join(path2, recoveryNamespace, run1, "path2");
    const deleted = await run(bisyncArgs(path1, path2, workdir, [
      "--backup-dir1", path1Backup,
      "--backup-dir2", path2Backup,
      "--exclude", "/.syncraft-recovery/relation-test/**"
    ]));
    assert.equal(deleted.ok, true, deleted.stderr);
    assert.equal(
      sha256(await readFile(join(path2Backup, deletedName))),
      sha256(deletedBytes)
    );

    const replacementBytes = Buffer.from("recreated version after deletion\n");
    await writeFile(join(path1, deletedName), replacementBytes);
    const recreate = await run(bisyncArgs(path1, path2, workdir, [
      "--exclude", "/.syncraft-recovery/relation-test/**"
    ]));
    assert.equal(recreate.ok, true, recreate.stderr);
    const overwrittenBytes = Buffer.from("newer replacement content\n");
    await writeFile(join(path1, deletedName), overwrittenBytes);
    const run2 = "7ecfcb34-3991-42d5-89ee-391b7a7238c8";
    const path1Backup2 = join(path1, recoveryNamespace, run2, "path1");
    const path2Backup2 = join(path2, recoveryNamespace, run2, "path2");
    const overwrite = await run(bisyncArgs(path1, path2, workdir, [
      "--backup-dir1", path1Backup2,
      "--backup-dir2", path2Backup2,
      "--exclude", "/.syncraft-recovery/relation-test/**"
    ]));
    assert.equal(overwrite.ok, true, overwrite.stderr);
    assert.equal(sha256(await readFile(join(path2Backup2, deletedName))), sha256(replacementBytes));
    assert.equal(sha256(await readFile(join(path2Backup, deletedName))), sha256(deletedBytes));
    const listTree = async root => {
      const entries = [];
      const visit = async (directory, relative = "") => {
        for (const item of await (await import("node:fs/promises")).readdir(directory, { withFileTypes: true })) {
          const childRelative = relative ? `${relative}/${item.name}` : item.name;
          const child = join(directory, item.name);
          if (item.isDirectory()) await visit(child, childRelative);
          else entries.push({ name: childRelative, sha256: sha256(await readFile(child)) });
        }
      };
      await visit(root);
      return entries;
    };
    const remaining = { path1: await listTree(path1), path2: await listTree(path2) };
    assert.equal(remaining.path1.find(item => item.name === deletedName)?.sha256, sha256(overwrittenBytes));
    assert.equal(remaining.path2.find(item => item.name === deletedName)?.sha256, sha256(overwrittenBytes));
  });
});

test("product local and remote initial modes map to rclone choices and select the intended side", async () => {
  for (const item of [
    { productMode: "local", rcloneMode: "path1", expected: "local side\n" },
    { productMode: "remote", rcloneMode: "path2", expected: "remote side\n" }
  ]) {
    await withPair(async ({ path1, path2, workdir }) => {
      await Promise.all([
        writeFile(join(path1, "initial-choice.txt"), "local side\n"),
        writeFile(join(path2, "initial-choice.txt"), "remote side\n")
      ]);
      const sharedMtime = new Date("2020-01-02T03:04:05.000Z");
      await Promise.all([
        utimes(join(path1, "initial-choice.txt"), sharedMtime, sharedMtime),
        utimes(join(path2, "initial-choice.txt"), sharedMtime, sharedMtime)
      ]);

      const rcloneMode = toRcloneBisyncResyncMode(item.productMode);
      assert.equal(rcloneMode, item.rcloneMode);
      const initialized = await run(bisyncArgs(path1, path2, workdir, ["--resync", "--resync-mode", rcloneMode]));
      assert.equal(initialized.ok, true, initialized.stderr);
      const checked = await run(bisyncArgs(path1, path2, workdir, ["--check-sync=true"]));
      assert.equal(checked.ok, true, checked.stderr);
      assert.equal(await readFile(join(path1, "initial-choice.txt"), "utf8"), item.expected);
      assert.equal(await readFile(join(path2, "initial-choice.txt"), "utf8"), item.expected);
    });
  }
  assert.throws(() => toRcloneBisyncResyncMode("path1"), /Unsupported bidirectional initial mode/);
  assert.throws(() => toRcloneBisyncResyncMode("untrusted-mode"), /Unsupported bidirectional initial mode/);
});

test("locked rclone bisync listing entries parse with nested, spaced, and Unicode names", async () => {
  await withPair(async ({ path1, path2, workdir }) => {
    await mkdir(join(path1, "empty directory"), { recursive: true });
    await mkdir(join(path1, "nested folder"), { recursive: true });
    await writeFile(join(path1, "nested folder", "quoted ' name.txt"), "quoted\n");
    await writeFile(join(path1, "space name.txt"), "spaces\n");
    await writeFile(join(path1, "unicode-你好.txt"), "unicode\n");
    const initialized = await run(bisyncArgs(path1, path2, workdir, [
      "--resync", "--resync-mode", "path1", "--create-empty-src-dirs"
    ]));
    assert.equal(initialized.ok, true, initialized.stderr);
    const listingFile = (await (await import("node:fs/promises")).readdir(workdir)).find(name => name.endsWith(".path1.lst"));
    assert.ok(listingFile);
    const listing = await readFile(join(workdir, listingFile), "utf8");
    const names = parseBisyncListing(listing);
    assert.ok(names.includes("empty directory"), listing);
    assert.ok(names.includes("nested folder/quoted ' name.txt"), listing);
    assert.ok(names.includes("space name.txt"), listing);
    assert.ok(names.includes("unicode-你好.txt"), listing);
  });
});

test("locked rclone hashsum hashes an exact file with download fallback", async () => {
  await withPair(async ({ path1 }) => {
    const content = Buffer.from("hash source\n");
    const file = join(path1, "hash source.txt");
    await writeFile(file, content);
    const result = await run(["hashsum", "sha256", file, "--download"]);
    assert.equal(result.ok, true, result.stderr);
    assert.match(result.stdout, new RegExp(`^${sha256(content)}\\s+`));
  });
});
