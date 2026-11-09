import { createHash, randomUUID, createPrivateKey, createPublicKey } from "node:crypto";
import { readFile as readFileSync } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { lstat, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import { canonicalJson, createEnrollmentIdentityId } from "../core/enrollmentProtocol.js";
import { buildVlessUri } from "../core/serverAdmin.js";
import { RELATION_SERVICE_SFTP_USER } from "./relationServiceProductWiring.js";
import { acquireServerStateLock } from "../core/serverStateLock.js";

const REGISTRY_KIND = "sfsc-enrollment-data-channel";
const REGISTRY_VERSION = 1;
const DATA_USER = "sfsc-enrollment-data";
const KEY_TYPE = Buffer.from("ssh-ed25519", "ascii");

function dataClientName(relationId) {
  return `${DATA_USER}-${createHash("sha256").update(relationId).digest("hex").slice(0, 24)}`;
}

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function sshWireKey(jwk) {
  if (!jwk || jwk.kty !== "OKP" || jwk.crv !== "Ed25519" || typeof jwk.x !== "string") {
    throw fail("enrollment_data_key_invalid", "Ed25519 public key is invalid");
  }
  const raw = Buffer.from(jwk.x, "base64url");
  if (raw.length !== 32 || raw.toString("base64url") !== jwk.x) {
    throw fail("enrollment_data_key_invalid", "Ed25519 public key encoding is invalid");
  }
  const length = value => { const b = Buffer.alloc(4); b.writeUInt32BE(value.length); return Buffer.concat([b, value]); };
  return Buffer.concat([length(KEY_TYPE), length(raw)]);
}

export function enrollmentEd25519OpenSshKey(jwk) {
  const wire = sshWireKey(jwk);
  return `ssh-ed25519 ${wire.toString("base64")}`;
}

export function enrollmentSshFingerprint(jwk) {
  return `SHA256:${createHash("sha256").update(sshWireKey(jwk)).digest("base64").replace(/=+$/, "")}`;
}

export function applyEnrollmentDataOverlay(config, { relations } = {}) {
  if (!config || typeof config !== "object" || !Array.isArray(relations)) throw new TypeError("data overlay inputs are invalid");
  const output = structuredClone(config);
  const inbound = (output.inbounds || []).find(item => item.type === "vless" && item.tag === "vless-in");
  if (!inbound) throw fail("enrollment_data_channel_not_ready", "VLESS inbound is unavailable");
  inbound.users ||= [];
  const route = output.route || (output.route = {});
  const rules = route.rules || (route.rules = []);
  for (const relation of relations) {
    const port = relation?.listener?.port;
    const dataIdentity = relation?.dataIdentity;
    if (relation?.listener?.host !== "127.0.0.1" || !Number.isSafeInteger(port) || port < 1 || port > 65535
      || typeof dataIdentity?.clientName !== "string" || !dataIdentity.clientName.startsWith(`${DATA_USER}-`)
      || typeof dataIdentity.uuid !== "string") {
      throw fail("enrollment_data_state_invalid", "Data relation listener is invalid");
    }
    const existing = inbound.users.find(item => item.name === dataIdentity.clientName);
    if (existing && existing.uuid !== dataIdentity.uuid) throw fail("enrollment_data_state_invalid", "Data VLESS identity conflicts with configuration");
    if (!existing) inbound.users.push({ name: dataIdentity.clientName, uuid: dataIdentity.uuid });
    const deny = { inbound: ["vless-in"], auth_user: [dataIdentity.clientName], action: "reject" };
    if (!rules.some(item => canonicalJson(item) === canonicalJson(deny))) rules.unshift(deny);
    const allow = { inbound: ["vless-in"], auth_user: [dataIdentity.clientName], ip_cidr: ["127.0.0.1/32"], port: [port], action: "route", outbound: "direct" };
    if (!rules.some(item => canonicalJson(item) === canonicalJson(allow))) {
      const denyIndex = rules.findIndex(item => canonicalJson(item) === canonicalJson(deny));
      rules.splice(denyIndex < 0 ? rules.length : denyIndex, 0, allow);
    }
  }
  route.final ||= "direct";
  return output;
}

async function readRegistry(path) {
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink() || !info.isFile() || (process.platform !== "win32" && (info.mode & 0o777) !== 0o600)) {
      throw fail("enrollment_data_state_invalid", "Data channel registry must be a private regular file");
    }
    const value = JSON.parse(await readFile(path, "utf8"));
    if (Object.keys(value).sort().join(",") !== "built,channels,kind,version"
      || value.kind !== REGISTRY_KIND || value.version !== REGISTRY_VERSION || !value.channels || typeof value.channels !== "object"
      || !(value.built === null || (value.built && /^[a-f0-9]{64}$/.test(value.built.configSha256)
        && value.built.members && typeof value.built.members === "object"))) {
      throw fail("enrollment_data_state_invalid", "Data channel registry is invalid");
    }
    for (const [relationId, channel] of Object.entries(value.channels)) {
      if (!/^rel_[A-Za-z0-9_-]{16,128}$/.test(relationId)
        || Object.keys(channel).sort().join(",") !== "applied,channelRevision,clientName,uuid"
        || channel.clientName !== dataClientName(relationId)
        || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(channel.uuid)
        || !/^chrev_[A-Za-z0-9_-]{16,128}$/.test(channel.channelRevision)
        || !(channel.applied === null || (channel.applied && /^[a-f0-9]{64}$/.test(channel.applied.configSha256)
          && typeof channel.applied.appliedAt === "string" && channel.applied.channelRevision === channel.channelRevision
          && Number.isSafeInteger(channel.applied.listenerPort) && typeof channel.applied.connectionUri === "string"))) {
        throw fail("enrollment_data_state_invalid", "Data relation channel registry entry is invalid");
      }
    }
    for (const [relationId, member] of Object.entries(value.built?.members || {})) {
      if (!Object.hasOwn(value.channels, relationId)
        || Object.keys(member).sort().join(",") !== "channelRevision,connectionUri,listenerPort,uuid"
        || member.channelRevision !== value.channels[relationId].channelRevision
        || member.uuid !== value.channels[relationId].uuid
        || !Number.isSafeInteger(member.listenerPort) || member.listenerPort < 1 || member.listenerPort > 65535
        || typeof member.connectionUri !== "string" || !member.connectionUri.startsWith("vless://")) {
        throw fail("enrollment_data_state_invalid", "Data overlay build snapshot is invalid");
      }
    }
    if (canonicalJson(value) + "\n" !== await readFile(path, "utf8")) throw fail("enrollment_data_state_invalid", "Data channel registry is not canonical");
    return value;
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    return null;
  }
}

