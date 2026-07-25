#!/usr/bin/env node
// Signs and verifies release artifacts with a detached Ed25519 signature.
//
//   node scripts/release-signature.mjs keygen --out-dir secrets/release-key
//   node scripts/release-signature.mjs sign dist/release-bundles/<name>.zip
//   node scripts/release-signature.mjs verify dist/release-bundles/<name>.zip
//
// Signing reads the private key from SFSC_RELEASE_SIGNING_KEY (a PEM path) or
// SFSC_RELEASE_SIGNING_KEY_PEM (the PEM itself, for CI secrets).
// Verification reads the trusted public key from SFSC_RELEASE_PUBLIC_KEY (path),
// SFSC_RELEASE_PUBLIC_KEY_PEM, or release-signing-key.pub in the repo root.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  generateReleaseKeyPair,
  signReleaseArtifact,
  verifyReleaseArtifact
} from "./lib/releaseSignature.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_PUBLIC_KEY_FILE = join(root, "release-signing-key.pub");

const [command, ...rest] = process.argv.slice(2);
const flags = parseFlags(rest);

try {
  if (command === "keygen") {
    await runKeygen(flags);
  } else if (command === "sign") {
    await runSign(flags);
  } else if (command === "verify") {
    await runVerify(flags);
  } else {
    usage();
    process.exit(command ? 1 : 0);
  }
} catch (error) {
  console.error(`release-signature: ${error.message}`);
  process.exit(1);
}

function usage() {
  console.error(`Usage:
  node scripts/release-signature.mjs keygen [--out-dir <dir>]
  node scripts/release-signature.mjs sign <artifact> [--signature <path>]
  node scripts/release-signature.mjs verify <artifact> [--signature <path>] [--public-key <path>]

Environment:
  SFSC_RELEASE_SIGNING_KEY       path to the Ed25519 private key PEM (signing)
  SFSC_RELEASE_SIGNING_KEY_PEM   inline private key PEM (signing, for CI secrets)
  SFSC_RELEASE_PUBLIC_KEY        path to the trusted public key PEM (verifying)
  SFSC_RELEASE_PUBLIC_KEY_PEM    inline trusted public key PEM (verifying)`);
}

async function runKeygen(options) {
  const outDir = resolve(options.values["out-dir"] || join(root, "secrets", "release-key"));
  const keyPair = generateReleaseKeyPair();
  await mkdir(outDir, { recursive: true, mode: 0o700 });
  const privatePath = join(outDir, "release-signing-key.pem");
  const publicPath = join(outDir, "release-signing-key.pub");
  // 0o600: the private key must not be readable by other local accounts.
  await writeFile(privatePath, keyPair.privateKeyPem, { encoding: "utf8", mode: 0o600 });
  await writeFile(publicPath, keyPair.publicKeyPem, { encoding: "utf8", mode: 0o644 });
  console.log(`private key: ${privatePath}`);
  console.log(`public key:  ${publicPath}`);
  console.log(`keyId:       ${keyPair.keyId}`);
  console.log("");
  console.log("Next steps:");
  console.log(`  1. Copy the public key to ${DEFAULT_PUBLIC_KEY_FILE} and commit it.`);
  console.log("  2. Keep the private key out of the repo; store it in the release secret store.");
  console.log("  3. Set SFSC_RELEASE_SIGNING_KEY on the release machine to the private key path.");
}

async function runSign(options) {
  const artifact = requireArtifact(options);
  const privateKeyPem = await readSigningKey();
  const signaturePath = options.values.signature ? resolve(options.values.signature) : `${artifact}.sig`;
  const { record } = await signReleaseArtifact(artifact, privateKeyPem, { signaturePath });
  console.log(`signed ${record.artifact}`);
  console.log(`  digest: ${record.digest}`);
  console.log(`  keyId:  ${record.keyId}`);
  console.log(`  sig:    ${signaturePath}`);
}

async function runVerify(options) {
  const artifact = requireArtifact(options);
  const signaturePath = options.values.signature ? resolve(options.values.signature) : `${artifact}.sig`;
  const publicKeyPem = await readPublicKey(options.values["public-key"]);
  const result = await verifyReleaseArtifact(artifact, signaturePath, publicKeyPem);
  if (!result.ok) {
    for (const problem of result.problems) {
      console.error(`  - ${problem}`);
    }
    throw new Error(`signature verification failed for ${artifact}`);
  }
  console.log(`signature OK for ${artifact}`);
  console.log(`  keyId:  ${result.keyId}`);
  console.log(`  digest: ${result.digest}`);
}

function requireArtifact(options) {
  const artifact = options.positional[0];
  if (!artifact) {
    usage();
    throw new Error("an artifact path is required");
  }
  return resolve(artifact);
}

async function readSigningKey() {
  const inline = String(process.env.SFSC_RELEASE_SIGNING_KEY_PEM || "").trim();
  if (inline) {
    return inline;
  }
  const path = String(process.env.SFSC_RELEASE_SIGNING_KEY || "").trim();
  if (!path) {
    throw new Error("set SFSC_RELEASE_SIGNING_KEY (PEM path) or SFSC_RELEASE_SIGNING_KEY_PEM to sign");
  }
  return readFile(resolve(path), "utf8");
}

async function readPublicKey(explicitPath) {
  const inline = String(process.env.SFSC_RELEASE_PUBLIC_KEY_PEM || "").trim();
  if (!explicitPath && inline) {
    return inline;
  }
  const path = resolve(explicitPath || process.env.SFSC_RELEASE_PUBLIC_KEY || DEFAULT_PUBLIC_KEY_FILE);
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new Error(`trusted public key not found: ${path} (run keygen, or set SFSC_RELEASE_PUBLIC_KEY)`);
    }
    throw error;
  }
}

function parseFlags(args) {
  const values = {};
  const positional = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg.startsWith("--")) {
      const [key, inlineValue] = arg.slice(2).split("=");
      if (inlineValue !== undefined) {
        values[key] = inlineValue;
      } else {
        values[key] = args[index + 1];
        index += 1;
      }
    } else {
      positional.push(arg);
    }
  }
  return { values, positional };
}
