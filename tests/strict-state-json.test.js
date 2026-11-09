import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  normalizeStartupStateLimits,
  parseStrictStateJson,
  STARTUP_STATE_POLICY_LIMITS
} from "../src/service/strictStateJson.js";

const LIMITS = Object.freeze({
  maxBytes: 1024,
  maxDepth: 16,
  maxNodes: 100
});

test("policy limits can only be tightened with exact options", () => {
  assert.deepEqual(
    normalizeStartupStateLimits({
      maxBytes: STARTUP_STATE_POLICY_LIMITS.maxBytes,
      maxDepth: STARTUP_STATE_POLICY_LIMITS.maxDepth,
      maxNodes: STARTUP_STATE_POLICY_LIMITS.maxNodes
    }),
    STARTUP_STATE_POLICY_LIMITS
  );
  for (const [key, cap] of Object.entries(STARTUP_STATE_POLICY_LIMITS)) {
    assert.throws(
      () => normalizeStartupStateLimits({ ...LIMITS, [key]: cap + 1 }),
      error => error?.code === "startup_quiescence_input_invalid"
    );
  }
  for (const invalid of [
    null,
    {},
    { ...LIMITS, extra: 1 },
    { ...LIMITS, maxBytes: 0 },
    { ...LIMITS, maxDepth: 1.5 },
    { ...LIMITS, maxNodes: Number.MAX_SAFE_INTEGER + 1 }
  ]) {
    assert.throws(
      () => normalizeStartupStateLimits(invalid),
      error => error?.code === "startup_quiescence_input_invalid"
    );
  }
});

test("byte limit uses the actual typed-array view bounds", () => {
  const backing = Buffer.from("xx{}yy", "utf8");
  const view = backing.subarray(2, 4);
  const parsed = parseStrictStateJson(view, {
    ...LIMITS,
    maxBytes: 2
  });
  assert.equal(parsed.observedBytes, 2);
  assert.equal(
    parsed.rawSha256,
    createHash("sha256").update(Buffer.from("{}")).digest("hex")
  );
  assert.equal(Object.getPrototypeOf(parsed.value), null);

  assert.throws(
    () => parseStrictStateJson(backing, { ...LIMITS, maxBytes: 5 }),
    error => error?.code === "startup_quiescence_state_too_large"
      && error.observedBytes === 6
  );
});

test("native typed-array bounds ignore own buffer and length shadows", () => {
  const backing = Buffer.from("xx{}yy", "utf8");
  const view = backing.subarray(2, 4);
  Object.defineProperties(view, {
    buffer: {
      configurable: true,
      value: new ArrayBuffer(1)
    },
    byteOffset: {
      configurable: true,
      value: 0
    },
    byteLength: {
      configurable: true,
      value: 0
    }
  });
  const parsed = parseStrictStateJson(view, {
    ...LIMITS,
    maxBytes: 2
  });
  assert.equal(parsed.observedBytes, 2);
  assert.equal(
    parsed.rawSha256,
    createHash("sha256").update(Buffer.from("{}")).digest("hex")
  );
});

test("SharedArrayBuffer-backed input is rejected", {
  skip: typeof SharedArrayBuffer === "undefined"
    ? "SharedArrayBuffer unavailable"
    : false
}, () => {
  const shared = new SharedArrayBuffer(2);
  const view = new Uint8Array(shared);
  view.set([0x7b, 0x7d]);
  assert.throws(
    () => parseStrictStateJson(view, LIMITS),
    error => error?.code === "startup_quiescence_input_invalid"
  );
});

test("ordinary-buffer getter shadow cannot disguise SharedArrayBuffer backing", {
  skip: typeof SharedArrayBuffer === "undefined"
    ? "SharedArrayBuffer unavailable"
    : false
}, () => {
  const shared = new SharedArrayBuffer(2);
  const view = new Uint8Array(shared);
  view.set([0x7b, 0x7d]);
  Object.defineProperties(view, {
    buffer: {
      configurable: true,
      value: new ArrayBuffer(2)
    },
    byteOffset: {
      configurable: true,
      value: 0
    },
    byteLength: {
      configurable: true,
      value: 2
    }
  });
  assert.throws(
    () => parseStrictStateJson(view, LIMITS),
    error => error?.code === "startup_quiescence_input_invalid"
      && !error.message.includes("shared")
  );
});

test("throwing option proxies normalize to typed input_invalid", () => {
  const proxy = new Proxy({}, {
    getPrototypeOf() {
      throw new Error("proxy-secret");
    }
  });
  assert.throws(
    () => normalizeStartupStateLimits(proxy),
    error => error?.code === "startup_quiescence_input_invalid"
      && !error.message.includes("proxy-secret")
  );
});

test("only Uint8Array and Buffer views are accepted", () => {
  assert.throws(
    () => parseStrictStateJson(
      new Uint16Array([0x7d7b]),
      LIMITS
    ),
    error => error?.code === "startup_quiescence_input_invalid"
  );
  assert.throws(
    () => parseStrictStateJson(
      new DataView(new ArrayBuffer(2)),
      LIMITS
    ),
    error => error?.code === "startup_quiescence_input_invalid"
  );
});

test("decoded duplicate keys are rejected before object construction", () => {
  assert.throws(
    () => parseStrictStateJson(
      Buffer.from("{\"a\":1,\"\\u0061\":2}", "utf8"),
      LIMITS
    ),
    error => error?.code === "startup_quiescence_duplicate_key"
      && error.rawSha256?.length === 64
  );
});

