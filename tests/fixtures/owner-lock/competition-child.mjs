import {
  access,
  link,
  readFile,
  unlink,
  writeFile
} from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { loadOwnerLockBinding } from "../../../src/service/ownerLockBinding.js";

function argument(name) {
  const index = process.argv.indexOf(name);
  if (index < 0 || index + 1 >= process.argv.length) {
    throw new Error(`missing ${name}`);
  }
  return process.argv[index + 1];
}

async function waitForPath(filePath, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      await access(filePath);
      return;
    } catch (error) {
      if (error?.code !== "ENOENT") {
        throw error;
      }
    }
    if (Date.now() >= deadline) {
      throw new Error(`timed out waiting for ${filePath}`);
    }
    await delay(20);
  }
}

const config = JSON.parse(await readFile(argument("--config"), "utf8"));
await waitForPath(config.barrierPath, config.timeoutMs ?? 5_000);

const binding = loadOwnerLockBinding({
  artifactPath: config.artifactPath,
  manifestPath: config.manifestPath
});
let report;
let winner = false;
try {
  const evidence = binding.acquireOwnerLock({ statePath: config.statePath });
  const verification = binding.verifyOwnerLock({ evidence });
  report = {
    contender: config.contender,
    outcome: "ok",
    evidence,
    verification
  };
  winner = true;
} catch (error) {
  report = {
    contender: config.contender,
    outcome: error?.code === "owner_lock_busy" ? "busy" : "unexpected",
    code: typeof error?.code === "string" ? error.code : "unknown",
    reason: typeof error?.reason === "string" ? error.reason : null,
    message: error?.message ?? String(error)
  };
  if (report.outcome === "unexpected") {
    process.exitCode = 1;
  }
}

const temporaryReportPath = path.join(
  path.dirname(config.reportPath),
  `.${path.basename(config.reportPath)}.${process.pid}.tmp`
);
await writeFile(temporaryReportPath, `${JSON.stringify(report)}\n`, {
  flag: "wx"
});
try {
  await link(temporaryReportPath, config.reportPath);
} finally {
  try {
    await unlink(temporaryReportPath);
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
  }
}

if (winner) {
  await waitForPath(config.releasePath, config.timeoutMs ?? 5_000);
}
