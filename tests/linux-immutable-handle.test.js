import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { constants as fsConstants } from "node:fs";
import {
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  realpath,
  rm,
  unlink,
  writeFile
} from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import test, { after } from "node:test";

import {
  DIRECTORY_ROOT_MARKER_NAME,
  DirectoryRootGuardError,
  checkDirectoryRoot,
  commitDirectoryRootRegistration,
  prepareDirectoryRootRegistration
} from "../src/core/directoryRootGuard.js";
import {
  LinuxImmutableHandleError,
  ROOT_GUARD_HELPER_VERSION,
  ensureDirectoryRootProtection
} from "../src/core/linuxImmutableHandle.js";

const PROJECT_ROOT = fileURLToPath(new URL("..", import.meta.url));
const SERVER_ID = `srv_${"c".repeat(24)}`;
const SHARE_ID = `shr_${"d".repeat(24)}`;
const NOW_MS = 1_760_000_000_000;
const WIN32_DEPS = Object.freeze({ platform: "win32" });
const IMMUTABLE_FLAG = 0x10n;
const BASE_FLAGS = 0x80000n;

const INTEGRATION_HELPER = process.env.SFSC_ROOT_GUARD_HELPER || "";
const INTEGRATION_HELPER_SHA256 =
  (process.env.SFSC_ROOT_GUARD_SHA256 || "").toLowerCase();
const INTEGRATION_TEST_ROOT = process.env.SFSC_ROOT_GUARD_TEST_ROOT
  || process.env.SFSC_ROOT_PROTECTION_TEST_ROOT
  || process.env.SFSC_TEST_ROOT
  || process.env.ROOT
  || "";
const INTEGRATION_NO_CAP = process.env.SFSC_ROOT_GUARD_EXPECT_NO_CAP === "1";
const TEMP_BASE = INTEGRATION_TEST_ROOT
  ? join(INTEGRATION_TEST_ROOT, "node-linux-immutable-handle-tests")
  : join(PROJECT_ROOT, ".tmp", "linux-immutable-handle-tests");
const INTEGRATION_AVAILABLE = process.platform === "linux"
  && INTEGRATION_HELPER.length > 0
  && /^[a-f0-9]{64}$/.test(INTEGRATION_HELPER_SHA256)
  && INTEGRATION_TEST_ROOT.length > 0;
const RUN_POSITIVE_INTEGRATION = INTEGRATION_AVAILABLE && !INTEGRATION_NO_CAP;
const RUN_NO_CAP_INTEGRATION = INTEGRATION_AVAILABLE && INTEGRATION_NO_CAP;

await mkdir(TEMP_BASE, { recursive: true });

after(async () => {
  await rm(TEMP_BASE, { recursive: true, force: true });
});

async function makeCase(t, label) {
  const rootPath = await mkdtemp(join(TEMP_BASE, `${label}-`));
  t.after(async () => {
    await rm(rootPath, { recursive: true, force: true });
  });
  return rootPath;
}

async function prepareRecord(rootPath) {
  return prepareDirectoryRootRegistration(
    {
      rootPath,
      serverId: SERVER_ID,
      shareId: SHARE_ID
    },
    {
      nowMs: NOW_MS,
      testDependencies: WIN32_DEPS
    }
  );
}

async function commitRecord(record) {
  return commitDirectoryRootRegistration(record, {
    nowMs: NOW_MS + 1000,
    testDependencies: WIN32_DEPS
  });
}

async function registerCase(t, label) {
  const rootPath = await makeCase(t, label);
  return {
    rootPath,
    record: await commitRecord(await prepareRecord(rootPath))
  };
}

async function writeFakeHelper(t, rootPath, bytes = "fake linux helper\n") {
  const helperPath = join(rootPath, "sfsc-root-guard");
  await writeFile(helperPath, bytes, { mode: 0o755 });
  return {
    helperPath,
    helperSha256: sha256(Buffer.from(bytes, "utf8"))
  };
}

function win32RootGuard(record, options) {
  return checkDirectoryRoot(record, {
    ...options,
    testDependencies: WIN32_DEPS
  });
}

function dependencies(runHelper, overrides = {}) {
  return {
    platform: "linux",
    fs: { lstat, open, realpath },
    checkDirectoryRoot: win32RootGuard,
    runHelper,
    validateHelperMetadata: async () => {},
    ...overrides
  };
}

function trackingFileSystem(options = {}) {
  const opened = [];
  return {
    opened,
    fs: {
      lstat,
      realpath,
      async open(...args) {
        const target = await open(...args);
        const record = {
          closeCalls: 0,
          closeError: null,
          handle: null
        };
        const index = opened.length;
        const handle = new Proxy(target, {
          get(value, property) {
            if (property === "close") {
              return async () => {
                record.closeCalls += 1;
                await options.closeGate?.(record, index);
                const closeShouldFail = Array.isArray(options.closeErrorAt)
                  ? options.closeErrorAt.includes(index)
                  : options.closeErrorAt === index;
                if (closeShouldFail) {
                  record.closeError = Object.assign(
                    new Error("synthetic close failure"),
                    { code: "EIO" }
                  );
                  await value.close();
                  throw record.closeError;
                }
                return value.close();
              };
            }
            const selected = Reflect.get(value, property, value);
            return typeof selected === "function" ? selected.bind(value) : selected;
          }
        });
        record.handle = handle;
        opened.push(record);
        await options.onOpen?.(record, index);
        return handle;
      }
    }
  };
}

