import { parentPort, workerData } from "node:worker_threads";
import { loadOwnerLockBinding } from "../../../src/service/ownerLockBinding.js";

function errorReport(error, fallback) {
  return {
    ok: false,
    code: typeof error?.code === "string" ? error.code : fallback,
    reason: typeof error?.reason === "string" ? error.reason : null,
    message: error?.message ?? String(error)
  };
}

let report;
try {
  const binding = loadOwnerLockBinding({
    artifactPath: workerData.artifactPath,
    manifestPath: workerData.manifestPath
  });
  if (workerData.mode === "acquire") {
    const evidence = binding.acquireOwnerLock({
      statePath: workerData.statePath
    });
    report = { ok: true, operation: "acquire", evidence };
  } else if (workerData.mode === "verify") {
    const verification = binding.verifyOwnerLock({
      evidence: workerData.evidence
    });
    report = { ok: true, operation: "verify", verification };
  } else {
    report = {
      ok: false,
      code: "fixture_mode_invalid",
      reason: null,
      message: "worker mode must be acquire or verify"
    };
  }
} catch (error) {
  report = errorReport(error, "owner_lock_worker_failed");
}

parentPort.postMessage(report);
