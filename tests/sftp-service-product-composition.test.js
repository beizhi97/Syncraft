import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const testRoot = await mkdtemp(join(tmpdir(), "sfsc-sftp-product-composition-"));
const savedEnv = new Map();
for (const key of ["HOST", "PORT", "SERVER_DATA_ROOT", "SFSC_ADMIN_TOKEN", "SFSC_ENROLLMENT_BOOTSTRAP_PORT"]) {
  savedEnv.set(key, process.env[key]);
}
process.env.HOST = "127.0.0.1";
process.env.PORT = "0";
process.env.SERVER_DATA_ROOT = testRoot;
process.env["SFSC_ADMIN_TOKEN"] = ["sftp", "composition", "test", "token"].join("-");
process.env.SFSC_ENROLLMENT_BOOTSTRAP_PORT = "0";
const { main } = await import("../src/server.js?sftp-product-composition-test");
for (const [key, value] of savedEnv) {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

const runtimePackageDirectory = join(
  projectRoot,
  "server",
  "runtime",
  "native",
  "linux-arm64",
  "relation-v2"
);
const managerStatePath = join(testRoot, "state", "relation-services.json");
const epochRoot = join(testRoot, "epoch");
const env = {
  SFSC_RUNTIME_ADMISSION_REQUIRED: "1",
  SFSC_RUNTIME_EPOCH_ROOT: epochRoot,
  SFSC_RELATION_STATE_PATH: managerStatePath,
  SFSC_CONTAINER_ID: "a".repeat(12),
  SFSC_BOOTSTRAP_NONCE: "A".repeat(43)
};
const packageLoaderResult = Object.freeze({
  supervisorPath: resolve(testRoot, "package", "sfsc-relation-supervisor"),
  rootGuardPath: resolve(testRoot, "package", "sfsc-root-guard"),
  rootGuardSha256: "a".repeat(64),
  sftpServicePath: resolve(testRoot, "package", "sfsc-sftp-service")
});
const manager = Object.freeze({
  async start() {},
  async query() {},
  async disable() {},
  async reconcile() {}
});

async function closeServer(server) {
  if (!server?.listening) return;
  await new Promise((resolveClose, rejectClose) => {
    server.close(error => error ? rejectClose(error) : resolveClose());
  });
}

async function expectStartupFailure(options) {
  let result;
  try {
    result = await main(options);
  } catch (error) {
    return error;
  }
  await closeServer(result.server);
  throw new Error("server unexpectedly started after V2 package failure");
}

test("product startup selects SFTP V2 and fails closed for missing or invalid packages", async t => {
  t.after(() => rm(testRoot, { recursive: true, force: true }));
  t.after(async () => {
    await closeServer(activeServer);
  });
  let activeServer = null;
  const loaderPaths = [];
  let admissionCalls = 0;
  const startupAdmission = async ({ managerOptions }) => {
    admissionCalls += 1;
    assert.equal(typeof managerOptions.runtime.prepare, "function");
    assert.equal(typeof managerOptions.protection.verify, "function");
    return Object.freeze({ manager });
  };
  const commonOptions = {
    env,
    startupAdmission,
    readEpochIdentity: async () => ({ containerId: "a".repeat(64) }),
    ownerGateFactory: () => Object.freeze({})
  };

  const missingError = Object.assign(
    new Error("SFTP V2 runtime package is missing"),
    { code: "sftp_runtime_package_missing" }
  );
  const missing = await expectStartupFailure({
    ...commonOptions,
    relationRuntimePackageLoaderForTest: async ({ directory }) => {
      loaderPaths.push(directory);
      throw missingError;
    }
  });
  assert.equal(missing, missingError);
  assert.equal(admissionCalls, 0);

  const invalid = await expectStartupFailure({
    ...commonOptions,
    relationRuntimePackageLoaderForTest: async ({ directory }) => {
      loaderPaths.push(directory);
      return Object.freeze({
        ...packageLoaderResult,
        rootGuardSha256: "invalid"
      });
    }
  });
  assert.match(invalid.message, /SHA-256|digest|sftpRuntimePackage/i);
  assert.equal(admissionCalls, 0);

  const result = await main({
    ...commonOptions,
    relationRuntimePackageLoaderForTest: async ({ directory }) => {
      loaderPaths.push(directory);
      return packageLoaderResult;
    }
  });
  activeServer = result.server;
  assert.deepEqual(loaderPaths, [
    runtimePackageDirectory,
    runtimePackageDirectory,
    runtimePackageDirectory
  ]);
  assert.equal(admissionCalls, 1);
  assert.equal(result.server.listening, true);
  assert.equal(result.runtimeAdmission.manager, manager);
  assert.ok(result.relationService);
  assert.equal(typeof result.relationService.start, "function");
  await closeServer(result.server);
  activeServer = null;
});

