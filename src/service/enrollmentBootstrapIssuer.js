import { createHash, randomUUID, randomBytes } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { lstat, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import { encodeChannelImportCode } from "../core/channelImportCode.js";
import { buildVlessUri } from "../core/serverAdmin.js";
import {
  canonicalJson,
  createEnrollmentIdentityId,
  DEFAULT_CHANNEL_MAX_TTL_MS
} from "../core/enrollmentProtocol.js";
import { createHttpError } from "../core/errors.js";

const REGISTRY_KIND = "sfsc-enrollment-bootstrap-registry";
const REGISTRY_VERSION = 1;
const BOOTSTRAP_NAME = "sfsc-enrollment-bootstrap";
const BOOTSTRAP_PATH = "/api/enrollment/v1";

function error(code, message, status = 503) {
  return createHttpError(code, status, message);
}

function validateIdentity(value) {
  if (!value || value.kind !== REGISTRY_KIND || value.version !== REGISTRY_VERSION
    || Object.keys(value).sort().join(",") !== "applied,bootstrapUuid,channelFingerprint,channelRevision,kind,version"
    || typeof value.bootstrapUuid !== "string"
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value.bootstrapUuid)
    || typeof value.channelRevision !== "string"
    || !/^chrev_[A-Za-z0-9_-]{16,128}$/.test(value.channelRevision)
    || typeof value.channelFingerprint !== "string"
    || !/^[a-f0-9]{64}$/.test(value.channelFingerprint)
    || !(value.applied === null || (value.applied
      && Object.keys(value.applied).sort().join(",") === "appliedAt,channelFingerprint,channelRevision,configSha256,gatewayPort,overlayFingerprint"
      && value.applied.channelRevision === value.channelRevision
      && value.applied.channelFingerprint === value.channelFingerprint
      && value.applied.overlayFingerprint === overlayFingerprint({ clientName: BOOTSTRAP_NAME, uuid: value.bootstrapUuid }, value.applied.gatewayPort)
      && Number.isInteger(value.applied.gatewayPort) && value.applied.gatewayPort > 0 && value.applied.gatewayPort <= 65535
      && /^[a-f0-9]{64}$/.test(value.applied.configSha256)
      && typeof value.applied.appliedAt === "string"))) {
    throw error("enrollment_state_invalid", "Bootstrap channel registry is invalid", 500);
  }
  return value;
}

async function readRegistry(path) {
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink() || !info.isFile()
      || (process.platform !== "win32" && (info.mode & 0o777) !== 0o600)) {
      throw error("enrollment_state_invalid", "Bootstrap channel registry must be a private regular file", 500);
    }
    const bytes = await readFile(path);
    const raw = bytes.toString("utf8");
    const value = JSON.parse(raw);
    if (raw !== `${canonicalJson(value)}\n`
      || Object.keys(value || {}).sort().join(",") !== "applied,bootstrapUuid,channelFingerprint,channelRevision,kind,version") {
      throw error("enrollment_state_invalid", "Bootstrap channel registry is not canonical", 500);
    }
    return validateIdentity(value);
  } catch (cause) {
    if (cause?.code !== "ENOENT") throw cause;
    return null;
  }
}

async function writeRegistry(path, value) {
  const parent = dirname(path);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const temp = join(parent, `.${basename(path)}.${process.pid}.${randomBytes(12).toString("hex")}.tmp`);
  const handle = await open(temp, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL, 0o600);
  try {
    await handle.writeFile(`${canonicalJson(value)}\n`, "utf8");
    await handle.chmod(0o600);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temp, path);
  } catch (cause) {
    await unlink(temp).catch(() => {});
    throw cause;
  }
  if (process.platform !== "win32") {
    const directory = await open(parent, fsConstants.O_RDONLY);
    try { await directory.sync(); } finally { await directory.close(); }
  }
}

function channelFingerprint(tunnel, gatewayPort) {
  const material = {
    tunnel: {
      id: tunnel.id,
      protocol: tunnel.protocol,
      listenHost: tunnel.listenHost,
      listenPort: tunnel.listenPort,
      publicHost: tunnel.publicHost,
      publicPort: tunnel.publicPort,
      security: tunnel.security,
      transport: tunnel.transport,
      transportPath: tunnel.transportPath,
      remark: tunnel.remark,
      reality: tunnel.reality
    },
    bootstrapOrigin: `http://127.0.0.1:${gatewayPort}`,
    bootstrapPath: BOOTSTRAP_PATH
  };
  return createHash("sha256").update(canonicalJson(material), "utf8").digest("hex");
}

function validateGatewayPort(port) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw error("enrollment_channel_not_ready", "Bootstrap gateway must have a bound TCP port");
  }
}

function overlayFingerprint(bootstrapUser, gatewayPort) {
  const overlay = {
    user: { name: bootstrapUser.clientName, uuid: bootstrapUser.uuid },
    gatewayPort,
    allow: { inbound: ["vless-in"], auth_user: [BOOTSTRAP_NAME], ip_cidr: ["127.0.0.1/32"], port: [gatewayPort], action: "route", outbound: "direct" },
    deny: { inbound: ["vless-in"], auth_user: [BOOTSTRAP_NAME], action: "reject" }
  };
  return createHash("sha256").update(canonicalJson(overlay), "utf8").digest("hex");
}

