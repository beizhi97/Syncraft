import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";

// A `.zip` next to a `.zip.sha256` only proves the checksum was recomputed by
// whoever last touched the pair; it carries no authenticity. These helpers add a
// detached Ed25519 signature over the artifact digest so a receiver can prove the
// bundle came from the holder of the release key.
//
// Ed25519 is used because node:crypto supports it with no external dependency and
// the signature is small enough to ship as a text sidecar.

export const RELEASE_SIGNATURE_VERSION = 1;
export const RELEASE_SIGNATURE_ALGORITHM = "ed25519";
export const RELEASE_SIGNATURE_DIGEST = "sha256";

export function generateReleaseKeyPair() {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return {
    privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
    keyId: computeKeyId(publicKey.export({ type: "spki", format: "pem" }).toString())
  };
}

// The key id is a digest of the public key, so a signature names the key that
// produced it without embedding the key itself.
export function computeKeyId(publicKeyPem) {
  const normalized = normalizePem(publicKeyPem);
  return createHash("sha256").update(normalized).digest("hex").slice(0, 32);
}

export function sha256Hex(data) {
  return createHash("sha256").update(data).digest("hex");
}

export function signReleaseDigest(digestHex, privateKeyPem) {
  const digest = assertDigestHex(digestHex);
  const privateKey = loadPrivateKey(privateKeyPem);
  const publicKeyPem = createPublicKey(privateKey).export({ type: "spki", format: "pem" }).toString();
  const signature = sign(null, Buffer.from(digest, "utf8"), privateKey);
  return {
    version: RELEASE_SIGNATURE_VERSION,
    algorithm: RELEASE_SIGNATURE_ALGORITHM,
    digestAlgorithm: RELEASE_SIGNATURE_DIGEST,
    digest,
    keyId: computeKeyId(publicKeyPem),
    signature: signature.toString("base64")
  };
}

export function verifyReleaseSignature(signatureRecord, publicKeyPem, expectedDigestHex) {
  const problems = [];
  const record = signatureRecord && typeof signatureRecord === "object" ? signatureRecord : {};
  if (record.version !== RELEASE_SIGNATURE_VERSION) {
    problems.push(`unsupported signature version: ${String(record.version)}`);
  }
  if (record.algorithm !== RELEASE_SIGNATURE_ALGORITHM) {
    problems.push(`unsupported signature algorithm: ${String(record.algorithm)}`);
  }
  if (record.digestAlgorithm !== RELEASE_SIGNATURE_DIGEST) {
    problems.push(`unsupported digest algorithm: ${String(record.digestAlgorithm)}`);
  }
  let digest = "";
  try {
    digest = assertDigestHex(record.digest);
  } catch (error) {
    problems.push(error.message);
  }
  const expected = expectedDigestHex ? String(expectedDigestHex).trim().toLowerCase() : "";
  if (expected && digest && expected !== digest) {
    problems.push("signed digest does not match the artifact digest");
  }
  let publicKey = null;
  try {
    publicKey = loadPublicKey(publicKeyPem);
  } catch (error) {
    problems.push(error.message);
  }
  if (publicKey && record.keyId && computeKeyId(publicKey.export({ type: "spki", format: "pem" }).toString()) !== record.keyId) {
    problems.push("signature keyId does not match the trusted public key");
  }
  if (problems.length) {
    return { ok: false, problems };
  }
  let signatureBytes;
  try {
    signatureBytes = Buffer.from(String(record.signature || ""), "base64");
  } catch {
    return { ok: false, problems: ["signature is not valid base64"] };
  }
  if (!signatureBytes.length) {
    return { ok: false, problems: ["signature is empty"] };
  }
  const verified = verify(null, Buffer.from(digest, "utf8"), publicKey, signatureBytes);
  return verified
    ? { ok: true, problems: [], keyId: record.keyId, digest }
    : { ok: false, problems: ["signature does not verify against the trusted public key"] };
}

export async function signReleaseArtifact(artifactPath, privateKeyPem, options = {}) {
  const data = await readFile(artifactPath);
  const record = signReleaseDigest(sha256Hex(data), privateKeyPem);
  const payload = {
    ...record,
    artifact: options.artifactName || basenameOf(artifactPath),
    signedAt: options.signedAt || new Date().toISOString()
  };
  const signaturePath = options.signaturePath || `${artifactPath}.sig`;
  await writeFile(signaturePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  return { signaturePath, record: payload };
}

export async function verifyReleaseArtifact(artifactPath, signaturePath, publicKeyPem) {
  const [data, raw] = await Promise.all([
    readFile(artifactPath),
    readFile(signaturePath, "utf8")
  ]);
  let record;
  try {
    record = JSON.parse(raw);
  } catch (error) {
    return { ok: false, problems: [`signature file is not valid JSON: ${error.message}`] };
  }
  return verifyReleaseSignature(record, publicKeyPem, sha256Hex(data));
}

function loadPrivateKey(privateKeyPem) {
  const pem = String(privateKeyPem || "").trim();
  if (!pem) {
    throw new Error("release signing private key is empty");
  }
  const key = createPrivateKey(pem);
  if (key.asymmetricKeyType !== "ed25519") {
    throw new Error(`release signing key must be ed25519, got ${key.asymmetricKeyType}`);
  }
  return key;
}

function loadPublicKey(publicKeyPem) {
  const pem = String(publicKeyPem || "").trim();
  if (!pem) {
    throw new Error("release signing public key is empty");
  }
  const key = createPublicKey(pem);
  if (key.asymmetricKeyType !== "ed25519") {
    throw new Error(`release public key must be ed25519, got ${key.asymmetricKeyType}`);
  }
  return key;
}

function assertDigestHex(value) {
  const digest = String(value || "").trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(digest)) {
    throw new Error("release digest must be a 64-character sha256 hex string");
  }
  return digest;
}

function normalizePem(pem) {
  return String(pem || "").replace(/\r\n/g, "\n").trim();
}

function basenameOf(path) {
  const parts = String(path).split(/[\\/]/);
  return parts[parts.length - 1] || String(path);
}
