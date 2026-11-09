#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDir, "..");
const moduleDir = path.join(projectRoot, "native", "sfsc-sftp-service");
const tempRoot = path.join(projectRoot, ".tmp", "r75-sftp-service");

function parseArgs(args) {
  const values = { goos: undefined, goarch: undefined, output: undefined };
  for (let i = 0; i < args.length; i += 1) {
    const key = args[i];
    if (!["--goos", "--goarch", "--output"].includes(key)) {
      throw new Error(`unknown argument: ${key}`);
    }
    const value = args[i + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`${key} requires a value`);
    }
    values[key.slice(2)] = value;
    i += 1;
  }
  return values;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env,
    encoding: "utf8",
    stdio: "inherit"
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} exited with status ${result.status}`);
  }
}

try {
  const options = parseArgs(process.argv.slice(2));
  const targetOS = options.goos ?? process.env.GOOS ?? "linux";
  const targetArch = options.goarch ?? process.env.GOARCH ?? "arm64";
  const ext = targetOS === "windows" ? ".exe" : "";
  const output = path.resolve(
    projectRoot,
    options.output ?? path.join(".tmp", "r75-sftp-service", `sfsc-sftp-service-${targetOS}-${targetArch}${ext}`)
  );
  const relative = path.relative(tempRoot, output);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error("--output must stay under .tmp/r75-sftp-service");
  }

  const env = {
    ...process.env,
    GO111MODULE: "on",
    CGO_ENABLED: "0",
    GOOS: targetOS,
    GOARCH: targetArch
  };
  await mkdir(path.dirname(output), { recursive: true });
  run("go", ["build", "-trimpath", "-buildvcs=false", "-o", output, "."], {
    cwd: moduleDir,
    env
  });
  process.stdout.write(`Built ${targetOS}/${targetArch}: ${output}\n`);
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
}
