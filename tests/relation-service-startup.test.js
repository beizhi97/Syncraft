import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  rm,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import {
  createLazyRelationServiceCatalog,
  createRelationServiceFacade,
  createRelationServiceStartup,
  createSftpRelationServiceStartup,
  relationServiceCatalogPath
} from "../src/service/relationServiceStartup.js";

const projectRoot = join(import.meta.dirname, "..");
const serverEntry = join(projectRoot, "src", "server.js");
const relationStartupEntry = join(
  projectRoot,
  "src",
  "service",
  "relationServiceStartup.js"
);

const serverStartupHarnessSource = `import assert from "node:assert/strict";
import { lstat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

const [
  serverEntry,
  relationStartupEntry,
  mode,
  dataRoot
] = process.argv.slice(2);
const { main } = await import(pathToFileURL(serverEntry).href);
const {
  createRelationServiceStartup
} = await import(pathToFileURL(relationStartupEntry).href);

const runtime = Object.freeze({
  async inspect() {
    return Object.freeze({ owned: false });
  },
  async stop() {
    throw new Error("runtime stop is not expected");
  },
  async abort() {
    throw new Error("runtime abort is not expected");
  }
});
const protection = Object.freeze({
  async verify() {
    throw new Error("protection is not expected");
  }
});
let managerStartsWith = 0;
const manager = Object.freeze({
  async start(input) {
    managerStartsWith += 1;
    return Object.freeze({ input });
  },
  async query(input) {
    return Object.freeze({ input });
  },
  async disable(input) {
    return Object.freeze({ input });
  },
  async reconcile(input) {
    return Object.freeze({ input });
  }
});

let admissionCalls = 0;
let admissionInput = null;
const startupAdmission = async input => {
  admissionCalls += 1;
  admissionInput = input;
  return Object.freeze({ manager });
};
const readEpochIdentity = async () => ({
  containerId: "1".repeat(64)
});
const ownerGateFactory = () => Object.freeze({});
const env = {
  SFSC_RUNTIME_ADMISSION_REQUIRED: "1",
  SFSC_RUNTIME_EPOCH_ROOT: join(dataRoot, "epoch"),
  SFSC_RELATION_STATE_PATH: join(
    dataRoot,
    "state",
    "relation-services.json"
  ),
  SFSC_BOOTSTRAP_NONCE: "A".repeat(43)
};

let listenCalls = 0;
const unexpectedListen = () => {
  listenCalls += 1;
};
let compositionCalls = 0;
let compositionInput = null;
let successFacadeManager = null;
const relationCompositionFactory = async input => {
  compositionCalls += 1;
  compositionInput = input;
  if (mode === "package-failure") {
    throw Object.assign(
      new Error("relation runtime package loader failed"),
      { code: "relation_runtime_package_invalid" }
    );
  }
  if (mode === "success") {
    return Object.freeze({
      runtime,
      protection,
      createFacade(value) {
        successFacadeManager = value;
        return Object.freeze({
          manager: value,
          async start() {},
          async query() {},
          async disable() {},
          async reconcile() {}
        });
      }
    });
  }
  if (mode === "missing-catalog") {
    return createRelationServiceStartup({
      ...input,
      runtimePackageLoader: async () => Object.freeze({
        supervisorPath: join(dataRoot, "sfsc-relation-supervisor"),
        helperPath: join(dataRoot, "sfsc-root-guard"),
        helperSha256: "a".repeat(64),
        execServicePath: join(dataRoot, "sfsc-root-guard"),
        signalServicePath: join(dataRoot, "sfsc-root-guard")
      }),
      wiringFactory: ({ catalog }) => Object.freeze({
        runtime,
        protection,
        async makeStartRequest(request) {
          await catalog.getForStart(request.relationId);
          throw new Error("a missing catalog must stop this request");
        }
      })
    });
  }
  throw new Error(\`unknown server startup harness mode: \${mode}\`);
};

if (mode === "package-failure") {
  let rejection = null;
  try {
    await main({
      env,
      startupAdmission,
      readEpochIdentity,
      ownerGateFactory,
      relationCompositionFactory,
      listen: unexpectedListen
    });
  } catch (error) {
    rejection = error;
  }
  assert.equal(rejection?.code, "relation_runtime_package_invalid");
  assert.equal(compositionCalls, 1);
  assert.equal(admissionCalls, 0);
  assert.equal(listenCalls, 0);
  process.exit(0);
}

const result = await main({
  env,
  startupAdmission,
  readEpochIdentity,
  ownerGateFactory,
  relationCompositionFactory
});

try {
  assert.equal(result.server.listening, true);
  assert.equal(admissionCalls, 1);
  assert.equal(compositionCalls, 1);
  assert.equal(result.runtimeAdmission.manager, manager);
  assert.equal(admissionInput.managerOptions.runtime, runtime);
  assert.equal(admissionInput.managerOptions.protection, protection);
  assert.equal(admissionInput.managerOptions.runtimeTimeoutMs, 30_000);
  assert.equal(admissionInput.managerOptions.protectionTimeoutMs, 10_000);

  if (mode === "success") {
    assert.equal(successFacadeManager, manager);
    assert.equal(result.relationService.manager, manager);
  } else if (mode === "missing-catalog") {
    const relationStatePath = env.SFSC_RELATION_STATE_PATH;
    await assert.rejects(
      result.relationService.start({
        relationId: "relation-startup0001",
        operationId: "operation-startup0001",
        expectedHandleDigest: ""
      }),
      error =>
        error?.code === "relation_service_binding_catalog_missing"
        && error?.cause?.code ===
          "relation_service_binding_catalog_file_invalid"
        && error?.cause?.cause?.code === "ENOENT"
    );
    assert.equal(managerStartsWith, 0);
    await assert.rejects(
      lstat(join(dirname(relationStatePath), "relation-service")),
      { code: "ENOENT" }
    );
  } else {
    assert.fail(\`unknown server startup harness mode: \${mode}\`);
  }
} finally {
  await new Promise((resolve, reject) => {
    result.server.close(error => {
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    });
  });
}
`;