async function writeRegistry(path, value) {
  const parent = dirname(path);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const temp = join(parent, `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
  const handle = await open(temp, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL, 0o600);
  try { await handle.writeFile(`${canonicalJson(value)}\n`); await handle.chmod(0o600); await handle.sync(); }
  finally { await handle.close(); }
  try {
    await rename(temp, path);
    if (process.platform !== "win32") { const dir = await open(parent, fsConstants.O_RDONLY); try { await dir.sync(); } finally { await dir.close(); } }
  } catch (error) { await unlink(temp).catch(() => {}); throw error; }
}

async function writeAuthorizedKey(path, line) {
  const parent = dirname(path);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const existing = await lstat(path).catch(error => error?.code === "ENOENT" ? null : Promise.reject(error));
  if (existing && (existing.isSymbolicLink() || !existing.isFile())) throw fail("enrollment_data_authorization_denied", "authorized_keys target is not a regular file");
  if (existing && (await readFile(path, "utf8") !== `${line}\n` && await readFile(path, "utf8") !== line)) {
    throw fail("enrollment_data_authorization_conflict", "authorized_keys content conflicts with the enrolled device key");
  }
  if (existing) return;
  const temp = join(parent, `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
  const handle = await open(temp, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL, 0o600);
  try { await handle.writeFile(`${line}\n`); await handle.chmod(0o600); await handle.sync(); }
  finally { await handle.close(); }
  try { await rename(temp, path); }
  catch (error) { await unlink(temp).catch(() => {}); if (error?.code !== "EEXIST") throw error; }
}

function consumedBinding(snapshot, deviceId, relationId) {
  const device = snapshot.authority?.devices?.[deviceId];
  if (!device || device.revokedAt !== null) throw fail("enrollment_data_authorization_denied", "Enrolled device is unavailable or revoked");
  const record = Object.values(snapshot.authority.enrollmentRecords || {}).find(item => item.deviceId === deviceId
    && item.consumedAt !== null && item.consumedByDeviceId === deviceId);
  if (!record) throw fail("enrollment_data_authorization_denied", "Device has no consumed enrollment record");
  const grant = snapshot.authority.relationGrants?.[relationId];
  if (!grant || grant.revokedAt !== null || grant.binding.identity.deviceId !== deviceId) {
    throw fail("enrollment_data_authorization_denied", "Relation grant is absent, revoked, or belongs to another device");
  }
  return { device, record, binding: grant.binding };
}

export function createEnrollmentDataAuthorization({ catalog, enrollmentService, facade, registryPath, authorizedKeysDir,
  getTunnel, getBootstrapUuid, getCurrentConfigSha256, listenerPortStart = 22000, listenerPortEnd = 32000, now = () => Date.now(), ttlMs = 5 * 60 * 1000 } = {}) {
  if (typeof catalog?.read !== "function" || typeof catalog?.update !== "function"
    || typeof enrollmentService?.listConsumedGrants !== "function"
    || typeof enrollmentService?.getTrustMaterial !== "function"
    || typeof facade?.query !== "function"
    || typeof registryPath !== "string" || typeof authorizedKeysDir !== "string" || typeof getTunnel !== "function"
    || typeof getBootstrapUuid !== "function" || typeof getCurrentConfigSha256 !== "function") throw new TypeError("data authorization dependencies are incomplete");
  if (!Number.isInteger(listenerPortStart) || !Number.isInteger(listenerPortEnd) || listenerPortStart < 1 || listenerPortEnd > 65535 || listenerPortStart > listenerPortEnd) throw new TypeError("listener port range is invalid");
  let queue = Promise.resolve();
  let registry = null;
  let releaseLock = null;
  const serialized = task => { const next = queue.then(task, task); queue = next.then(() => undefined, () => undefined); return next; };

  async function initialize() {
    if (!releaseLock) releaseLock = acquireServerStateLock({ dataDir: dirname(registryPath), statePath: registryPath, lockPath: `${registryPath}.lock` });
    registry = await readRegistry(registryPath);
    if (!registry) {
      registry = { kind: REGISTRY_KIND, version: REGISTRY_VERSION, channels: {}, built: null };
      await writeRegistry(registryPath, registry);
    }
    return structuredClone(registry);
  }

  async function ensureDataIdentity(relationId) {
    if (!registry) await initialize();
    const current = registry.channels[relationId];
    const bootstrapUuid = await getBootstrapUuid();
    if (typeof bootstrapUuid !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(bootstrapUuid)) throw fail("enrollment_data_channel_not_ready", "Bootstrap identity is unavailable");
    if (current) {
      if (current.uuid === bootstrapUuid) throw fail("enrollment_data_state_invalid", "Data VLESS identity reuses the bootstrap identity");
      return current;
    }
    let uuid = randomUUID();
    while (uuid === bootstrapUuid) uuid = randomUUID();
    const next = { clientName: dataClientName(relationId), uuid,
      channelRevision: createEnrollmentIdentityId("channelRevision"), applied: null };
    registry = { ...registry, channels: { ...registry.channels, [relationId]: next } };
    await writeRegistry(registryPath, registry);
    return next;
  }

  async function ensureRelation({ deviceId, relationId }) {
    return serialized(async () => {
      if (!registry) await initialize();
      const grants = await enrollmentService.listConsumedGrants();
      const grant = grants.find(item => item.deviceId === deviceId && item.bindings?.some(binding => binding.identity.relationId === relationId));
      if (!grant) throw fail("enrollment_data_authorization_denied", "No current consumed enrollment grant matches this relation");
      const first = await catalog.read();
      const verified = consumedBinding(first, deviceId, relationId);
      if (canonicalJson(grant.publicKeyJwk) !== canonicalJson(verified.device.publicKeyJwk)
        || grant.publicKeyFingerprint !== verified.device.publicKeyFingerprint
        || canonicalJson(grant.bindings.find(binding => binding.identity.relationId === relationId)) !== canonicalJson(verified.binding)) {
        throw fail("enrollment_data_authorization_conflict", "Enrollment service grant differs from catalog authority");
      }
      const root = first.roots[verified.binding.identity.rootId];
      if (!root || root.status !== "active") throw fail("enrollment_data_authorization_denied", "Bound directory root is not active");
      const dataIdentity = await ensureDataIdentity(relationId);
      const authorizedKeysPath = join(authorizedKeysDir, `${relationId}.keys`);
      const keyLine = enrollmentEd25519OpenSshKey(verified.device.publicKeyJwk);
      const relation = await catalog.update({ expectedRevision: first.revision }, async state => {
        const current = consumedBinding(state, deviceId, relationId);
        if (canonicalJson(current.binding) !== canonicalJson(verified.binding)
          || canonicalJson(current.device.publicKeyJwk) !== canonicalJson(verified.device.publicKeyJwk)) throw fail("enrollment_data_authorization_conflict", "Enrollment grant changed during relation materialization");
        const rootCurrent = state.roots[current.binding.identity.rootId];
        if (!rootCurrent || rootCurrent.status !== "active") throw fail("enrollment_data_authorization_denied", "Bound directory root is not active");
        const old = state.relations[relationId];
        if (old) {
          if (old.rootId !== current.binding.identity.rootId || old.authorization.devicePublicKeyFingerprint !== current.device.publicKeyFingerprint) throw fail("enrollment_data_authorization_conflict", "Existing relation materialization conflicts with its grant");
          await writeAuthorizedKey(old.authorization.authorizedKeysPath, keyLine);
          return;
        }
        const used = new Set(Object.values(state.relations).map(item => item.listener.port));
        let port = listenerPortStart;
        while (port <= listenerPortEnd && used.has(port)) port += 1;
        if (port > listenerPortEnd) throw fail("enrollment_data_listener_capacity", "No unique loopback listener port is available", 503);
        await writeAuthorizedKey(authorizedKeysPath, keyLine);
        state.relations[relationId] = {
          rootId: current.binding.identity.rootId,
          authorization: { authorizedKeysPath, sha256: createHash("sha256").update(`${keyLine}\n`).digest("hex"), devicePublicKeyFingerprint: current.device.publicKeyFingerprint },
          listener: { host: "127.0.0.1", port }
        };
      });
      return { binding: verified.binding, relation: (await catalog.read()).relations[relationId], dataIdentity: structuredClone(dataIdentity), registry: structuredClone(registry) };
    });
  }

  async function prepareDataAuthorization({ deviceId, relationId } = {}) {
    const materialized = await ensureRelation({ deviceId, relationId });
    if (!isRunning(await facade.query({ relationId }))) throw fail("enrollment_data_relation_not_ready", "Relation SFTP service is not running", 503);
    const state = await catalog.read();
    const verified = consumedBinding(state, deviceId, relationId);
    const tunnel = await getTunnel();
    const dataIdentity = registry.channels[relationId];
    const currentConfigSha256 = await getCurrentConfigSha256();
    const member = registry.built?.members?.[relationId];
    if (tunnel?.restartRequired === true || !dataIdentity?.applied
      || !/^[a-f0-9]{64}$/.test(currentConfigSha256 || "")
      || dataIdentity.applied.configSha256 !== currentConfigSha256
      || registry.built.configSha256 !== currentConfigSha256
      || !member || member.channelRevision !== dataIdentity.channelRevision || member.uuid !== dataIdentity.uuid
      || member.listenerPort !== materialized.relation.listener.port
      || dataIdentity.applied.channelRevision !== dataIdentity.channelRevision
      || dataIdentity.applied.listenerPort !== member.listenerPort) {
      throw fail("enrollment_data_channel_not_ready", "Current data overlay config, relation snapshot, or tunnel state has not been successfully applied", 503);
    }
    const issuedAt = new Date(now()).toISOString();
    const trust = await enrollmentService.getTrustMaterial();
    if (trust.serverId !== state.authority.serverId || !/^key_[A-Za-z0-9_-]{16,128}$/.test(trust.keyId)) throw fail("enrollment_data_signer_invalid", "Provisioning signer does not match the catalog server identity");
    const connectionUri = buildVlessUri(tunnel, { uuid: dataIdentity.uuid, clientName: dataIdentity.clientName });
    if (dataIdentity.channelRevision === verified.binding.channelRevision || member.connectionUri !== connectionUri
      || dataIdentity.applied.connectionUri !== connectionUri) throw fail("enrollment_data_channel_not_ready", "Current data tunnel URI differs from the applied channel", 503);
    const hostKey = await hostKeyMaterial(state.serverHostKey);
    const payload = {
      protocol: "sfsc-data-authorization", version: 1, kind: "data-authorization",
      serverId: state.authority.serverId, keyId: trust.keyId, deviceId, publicKeyFingerprint: verified.device.publicKeyFingerprint,
      binding: verified.binding,
      authorization: { directions: ["bidirectional"], allowDelete: true },
      displayName: String(state.roots[verified.binding.identity.rootId].canonicalRoot).split(/[\\/]/).filter(Boolean).at(-1),
      sftp: { host: "127.0.0.1", port: materialized.relation.listener.port, user: RELATION_SERVICE_SFTP_USER, rootPath: "/" },
      serverHostKey: hostKey,
      sftpDataChannel: { connection: { type: "vless", uri: connectionUri }, channelRevision: dataIdentity.channelRevision },
      issuedAt, expiresAt: new Date(now() + ttlMs).toISOString()
    };
    return Object.freeze({ payload });
  }

  async function applyOverlay(config) {
    return serialized(async () => {
      if (!registry) await initialize();
      const state = await catalog.read();
      const tunnel = await getTunnel();
      const relations = Object.entries(state.relations).filter(([relationId, relation]) => {
        const grant = state.authority.relationGrants?.[relationId];
        return Boolean(grant && grant.revokedAt === null && state.roots[relation.rootId]?.status === "active"
          && state.authority.devices[grant.binding.identity.deviceId]?.revokedAt === null
          && state.authority.enrollmentRecords && Object.values(state.authority.enrollmentRecords).some(record => record.deviceId === grant.binding.identity.deviceId && record.consumedAt !== null)
          && registry.channels[relationId]);
      }).map(([relationId, relation]) => ({ ...relation, relationId, dataIdentity: registry.channels[relationId] }));
      const output = applyEnrollmentDataOverlay(config, { relations });
      const members = Object.fromEntries(relations.map(relation => [relation.relationId, {
        channelRevision: relation.dataIdentity.channelRevision,
        uuid: relation.dataIdentity.uuid,
        listenerPort: relation.listener.port,
        connectionUri: buildVlessUri(tunnel, { uuid: relation.dataIdentity.uuid, clientName: relation.dataIdentity.clientName })
      }]));
      const configSha256 = createHash("sha256").update(JSON.stringify(output, null, 2), "utf8").digest("hex");
      registry = { ...registry, built: { configSha256, members } };
      await writeRegistry(registryPath, registry);
      return output;
    });
  }

  async function markApplied({ expectedConfigSha256, restartResult } = {}) {
    return serialized(async () => {
      if (!registry) await initialize();
      if (!/^[a-f0-9]{64}$/.test(String(expectedConfigSha256 || ""))
        || !registry.built || registry.built.configSha256 !== expectedConfigSha256
        || restartResult?.ok !== true || restartResult?.configSha256 !== expectedConfigSha256) {
        throw fail("enrollment_data_channel_apply_failed", "Applied data overlay receipt does not match its config digest");
      }
      const state = await catalog.read();
      const appliedAt = typeof restartResult.restartedAt === "string" ? restartResult.restartedAt : new Date(now()).toISOString();
      registry = { ...registry, channels: Object.fromEntries(Object.entries(registry.channels).map(([relationId, channel]) => {
        const member = registry.built.members[relationId];
        const grant = state.authority.relationGrants?.[relationId];
        const device = grant && state.authority.devices[grant.binding.identity.deviceId];
        const hasConsumedEnrollment = device && Object.values(state.authority.enrollmentRecords || {}).some(record => (
          record.deviceId === grant.binding.identity.deviceId && record.consumedByDeviceId === record.deviceId && record.consumedAt !== null
        ));
        const relation = state.relations[relationId];
        const stillAuthorized = member && grant && grant.revokedAt === null && device?.revokedAt === null
          && hasConsumedEnrollment && relation?.listener.host === "127.0.0.1" && relation.listener.port === member.listenerPort
          && channel.uuid === member.uuid && channel.channelRevision === member.channelRevision
          && state.roots[relation.rootId]?.status === "active";
        return [relationId, { ...channel, applied: stillAuthorized ? { configSha256: expectedConfigSha256, appliedAt,
          channelRevision: member.channelRevision, listenerPort: member.listenerPort, connectionUri: member.connectionUri } : null }];
      })) };
      await writeRegistry(registryPath, registry);
      return { configSha256: expectedConfigSha256, appliedAt };
    });
  }

  async function isApplied({ expectedConfigSha256 } = {}) {
    return serialized(async () => {
      if (!registry) await initialize();
      if (!/^[a-f0-9]{64}$/.test(String(expectedConfigSha256 || ""))
        || registry.built?.configSha256 !== expectedConfigSha256) return false;
      const state = await catalog.read();
      const activeRelationIds = Object.entries(state.relations).filter(([relationId, relation]) => {
        const grant = state.authority.relationGrants?.[relationId];
        return Boolean(grant && grant.revokedAt === null && state.roots[relation.rootId]?.status === "active"
          && state.authority.devices[grant.binding.identity.deviceId]?.revokedAt === null
          && Object.values(state.authority.enrollmentRecords || {}).some(record => record.deviceId === grant.binding.identity.deviceId
            && record.consumedAt !== null && record.consumedByDeviceId === record.deviceId)
          && registry.channels[relationId]);
      }).map(([relationId]) => relationId).sort();
      const builtRelationIds = Object.keys(registry.built.members).sort();
      if (canonicalJson(activeRelationIds) !== canonicalJson(builtRelationIds)) return false;
      return activeRelationIds.every(relationId => {
        const channel = registry.channels[relationId];
        const member = registry.built.members[relationId];
        return channel?.applied?.configSha256 === expectedConfigSha256
          && channel.applied.channelRevision === member.channelRevision
          && channel.applied.listenerPort === member.listenerPort
          && channel.applied.connectionUri === member.connectionUri
          && channel.uuid === member.uuid
          && channel.channelRevision === member.channelRevision;
      });
    });
  }

  return Object.freeze({ initialize, materialize: ensureRelation, prepareDataAuthorization, applyOverlay, markApplied, isApplied, close() { releaseLock?.(); releaseLock = null; } });
}

function isRunning(value) {
  return value?.state === "running" || value?.status === "running" || value?.relation?.state === "running";
}

async function hostKeyMaterial(hostKeyRecord) {
  const info = await lstat(hostKeyRecord.path);
  if (info.isSymbolicLink() || !info.isFile() || (process.platform !== "win32" && (info.mode & 0o777) !== 0o600)) {
    throw fail("enrollment_data_host_key_invalid", "Catalog host key must be a private regular file");
  }
  const pem = await readFileSync(hostKeyRecord.path, "utf8");
  const privateKey = createPrivateKey({ key: pem, format: "pem" });
  if (privateKey.asymmetricKeyType !== "ed25519") throw fail("enrollment_data_host_key_invalid", "Catalog host key must be Ed25519");
  const publicKey = createPublicKey(privateKey);
  const derFingerprint = createHash("sha256").update(publicKey.export({ format: "der", type: "spki" })).digest("hex");
  if (derFingerprint !== hostKeyRecord.publicKeySha256) throw fail("enrollment_data_host_key_invalid", "Catalog host key does not match its configured public-key digest");
  const jwk = publicKey.export({ format: "jwk" });
  const raw = Buffer.from(jwk.x, "base64url");
  const length = value => { const b = Buffer.alloc(4); b.writeUInt32BE(value.length); return Buffer.concat([b, value]); };
  const wire = Buffer.concat([length(KEY_TYPE), length(raw)]);
  return { publicKey: `ssh-ed25519 ${wire.toString("base64")}`, fingerprint: `SHA256:${createHash("sha256").update(wire).digest("base64").replace(/=+$/, "")}` };
}
