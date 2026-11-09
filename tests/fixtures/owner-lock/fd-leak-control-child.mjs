import { spawn } from "node:child_process";
import {
  closeSync,
  fstatSync,
  openSync
} from "node:fs";
import { fileURLToPath } from "node:url";

function argument(name) {
  const index = process.argv.indexOf(name);
  if (index < 0 || index + 1 >= process.argv.length) {
    throw new Error(`missing ${name}`);
  }
  return process.argv[index + 1];
}

const lockPath = argument("--lock-path");
const parentDev = argument("--parent-dev");
const parentIno = argument("--parent-ino");
const execChild = fileURLToPath(new URL("./exec-child.mjs", import.meta.url));
const lockFd = openSync(lockPath, "r");
let report;

try {
  const metadata = fstatSync(lockFd, { bigint: true });
  const child = spawn(process.execPath, [
    execChild,
    "--parent-dev", parentDev,
    "--parent-ino", parentIno,
    "--lock-dev", metadata.dev.toString(),
    "--lock-ino", metadata.ino.toString()
  ], {
    cwd: fileURLToPath(new URL("../../..", import.meta.url)),
    stdio: ["ignore", "pipe", "pipe", lockFd]
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", chunk => {
    stdout += chunk;
  });
  child.stderr.on("data", chunk => {
    stderr += chunk;
  });
  const completion = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => {
      resolve({ code, signal, stdout, stderr });
    });
  });
  let probe;
  try {
    probe = JSON.parse(completion.stdout);
  } catch {
    probe = null;
  }
  report = {
    complete: completion.code === 0 && probe?.complete === true,
    childExitCode: completion.code,
    childSignal: completion.signal,
    childStderr: completion.stderr,
    probe
  };
  if (!report.complete) {
    process.exitCode = 1;
  }
} finally {
  closeSync(lockFd);
}

process.stdout.write(`${JSON.stringify(report)}\n`);