test("startup loads the fixed package eagerly through one wiring instance", async t => {
  const root = await mkdtemp(join(tmpdir(), "sfsc-relation-startup-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const managerStatePath = join(root, "state", "relation-services.json");
  const runtime = Object.freeze({
    inspect() {},
    stop() {},
    abort() {}
  });
  const protection = Object.freeze({ verify() {} });
  const loaderCalls = [];
  const wiringCalls = [];
  let catalogOpenCalls = 0;

  const composition = await createRelationServiceStartup({
    root,
    managerStatePath,
    runtimePackageLoader: async input => {
      loaderCalls.push(input);
      return Object.freeze({ fixture: "runtime-package" });
    },
    catalogOpener: async () => {
      catalogOpenCalls += 1;
      throw new Error("catalog is unrelated to eager startup");
    },
    wiringFactory: input => {
      wiringCalls.push(input);
      return Object.freeze({
        runtime,
        protection,
        async makeStartRequest() {
          throw new Error("start is not expected");
        }
      });
    }
  });

  assert.deepEqual(loaderCalls, [{
    directory: join(
      root,
      "server",
      "runtime",
      "native",
      "linux-arm64",
      "relation"
    )
  }]);
  assert.equal(wiringCalls.length, 1);
  assert.equal(wiringCalls[0].rclonePath, "/usr/local/bin/rclone");
  assert.equal(
    wiringCalls[0].catalog.getForStart instanceof Function,
    true
  );
  assert.equal(
    wiringCalls[0].catalog.withStartBinding instanceof Function,
    true
  );
  assert.equal(composition.runtime, runtime);
  assert.equal(composition.protection, protection);
  assert.deepEqual(
    Object.keys(composition).sort(),
    ["createFacade", "protection", "runtime"]
  );

  await composition.runtime.inspect("handle", { purpose: "cleanup" });
  await composition.runtime.stop("handle", { purpose: "cleanup" });
  await composition.runtime.abort("lease", { purpose: "cleanup" });
  assert.equal(catalogOpenCalls, 0);
  assert.equal(
    relationServiceCatalogPath(managerStatePath),
    join(root, "state", "relation-service", "catalog.json")
  );
});

test("SFTP startup loads only the independent V2 package and wires without rclone", async t => {
  const root = await mkdtemp(join(tmpdir(), "sfsc-sftp-relation-startup-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const runtime = Object.freeze({ inspect() {}, stop() {}, abort() {} });
  const protection = Object.freeze({ verify() {} });
  const packagePath = Object.freeze({ sftpServicePath: "fixed-v2-service" });
  const loaderCalls = [];
  const wiringCalls = [];
  const composition = await createSftpRelationServiceStartup({
    root,
    managerStatePath: join(root, "state", "relation-services.json"),
    runtimePackageLoader: async value => {
      loaderCalls.push(value);
      return packagePath;
    },
    catalogOpener: async () => {
      throw new Error("catalog opening is lazy");
    },
    wiringFactory(value) {
      wiringCalls.push(value);
      return {
        runtime,
        protection,
        makeStartRequest() {}
      };
    }
  });
  assert.deepEqual(loaderCalls, [{
    directory: join(root, "server", "runtime", "native", "linux-arm64", "relation-v2")
  }]);
  assert.equal(wiringCalls.length, 1);
  assert.equal(wiringCalls[0].runtimePackage, packagePath);
  assert.equal(Object.hasOwn(wiringCalls[0], "rclonePath"), false);
  assert.equal(composition.runtime, runtime);
  assert.equal(composition.protection, protection);
  const managerCalls = [];
  const facade = composition.createFacade(Object.fromEntries(
    ["start", "query", "disable", "reconcile"].map(method => [
      method,
      async input => {
        managerCalls.push({ method, input });
        return { method };
      }
    ])
  ));
  assert.deepEqual(await facade.start({
    relationId: "relation-v2",
    operationId: "operation-v2",
    expectedHandleDigest: ""
  }), { method: "start" });
  assert.deepEqual(await facade.query({ relationId: "relation-v2" }), { method: "query" });
  assert.deepEqual(await facade.disable({ relationId: "relation-v2", operationId: "disable-v2" }), { method: "disable" });
  assert.deepEqual(await facade.reconcile({ relationId: "relation-v2" }), { method: "reconcile" });
  assert.deepEqual(managerCalls.map(({ method }) => method), [
    "start", "query", "disable", "reconcile"
  ]);
  await assert.rejects(createSftpRelationServiceStartup({
    root,
    managerStatePath: join(root, "state", "relation-services.json"),
    rclonePath: "/usr/local/bin/rclone"
  }), /unsupported fields/);
});

test("SFTP startup accepts root/state defaults and fails on the missing V2 package", async t => {
  const root = await mkdtemp(join(tmpdir(), "sfsc-sftp-default-startup-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await assert.rejects(createSftpRelationServiceStartup({
    root,
    managerStatePath: join(root, "state", "relations.json")
  }), /SFTP relation runtime package directory is missing/);
});

test("real catalog opener preserves missing-parent evidence as catalog_missing", async t => {
  const root = await mkdtemp(join(tmpdir(), "sfsc-relation-real-missing-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const unavailableParent = join(root, "unavailable");
  const catalogPath = join(
    unavailableParent,
    "relation-service",
    "catalog.json"
  );
  const lazy = createLazyRelationServiceCatalog({ catalogPath });

  await assert.rejects(
    lazy.catalog.getForStart("relation-realmissing0001"),
    error =>
      error?.code === "relation_service_binding_catalog_missing"
      && error?.cause?.code ===
        "relation_service_binding_catalog_file_invalid"
      && error?.cause?.cause?.code === "ENOENT"
  );
  assert.deepEqual(await readdir(root), []);
  await assert.rejects(lstat(unavailableParent), { code: "ENOENT" });
});

test("real catalog opener rejects a missing file without creating it", async t => {
  const root = await mkdtemp(join(tmpdir(), "sfsc-relation-real-file-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const relationDirectory = join(root, "relation-service");
  const catalogPath = join(relationDirectory, "catalog.json");
  await mkdir(relationDirectory, { mode: 0o700 });
  const lazy = createLazyRelationServiceCatalog({ catalogPath });

  await assert.rejects(
    lazy.catalog.getForStart("relation-realfile0001"),
    error =>
      error?.code === "relation_service_binding_catalog_missing"
  );
  assert.deepEqual(await readdir(relationDirectory), []);
  await assert.rejects(lstat(catalogPath), { code: "ENOENT" });
});

test("lazy catalog preserves permission and link errors", async t => {
  const root = await mkdtemp(join(tmpdir(), "sfsc-relation-real-errors-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const catalogPath = join(root, "relation-service", "catalog.json");
  const permissionCause = Object.assign(
    new Error("permission denied"),
    { code: "EACCES" }
  );
  const permissionError = Object.assign(
    new Error("catalog parent cannot be inspected", {
      cause: permissionCause
    }),
    { code: "relation_service_binding_catalog_file_invalid" }
  );
  const linkError = Object.assign(
    new Error("catalog parent must not traverse a symlink"),
    { code: "relation_service_binding_catalog_link_denied" }
  );
  const failures = [permissionError, linkError];
  const lazy = createLazyRelationServiceCatalog({
    catalogPath,
    catalogOpener: async () => {
      throw failures.shift();
    }
  });

  await assert.rejects(
    lazy.catalog.getForStart("relation-realerrors0001"),
    error => error === permissionError
  );
  await assert.rejects(
    lazy.catalog.getForStart("relation-realerrors0001"),
    error => error === linkError
  );
});

test("lazy catalog retries a failed open and reuses a successful open", async t => {
  const root = await mkdtemp(join(tmpdir(), "sfsc-relation-catalog-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const catalogPath = join(root, "relation-service", "catalog.json");
  const openerCalls = [];
  const startCalls = [];
  const bindingCalls = [];
  const openedCatalog = Object.freeze({
    async getForStart(relationId) {
      startCalls.push(relationId);
      return Object.freeze({ relationId });
    },
    async withStartBinding(relationId, task) {
      bindingCalls.push(relationId);
      return task(Object.freeze({ relationId }));
    }
  });

  const lazy = createLazyRelationServiceCatalog({
    catalogPath,
    catalogOpener: async options => {
      openerCalls.push(options);
      if (openerCalls.length === 1) {
        throw Object.assign(
          new Error("relation-service binding catalog does not exist"),
          { code: "relation_service_binding_catalog_missing" }
        );
      }
      return openedCatalog;
    }
  });

  await assert.rejects(
    lazy.catalog.getForStart("relation-catalog0001"),
    error => error?.code === "relation_service_binding_catalog_missing"
  );
  assert.equal(openerCalls.length, 1);
  assert.deepEqual(openerCalls[0], {
    mode: "require-existing",
    path: catalogPath
  });

  const first = await lazy.catalog.getForStart("relation-catalog0001");
  const seen = [];
  const second = await lazy.catalog.withStartBinding(
    "relation-catalog0001",
    snapshot => {
      seen.push(snapshot);
      return snapshot;
    }
  );
  assert.deepEqual(first, { relationId: "relation-catalog0001" });
  assert.deepEqual(second, { relationId: "relation-catalog0001" });
  assert.deepEqual(seen, [{ relationId: "relation-catalog0001" }]);
  assert.equal(openerCalls.length, 2);
  assert.deepEqual(startCalls, ["relation-catalog0001"]);
  assert.deepEqual(bindingCalls, ["relation-catalog0001"]);
});

test("facade accepts only public request fields and delegates to one manager", async () => {
  const madeStartRequests = [];
  const managerCalls = [];
  const startRequest = Object.freeze({
    relationId: "relation-facade0001",
    operationId: "operation-facade0001",
    identity: Object.freeze({ fixture: "identity" }),
    launch: Object.freeze({
      listener: Object.freeze({
        host: "127.0.0.1",
        port: 22001,
        role: "relation"
      })
    }),
    expectedHandleDigest: ""
  });
  const manager = Object.freeze({
    async start(input) {
      managerCalls.push({ method: "start", input });
      return Object.freeze({ method: "start-result" });
    },
    async query(input) {
      managerCalls.push({ method: "query", input });
      return Object.freeze({ method: "query-result" });
    },
    async disable(input) {
      managerCalls.push({ method: "disable", input });
      return Object.freeze({ method: "disable-result" });
    },
    async reconcile(input) {
      managerCalls.push({ method: "reconcile", input });
      return Object.freeze({ method: "reconcile-result" });
    }
  });
  const facade = createRelationServiceFacade({
    manager,
    wiring: Object.freeze({
      async makeStartRequest(input) {
        madeStartRequests.push(input);
        return startRequest;
      }
    })
  });

  const startInput = {
    relationId: "relation-facade0001",
    operationId: "operation-facade0001",
    expectedHandleDigest: ""
  };
  assert.deepEqual(
    await facade.start(startInput),
    { method: "start-result" }
  );
  assert.deepEqual(madeStartRequests, [startInput]);
  assert.equal(managerCalls[0].input, startRequest);

  const queryInput = { relationId: "relation-facade0001" };
  const disableInput = {
    handle: Object.freeze({ fixture: "handle" }),
    identity: Object.freeze({ fixture: "identity" }),
    operationId: "operation-disable0001",
    relationId: "relation-facade0001"
  };
  const reconcileInput = { relationId: "relation-facade0001" };
  assert.deepEqual(
    await facade.query(queryInput),
    { method: "query-result" }
  );
  assert.deepEqual(
    await facade.disable(disableInput),
    { method: "disable-result" }
  );
  assert.deepEqual(
    await facade.reconcile(reconcileInput),
    { method: "reconcile-result" }
  );
  assert.equal(managerCalls[1].input, queryInput);
  assert.equal(managerCalls[2].input, disableInput);
  assert.equal(managerCalls[3].input, reconcileInput);

  await assert.rejects(
    facade.start({ ...startInput, root: "/tmp/forbidden" }),
    /unsupported fields/
  );
  await assert.rejects(
    facade.query({ ...queryInput, path: "/tmp/forbidden" }),
    /unsupported fields/
  );
  await assert.rejects(
    facade.disable({ ...disableInput, catalogPath: "/tmp/forbidden" }),
    /unsupported fields/
  );
  await assert.rejects(
    facade.reconcile({ ...reconcileInput, port: 22001 }),
    /unsupported fields/
  );
  assert.equal(madeStartRequests.length, 1);
  assert.equal(managerCalls.length, 4);
});

test("server main fails before admission and listen when package loading fails", {
  timeout: 20_000
}, async t => {
  await runServerStartupHarness(t, "package-failure");
});

test("server main admits once and returns a facade for the admitted manager", {
  timeout: 20_000
}, async t => {
  await runServerStartupHarness(t, "success");
});

test("missing catalog permits listen and blocks start before manager mutation", {
  timeout: 20_000
}, async t => {
  await runServerStartupHarness(t, "missing-catalog");
});

async function runServerStartupHarness(t, mode) {
  const root = await mkdtemp(join(tmpdir(), `sfsc-relation-${mode}-`));
  t.after(() => rm(root, { recursive: true, force: true }));
  const harnessPath = join(root, "server-startup-harness.mjs");
  await writeFile(harnessPath, serverStartupHarnessSource);
  const childEnvironment = {
    ...process.env,
    NODE_ENV: "test",
    HOST: "127.0.0.1",
    PORT: "0",
    SFSC_ENROLLMENT_BOOTSTRAP_PORT: "0",
    SERVER_DATA_ROOT: root,
    SFSC_ALLOW_NO_ADMIN_TOKEN: "1"
  };
  for (const key of [
    "SFSC_RUNTIME_ADMISSION_REQUIRED",
    "SFSC_RUNTIME_EPOCH_ROOT",
    "SFSC_RELATION_STATE_PATH",
    "SFSC_CONTAINER_ID",
    "SFSC_BOOTSTRAP_NONCE"
  ]) {
    delete childEnvironment[key];
  }

  let child;
  try {
    child = spawn(
      process.execPath,
      [
        harnessPath,
        serverEntry,
        relationStartupEntry,
        mode,
        root
      ],
      {
        cwd: projectRoot,
        env: childEnvironment,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true
      }
    );
  } catch (error) {
    if (error?.code === "EPERM" && process.platform === "win32") {
      t.skip("Windows sandbox blocks the Node child-process proof");
      return;
    }
    throw error;
  }

  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", chunk => {
    stdout += chunk;
  });
  child.stderr.on("data", chunk => {
    stderr += chunk;
  });
  let exit;
  try {
    exit = await waitForChildExit(child, 15_000);
  } catch (error) {
    if (error?.code === "EPERM" && process.platform === "win32") {
      t.skip("Windows sandbox blocks the Node child-process proof");
      return;
    }
    throw error;
  }
  assert.equal(
    exit.code,
    0,
    `${mode} startup harness failed\nstdout:\n${stdout}\nstderr:\n${stderr}`
  );
}

function waitForChildExit(child, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`child process did not exit within ${timeoutMs}ms`));
    }, timeoutMs);
    child.once("error", error => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });
}
