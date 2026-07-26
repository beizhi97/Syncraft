import { readFile } from "node:fs/promises";
import { join } from "node:path";

const EXPECTED_IMAGE_DEFAULTS = [
  {
    file: "server/docker-compose.yml",
    service: "caddy",
    image: "caddy",
    variable: "CADDY_IMAGE_TAG",
    defaultTag: "2.10.2-alpine"
  },
  {
    file: "server/docker-compose.yml",
    service: "sing-box",
    image: "sfsc-sing-box",
    variable: "SING_BOX_IMAGE_TAG",
    defaultTag: "v1.13.14"
  },
  {
    file: "server/docker-compose.yml",
    service: "minio",
    image: "quay.io/minio/minio",
    variable: "MINIO_IMAGE_TAG",
    defaultTag: "RELEASE.2025-09-07T16-13-09Z"
  },
  {
    file: "server/docker-compose.yml",
    service: "minio-init",
    image: "quay.io/minio/mc",
    variable: "MINIO_MC_IMAGE_TAG",
    defaultTag: "RELEASE.2025-08-13T08-35-41Z"
  },
  {
    file: "server/docker-compose.n1.yml",
    service: "sing-box",
    image: "sfsc-sing-box",
    variable: "SING_BOX_IMAGE_TAG",
    defaultTag: "v1.13.14"
  },
  {
    file: "server/docker-compose.n1.yml",
    service: "minio",
    image: "quay.io/minio/minio",
    variable: "MINIO_IMAGE_TAG",
    defaultTag: "RELEASE.2025-09-07T16-13-09Z"
  },
  {
    file: "server/docker-compose.n1.yml",
    service: "minio-init",
    image: "quay.io/minio/mc",
    variable: "MINIO_MC_IMAGE_TAG",
    defaultTag: "RELEASE.2025-08-13T08-35-41Z"
  }
];

const EXPECTED_ENV_DEFAULTS = {
  S3_ENDPOINT: "http://minio:9000",
  S3_CLIENT_ENDPOINT: "http://minio:9000",
  VLESS_PORT: "45678"
};

const EXPECTED_COMPOSE_SNIPPETS = [
  {
    file: "server/docker-compose.yml",
    snippets: [
      "SFSC_REQUIRE_ADMIN_TOKEN: \"1\"",
      "SFSC_ADMIN_TOKEN: ${SFSC_ADMIN_TOKEN:?set SFSC_ADMIN_TOKEN before starting the server}",
      "SFSC_TRUST_PROXY: \"1\"",
      "SFSC_PUBLIC_HOST: ${SFSC_PUBLIC_HOST:?set SFSC_PUBLIC_HOST before starting the server}",
      "- \"80:80\"",
      "- \"443:443\"",
      "VLESS_PORT: ${VLESS_PORT:-45678}",
      "S3_ENDPOINT: ${S3_ENDPOINT:-http://minio:9000}",
      "S3_CLIENT_ENDPOINT: ${S3_CLIENT_ENDPOINT:-http://minio:9000}",
      "S3_SECRET_ACCESS_KEY: ${MINIO_ROOT_PASSWORD:?set MINIO_ROOT_PASSWORD before starting the server}",
      "MINIO_ROOT_PASSWORD: ${MINIO_ROOT_PASSWORD:?set MINIO_ROOT_PASSWORD before starting the server}"
    ]
  },
  {
    file: "server/docker-compose.n1.yml",
    snippets: [
      "SFSC_REQUIRE_ADMIN_TOKEN: \"1\"",
      "SFSC_ADMIN_TOKEN: ${SFSC_ADMIN_TOKEN:?set SFSC_ADMIN_TOKEN before starting the server}",
      "VLESS_PORT: ${VLESS_PORT:-45679}",
      "S3_ENDPOINT: http://minio:9000",
      "S3_CLIENT_ENDPOINT: http://n1-minio.sfsc:9000",
      "extra_hosts:",
      "- \"n1-minio.sfsc:127.0.0.1\"",
      "- /ssd/sfsc-test/minio:/data",
      "S3_SECRET_ACCESS_KEY: ${MINIO_ROOT_PASSWORD:?set MINIO_ROOT_PASSWORD before starting the server}",
      "MINIO_ROOT_PASSWORD: ${MINIO_ROOT_PASSWORD:?set MINIO_ROOT_PASSWORD before starting the server}"
    ]
  }
];

// CORE-4: compose files must never fall back to the weak placeholder password.
// A `:-change-this-minio-root-password` default silently gives production
// MinIO a guessable root credential when the operator forgets the env value.
const FORBIDDEN_COMPOSE_SNIPPETS = [
  "change-this-minio-root-password"
];