function fakeHelperChild() {
  const child = new EventEmitter();
  child.pid = 4242;
  child.stdin = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin.end = () => {};
  child.kill = () => true;
  return child;
}

function helperSuccess(request, flagsBefore, flagsAfter) {
  return {
    version: 1,
    helperVersion: ROOT_GUARD_HELPER_VERSION,
    operation: request.operation,
    ok: true,
    identity: {
      dev: request.expected.dev,
      ino: request.expected.ino,
      size: request.expected.size
    },
    contentSha256: request.expected.sha256,
    flagsBefore: {
      raw: flagsBefore.toString(),
      immutable: (flagsBefore & IMMUTABLE_FLAG) !== 0n
    },
    flagsAfter: {
      raw: flagsAfter.toString(),
      immutable: (flagsAfter & IMMUTABLE_FLAG) !== 0n
    },
    capabilities: {
      effectiveHasLinuxImmutable: true,
      permittedHasLinuxImmutable: true,
      boundingHasLinuxImmutable: true,
      noNewPrivs: false
    }
  };
}

function helperFailure(operation, code) {
  return {
    version: 1,
    helperVersion: ROOT_GUARD_HELPER_VERSION,
    operation,
    ok: false,
    error: { code }
  };
}

function helperResult(value, exitCode = 0) {
  return {
    exitCode,
    signal: null,
    timedOut: false,
    overflow: false,
    stdout: Buffer.from(`${JSON.stringify(value)}\n`, "utf8"),
    stderr: Buffer.alloc(0)
  };
}

function fakeHelper({ onRequest, initialFlags = BASE_FLAGS, allowSet = true } = {}) {
  let flags = initialFlags;
  const calls = [];
  const runHelper = async ({ request }) => {
    calls.push(structuredClone(request));
    await onRequest?.(request);
    const before = flags;
    if (request.operation === "set_immutable") {
      if (!allowSet) {
        return helperResult(helperFailure("set_immutable", "set_flags_failed"), 2);
      }
      flags |= IMMUTABLE_FLAG;
    }
    return helperResult(helperSuccess(request, before, flags));
  };
  return {
    calls,
    runHelper,
    get flags() {
      return flags;
    }
  };
}

async function expectHandleError(promise, code, helperCode) {
  await assert.rejects(promise, (error) => {
    assert.ok(error instanceof LinuxImmutableHandleError);
    assert.equal(error.code, code);
    if (helperCode !== undefined) {
      assert.equal(error.helperCode, helperCode);
    }
    return true;
  });
}

function stagePath(record) {
  return join(record.canonicalRoot, record.stage.name);
}

