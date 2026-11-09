import { createHash } from "node:crypto";

export const STARTUP_STATE_POLICY_LIMITS = Object.freeze({
  maxBytes: 16 * 1024 * 1024,
  maxDepth: 64,
  maxNodes: 200000
});

const OPTION_KEYS = Object.freeze([
  "maxBytes",
  "maxDepth",
  "maxNodes"
]);
const TYPED_ARRAY_PROTOTYPE = Object.getPrototypeOf(Uint8Array.prototype);
const TYPED_ARRAY_BUFFER_GETTER = Object.getOwnPropertyDescriptor(
  TYPED_ARRAY_PROTOTYPE,
  "buffer"
).get;
const TYPED_ARRAY_BYTE_OFFSET_GETTER = Object.getOwnPropertyDescriptor(
  TYPED_ARRAY_PROTOTYPE,
  "byteOffset"
).get;
const TYPED_ARRAY_BYTE_LENGTH_GETTER = Object.getOwnPropertyDescriptor(
  TYPED_ARRAY_PROTOTYPE,
  "byteLength"
).get;
const TYPED_ARRAY_TO_STRING_TAG_GETTER = Object.getOwnPropertyDescriptor(
  TYPED_ARRAY_PROTOTYPE,
  Symbol.toStringTag
).get;
const JSON_WHITESPACE = new Set([" ", "\t", "\n", "\r"]);
const NUMBER_PATTERN = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/;

export class StrictStateJsonError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "StrictStateJsonError";
    this.code = code;
    this.offset = Number.isSafeInteger(details.offset) ? details.offset : null;
    this.depth = Number.isSafeInteger(details.depth) ? details.depth : null;
    this.rawSha256 = typeof details.rawSha256 === "string"
      ? details.rawSha256
      : null;
    this.observedBytes = Number.isSafeInteger(details.observedBytes)
      ? details.observedBytes
      : null;
    this.nodeCount = Number.isSafeInteger(details.nodeCount)
      ? details.nodeCount
      : 0;
  }
}

export function parseStrictStateJson(bytes, options) {
  const limits = normalizeStartupStateLimits(options);
  const observed = observeTypedArray(bytes);
  const observedBytes = observed.byteLength;
  if (observedBytes > limits.maxBytes) {
    throw strictError(
      "startup_quiescence_state_too_large",
      "state bytes exceed the configured limit",
      { observedBytes }
    );
  }

  let copy;
  try {
    copy = new Uint8Array(observedBytes);
    copy.set(observed.view);
  } catch {
    throw strictError(
      "startup_quiescence_input_invalid",
      "state bytes must be an ordinary Uint8Array or Buffer",
      { observedBytes }
    );
  }

  const rawSha256 = createHash("sha256").update(copy).digest("hex");
  if (copy.byteLength >= 3
    && copy[0] === 0xef
    && copy[1] === 0xbb
    && copy[2] === 0xbf) {
    throw strictError(
      "startup_quiescence_json_invalid",
      "state JSON must not contain a UTF-8 BOM",
      { offset: 0, rawSha256, observedBytes }
    );
  }

  let text;
  try {
    text = new TextDecoder("utf-8", {
      fatal: true,
      ignoreBOM: true
    }).decode(copy);
  } catch {
    throw strictError(
      "startup_quiescence_json_invalid",
      "state bytes are not valid UTF-8",
      { offset: 0, rawSha256, observedBytes }
    );
  }

  const parser = new StrictJsonParser(
    text,
    limits,
    rawSha256,
    observedBytes
  );
  const value = parser.parse();
  return Object.freeze({
    value: deepFreeze(value),
    rawSha256,
    observedBytes,
    nodeCount: parser.nodeCount
  });
}

export function normalizeStartupStateLimits(options) {
  return normalizeLimits(options);
}

export function deepFreeze(value) {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) {
    return value;
  }
  Object.freeze(value);
  for (const nested of Object.values(value)) {
    deepFreeze(nested);
  }
  return value;
}

