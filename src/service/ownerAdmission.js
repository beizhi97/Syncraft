import path from "node:path";
import { fileURLToPath } from "node:url";
import { isMainThread } from "node:worker_threads";
import { createOwnerAdmissionCore } from "./ownerAdmissionCore.js";
import {
  loadOwnerLockBinding,
  loadOwnerStateSnapshotBinding
} from "./ownerLockBinding.js";

const root = fileURLToPath(new URL("../..", import.meta.url));
const arch = process.arch;

let admission;

function assertMainThread(operation) {
  if (!isMainThread) {
    throw Object.assign(
      new Error(`owner lease ${operation} must run on the Node main thread`),
      { code: "owner_lock_main_thread_required" }
    );
  }
}

function candidateAdmission() {
  if (!admission) {
    if (process.platform !== "linux" || !["arm64", "x64"].includes(arch)) {
      throw Object.assign(
        new Error("owner-lock candidate is supported only on Linux arm64 or x64"),
        { code: "owner_lock_artifact_invalid" }
      );
    }
    const runtimeAdmission = process.env.SFSC_RUNTIME_ADMISSION_REQUIRED === "1";
    const candidateRoot = runtimeAdmission
      ? path.join(root, "server", "runtime", "native", `${process.platform}-${arch}`)
      : path.join(root, ".tmp", "build-owner-lock-addon", process.platform, arch);
    const artifactPath = path.join(candidateRoot, "sfsc_owner_lock.node");
    const manifestPath = path.join(candidateRoot, "manifest.json");
    const binding = runtimeAdmission
      ? loadOwnerStateSnapshotBinding({ artifactPath, manifestPath })
      : loadOwnerLockBinding({ artifactPath, manifestPath });
    admission = createOwnerAdmissionCore({
      binding,
      snapshotEnabled: runtimeAdmission
    });
  }
  return admission;
}

export function acquireOwnerLease(input) {
  assertMainThread("acquisition");
  return candidateAdmission().acquireOwnerLease(input);
}

export function assertOwnerLease(lease) {
  assertMainThread("verification");
  return candidateAdmission().assertOwnerLease(lease);
}
