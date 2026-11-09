import { setImmediate as delay } from "node:timers/promises";
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
const expected = process.argv.includes("--expect")
  ? argument("--expect")
  : undefined;
const holdIndex = process.argv.indexOf("--hold-ms");
const holdMs = holdIndex < 0 ? 0 : Number(argument("--hold-ms"));

const binding = loadOwnerLockBinding({ artifactPath, manifestPath });
const admission = createOwnerAdmissionCore({ binding });

try {
  const lease = admission.acquireOwnerLease({ statePath });
  admission.assertOwnerLease(lease);
  if (expected && expected !== "ok") {
    throw new Error(`expected ${expected}, acquired owner lease`);
  }
  process.stdout.write(`${JSON.stringify({ code: "ok" })}\n`);
  if (holdMs > 0) {
    await delay(holdMs);
  }
} catch (error) {
  const code = typeof error?.code === "string"
    ? error.code
    : "unexpected_failure";
  process.stdout.write(`${JSON.stringify({
    code,
    message: error?.message ?? String(error)
  })}\n`);
  if (!expected || expected !== code) {
    process.exitCode = 1;
  }
}