/**
 * Persists one independent VLESS identity and the active channel revision.
 * Channel revisions rotate when the inherited tunnel or bootstrap endpoint changes.
 */
export function createEnrollmentBootstrapIssuer({ registryPath, enrollmentService, now = () => Date.now() } = {}) {
  if (typeof registryPath !== "string" || !registryPath) throw new TypeError("registryPath is required");
  if (!enrollmentService || typeof enrollmentService.setActiveChannelRevision !== "function"
    || typeof enrollmentService.issueChannelCode !== "function") {
    throw new TypeError("enrollmentService must provide setActiveChannelRevision and issueChannelCode");
  }
  let queue = Promise.resolve();
  let registry = null;

  async function serialized(task) {
    const previous = queue;
    let release;
    queue = new Promise(resolve => { release = resolve; });
    await previous;
    try { return await task(); } finally { release(); }
  }

  async function currentUnlocked({ tunnel, gatewayPort }) {
    validateGatewayPort(gatewayPort);
    if (!tunnel || typeof tunnel !== "object") throw error("enrollment_channel_not_ready", "Admin tunnel settings are unavailable");
    const fingerprint = channelFingerprint(tunnel, gatewayPort);
    if (!registry) registry = await readRegistry(registryPath);
    if (!registry) {
      registry = {
        kind: REGISTRY_KIND,
        version: REGISTRY_VERSION,
        bootstrapUuid: randomUUID(),
        channelRevision: createEnrollmentIdentityId("channelRevision"),
        channelFingerprint: fingerprint,
        applied: null
      };
      await writeRegistry(registryPath, registry);
    } else if (registry.channelFingerprint !== fingerprint) {
      registry = {
        ...registry,
        channelRevision: createEnrollmentIdentityId("channelRevision"),
        channelFingerprint: fingerprint,
        applied: null
      };
      await writeRegistry(registryPath, registry);
    }
    enrollmentService.setActiveChannelRevision(registry.channelRevision);
    return publicIdentity(registry, gatewayPort);
  }

  function publicIdentity(value, gatewayPort) {
    return Object.freeze({
      clientName: BOOTSTRAP_NAME,
      uuid: value.bootstrapUuid,
      channelRevision: value.channelRevision,
      gatewayPort
    });
  }

  async function initialize(input) {
    return serialized(() => currentUnlocked(input));
  }

  async function current(input) {
    return serialized(() => currentUnlocked(input));
  }

  async function issue({ tunnel, gatewayPort, configSha256, issuedAt: requestedIssuedAt, expiresAt: requestedExpiresAt, onIssued } = {}) {
    return serialized(async () => {
      const bootstrapUser = await currentUnlocked({ tunnel, gatewayPort });
      if (tunnel.restartRequired === true) {
        throw error("enrollment_channel_not_ready", "Apply the current sing-box tunnel configuration before issuing a bootstrap channel");
      }
      const expectedOverlayFingerprint = overlayFingerprint(bootstrapUser, gatewayPort);
      if (!registry.applied || registry.applied.channelRevision !== bootstrapUser.channelRevision
        || registry.applied.channelFingerprint !== registry.channelFingerprint
        || registry.applied.gatewayPort !== gatewayPort
        || registry.applied.overlayFingerprint !== expectedOverlayFingerprint
        || registry.applied.configSha256 !== configSha256) {
        throw error("enrollment_channel_not_ready", "Current bootstrap overlay has not been applied with this sing-box config digest");
      }
      if (onIssued !== undefined && typeof onIssued !== "function") {
        throw error("enrollment_request_invalid", "Channel issuance callback is invalid", 400);
      }
      const issuedAt = requestedIssuedAt === undefined ? now() : Date.parse(requestedIssuedAt);
      const expiresAt = requestedExpiresAt === undefined
        ? new Date(issuedAt + DEFAULT_CHANNEL_MAX_TTL_MS).toISOString()
        : requestedExpiresAt;
      const expiresAtMs = Date.parse(expiresAt);
      if (!Number.isFinite(issuedAt) || !Number.isFinite(expiresAtMs)
        || issuedAt > now() + 60_000 || expiresAtMs <= now()
        || expiresAtMs <= issuedAt || expiresAtMs - issuedAt > DEFAULT_CHANNEL_MAX_TTL_MS) {
        throw error("enrollment_channel_expired", "Channel code validity window is invalid or expired", 410);
      }
      const issuedAtIso = new Date(issuedAt).toISOString();
      const connection = {
        type: "vless",
        uri: buildVlessUri(tunnel, { uuid: bootstrapUser.uuid, clientName: bootstrapUser.clientName })
      };
      const bootstrap = {
        endpoint: `http://127.0.0.1:${gatewayPort}${BOOTSTRAP_PATH}`,
        purpose: "identity-enrollment",
        expiresAt
      };
      const signed = await enrollmentService.issueChannelCode({
        channelRevision: bootstrapUser.channelRevision,
        connection,
        bootstrap,
        expiresAt,
        issuedAt: issuedAtIso
      });
      const endpointOrigin = new URL(bootstrap.endpoint).origin;
      const pin = { ...signed.pin, allowedBootstrapOrigins: [endpointOrigin], bootstrapPathPrefix: BOOTSTRAP_PATH };
      const wrappedCode = encodeChannelImportCode({ channelCode: signed.channelCode, pin });
      const result = {
        channelRevision: bootstrapUser.channelRevision,
        bootstrapUser,
        connection,
        bootstrap,
        issuedAt: issuedAtIso,
        expiresAt,
        channelCode: signed.channelCode,
        wrappedCode,
        pin
      };
      await onIssued?.(result);
      return result;
    });
  }

  async function markApplied({ tunnel, gatewayPort, expectedConfigSha256, restartResult } = {}) {
    return serialized(async () => {
      const identity = await currentUnlocked({ tunnel, gatewayPort });
      if (!/^[a-f0-9]{64}$/.test(String(expectedConfigSha256 || ""))
        || restartResult?.ok !== true || restartResult?.configSha256 !== expectedConfigSha256) {
        throw error("singbox_restart_failed", "Bootstrap overlay application receipt does not match the expected config digest", 502);
      }
      registry = {
        ...registry,
        applied: {
          channelRevision: identity.channelRevision,
          channelFingerprint: registry.channelFingerprint,
          gatewayPort,
          overlayFingerprint: overlayFingerprint(identity, gatewayPort),
          configSha256: expectedConfigSha256,
          appliedAt: typeof restartResult.restartedAt === "string" ? restartResult.restartedAt : new Date(now()).toISOString()
        }
      };
      await writeRegistry(registryPath, registry);
      return registry.applied;
    });
  }

  async function isApplied({ tunnel, gatewayPort, configSha256 } = {}) {
    return serialized(async () => {
      const identity = await currentUnlocked({ tunnel, gatewayPort });
      const applied = registry.applied;
      return tunnel?.restartRequired !== true
        && /^[a-f0-9]{64}$/.test(String(configSha256 || ""))
        && applied?.channelRevision === identity.channelRevision
        && applied.channelFingerprint === registry.channelFingerprint
        && applied.gatewayPort === gatewayPort
        && applied.overlayFingerprint === overlayFingerprint(identity, gatewayPort)
        && applied.configSha256 === configSha256;
    });
  }

  async function snapshot() {
    return serialized(async () => {
      if (!registry) registry = await readRegistry(registryPath);
      return registry ? structuredClone(registry) : null;
    });
  }

  async function restoreSnapshot(value) {
    return serialized(async () => {
      if (!value) throw error("enrollment_state_invalid", "Bootstrap channel snapshot is missing", 500);
      registry = validateIdentity(structuredClone(value));
      await writeRegistry(registryPath, registry);
      enrollmentService.setActiveChannelRevision(registry.channelRevision);
      return structuredClone(registry);
    });
  }

  return Object.freeze({ initialize, current, issue, markApplied, isApplied, snapshot, restoreSnapshot });
}

