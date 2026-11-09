import { parentPort, workerData } from "node:worker_threads";
import { loadOwnerLockBinding } from "../../../src/service/ownerLockBinding.js";
import { createOwnerAdmissionCore } from "../../../src/service/ownerAdmissionCore.js";

try {
  const binding = loadOwnerLockBinding({
    artifactPath: workerData.artifactPath,
    manifestPath: workerData.manifestPath
  });
  const admission = createOwnerAdmissionCore({ binding });
  admission.acquireOwnerLease({ statePath: workerData.statePath });
  parentPort.postMessage({ code: "unexpected_success" });
} catch (error) {
  parentPort.postMessage({
    code: typeof error?.code === "string"
      ? error.code
      : "unexpected_failure",
    message: error?.message ?? String(error)
  });
}
