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
      "S3_CLIENT_ENDPOINT: ${S3_CLIENT_ENDPOINT:-http://minio:9000}"
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
      "- /ssd/sfsc-test/minio:/data"
    ]
  }
];

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
  }

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
