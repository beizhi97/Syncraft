import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { normalizeHttpError } from "../src/core/errors.js";
import {
  ensureSftpAccessMarkers,
  sftpAccessMarkerName
} from "../client/src/sftpAccessMarker.js";

const rootId = "root_0123456789abcdef";

async function captureNormalizedMarkerFailure(t, scenario) {
  const base = await mkdtemp(join(tmpdir(), "syncraft-client-marker-error-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const localRoot = join(base, "local");
  const remoteRoot = join(base, "remote");
  const markerName = sftpAccessMarkerName(rootId);
  await mkdir(remoteRoot);
  if (scenario !== "write-failure") await mkdir(localRoot);
  if (scenario === "conflict") await writeFile(join(localRoot, markerName), "wrong root\n");

  let remoteCommands = 0;
  let error;
  try {
    await ensureSftpAccessMarkers({
      localRoot,
      remoteRoot,
      rootId,
      createMissing: scenario === "write-failure",
      markerSourceFile: join(base, "unused-marker-source"),
      rcloneBin: "unused-rclone-in-local-marker-case",
      runBuffered: async () => {
        remoteCommands += 1;
        throw new Error("remote command should not run before the local marker failure");
      }
    });
  } catch (caught) {
    error = caught;
  }
  assert.ok(error, `${scenario} marker operation must reject`);
  return {
    error,
    normalized: normalizeHttpError(error, "client_error"),
    remoteCommands
  };
}

for (const [scenario, expectedCode, expectedStatus] of [
  ["missing", "sftp_access_marker_missing", 400],
  ["conflict", "sftp_access_marker_conflict", 409],
  ["write-failure", "sftp_access_marker_write_failed", 500]
]) {
  test(`${scenario} local SFTP marker error remains stable through normalizeHttpError`, async t => {
    const { error, normalized, remoteCommands } = await captureNormalizedMarkerFailure(t, scenario);
    assert.equal(error.code, expectedCode, "the real marker module emits its dedicated stable code");
    assert.equal(normalized.code, expectedCode);
    assert.equal(normalized.status, expectedStatus);
    assert.equal(remoteCommands, 0, "local marker failure must stop before any remote request");
  });
}

test("invalid local SFTP marker root ID remains stable through normalizeHttpError", async t => {
  const base = await mkdtemp(join(tmpdir(), "syncraft-client-marker-invalid-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  let remoteCommands = 0;
  let error;
  try {
    await ensureSftpAccessMarkers({
      localRoot: join(base, "local"),
      remoteRoot: join(base, "remote"),
      rootId: "not-a-verified-root-id",
      createMissing: false,
      rcloneBin: "unused-rclone-in-invalid-marker-case",
      runBuffered: async () => { remoteCommands += 1; throw new Error("unexpected remote command"); }
    });
  } catch (caught) {
    error = caught;
  }

  assert.ok(error, "invalid root ID must reject through the production marker module");
  const normalized = normalizeHttpError(error, "client_error");
  assert.equal(error.code, "sftp_access_marker_invalid");
  assert.equal(normalized.code, "sftp_access_marker_invalid");
  assert.equal(normalized.status, 400);
  assert.equal(remoteCommands, 0, "invalid root ID must fail before any remote request");
});

test("missing local marker leaves local and remote data untouched", async t => {
  const base = await mkdtemp(join(tmpdir(), "syncraft-client-marker-preserve-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const localRoot = join(base, "local");
  const remoteRoot = join(base, "remote");
  await Promise.all([mkdir(localRoot), mkdir(remoteRoot)]);
  const localFile = join(localRoot, "keep-this-file.txt");
  const remoteFile = join(remoteRoot, "keep-this-file.txt");
  await Promise.all([writeFile(localFile, "local survivor\n"), writeFile(remoteFile, "remote survivor\n")]);
  let commands = 0;

  await assert.rejects(ensureSftpAccessMarkers({
    localRoot,
    remoteRoot,
    rootId,
    createMissing: false,
    rcloneBin: "unused-rclone-in-local-marker-case",
    runBuffered: async () => { commands += 1; throw new Error("unexpected remote command"); }
  }), error => error?.code === "sftp_access_marker_missing");

  assert.equal(commands, 0);
  assert.equal(await readFile(localFile, "utf8"), "local survivor\n");
  assert.equal(await readFile(remoteFile, "utf8"), "remote survivor\n");
  await assert.rejects(readFile(join(localRoot, sftpAccessMarkerName(rootId))), error => error?.code === "ENOENT");
  await assert.rejects(readFile(join(remoteRoot, sftpAccessMarkerName(rootId))), error => error?.code === "ENOENT");
});
