import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Usage: node scripts/build-root-guard.mjs [--with-arm64-tests]
const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDirectory, "..");
const outputDirectory = path.join(repoRoot, ".tmp", "build-root-guard");
const cacheDirectory = path.join(outputDirectory, "gocache");
const tempDirectory = path.join(outputDirectory, "gotmp");
const packagePath = "./native/sfsc-root-guard";
const helperVersion = "1";
const includeARM64Tests = process.argv.includes("--with-arm64-tests");

const unknownArguments = process.argv.slice(2).filter((argument) => argument !== "--with-arm64-tests");
if (unknownArguments.length > 0) {
  throw new Error(`unknown argument(s): ${unknownArguments.join(" ")}`);
}

const targets = [
  { goarch: "amd64", machine: 0x3e },
  { goarch: "arm64", machine: 0xb7 }
];

await mkdir(cacheDirectory, { recursive: true });
await mkdir(tempDirectory, { recursive: true });

const goVersion = (await runCommand("go", ["version"], {})).trim();
const builtTargets = [];

for (const target of targets) {
  const binaryName = `sfsc-root-guard-linux-${target.goarch}`;
  const binaryPath = path.join(outputDirectory, binaryName);
  const manifestName = `${binaryName}.manifest.json`;
  const manifestPath = path.join(outputDirectory, manifestName);
  const shaName = `${binaryName}.sha256`;
  const shaPath = path.join(outputDirectory, shaName);

  await Promise.all([
    rm(binaryPath, { force: true }),
    rm(manifestPath, { force: true }),
    rm(shaPath, { force: true })
  ]);
  await runCommand("go", [
    "build",
    "-trimpath",
    "-buildvcs=false",
    "-o",
    binaryPath,
    packagePath
  ], {
    cwd: repoRoot,
    env: {
      ...process.env,
      CGO_ENABLED: "0",
      GO111MODULE: "off",
      GOOS: "linux",
      GOARCH: target.goarch,
      GOCACHE: cacheDirectory,
      GOTMPDIR: tempDirectory
    }
  });

  const bytes = await readFile(binaryPath);
  assertElfTarget(bytes, target.goarch, target.machine);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const manifest = {
    version: 1,
    helperVersion,
    package: "native/sfsc-root-guard",
    goos: "linux",
    goarch: target.goarch,
    cgoEnabled: false,
    goVersion,
    file: binaryName,
    size: bytes.length,
    sha256
  };
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  await writeFile(shaPath, `${sha256}  ${binaryName}\n`, "utf8");
  builtTargets.push({
    goarch: target.goarch,
    binary: binaryPath,
    manifest: manifestPath,
    sha256File: shaPath,
    sha256,
    size: bytes.length
  });
}

let arm64Tests = null;
if (includeARM64Tests) {
  const binaryName = "sfsc-root-guard-linux-arm64.test";
  const binaryPath = path.join(outputDirectory, binaryName);
  const manifestName = `${binaryName}.manifest.json`;
  const manifestPath = path.join(outputDirectory, manifestName);
  const shaName = `${binaryName}.sha256`;
  const shaPath = path.join(outputDirectory, shaName);

  await Promise.all([
    rm(binaryPath, { force: true }),
    rm(manifestPath, { force: true }),
    rm(shaPath, { force: true })
  ]);
  await runCommand("go", [
    "test",
    "-c",
    "-trimpath",
    "-buildvcs=false",
    "-o",
    binaryPath,
    packagePath
  ], {
    cwd: repoRoot,
    env: {
      ...process.env,
      CGO_ENABLED: "0",
      GO111MODULE: "off",
      GOOS: "linux",
      GOARCH: "arm64",
      GOCACHE: cacheDirectory,
      GOTMPDIR: tempDirectory
    }
  });

  const bytes = await readFile(binaryPath);
  assertElfTarget(bytes, "arm64", 0xb7);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const manifest = {
    version: 1,
    helperVersion,
    package: "native/sfsc-root-guard",
    kind: "go-test",
    goos: "linux",
    goarch: "arm64",
    cgoEnabled: false,
    goVersion,
    file: binaryName,
    size: bytes.length,
    sha256
  };
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  await writeFile(shaPath, `${sha256}  ${binaryName}\n`, "utf8");
  arm64Tests = {
    binary: binaryPath,
    manifest: manifestPath,
    sha256File: shaPath,
    sha256,
    size: bytes.length
  };
}

console.log(JSON.stringify({
  outputDirectory,
  package: "native/sfsc-root-guard",
  helperVersion,
  targets: builtTargets,
  arm64Tests
}, null, 2));

function runCommand(command, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("error", reject);
    child.on("close", (code, signal) => {
      if (code === 0) {
        resolve(Buffer.concat(stdout).toString("utf8"));
        return;
      }
      const detail = Buffer.concat(stderr).toString("utf8").trim();
      reject(new Error(
        `${command} exited with code ${code ?? "null"}${signal ? ` (${signal})` : ""}` +
        (detail ? `: ${detail}` : "")
      ));
    });
  });
}

function assertElfTarget(bytes, goarch, expectedMachine) {
  if (bytes.length < 20 ||
      bytes[0] !== 0x7f ||
      bytes[1] !== 0x45 ||
      bytes[2] !== 0x4c ||
      bytes[3] !== 0x46 ||
      bytes[4] !== 2 ||
      bytes[5] !== 1) {
    throw new Error(`built file is not a 64-bit little-endian ELF for ${goarch}`);
  }
  const machine = bytes.readUInt16LE(18);
  if (machine !== expectedMachine) {
    throw new Error(`ELF machine for ${goarch} is 0x${machine.toString(16)}, expected 0x${expectedMachine.toString(16)}`);
  }
}