/** Adds the bootstrap identity to the existing VLESS inbound and constrains it to the loopback gateway port. */
export function applyEnrollmentBootstrapOverlay(config, { bootstrapUser, gatewayPort } = {}) {
  validateGatewayPort(gatewayPort);
  if (!config || typeof config !== "object") throw new TypeError("sing-box config is required");
  if (!bootstrapUser || bootstrapUser.clientName !== BOOTSTRAP_NAME
    || typeof bootstrapUser.uuid !== "string") throw new TypeError("bootstrapUser is invalid");
  const output = structuredClone(config);
  const inbound = (output.inbounds || []).find(item => item.type === "vless" && item.tag === "vless-in");
  if (!inbound) throw error("enrollment_channel_not_ready", "The configured VLESS inbound is unavailable");
  inbound.users ||= [];
  const sameName = inbound.users.find(item => item.name === BOOTSTRAP_NAME);
  if (sameName && sameName.uuid !== bootstrapUser.uuid) {
    throw error("enrollment_state_invalid", "Bootstrap VLESS identity conflicts with an existing user", 500);
  }
  if (!sameName) inbound.users.push({ name: BOOTSTRAP_NAME, uuid: bootstrapUser.uuid });
  const route = output.route || (output.route = {});
  const rules = route.rules || (route.rules = []);
  const allow = { inbound: ["vless-in"], auth_user: [BOOTSTRAP_NAME], ip_cidr: ["127.0.0.1/32"], port: [gatewayPort], action: "route", outbound: "direct" };
  const deny = { inbound: ["vless-in"], auth_user: [BOOTSTRAP_NAME], action: "reject" };
  const existingAllow = rules.some(item => canonicalJson(item) === canonicalJson(allow));
  const existingDeny = rules.some(item => canonicalJson(item) === canonicalJson(deny));
  if (!existingDeny) rules.unshift(deny);
  if (!existingAllow) rules.unshift(allow);
  route.final ||= "direct";
  return output;
}