function normalizeLimits(options) {
  try {
    if (options === null
      || typeof options !== "object"
      || Array.isArray(options)) {
      throw invalidInput();
    }
    const prototype = Object.getPrototypeOf(options);
    if (prototype !== Object.prototype && prototype !== null) {
      throw invalidInput();
    }
    const keys = Reflect.ownKeys(options);
    if (keys.length !== OPTION_KEYS.length
      || keys.some(key => typeof key !== "string")
      || OPTION_KEYS.some(key => !Object.hasOwn(options, key))) {
      throw invalidInput();
    }

    const limits = {};
    for (const key of OPTION_KEYS) {
      const value = options[key];
      if (!Number.isSafeInteger(value)
        || value <= 0
        || value > STARTUP_STATE_POLICY_LIMITS[key]) {
        throw invalidInput();
      }
      limits[key] = value;
    }
    return Object.freeze(limits);
  } catch {
    throw invalidInput();
  }
}

function observeTypedArray(bytes) {
  try {
    const tag = Reflect.apply(
      TYPED_ARRAY_TO_STRING_TAG_GETTER,
      bytes,
      []
    );
    if (tag !== "Uint8Array") {
      throw new TypeError("typed array");
    }
    const buffer = Reflect.apply(TYPED_ARRAY_BUFFER_GETTER, bytes, []);
    const byteOffset = Reflect.apply(
      TYPED_ARRAY_BYTE_OFFSET_GETTER,
      bytes,
      []
    );
    const byteLength = Reflect.apply(
      TYPED_ARRAY_BYTE_LENGTH_GETTER,
      bytes,
      []
    );
    if (typeof SharedArrayBuffer !== "undefined"
      && buffer instanceof SharedArrayBuffer) {
      throw new TypeError("shared");
    }
    if (!(buffer instanceof ArrayBuffer)) {
      throw new TypeError("buffer");
    }
    const view = new Uint8Array(buffer, byteOffset, byteLength);
    return { view, byteLength };
  } catch {
    throw invalidInput();
  }
}

function invalidInput() {
  return strictError(
    "startup_quiescence_input_invalid",
    "startup quiescence options or input bytes are invalid"
  );
}

function strictError(code, message, details = {}) {
  return new StrictStateJsonError(code, message, details);
}

class StrictJsonParser {
  constructor(text, limits, rawSha256, observedBytes) {
    this.text = text;
    this.index = 0;
    this.limits = limits;
    this.rawSha256 = rawSha256;
    this.observedBytes = observedBytes;
    this.nodeCount = 0;
  }

  parse() {
    this.skipWhitespace();
    if (this.index === this.text.length) {
      this.fail("state JSON is empty", "startup_quiescence_json_invalid");
    }
    const value = this.parseValue(0);
    this.skipWhitespace();
    if (this.index !== this.text.length) {
      this.fail(
        "state JSON contains trailing content",
        "startup_quiescence_json_invalid"
      );
    }
    return value;
  }

  parseValue(parentDepth) {
    this.countNode();
    this.skipWhitespace();
    const character = this.text[this.index];
    if (character === "{") {
      return this.parseObject(parentDepth + 1);
    }
    if (character === "[") {
      return this.parseArray(parentDepth + 1);
    }
    if (character === "\"") {
      return this.parseString();
    }
    if (character === "t") {
      this.consumeLiteral("true");
      return true;
    }
    if (character === "f") {
      this.consumeLiteral("false");
      return false;
    }
    if (character === "n") {
      this.consumeLiteral("null");
      return null;
    }
    if (character === "-" || (character >= "0" && character <= "9")) {
      return this.parseNumber();
    }
    this.fail(
      "state JSON contains an unsupported value",
      "startup_quiescence_json_invalid"
    );
  }

  parseObject(depth) {
    this.checkContainerDepth(depth);
    this.index += 1;
    const object = Object.create(null);
    const keys = new Set();
    this.skipWhitespace();
    if (this.text[this.index] === "}") {
      this.index += 1;
      return object;
    }
    while (true) {
      this.skipWhitespace();
      if (this.text[this.index] !== "\"") {
        this.fail(
          "state JSON object keys must be strings",
          "startup_quiescence_json_invalid"
        );
      }
      const key = this.parseString();
      if (keys.has(key)) {
        this.fail(
          "state JSON contains a duplicate decoded object key",
          "startup_quiescence_duplicate_key"
        );
      }
      keys.add(key);
      this.skipWhitespace();
      this.expect(":");
      const value = this.parseValue(depth);
      Object.defineProperty(object, key, {
        value,
        enumerable: true,
        configurable: true,
        writable: true
      });
      this.skipWhitespace();
      if (this.text[this.index] === "}") {
        this.index += 1;
        return object;
      }
      this.expect(",");
    }
  }