// D-5: registry-pulled images must be pinned by digest in compose (tags are
// mutable), and the locally built sing-box image must pin its base digest in
// its Dockerfile FROM. Keys are the *_IMAGE_DIGEST env vars; defaults must
// stay aligned between compose and server/.env.example.
const EXPECTED_IMAGE_DIGESTS = {
  CADDY_IMAGE_DIGEST: "sha256:4c6e91c6ed0e2fa03efd5b44747b625fec79bc9cd06ac5235a779726618e530d",
  MINIO_IMAGE_DIGEST: "sha256:14cea493d9a34af32f524e538b8346cf79f3321eff8e708c1e2960462bd8936e",
  MINIO_MC_IMAGE_DIGEST: "sha256:a7fe349ef4bd8521fb8497f55c6042871b2ae640607cf99d9bede5e9bdf11727"
};
const EXPECTED_COMPOSE_DIGEST_SNIPPETS = [
  {
    file: "server/docker-compose.yml",
    snippets: [
      "image: caddy:${CADDY_IMAGE_TAG:-2.10.2-alpine}@${CADDY_IMAGE_DIGEST:-" + EXPECTED_IMAGE_DIGESTS.CADDY_IMAGE_DIGEST + "}",
      "image: quay.io/minio/minio:${MINIO_IMAGE_TAG:-RELEASE.2025-09-07T16-13-09Z}@${MINIO_IMAGE_DIGEST:-" + EXPECTED_IMAGE_DIGESTS.MINIO_IMAGE_DIGEST + "}",
      "image: quay.io/minio/mc:${MINIO_MC_IMAGE_TAG:-RELEASE.2025-08-13T08-35-41Z}@${MINIO_MC_IMAGE_DIGEST:-" + EXPECTED_IMAGE_DIGESTS.MINIO_MC_IMAGE_DIGEST + "}"
    ]
  },
  {
    file: "server/docker-compose.n1.yml",
    snippets: [
      "image: quay.io/minio/minio:${MINIO_IMAGE_TAG:-RELEASE.2025-09-07T16-13-09Z}@${MINIO_IMAGE_DIGEST:-" + EXPECTED_IMAGE_DIGESTS.MINIO_IMAGE_DIGEST + "}",
      "image: quay.io/minio/mc:${MINIO_MC_IMAGE_TAG:-RELEASE.2025-08-13T08-35-41Z}@${MINIO_MC_IMAGE_DIGEST:-" + EXPECTED_IMAGE_DIGESTS.MINIO_MC_IMAGE_DIGEST + "}"
    ]
  }
];
const EXPECTED_DOCKERFILE_DIGESTS = [
  {
    file: "server/Dockerfile",
    snippets: [
      "FROM quay.io/minio/mc:RELEASE.2025-08-13T08-35-41Z@" + EXPECTED_IMAGE_DIGESTS.MINIO_MC_IMAGE_DIGEST + " AS minio-mc",
      "FROM node:22-alpine@sha256:16e22a550f3863206a3f701448c45f7912c6896a62de43add43bb9c86130c3e2"
    ]
  },
  {
    file: "server/sing-box.Dockerfile",
    snippets: [
      "ARG SING_BOX_IMAGE_DIGEST=sha256:c8b67944345dc84a226b648a71f854818606eae0813c4e6a452f192ef821b5b8",
      "FROM ghcr.io/sagernet/sing-box:${SING_BOX_IMAGE_TAG}@${SING_BOX_IMAGE_DIGEST}"
    ]
  },
  {
    file: "server/appliance.Dockerfile",
    snippets: [
      // rclone tag must stay aligned with client/resources/bin/win32/binaries.lock.json.
      "ARG RCLONE_IMAGE_TAG=1.74.3",
      "FROM ghcr.io/sagernet/sing-box:${SING_BOX_IMAGE_TAG}@${SING_BOX_IMAGE_DIGEST} AS singbox",
      "FROM rclone/rclone:${RCLONE_IMAGE_TAG}@${RCLONE_IMAGE_DIGEST} AS rclone",
      "FROM quay.io/minio/mc:${MINIO_MC_IMAGE_TAG}@${MINIO_MC_IMAGE_DIGEST} AS minio-mc",
      "FROM ghcr.io/linuxserver/baseimage-alpine:3.22@sha256:7451d313a8b95bd2b9ed798887e6b560ef5065e9ba6ef126a9e792d8b692df9c"
    ]
  }
];