test("container depth and value node limits have exact boundaries", () => {
  const depthOne = Buffer.from("{\"a\":1}", "utf8");
  assert.equal(
    parseStrictStateJson(depthOne, {
      ...LIMITS,
      maxDepth: 1,
      maxNodes: 3
    }).value.a,
    1
  );
  assert.throws(
    () => parseStrictStateJson(depthOne, {
      ...LIMITS,
      maxDepth: 0
    }),
    error => error?.code === "startup_quiescence_input_invalid"
  );
  assert.throws(
    () => parseStrictStateJson(
      Buffer.from("{\"a\":{\"b\":1}}", "utf8"),
      { ...LIMITS, maxDepth: 1, maxNodes: 10 }
    ),
    error => error?.code === "startup_quiescence_depth_exceeded"
  );

  const twoNodes = Buffer.from("[1]", "utf8");
  assert.equal(
    parseStrictStateJson(twoNodes, {
      ...LIMITS,
      maxNodes: 2
    }).nodeCount,
    2
  );
  assert.throws(
    () => parseStrictStateJson(twoNodes, {
      ...LIMITS,
      maxNodes: 1
    }),
    error => error?.code === "startup_quiescence_node_limit_exceeded"
  );
});

test("fixed policy depth and node caps accept exact limits and reject plus one", () => {
  const exactDepthSource = `${
    "[".repeat(STARTUP_STATE_POLICY_LIMITS.maxDepth)
  }0${
    "]".repeat(STARTUP_STATE_POLICY_LIMITS.maxDepth)
  }`;
  const exactDepth = parseStrictStateJson(
    Buffer.from(exactDepthSource, "utf8"),
    STARTUP_STATE_POLICY_LIMITS
  );
  assert.equal(
    exactDepth.nodeCount,
    STARTUP_STATE_POLICY_LIMITS.maxDepth + 1
  );

  const overDepthSource = `${
    "[".repeat(STARTUP_STATE_POLICY_LIMITS.maxDepth + 1)
  }0${
    "]".repeat(STARTUP_STATE_POLICY_LIMITS.maxDepth + 1)
  }`;
  assert.throws(
    () => parseStrictStateJson(
      Buffer.from(overDepthSource, "utf8"),
      STARTUP_STATE_POLICY_LIMITS
    ),
    error => error?.code === "startup_quiescence_depth_exceeded"
  );

  const exactNodesSource =
    `[${"0,".repeat(STARTUP_STATE_POLICY_LIMITS.maxNodes - 2)}0]`;
  const exactNodes = parseStrictStateJson(
    Buffer.from(exactNodesSource, "utf8"),
    STARTUP_STATE_POLICY_LIMITS
  );
  assert.equal(exactNodes.nodeCount, STARTUP_STATE_POLICY_LIMITS.maxNodes);

  const overNodesSource =
    `[${"0,".repeat(STARTUP_STATE_POLICY_LIMITS.maxNodes - 1)}0]`;
  assert.throws(
    () => parseStrictStateJson(
      Buffer.from(overNodesSource, "utf8"),
      STARTUP_STATE_POLICY_LIMITS
    ),
    error => error?.code === "startup_quiescence_node_limit_exceeded"
  );
});

test("invalid UTF-8, BOM, trailing content and unpaired surrogates fail", () => {
  const cases = [
    [Buffer.from([0x7b, 0xff, 0x7d]), "startup_quiescence_json_invalid"],
    [Buffer.from([0xef, 0xbb, 0xbf, 0x7b, 0x7d]), "startup_quiescence_json_invalid"],
    [Buffer.from("{}x", "utf8"), "startup_quiescence_json_invalid"],
    [Buffer.from("{\"x\":\"\\uD800\"}", "utf8"), "startup_quiescence_json_invalid"]
  ];
  for (const [bytes, code] of cases) {
    assert.throws(
      () => parseStrictStateJson(bytes, LIMITS),
      error => error?.code === code
    );
  }
});

test("ambiguous JSON numbers fail closed", () => {
  for (const source of [
    "-0",
    "9007199254740992",
    "1e309"
  ]) {
    assert.throws(
      () => parseStrictStateJson(Buffer.from(source, "utf8"), LIMITS),
      error => error?.code === "startup_quiescence_json_invalid"
    );
  }
});

test("prototype-like keys remain inert own data and output is deep frozen", () => {
  const parsed = parseStrictStateJson(
    Buffer.from(
      "{\"__proto__\":{\"polluted\":true},\"constructor\":1,\"prototype\":2}",
      "utf8"
    ),
    LIMITS
  );
  assert.equal(Object.getPrototypeOf(parsed.value), null);
  assert.equal(Object.hasOwn(parsed.value, "__proto__"), true);
  assert.equal(Object.getPrototypeOf(parsed.value.__proto__), null);
  assert.equal(parsed.value.__proto__.polluted, true);
  assert.equal({}.polluted, undefined);
  assert.equal(Object.isFrozen(parsed), true);
  assert.equal(Object.isFrozen(parsed.value), true);
  assert.equal(Object.isFrozen(parsed.value.__proto__), true);
});

test("parser errors expose safe diagnostics but no source snippet", () => {
  let observed;
  try {
    parseStrictStateJson(
      Buffer.from("{\"secret\":\"do-not-echo\",}", "utf8"),
      LIMITS
    );
  } catch (error) {
    observed = error;
  }
  assert.equal(observed?.code, "startup_quiescence_json_invalid");
  assert.doesNotMatch(observed.message, /do-not-echo|secret/);
  assert.equal(Object.hasOwn(observed, "value"), false);
  assert.equal(observed.rawSha256?.length, 64);
  assert.equal(Number.isSafeInteger(observed.observedBytes), true);
});
