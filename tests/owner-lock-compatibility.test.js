import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { evaluateOwnerLockCompatibility } from "../src/service/ownerLockCompatibility.js";

const manifest = () => ({
  arch: "x64",
  artifactFile: "sfsc_owner_lock.node",
  artifactSha256: "a".repeat(64),
  artifactSizeBytes: 128,
  libc: "glibc",
  napiVersion: 8,
  nodeMajor: 22,
  platform: "linux",
  schemaVersion: "1"
});

const runtime = () => ({
  arch: "x64",
  libc: "glibc",
  napiVersion: 10,
  platform: "linux"
});

function evaluate(manifestValue = manifest(), runtimeValue = runtime()) {
  return evaluateOwnerLockCompatibility({
    manifest: manifestValue,
    runtime: runtimeValue
  });
}

test("compatibility module is pure source with no runtime or I/O imports", () => {
  const source = readFileSync(
    new URL("../src/service/ownerLockCompatibility.js", import.meta.url),
    "utf8"
  );
  assert.equal(/^\s*import\s/m.test(source), false);
  assert.equal(/\bprocess\b/.test(source), false);
  assert.equal(/\brequire\s*\(/.test(source), false);
});

test("valid schema 1 metadata is compatible without comparing Node major", () => {
  const inputManifest = manifest();
  inputManifest.nodeMajor = Number.MAX_SAFE_INTEGER;
  const inputRuntime = runtime();
  inputRuntime.napiVersion = 8;

  assert.deepEqual(evaluate(inputManifest, inputRuntime), {
    compatible: true,
    reason: "compatible"
  });
  assert.deepEqual(inputManifest, { ...manifest(), nodeMajor: Number.MAX_SAFE_INTEGER });
  assert.deepEqual(inputRuntime, { ...runtime(), napiVersion: 8 });
});

test("manifest must retain exactly nine schema 1 metadata fields", () => {
  const missing = manifest();
  delete missing.nodeMajor;
  assert.equal(evaluate(missing).reason, "manifest_invalid");

  const extra = { ...manifest(), buildId: "forbidden" };
  assert.equal(evaluate(extra).reason, "manifest_invalid");

  for (const nodeMajor of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal(
      evaluate({ ...manifest(), nodeMajor }).reason,
      "manifest_invalid"
    );
  }
});

test("platform and architecture require exact runtime matches", () => {
  assert.equal(
    evaluate({ ...manifest(), platform: "darwin" }).reason,
    "platform_mismatch"
  );
  assert.equal(
    evaluate({ ...manifest(), arch: "arm64" }).reason,
    "arch_mismatch"
  );
});

test("manifest and runtime Node-API values must be safe integers at least 8", () => {
  for (const napiVersion of [7, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal(
      evaluate({ ...manifest(), napiVersion }).reason,
      "napi_too_low"
    );
  }
  for (const napiVersion of [7, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal(
      evaluate(manifest(), { ...runtime(), napiVersion }).reason,
      "napi_runtime_invalid"
    );
  }
  assert.equal(
    evaluate({ ...manifest(), napiVersion: 9 }, {
      ...runtime(),
      napiVersion: 8
    }).reason,
    "napi_runtime_insufficient"
  );
});

test("libc must be a known matching family", () => {
  assert.equal(
    evaluate({ ...manifest(), libc: "musl" }).reason,
    "libc_mismatch"
  );
  assert.equal(
    evaluate(manifest(), { ...runtime(), libc: "unknown" }).reason,
    "libc_mismatch"
  );
  assert.equal(
    evaluate({ ...manifest(), libc: "unknown" }).reason,
    "manifest_invalid"
  );
});

test("compatibility result is frozen", () => {
  const output = evaluate();
  assert.equal(Object.isFrozen(output), true);
  assert.throws(() => {
    output.reason = "changed";
  }, TypeError);
});