// The appliance bundles its own rclone; its version must match the Windows
// client lock so both ends of a sync run the same engine (D-5 second half).
async function auditApplianceRcloneAlignment(root, issues) {
  const lockText = await readOptionalText(root, "client/resources/bin/win32/binaries.lock.json");
  const applianceText = await readOptionalText(root, "server/appliance.Dockerfile");
  if (lockText == null || applianceText == null) {
    return;
  }
  let lockVersion = "";
  try {
    lockVersion = String(JSON.parse(lockText)?.tools?.rclone?.version || "");
  } catch {
    issues.push("client/resources/bin/win32/binaries.lock.json must be valid JSON for the rclone alignment audit");
    return;
  }
  const applianceVersion = applianceText.match(/^ARG RCLONE_IMAGE_TAG=(\S+)$/m)?.[1] || "";
  if (lockVersion && applianceVersion && lockVersion !== applianceVersion) {
    issues.push(`server/appliance.Dockerfile RCLONE_IMAGE_TAG=${applianceVersion} must match binaries.lock.json rclone version ${lockVersion}`);
  }
}

export async function auditComposeConfig(root) {
  const issues = [];
  const envText = await readText(root, "server/.env.example", issues);
  const envDefaults = parseEnvDefaults(envText);

  for (const [name, expected] of Object.entries(EXPECTED_ENV_DEFAULTS)) {
    if (envDefaults[name] !== expected) {
      issues.push(`server/.env.example must set ${name}=${expected}`);
    }
  }

  const composeTexts = new Map();
  for (const item of EXPECTED_IMAGE_DEFAULTS) {
    const composeText = await readComposeText(root, item.file, issues, composeTexts);
    if (!composeText) {
      continue;
    }
    if (/:latest\b/.test(composeText)) {
      issues.push(`${item.file} must not use :latest image tags`);
    }
    const expectedImage = `${item.image}:\${${item.variable}:-${item.defaultTag}}`;
    if (!composeText.includes(`image: ${expectedImage}`)) {
      issues.push(`${item.file} service ${item.service} must use image ${expectedImage}`);
    }
    if (envDefaults[item.variable] !== item.defaultTag) {
      issues.push(`server/.env.example must set ${item.variable}=${item.defaultTag}`);
    }
  }

  for (const item of EXPECTED_COMPOSE_SNIPPETS) {
    const composeText = await readComposeText(root, item.file, issues, composeTexts);
    for (const snippet of item.snippets) {
      if (!composeText.includes(snippet)) {
        issues.push(`${item.file} must include ${snippet}`);
      }
    }
    for (const forbidden of FORBIDDEN_COMPOSE_SNIPPETS) {
      if (composeText.includes(forbidden)) {
        issues.push(`${item.file} must not fall back to the placeholder MinIO password ${forbidden}`);
      }
    }
  }

  for (const item of EXPECTED_COMPOSE_DIGEST_SNIPPETS) {
    const composeText = await readComposeText(root, item.file, issues, composeTexts);
    for (const snippet of item.snippets) {
      if (!composeText.includes(snippet)) {
        issues.push(`${item.file} must pin registry images by digest: ${snippet}`);
      }
    }
  }

  for (const [name, expected] of Object.entries(EXPECTED_IMAGE_DIGESTS)) {
    if (envDefaults[name] !== expected) {
      issues.push(`server/.env.example must set ${name}=${expected}`);
    }
  }

  for (const item of EXPECTED_DOCKERFILE_DIGESTS) {
    const dockerfileText = await readText(root, item.file, issues);
    for (const snippet of item.snippets) {
      if (!dockerfileText.includes(snippet)) {
        issues.push(`${item.file} must pin its base image by digest: ${snippet}`);
      }
    }
  }

  await auditApplianceRcloneAlignment(root, issues);

  const genericConfig = await readOptionalText(root, "server/sing-box/config.example.json");
  const genericRuntimeConfig = await readOptionalText(root, "server/sing-box/config.json");
  for (const [path, text] of [["server/sing-box/config.example.json", genericConfig], ["server/sing-box/config.json", genericRuntimeConfig]]) {
    if (text == null) {
      continue;
    }
    try {
      const config = JSON.parse(text);
      if (config?.inbounds?.[0]?.listen_port !== 45678) {
        issues.push(`${path} must listen on the generic compose VLESS port 45678`);
      }
    } catch {
      issues.push(`${path} must be valid JSON`);
    }
  }

  return issues;
}

async function readComposeText(root, rel, issues, cache) {
  if (!cache.has(rel)) {
    cache.set(rel, await readText(root, rel, issues));
  }
  return cache.get(rel);
}

async function readText(root, rel, issues) {
  try {
    return await readFile(join(root, ...rel.split("/")), "utf8");
  } catch {
    issues.push(`${rel} is missing for compose config audit`);
    return "";
  }
}

async function readOptionalText(root, rel) {
  try {
    return await readFile(join(root, ...rel.split("/")), "utf8");
  } catch {
    return null;
  }
}

function parseEnvDefaults(text) {
  const values = {};
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (match) {
      values[match[1]] = match[2].trim();
    }
  }
  return values;
}