function markerPath(record) {
  return join(record.canonicalRoot, DIRECTORY_ROOT_MARKER_NAME);
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

test("rejects non-Linux platforms before touching the root", async (t) => {
  const { record, rootPath } = await registerCase(t, "non-linux");
  const helper = await writeFakeHelper(t, rootPath);
  await expectHandleError(
    ensureDirectoryRootProtection(record, {
      ...helper,
      testDependencies: {
        checkDirectoryRoot: () => {
          throw new Error("must not be called");
        }
      }
    }),
    "root_protection_unsupported_platform"
  );
});

test("pre-aborted protection is a confirmed no-work cancellation", async () => {
  const controller = new AbortController();
  controller.abort(new Error("synthetic cancellation"));
  let dependencyCalls = 0;
  const forbidden = async () => {
    dependencyCalls += 1;
    throw new Error("must not be called");
  };
  await assert.rejects(
    ensureDirectoryRootProtection(undefined, {
      helperPath: join(PROJECT_ROOT, ".tmp", "never-opened-helper"),
      helperSha256: "a".repeat(64),
      signal: controller.signal,
      testDependencies: {
        platform: "win32",
        fs: {
          lstat: forbidden,
          open: forbidden,
          realpath: forbidden
        },
        checkDirectoryRoot: forbidden,
        runHelper: forbidden,
        validateHelperMetadata: forbidden
      }
    }),
    (error) => {
      assert.equal(error.code, "root_protection_aborted");
      assert.equal(error.settlement, "confirmed");
      return true;
    }
  );
  assert.equal(dependencyCalls, 0);
});

test("abort after marker open performs one close and starts no helper", async (t) => {
  const { record, rootPath } = await registerCase(t, "abort-marker-open");
  const helper = await writeFakeHelper(t, rootPath);
  const controller = new AbortController();
  const tracking = trackingFileSystem({
    onOpen(_handle, index) {
      if (index === 0) {
        controller.abort(new Error("synthetic cancellation"));
      }
    }
  });
  let helperCalls = 0;
  await assert.rejects(
    ensureDirectoryRootProtection(record, {
      ...helper,
      signal: controller.signal,
      testDependencies: dependencies(async () => {
        helperCalls += 1;
        throw new Error("must not run");
      }, {
        fs: tracking.fs
      })
    }),
    (error) => {
      assert.equal(error.code, "root_protection_aborted");
      assert.equal(error.settlement, "confirmed");
      return true;
    }
  );
  assert.equal(tracking.opened.length, 1);
  assert.equal(tracking.opened[0].closeCalls, 1);
  assert.equal(helperCalls, 0);
});

test("marker close rejection is preserved as uncertain settlement", async (t) => {
  const { record, rootPath } = await registerCase(t, "marker-close-reject");
  const helper = await writeFakeHelper(t, rootPath);
  const controller = new AbortController();
  const tracking = trackingFileSystem({
    closeErrorAt: 0,
    onOpen(_handle, index) {
      if (index === 0) {
        controller.abort(new Error("synthetic cancellation"));
      }
    }
  });
  await assert.rejects(
    ensureDirectoryRootProtection(record, {
      ...helper,
      signal: controller.signal,
      testDependencies: dependencies(fakeHelper().runHelper, {
        fs: tracking.fs
      })
    }),
    (error) => {
      assert.equal(error.code, "root_protection_settlement_uncertain");
      assert.equal(error.settlement, "uncertain");
      assert.equal(error.settlementCode, "handle_close_failed");
      assert.equal(error.closeErrors.length, 1);
      assert.equal(error.closeErrors[0].code, "EIO");
      return true;
    }
  );
  assert.equal(tracking.opened[0].closeCalls, 1);
});

test("one rejected close does not skip the other transferred handle", async (t) => {
  const { record, rootPath } = await registerCase(t, "all-handles-close");
  const helper = await writeFakeHelper(t, rootPath);
  const tracking = trackingFileSystem({ closeErrorAt: 1 });
  await assert.rejects(
    ensureDirectoryRootProtection(record, {
      ...helper,
      testDependencies: dependencies(async () => {
        throw new Error("synthetic helper failure");
      }, {
        fs: tracking.fs
      })
    }),
    (error) => {
      assert.equal(error.code, "root_protection_settlement_uncertain");
      assert.equal(error.settlement, "uncertain");
      return true;
    }
  );
  assert.equal(tracking.opened.length, 2);
  assert.equal(tracking.opened[0].closeCalls, 1);
  assert.equal(tracking.opened[1].closeCalls, 1);
});

test("metadata failure aggregates every transferred close uncertainty", async (t) => {
  const { record, rootPath } = await registerCase(t, "combined-close-uncertainty");
  const helper = await writeFakeHelper(t, rootPath);
  const tracking = trackingFileSystem({ closeErrorAt: [0, 1] });
  await assert.rejects(
    ensureDirectoryRootProtection(record, {
      ...helper,
      testDependencies: dependencies(fakeHelper().runHelper, {
        fs: tracking.fs,
        async validateHelperMetadata() {
          throw new Error("synthetic helper metadata failure");
        }
      })
    }),
    (error) => {
      assert.equal(error.code, "root_protection_settlement_uncertain");
      assert.equal(error.settlement, "uncertain");
      assert.equal(error.closeErrors.length, 2);
      assert.equal(error.cause?.message, "synthetic helper metadata failure");
      return true;
    }
  );
  assert.deepEqual(tracking.opened.map((entry) => entry.closeCalls), [1, 1]);
});

test("helper metadata failure starts marker close while helper close remains pending", async (t) => {
  const { record, rootPath } = await registerCase(t, "helper-close-cross-layer-pending");
  const helper = await writeFakeHelper(t, rootPath);
  let releaseHelperClose;
  let markHelperClose;
  const helperCloseStarted = new Promise((resolve) => {
    markHelperClose = resolve;
  });
  const helperCloseGate = new Promise((resolve) => {
    releaseHelperClose = resolve;
  });
  const tracking = trackingFileSystem({
    async closeGate(_record, index) {
      if (index === 1) {
        markHelperClose();
        await helperCloseGate;
      }
    }
  });
  let settled = false;
  const protection = ensureDirectoryRootProtection(record, {
    ...helper,
    testDependencies: dependencies(undefined, {
      fs: tracking.fs,
      async validateHelperMetadata() {
        throw new Error("synthetic helper metadata failure");
      }
    })
  }).then(
    (value) => {
      settled = true;
      return { value };
    },
    (error) => {
      settled = true;
      return { error };
    }
  );

  await helperCloseStarted;
  await delay(10);
  assert.equal(settled, false);
  assert.deepEqual(tracking.opened.map((entry) => entry.closeCalls), [1, 1]);
  releaseHelperClose();
  const result = await protection;
  assert.equal(result.error.code, "root_protection_helper_trust_invalid");
  assert.equal(result.error.settlement, "confirmed");
});

test("helper parent realpath failure keeps the transferred marker under cleanup ownership", async (t) => {
  const { record, rootPath } = await registerCase(t, "helper-realpath-failure");
  const helper = await writeFakeHelper(t, rootPath);
  const tracking = trackingFileSystem();
  const result = await ensureDirectoryRootProtection(record, {
    ...helper,
    testDependencies: dependencies(undefined, {
      fs: {
        ...tracking.fs,
        async realpath() {
          throw Object.assign(new Error("synthetic realpath failure"), { code: "EACCES" });
        }
      }
    })
  }).then(
    (value) => ({ value }),
    (error) => ({ error })
  );

  assert.equal(result.error.code, "root_protection_helper_trust_invalid");
  assert.equal(result.error.settlement, "confirmed");
  assert.deepEqual(tracking.opened.map((entry) => entry.closeCalls), [1]);
});

test("helper parent mismatch closes the transferred marker exactly once", async (t) => {
  const { record, rootPath } = await registerCase(t, "helper-parent-mismatch");
  const helper = await writeFakeHelper(t, rootPath);
  const tracking = trackingFileSystem();
  const result = await ensureDirectoryRootProtection(record, {
    ...helper,
    testDependencies: dependencies(undefined, {
      fs: {
        ...tracking.fs,
        async realpath() {
          return `${rootPath}-linked`;
        }
      }
    })
  }).then(
    (value) => ({ value }),
    (error) => ({ error })
  );

  assert.equal(result.error.code, "root_protection_helper_trust_invalid");
  assert.equal(result.error.settlement, "confirmed");
  assert.deepEqual(tracking.opened.map((entry) => entry.closeCalls), [1]);
});

test("abort after helper ownership transfer closes the marker exactly once", async (t) => {
  const { record, rootPath } = await registerCase(t, "helper-transfer-abort");
  const helper = await writeFakeHelper(t, rootPath);
  const controller = new AbortController();
  const tracking = trackingFileSystem();
  const result = await ensureDirectoryRootProtection(record, {
    ...helper,
    signal: controller.signal,
    testDependencies: dependencies(undefined, {
      fs: {
        ...tracking.fs,
        async realpath(path) {
          controller.abort(new Error("synthetic transfer cancellation"));
          return realpath(path);
        }
      }
    })
  }).then(
    (value) => ({ value }),
    (error) => ({ error })
  );

  assert.equal(result.error.code, "root_protection_aborted");
  assert.equal(result.error.settlement, "confirmed");
  assert.deepEqual(tracking.opened.map((entry) => entry.closeCalls), [1]);
});

test("helper error does not settle before the exact child close", async (t) => {
  const { record, rootPath } = await registerCase(t, "error-before-close");
  const helper = await writeFakeHelper(t, rootPath);
  const tracking = trackingFileSystem();
  const child = fakeHelperChild();
  let markError;
  const errorObserved = new Promise((resolve) => {
    markError = resolve;
  });
  let settled = false;
  const protection = ensureDirectoryRootProtection(record, {
    ...helper,
    testDependencies: dependencies(undefined, {
      fs: tracking.fs,
      spawn() {
        setImmediate(() => {
          child.emit("error", Object.assign(
            new Error("synthetic spawn error"),
            { code: "ENOENT" }
          ));
          markError();
        });
        return child;
      }
    })
  }).then(
    (value) => {
      settled = true;
      return { value };
    },
    (error) => {
      settled = true;
      return { error };
    }
  );

  await errorObserved;
  await delay(10);
  assert.equal(settled, false);
  child.emit("close", 1, null);
  const result = await protection;
  assert.equal(result.error.code, "root_protection_helper_spawn_failed");
  assert.equal(result.error.settlement, "confirmed");
  assert.deepEqual(tracking.opened.map((entry) => entry.closeCalls), [1, 1]);
});

test("default helper runner resolves a successful child close without using the abort signal field", async (t) => {
  const { record, rootPath } = await registerCase(t, "native-success");
  const helper = await writeFakeHelper(t, rootPath);
  const child = fakeHelperChild();
  let fakeFlags = BASE_FLAGS;
  child.stdin.end = (line) => {
    const request = JSON.parse(String(line));
    setImmediate(() => {
      const before = fakeFlags;
      if (request.operation === "set_immutable") {
        fakeFlags |= IMMUTABLE_FLAG;
      }
      const after = fakeFlags;
      const value = helperSuccess(request, before, after);
      child.stdout.emit(
        "data",
        Buffer.from(`${JSON.stringify(value)}\n`, "utf8")
      );
      child.emit("close", 0, null);
    });
  };
  const receipt = await ensureDirectoryRootProtection(record, {
    ...helper,
    testDependencies: dependencies(undefined, {
      spawn() {
        return child;
      }
    })
  });
  assert.equal(receipt.ok, true);
  assert.equal(receipt.changed, true);
  assert.equal(receipt.flagsAfter.immutable, true);
});

test("post-spawn stdin failure waits for the exact child close and kills once", async (t) => {
  const { record, rootPath } = await registerCase(t, "post-spawn-sync-error");
  const helper = await writeFakeHelper(t, rootPath);
  const tracking = trackingFileSystem();
  const child = fakeHelperChild();
  let killCalls = 0;
  let markKillAttempted;
  const killAttempted = new Promise((resolve) => {
    markKillAttempted = resolve;
  });
  child.kill = () => {
    killCalls += 1;
    markKillAttempted();
    return true;
  };
  child.stdin.end = () => {
    throw new Error("synthetic stdin failure");
  };
  let settled = false;
  const protection = ensureDirectoryRootProtection(record, {
    ...helper,
    testDependencies: dependencies(undefined, {
      fs: tracking.fs,
      spawn() {
        return child;
      }
    })
  }).then(
    (value) => {
      settled = true;
      return { value };
    },
    (error) => {
      settled = true;
      return { error };
    }
  );
  // Filesystem setup before spawn is asynchronous, so a fixed delay can check
  // killCalls before stdin.end has even been reached under parallel load.
  await killAttempted;
  assert.equal(settled, false);
  assert.equal(killCalls, 1);
  child.emit("close", 1, null);
  const result = await protection;
  assert.equal(result.error.code, "root_protection_helper_spawn_failed");
  assert.equal(result.error.settlement, "confirmed");
  assert.deepEqual(tracking.opened.map((entry) => entry.closeCalls), [1, 1]);
});

test("all handle close attempts start before a pending close settles, then recheck abort", async (t) => {
  const { record, rootPath } = await registerCase(t, "parallel-close-abort");
  const helper = await writeFakeHelper(t, rootPath);
  const controller = new AbortController();
  let releaseFirstClose;
  let markFirstClose;
  const firstCloseStarted = new Promise((resolve) => {
    markFirstClose = resolve;
  });
  const firstCloseGate = new Promise((resolve) => {
    releaseFirstClose = resolve;
  });
  const tracking = trackingFileSystem({
    async closeGate(_record, index) {
      if (index === 0) {
        markFirstClose();
        controller.abort(new Error("cancelled during close"));
        await firstCloseGate;
      }
    }
  });
  let settled = false;
  const protection = ensureDirectoryRootProtection(record, {
    ...helper,
    signal: controller.signal,
    testDependencies: dependencies(async () => {
      throw new Error("synthetic helper failure");
    }, {
      fs: tracking.fs
    })
  }).then(
    (value) => {
      settled = true;
      return { value };
    },
    (error) => {
      settled = true;
      return { error };
    }
  );
  await firstCloseStarted;
  await delay(10);
  assert.equal(settled, false);
  assert.deepEqual(tracking.opened.map((entry) => entry.closeCalls), [1, 1]);
  releaseFirstClose();
  const result = await protection;
  assert.equal(result.error.code, "root_protection_aborted");
  assert.equal(result.error.settlement, "confirmed");
});

test("sets immutable once and allows marker-only roots on later starts", async (t) => {
  const { record, rootPath } = await registerCase(t, "marker-only");
  await unlink(stagePath(record));
  const helper = await writeFakeHelper(t, rootPath);
  const fake = fakeHelper();
  let rootChecks = 0;
  const first = await ensureDirectoryRootProtection(record, {
    ...helper,
    testDependencies: dependencies(fake.runHelper, {
      checkDirectoryRoot(active, options) {
        rootChecks += 1;
        return win32RootGuard(active, options);
      }
    })
  });
  assert.equal(first.stageBefore, "missing");
  assert.equal(first.stageAfter, "missing");
  assert.equal(first.changed, true);
  assert.equal(first.flagsBefore.immutable, false);
  assert.equal(first.flagsAfter.immutable, true);
  assert.equal(fake.calls.length, 3);
  assert.deepEqual(fake.calls.map((call) => call.operation), [
    "inspect",
    "set_immutable",
    "inspect"
  ]);

  const second = await ensureDirectoryRootProtection(record, {
    ...helper,
    testDependencies: dependencies(fake.runHelper, {
      checkDirectoryRoot(active, options) {
        rootChecks += 1;
        return win32RootGuard(active, options);
      }
    })
  });
  assert.equal(second.stageBefore, "missing");
  assert.equal(second.stageAfter, "missing");
  assert.equal(second.changed, false);
  assert.equal(second.flagsBefore.immutable, true);
  assert.equal(second.flagsAfter.immutable, true);
  assert.equal(fake.calls.length, 4);
  assert.equal(rootChecks, 4);
});

test("accepts a present stage only when it remains the same inode", async (t) => {
  const { record, rootPath } = await registerCase(t, "same-stage");
  const helper = await writeFakeHelper(t, rootPath);
  const fake = fakeHelper();
  const receipt = await ensureDirectoryRootProtection(record, {
    ...helper,
    testDependencies: dependencies(fake.runHelper)
  });
  assert.equal(receipt.stageBefore, "same_inode");
  assert.equal(receipt.stageAfter, "same_inode");
  assert.equal(receipt.flagsAfter.immutable, true);
});

test("rejects helper digest mismatches before spawning", async (t) => {
  const { record, rootPath } = await registerCase(t, "bad-helper-sha");
  const helper = await writeFakeHelper(t, rootPath);
  let spawns = 0;
  await expectHandleError(
    ensureDirectoryRootProtection(record, {
      ...helper,
      helperSha256: "0".repeat(64),
      testDependencies: dependencies(async () => {
        spawns += 1;
        throw new Error("must not run");
      })
    }),
    "root_protection_helper_digest_mismatch"
  );
  assert.equal(spawns, 0);
});

test("rejects a stage path bound to a different inode before spawning", async (t) => {
  const { record, rootPath } = await registerCase(t, "wrong-stage");
  const helper = await writeFakeHelper(t, rootPath);
  await unlink(stagePath(record));
  await writeFile(stagePath(record), "different inode\n");
  let spawns = 0;
  await expectHandleError(
    ensureDirectoryRootProtection(record, {
      ...helper,
      testDependencies: dependencies(async () => {
        spawns += 1;
        throw new Error("must not run");
      })
    }),
    "root_protection_stage_changed"
  );
  assert.equal(spawns, 0);
});

test("propagates marker content corruption from the root guard", async (t) => {
  const { record, rootPath } = await registerCase(t, "bad-marker");
  const helper = await writeFakeHelper(t, rootPath);
  await writeFile(markerPath(record), "corrupt marker\n");
  await assert.rejects(
    ensureDirectoryRootProtection(record, {
      ...helper,
      testDependencies: dependencies(fakeHelper().runHelper)
    }),
    (error) => {
      assert.ok(error instanceof DirectoryRootGuardError);
      assert.equal(error.code, "directory_root_marker_mismatch");
      return true;
    }
  );
});

test("blocks a missing stage that appears during protection", async (t) => {
  const { record, rootPath } = await registerCase(t, "stage-appears");
  await unlink(stagePath(record));
  const helper = await writeFakeHelper(t, rootPath);
  const fake = fakeHelper({
    onRequest(request) {
      if (request.operation === "set_immutable") {
        return writeFile(stagePath(record), "late alias\n");
      }
    }
  });
  await expectHandleError(
    ensureDirectoryRootProtection(record, {
      ...helper,
      testDependencies: dependencies(fake.runHelper)
    }),
    "root_protection_stage_changed"
  );
});

test("blocks a present stage that disappears during protection", async (t) => {
  const { record, rootPath } = await registerCase(t, "stage-disappears");
  const helper = await writeFakeHelper(t, rootPath);
  const fake = fakeHelper({
    async onRequest(request) {
      if (request.operation === "set_immutable") {
        await unlink(stagePath(record));
      }
    }
  });
  await expectHandleError(
    ensureDirectoryRootProtection(record, {
      ...helper,
      testDependencies: dependencies(fake.runHelper)
    }),
    "root_protection_stage_changed"
  );
});

test("blocks marker path replacement even when the opened handle is unchanged", async (t) => {
  const { record, rootPath } = await registerCase(t, "marker-replaced");
  const helper = await writeFakeHelper(t, rootPath);
  const fake = fakeHelper({
    async onRequest(request) {
      if (request.operation === "set_immutable") {
        const replacement = await readFile(markerPath(record));
        await unlink(markerPath(record));
        await writeFile(markerPath(record), replacement);
      }
    }
  });
  await expectHandleError(
    ensureDirectoryRootProtection(record, {
      ...helper,
      testDependencies: dependencies(fake.runHelper)
    }),
    "root_protection_marker_changed"
  );
});

test("rejects duplicate helper JSON fields", async (t) => {
  const { record, rootPath } = await registerCase(t, "duplicate-json");
  const helper = await writeFakeHelper(t, rootPath);
  const duplicate = `{"version":1,"version":1,"helperVersion":"1","operation":"inspect","ok":true,"identity":{"dev":"1","ino":"1","size":"1"},"contentSha256":"${"0".repeat(64)}","flagsBefore":{"raw":"524288","immutable":false},"flagsAfter":{"raw":"524288","immutable":false},"capabilities":{"effectiveHasLinuxImmutable":true,"permittedHasLinuxImmutable":true,"boundingHasLinuxImmutable":true,"noNewPrivs":false}}\n`;
  await expectHandleError(
    ensureDirectoryRootProtection(record, {
      ...helper,
      testDependencies: dependencies(async () => ({
        exitCode: 0,
        signal: null,
        timedOut: false,
        overflow: false,
        stdout: Buffer.from(duplicate),
        stderr: Buffer.alloc(0)
      }))
    }),
    "root_protection_helper_protocol_invalid"
  );
});

test("rejects fields outside the fixed helper response schema", async (t) => {
  const { record, rootPath } = await registerCase(t, "extra-helper-field");
  const helper = await writeFakeHelper(t, rootPath);
  await expectHandleError(
    ensureDirectoryRootProtection(record, {
      ...helper,
      testDependencies: dependencies(async ({ request }) => {
        const response = helperSuccess(request, BASE_FLAGS, BASE_FLAGS);
        return helperResult({ ...response, changed: false });
      })
    }),
    "root_protection_helper_protocol_invalid"
  );
});

test("fails closed on timeout, unexpected exit and malformed error responses", async (t) => {
  const { record, rootPath } = await registerCase(t, "protocol-failures");
  const helper = await writeFakeHelper(t, rootPath);
  await expectHandleError(
    ensureDirectoryRootProtection(record, {
      ...helper,
      testDependencies: dependencies(async () => ({
        exitCode: null,
        signal: "SIGKILL",
        timedOut: true,
        overflow: false,
        stdout: Buffer.alloc(0),
        stderr: Buffer.alloc(0)
      }))
    }),
    "root_protection_helper_timeout"
  );
  await expectHandleError(
    ensureDirectoryRootProtection(record, {
      ...helper,
      testDependencies: dependencies(async () => ({
        exitCode: 1,
        signal: null,
        timedOut: false,
        overflow: false,
        stdout: Buffer.from(`${JSON.stringify(helperFailure("inspect", "unsupported"))}\n`),
        stderr: Buffer.alloc(0)
      }))
    }),
    "root_protection_helper_protocol_invalid"
  );
  await expectHandleError(
    ensureDirectoryRootProtection(record, {
      ...helper,
      testDependencies: dependencies(async () => helperResult(
        helperSuccess(
          {
            operation: "inspect",
            expected: record.markerIdentity
          },
          BASE_FLAGS,
          BASE_FLAGS
        ),
        2
      ))
    }),
    "root_protection_helper_protocol_invalid"
  );
});

test("surfaces a fixed helper failure code without errno or raw output", async (t) => {
  const { record, rootPath } = await registerCase(t, "helper-error");
  const helper = await writeFakeHelper(t, rootPath);
  const fake = fakeHelper({ allowSet: false });
  await expectHandleError(
    ensureDirectoryRootProtection(record, {
      ...helper,
      testDependencies: dependencies(fake.runHelper)
    }),
    "root_protection_helper_failed",
    "set_flags_failed"
  );
});

test("rechecks the root after protection and never repairs a late failure", async (t) => {
  const { record, rootPath } = await registerCase(t, "post-root-failure");
  const helper = await writeFakeHelper(t, rootPath);
  const fake = fakeHelper();
  let calls = 0;
  const deps = dependencies(fake.runHelper, {
    checkDirectoryRoot(active, options) {
      calls += 1;
      if (calls === 2) {
        throw new Error("post-protection root check failed");
      }
      return win32RootGuard(active, options);
    }
  });
  await assert.rejects(
    ensureDirectoryRootProtection(record, {
      ...helper,
      testDependencies: deps
    }),
    /post-protection root check failed/
  );
  assert.equal(calls, 2);
});

test("validates requiredBytes and reserveBytes as exact decimal strings", async (t) => {
  const { record, rootPath } = await registerCase(t, "space-input");
  const helper = await writeFakeHelper(t, rootPath);
  await expectHandleError(
    ensureDirectoryRootProtection(record, {
      ...helper,
      reserveBytes: 1,
      testDependencies: dependencies(fakeHelper().runHelper)
    }),
    "root_protection_input_invalid"
  );
});

test("Linux integration: first set, repeat protection and marker-only", {
  skip: !RUN_POSITIVE_INTEGRATION
}, async (t) => {
  const first = await registerLinuxFixture(t, "integration-idempotent");
  const firstReceipt = await ensureDirectoryRootProtection(first, {
    helperPath: INTEGRATION_HELPER,
    helperSha256: INTEGRATION_HELPER_SHA256
  });
  assert.equal(firstReceipt.changed, true);
  assert.equal(firstReceipt.stageBefore, "same_inode");
  assert.equal(firstReceipt.flagsBefore.immutable, false);
  assert.equal(firstReceipt.flagsAfter.immutable, true);
  t.diagnostic(
    `SFSC_ROOT_PROTECTION_RECEIPT_FIRST_SET=${JSON.stringify(firstReceipt)}`
  );

  const secondReceipt = await ensureDirectoryRootProtection(first, {
    helperPath: INTEGRATION_HELPER,
    helperSha256: INTEGRATION_HELPER_SHA256
  });
  assert.equal(secondReceipt.changed, false);
  assert.equal(secondReceipt.flagsAfter.immutable, true);
  t.diagnostic(
    `SFSC_ROOT_PROTECTION_RECEIPT_REPEAT=${JSON.stringify(secondReceipt)}`
  );

  const markerOnly = await registerLinuxFixture(t, "integration-marker-only");
  await unlink(stagePath(markerOnly));
  const markerOnlyReceipt = await ensureDirectoryRootProtection(markerOnly, {
    helperPath: INTEGRATION_HELPER,
    helperSha256: INTEGRATION_HELPER_SHA256
  });
  assert.equal(markerOnlyReceipt.stageBefore, "missing");
  assert.equal(markerOnlyReceipt.stageAfter, "missing");
  assert.equal(markerOnlyReceipt.flagsAfter.immutable, true);
  t.diagnostic(
    `SFSC_ROOT_PROTECTION_RECEIPT_MARKER_ONLY=${JSON.stringify(markerOnlyReceipt)}`
  );
});

test("Linux integration: wrong helper digest is rejected", {
  skip: !RUN_POSITIVE_INTEGRATION
}, async (t) => {
  const record = await registerLinuxFixture(t, "integration-bad-helper");
  await expectHandleError(
    ensureDirectoryRootProtection(record, {
      helperPath: INTEGRATION_HELPER,
      helperSha256: "0".repeat(64)
    }),
    "root_protection_helper_digest_mismatch"
  );
});

test("Linux integration: wrong stage inode is rejected", {
  skip: !RUN_POSITIVE_INTEGRATION
}, async (t) => {
  const record = await registerLinuxFixture(t, "integration-bad-stage");
  await unlink(stagePath(record));
  await writeFile(stagePath(record), "different inode\n");
  await expectHandleError(
    ensureDirectoryRootProtection(record, {
      helperPath: INTEGRATION_HELPER,
      helperSha256: INTEGRATION_HELPER_SHA256
    }),
    "root_protection_stage_changed"
  );
});

test("Linux integration: wrong marker content is rejected", {
  skip: !RUN_POSITIVE_INTEGRATION
}, async (t) => {
  const record = await registerLinuxFixture(t, "integration-bad-marker");
  await writeFile(markerPath(record), "corrupt marker\n");
  await assert.rejects(
    ensureDirectoryRootProtection(record, {
      helperPath: INTEGRATION_HELPER,
      helperSha256: INTEGRATION_HELPER_SHA256
    }),
    (error) => {
      assert.ok(error instanceof DirectoryRootGuardError);
      assert.equal(error.code, "directory_root_marker_mismatch");
      return true;
    }
  );
});

test("Linux integration: fresh root without immutable capability is rejected", {
  skip: !RUN_NO_CAP_INTEGRATION
}, async (t) => {
  const record = await registerLinuxFixture(t, "integration-no-capability");
  const inspectBefore = await inspectNativeMarker(record);
  assert.equal(inspectBefore.ok, true);
  assert.equal(inspectBefore.flagsBefore.immutable, false);
  assert.equal(inspectBefore.flagsBefore.raw, inspectBefore.flagsAfter.raw);
  assert.equal(inspectBefore.capabilities.effectiveHasLinuxImmutable, false);
  assert.equal(inspectBefore.capabilities.permittedHasLinuxImmutable, false);
  assert.equal(inspectBefore.capabilities.boundingHasLinuxImmutable, false);
  await assert.rejects(
    ensureDirectoryRootProtection(record, {
      helperPath: INTEGRATION_HELPER,
      helperSha256: INTEGRATION_HELPER_SHA256
    }),
    (error) => {
      assert.ok(error instanceof LinuxImmutableHandleError);
      assert.equal(error.code, "root_protection_helper_failed");
      assert.equal(error.helperCode, "set_flags_failed");
      return true;
    }
  );
  const inspectAfter = await inspectNativeMarker(record);
  assert.equal(inspectAfter.ok, true);
  assert.equal(inspectAfter.flagsBefore.raw, inspectBefore.flagsBefore.raw);
  assert.equal(inspectAfter.flagsAfter.raw, inspectBefore.flagsAfter.raw);
  assert.equal(inspectAfter.flagsAfter.immutable, false);
});

async function registerLinuxFixture(t, label) {
  await mkdir(INTEGRATION_TEST_ROOT, { recursive: true });
  const rootPath = await mkdtemp(join(INTEGRATION_TEST_ROOT, `${label}-`));
  t.after(async () => {
    try {
      await rm(rootPath, { recursive: true, force: true });
    } catch (error) {
      const message =
        `SFSC_ROOT_PROTECTION_LEFTOVER=${rootPath} ` +
        `cleanup=${error?.code || error?.message || "unknown"}`;
      t.diagnostic(message);
      console.error(message);
    }
  });
  const pending = await prepareDirectoryRootRegistration({
    rootPath,
    serverId: SERVER_ID,
    shareId: SHARE_ID
  }, {
    nowMs: Date.now()
  });
  const activeRecord = await commitDirectoryRootRegistration(pending, {
    nowMs: Date.now() + 1000
  });
  t.diagnostic(
    `SFSC_ROOT_PROTECTION_REGISTERED=${JSON.stringify(activeRecord)}`
  );
  return activeRecord;
}

async function inspectNativeMarker(record) {
  const noFollow = fsConstants.O_NOFOLLOW ?? 0;
  const marker = await open(
    markerPath(record),
    fsConstants.O_RDONLY | noFollow
  );
  const helper = await open(
    INTEGRATION_HELPER,
    fsConstants.O_RDONLY | noFollow
  );
  try {
    const markerStat = await marker.stat({ bigint: true });
    const request = {
      version: 1,
      operation: "inspect",
      expected: {
        dev: markerStat.dev.toString(),
        ino: markerStat.ino.toString(),
        size: markerStat.size.toString(),
        sha256: record.marker.contentSha256
      }
    };
    const result = await runNativeHelperForTest(marker, helper, request);
    assert.equal(result.exitCode, 0);
    assert.equal(result.signal, null);
    const raw = result.stdout.toString("utf8").trim();
    const parsed = JSON.parse(raw);
    assert.equal(JSON.stringify(parsed), raw);
    return parsed;
  } finally {
    await helper.close().catch(() => {});
    await marker.close().catch(() => {});
  }
}

function runNativeHelperForTest(marker, helper, request) {
  return new Promise((resolve, reject) => {
    const child = spawn("/proc/self/fd/4", ["protect-fd"], {
      cwd: "/",
      env: { LANG: "C" },
      shell: false,
      stdio: ["pipe", "pipe", "pipe", marker.fd, helper.fd]
    });
    const stdout = [];
    const stderr = [];
    let outputBytes = 0;
    let settled = false;
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(new Error("native inspect helper timed out"));
    }, 5_000);
    timer.unref?.();

    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) {
        reject(error);
      } else {
        resolve(result);
      }
    };
    child.once("error", (error) => finish(error));
    child.once("close", (exitCode, signal) => finish(null, {
      exitCode,
      signal,
      stdout: Buffer.concat(stdout),
      stderr: Buffer.concat(stderr)
    }));
    child.stdin.once("error", () => {});
    child.stdout.on("data", (chunk) => {
      outputBytes += chunk.length;
      if (outputBytes > 16 * 1024) {
        child.kill("SIGKILL");
        finish(new Error("native inspect helper output exceeded the limit"));
        return;
      }
      stdout.push(chunk);
    });
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.stdin.end(`${JSON.stringify(request)}\n`);
  });
}