  parseArray(depth) {
    this.checkContainerDepth(depth);
    this.index += 1;
    const array = [];
    this.skipWhitespace();
    if (this.text[this.index] === "]") {
      this.index += 1;
      return array;
    }
    while (true) {
      array.push(this.parseValue(depth));
      this.skipWhitespace();
      if (this.text[this.index] === "]") {
        this.index += 1;
        return array;
      }
      this.expect(",");
    }
  }

  parseString() {
    this.expect("\"");
    let value = "";
    while (this.index < this.text.length) {
      const character = this.text[this.index];
      this.index += 1;
      if (character === "\"") {
        if (!isWellFormedUnicode(value)) {
          this.fail(
            "state JSON contains an unpaired surrogate",
            "startup_quiescence_json_invalid"
          );
        }
        return value;
      }
      if (character === "\\") {
        if (this.index >= this.text.length) {
          this.fail(
            "state JSON string escape is truncated",
            "startup_quiescence_json_invalid"
          );
        }
        const escaped = this.text[this.index];
        this.index += 1;
        if (escaped === "\""
          || escaped === "\\"
          || escaped === "/") {
          value += escaped;
          continue;
        }
        if (escaped === "b") {
          value += "\b";
          continue;
        }
        if (escaped === "f") {
          value += "\f";
          continue;
        }
        if (escaped === "n") {
          value += "\n";
          continue;
        }
        if (escaped === "r") {
          value += "\r";
          continue;
        }
        if (escaped === "t") {
          value += "\t";
          continue;
        }
        if (escaped === "u") {
          value += this.parseUnicodeEscape();
          continue;
        }
        this.fail(
          "state JSON contains an invalid string escape",
          "startup_quiescence_json_invalid"
        );
      }
      if (character.charCodeAt(0) < 0x20) {
        this.fail(
          "state JSON strings must not contain control characters",
          "startup_quiescence_json_invalid"
        );
      }
      value += character;
    }
    this.fail(
      "state JSON string is unterminated",
      "startup_quiescence_json_invalid"
    );
  }

  parseUnicodeEscape() {
    const digits = this.text.slice(this.index, this.index + 4);
    if (!/^[0-9A-Fa-f]{4}$/.test(digits)) {
      this.fail(
        "state JSON contains an invalid unicode escape",
        "startup_quiescence_json_invalid"
      );
    }
    this.index += 4;
    return String.fromCharCode(Number.parseInt(digits, 16));
  }

  parseNumber() {
    const remaining = this.text.slice(this.index);
    const match = NUMBER_PATTERN.exec(remaining);
    if (!match) {
      this.fail(
        "state JSON contains an invalid number",
        "startup_quiescence_json_invalid"
      );
    }
    this.index += match[0].length;
    const value = Number(match[0]);
    if (!Number.isFinite(value)
      || Object.is(value, -0)
      || (Number.isInteger(value) && !Number.isSafeInteger(value))) {
      this.fail(
        "state JSON number is outside the unambiguous safe range",
        "startup_quiescence_json_invalid"
      );
    }
    return value;
  }

  consumeLiteral(literal) {
    if (this.text.slice(this.index, this.index + literal.length) !== literal) {
      this.fail(
        "state JSON contains an invalid literal",
        "startup_quiescence_json_invalid"
      );
    }
    this.index += literal.length;
  }

  checkContainerDepth(depth) {
    if (depth > this.limits.maxDepth) {
      this.fail(
        "state JSON exceeds the configured container depth",
        "startup_quiescence_depth_exceeded",
        depth
      );
    }
  }

  countNode() {
    this.nodeCount += 1;
    if (this.nodeCount > this.limits.maxNodes) {
      this.fail(
        "state JSON exceeds the configured node limit",
        "startup_quiescence_node_limit_exceeded"
      );
    }
  }

  skipWhitespace() {
    while (this.index < this.text.length
      && JSON_WHITESPACE.has(this.text[this.index])) {
      this.index += 1;
    }
  }

  expect(character) {
    if (this.text[this.index] !== character) {
      this.fail(
        `state JSON expected ${JSON.stringify(character)}`,
        "startup_quiescence_json_invalid"
      );
    }
    this.index += 1;
  }

  fail(message, code, depth = null) {
    throw new StrictStateJsonError(code, message, {
      offset: this.index,
      depth,
      rawSha256: this.rawSha256,
      observedBytes: this.observedBytes,
      nodeCount: this.nodeCount
    });
  }
}

function isWellFormedUnicode(value) {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        return false;
      }
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return false;
    }
  }
  return true;
}
