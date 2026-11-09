import { writeFile } from "node:fs/promises";
import { Worker } from "node:worker_threads";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { loadOwnerLockBinding } from "../../../src/service/ownerLockBinding.js";
import { createOwnerAdmissionCore } from "../../../src/service/ownerAdmissionCore.js";

function argument(name) {
  const index = process.argv.indexOf(name);
  if (index < 0 || index + 1 >= process.argv.length) {
    throw new Error(`missing ${name}`);
  }
  return process.argv[index + 1];
}

const artifactPath = argument("--artifact");
const manifestPath = argument("--manifest");
const statePath = argument("--state-path");
const reportPath = argument("--report");
const holdMs = Number(argument("--hold-ms"));

const binding = loadOwnerLockBinding({ artifactPath, manifestPath });
const admission = createOwnerAdmissionCore({ binding });
const lease = admission.acquireOwnerLease({ statePath });
admission.assertOwnerLease(lease);

const worker = new Worker(new URL("./worker-acquire.mjs", import.meta.url), {
  workerData: { artifactPath, manifestPath, statePath }
});
await new Promise((resolve, reject) => {
  worker.once("message", resolve);
  worker.once("error", reject);
});
await worker.terminate();

const gcAvailable = typeof global.gc === "function";
if (gcAvailable) {
  for (let index = 0; index < 3; index += 1) {
    global.gc();
    await delay(25);
  }
}

await writeFile(reportPath, `${JSON.stringify({
  gcAvailable,
  workerTerminated: true,
  fixture: fileURLToPath(import.meta.url)
})}\n`, { flag: "wx" });
await delay(holdMs);
