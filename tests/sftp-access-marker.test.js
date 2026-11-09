import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ensureSftpAccessMarkers, sftpAccessMarkerContents, sftpAccessMarkerName } from "../client/src/sftpAccessMarker.js";

const execFileAsync = promisify(execFile);
const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const rcloneBin = join(projectRoot, "client", "resources", "bin", "win32", "rclone.exe");
const rootId = "root_0123456789abcdef";

async function runBuffered(executable, args, options = {}) {
  try {
    const result = await execFileAsync(executable, args, {
      encoding: "utf8",
      timeout: options.timeoutMs || 15000,
      env: { ...process.env, ...options.env }
    });
    return { ok: true, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    return {
      ok: false,
      stdout: String(error.stdout || ""),
      stderr: String(error.stderr || error.message || "")
    };
  }
}

async function createMarkerPair(localRoot, remoteRoot, { root = rootId } = {}) {
  const source = join(localRoot, "marker-source.tmp");
  await writeFile(source, sftpAccessMarkerContents(root), { flag: "wx" });
  try {
    return await ensureSftpAccessMarkers({
      localRoot,
      remoteRoot,
      rootId: root,
      createMissing: true,
      markerSourceFile: source,
      rcloneBin,
      runBuffered
    });
  } finally {
    await rm(source, { force: true });
  }
}

async function bisync(localRoot, remoteRoot, markerName, workdir, extraArgs = []) {
  return runBuffered(rcloneBin, [
    "bisync",
    localRoot,
    remoteRoot,
    "--check-access",
    "--check-filename",
    markerName,
    "--resilient",
    "--compare",
    "size,modtime,checksum",
    "--checksum",
    "--exclude",
    "/.syncraft-root.json",
    "--exclude",
    "/.syncraft-root.stage-*",
    "--workdir",
    workdir,
    ...extraArgs
  ], { timeoutMs: 30000 });
}

async function withRoots(fn) {
  const base = await mkdtemp(join(tmpdir(), "syncraft-sftp-marker-"));
  const localRoot = join(base, "local");
  const remoteRoot = join(base, "remote");
  const workdir = join(base, "bisync-work");
  await Promise.all([mkdir(localRoot), mkdir(remoteRoot), mkdir(workdir)]);
  try {
    return await fn({ base, localRoot, remoteRoot, workdir });
  } finally {
    await rm(base, { recursive: true, force: true });
  }
}

test("locked rclone bisync initializes with its root marker and preserves a conflicting marker", async () => {
  await withRoots(async ({ localRoot, remoteRoot, workdir }) => {
    const { markerName } = await createMarkerPair(localRoot, remoteRoot);
    const initialized = await bisync(localRoot, remoteRoot, markerName, workdir, ["--resync", "--resync-mode", "newer"]);
    assert.equal(initialized.ok, true, initialized.stderr);

    const localMarker = join(localRoot, markerName);
    const remoteMarker = join(remoteRoot, markerName);
    assert.equal(await readFile(localMarker, "utf8"), sftpAccessMarkerContents(rootId));
    assert.equal(await readFile(remoteMarker, "utf8"), sftpAccessMarkerContents(rootId));

    const conflictingContents = "another-root-marker\n";
    await writeFile(remoteMarker, conflictingContents);
    await assert.rejects(
      createMarkerPair(localRoot, remoteRoot),
      (error) => error?.code === "sftp_access_marker_conflict"
    );
    assert.equal(await readFile(remoteMarker, "utf8"), conflictingContents);
    assert.equal(await readFile(localMarker, "utf8"), sftpAccessMarkerContents(rootId));
  });
});

for (const missingSide of ["local", "remote"]) {
  test(`locked rclone bisync refuses to run when the initialized ${missingSide} marker is missing`, async () => {
    await withRoots(async ({ localRoot, remoteRoot, workdir }) => {
      const { markerName } = await createMarkerPair(localRoot, remoteRoot);
      const initialized = await bisync(localRoot, remoteRoot, markerName, workdir, ["--resync", "--resync-mode", "newer"]);
      assert.equal(initialized.ok, true, initialized.stderr);

      const markerPath = join(missingSide === "local" ? localRoot : remoteRoot, markerName);
      await rm(markerPath);
      await assert.rejects(
        ensureSftpAccessMarkers({ localRoot, remoteRoot, rootId, rcloneBin, runBuffered }),
        (error) => error?.code === "sftp_access_marker_missing"
      );
      await assert.rejects(readFile(markerPath), (error) => error?.code === "ENOENT");

      const ordinaryRun = await bisync(localRoot, remoteRoot, markerName, workdir);
      assert.equal(ordinaryRun.ok, false);
    });
  });
}
