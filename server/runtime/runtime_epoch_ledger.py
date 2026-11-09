#!/usr/bin/env python3
"""Root-only host ledger for one serial Syncraft runtime launch."""

from __future__ import annotations

import hashlib
import json
import os
import re
import stat
import tempfile
from datetime import datetime, timezone
from pathlib import Path


DIGEST = re.compile(r"^[a-f0-9]{64}$")
IMAGE_DIGEST = re.compile(r"^sha256:[a-f0-9]{64}$")
EPOCH = re.compile(r"^epoch-[0-9]{8}$")
CONTAINER_ID = re.compile(r"^[a-f0-9]{64}$")
OPERATION_ID = re.compile(r"^[a-f0-9]{32,64}$")
NONCE = re.compile(r"^[A-Za-z0-9_-]{32,256}$")
OPERATION_PHASES = [
    "intent", "created", "maintenance", "sealed", "started",
    "ready", "current", "complete",
]
CURRENT_STATUSES = {"ready", "exited"}


class LedgerError(RuntimeError):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def canonical_json_bytes(value: object) -> bytes:
    return (json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True) + "\n").encode("utf-8")


def pretty_json_bytes(value: object) -> bytes:
    return (json.dumps(value, sort_keys=True, indent=2, ensure_ascii=True) + "\n").encode("utf-8")


def _lstat(path: Path):
    try:
        return path.lstat()
    except FileNotFoundError:
        return None


def _require_regular(path: Path, maximum: int, label: str) -> bytes:
    info = _lstat(path)
    if info is None or not stat.S_ISREG(info.st_mode) or stat.S_ISLNK(info.st_mode):
        raise LedgerError("ledger_file_invalid", f"{label} must be one regular file")
    if info.st_size > maximum:
        raise LedgerError("ledger_file_too_large", f"{label} exceeds its byte limit")
    data = path.read_bytes()
    if len(data) > maximum:
        raise LedgerError("ledger_file_too_large", f"{label} exceeds its byte limit")
    return data


def _require_root_owner(info, label: str, allow_non_root: bool) -> None:
    if os.name == "nt":
        if not allow_non_root:
            raise LedgerError("ledger_root_required", f"{label} requires Linux root ownership")
        return
    if info.st_uid != 0 and not allow_non_root:
        raise LedgerError("ledger_root_required", f"{label} must be owned by root")
    if info.st_mode & 0o022:
        raise LedgerError("ledger_permissions_invalid", f"{label} must not be group or world writable")


def ensure_ledger_root(path: Path, *, allow_non_root: bool = False) -> Path:
    raw = Path(path)
    if not raw.is_absolute():
        raise LedgerError("ledger_root_invalid", "ledger root must be absolute")
    raw.mkdir(parents=True, exist_ok=True, mode=0o700)
    root = raw.resolve()
    if root == Path(root.anchor):
        raise LedgerError("ledger_root_invalid", "ledger root cannot be a filesystem root")
    info = root.lstat()
    if not stat.S_ISDIR(info.st_mode) or stat.S_ISLNK(info.st_mode):
        raise LedgerError("ledger_root_invalid", "ledger root must be one non-symlink directory")
    _require_root_owner(info, "ledger root", allow_non_root)
    if os.name != "nt" and stat.S_IMODE(info.st_mode) & 0o077:
        os.chmod(root, 0o700)
    return root


def ensure_private_directory(path: Path, *, allow_non_root: bool = False) -> None:
    path.mkdir(parents=True, exist_ok=True, mode=0o700)
    info = path.lstat()
    if not stat.S_ISDIR(info.st_mode) or stat.S_ISLNK(info.st_mode):
        raise LedgerError("ledger_directory_invalid", f"{path.name} must be one non-symlink directory")
    _require_root_owner(info, path.name, allow_non_root)
    if os.name != "nt":
        os.chmod(path, 0o700)


def _fsync_directory(path: Path) -> None:
    if os.name == "nt":
        return
    descriptor = os.open(path, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def atomic_write(path: Path, data: bytes, mode: int, *, overwrite: bool = True) -> None:
    parent = path.parent
    ensure_private_directory(parent)
    if not overwrite and path.exists():
        raise LedgerError("ledger_file_exists", f"{path.name} is already sealed")
    descriptor, temp_name = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=parent)
    temp_path = Path(temp_name)
    try:
        with os.fdopen(descriptor, "wb") as handle:
            handle.write(data)
            handle.flush()
            os.fsync(handle.fileno())
        if os.name != "nt":
            os.chmod(temp_path, mode)
        os.replace(temp_path, path)
        _fsync_directory(parent)
    finally:
        try:
            temp_path.unlink()
        except FileNotFoundError:
            pass


def _read_json(path: Path, maximum: int, label: str):
    data = _require_regular(path, maximum, label)
    try:
        return json.loads(data.decode("utf-8")), data
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise LedgerError("ledger_json_invalid", f"{label} is not valid JSON") from error


def _require_digest(value, label: str) -> str:
    if not isinstance(value, str) or not DIGEST.fullmatch(value):
        raise LedgerError("ledger_manifest_invalid", f"{label} must be lowercase SHA-256")
    return value


def _require_int(value, label: str) -> int:
    if not isinstance(value, int) or isinstance(value, bool) or value < 0:
        raise LedgerError("ledger_manifest_invalid", f"{label} must be a non-negative integer")
    return value


def _require_absolute(value, label: str) -> str:
    if not isinstance(value, str) or not value or not os.path.isabs(value):
        raise LedgerError("ledger_manifest_invalid", f"{label} must be an absolute path")
    return value


def _state_baseline(state_path: Path, *, allow_non_root: bool = False) -> dict:
    data = _require_regular(state_path, 16 * 1024 * 1024, "relation state")
    info = state_path.stat()
    _require_root_owner(info, "relation state", allow_non_root)
    try:
        state = json.loads(data.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise LedgerError("relation_state_invalid", "relation state is not valid JSON") from error
    revision = _require_int(state.get("revision"), "state revision")
    return {"revision": revision, "rawSha256": sha256_bytes(data), "_bytes": data}


def operation_record(*, operation_id: str, deployment_id: str, state_path: str,
                     image: str, image_digest: str, target_epoch: str,
                     bootstrap_nonce: str, bootstrap_nonce_sha256: str,
                     closure_proof_sha256: str, previous_container_id: str | None,
                     previous_cgroup_path: str | None,
                     previous_history_closure_sha256: str, created_from_epoch: str,
                     cid_file: str, created_at: str, succession: dict | None = None) -> dict:
    if not OPERATION_ID.fullmatch(operation_id):
        raise LedgerError("runtime_operation_invalid", "operation ID is invalid")
    if not IMAGE_DIGEST.fullmatch(image_digest):
        raise LedgerError("runtime_operation_invalid", "image digest is invalid")
    if not EPOCH.fullmatch(target_epoch) or not NONCE.fullmatch(bootstrap_nonce):
        raise LedgerError("runtime_operation_invalid", "target epoch or nonce is invalid")
    for value, label in (
        (deployment_id, "deploymentId"),
        (image, "image"),
        (created_from_epoch, "createdFromEpoch"),
    ):
        if not isinstance(value, str) or not value:
            raise LedgerError("runtime_operation_invalid", f"{label} must be non-empty")
    _require_absolute(state_path, "statePath")
    _require_absolute(cid_file, "cidFile")
    _require_digest(bootstrap_nonce_sha256, "bootstrapNonceSha256")
    _require_digest(closure_proof_sha256, "closureProofSha256")
    _require_digest(previous_history_closure_sha256, "previousHistoryClosureSha256")
    if previous_container_id is not None and not CONTAINER_ID.fullmatch(previous_container_id):
        raise LedgerError("runtime_operation_invalid", "previous container ID is invalid")
    if previous_cgroup_path is not None:
        _require_absolute(previous_cgroup_path, "previousCgroupPath")
    value = {
        "schemaVersion": "1",
        "operationId": operation_id,
        "deploymentId": deployment_id,
        "statePath": state_path,
        "image": image,
        "imageDigest": image_digest,
        "targetEpoch": target_epoch,
        "bootstrapNonce": bootstrap_nonce,
        "bootstrapNonceSha256": bootstrap_nonce_sha256,
        "closureProofSha256": closure_proof_sha256,
        "previousContainerId": previous_container_id,
        "previousCgroupPath": previous_cgroup_path,
        "previousHistoryClosureSha256": previous_history_closure_sha256,
        "createdFromEpoch": created_from_epoch,
        "cidFile": cid_file,
        "phase": "intent",
        "containerId": None,
        "hostCgroupPath": None,
        "epochManifestSha256": None,
        "epochSealedAt": created_at,
        "maintenanceResultSha256": None,
        "failureCode": None,
        "createdAt": created_at,
        "updatedAt": created_at,
    }
    if succession is not None:
        value["succession"] = validate_succession(succession)
    return value


OPERATION_KEYS = {
    "schemaVersion", "operationId", "deploymentId", "statePath", "image",
    "imageDigest", "targetEpoch", "bootstrapNonce", "bootstrapNonceSha256",
    "closureProofSha256", "previousContainerId", "previousCgroupPath",
    "previousHistoryClosureSha256", "createdFromEpoch", "cidFile", "phase", "containerId",
    "hostCgroupPath", "epochManifestSha256", "epochSealedAt",
    "maintenanceResultSha256", "failureCode", "createdAt", "updatedAt",
}


SUCCESSION_KEYS = {
    "schemaVersion", "mode", "previousOperationId", "previousTargetEpoch",
    "previousEpochManifestSha256", "previousFailureCode", "closedProofSha256",
    "sourceStateRevision", "sourceStateRawSha256", "sourceTransactionId",
    "sourceScopeProjectionSha256", "sourceHistoryClosureSha256",
    "transactionEpochManifestSha256",
}


def validate_succession(value: dict) -> dict:
    if not isinstance(value, dict) or set(value) != SUCCESSION_KEYS:
        raise LedgerError("runtime_succession_invalid", "runtime succession has an invalid schema")
    if value["schemaVersion"] != "1" or value["mode"] not in {"reuse-after", "recover-current"}:
        raise LedgerError("runtime_succession_invalid", "runtime succession schema or mode is invalid")
    if not OPERATION_ID.fullmatch(str(value["previousOperationId"])):
        raise LedgerError("runtime_succession_invalid", "previous operation ID is invalid")
    if not EPOCH.fullmatch(str(value["previousTargetEpoch"])):
        raise LedgerError("runtime_succession_invalid", "previous target epoch is invalid")
    for key in ("previousEpochManifestSha256", "closedProofSha256", "sourceStateRawSha256"):
        _require_digest(value[key], key)
    if not isinstance(value["previousFailureCode"], str) or not value["previousFailureCode"]:
        raise LedgerError("runtime_succession_invalid", "previous failure code is invalid")
    _require_int(value["sourceStateRevision"], "sourceStateRevision")
    for key in (
        "sourceTransactionId", "sourceScopeProjectionSha256",
        "sourceHistoryClosureSha256", "transactionEpochManifestSha256",
    ):
        if value[key] is not None:
            _require_digest(value[key], key)
    if value["mode"] == "reuse-after" and value["sourceTransactionId"] is not None:
        if value["sourceScopeProjectionSha256"] is None or value["sourceHistoryClosureSha256"] is None:
            raise LedgerError("runtime_succession_invalid", "reused recovery succession lacks closure identity")
        if value["transactionEpochManifestSha256"] is None:
            raise LedgerError("runtime_succession_invalid", "reused recovery succession lacks its journal epoch")
    if value["mode"] == "recover-current" and value["transactionEpochManifestSha256"] is not None:
        raise LedgerError("runtime_succession_invalid", "a fresh recovery cannot claim a prior journal epoch")
    return value


def validate_operation(value: dict) -> dict:
    allowed = OPERATION_KEYS | {"succession"}
    if not isinstance(value, dict):
        raise LedgerError("runtime_operation_invalid", "runtime operation has an invalid schema")
    actual = set(value)
    if actual != OPERATION_KEYS and actual != allowed:
        raise LedgerError("runtime_operation_invalid", "runtime operation has an invalid schema")
    if value["schemaVersion"] != "1" or value["phase"] not in [*OPERATION_PHASES, "failed"]:
        raise LedgerError("runtime_operation_invalid", "runtime operation schema or phase is invalid")
    if not OPERATION_ID.fullmatch(str(value["operationId"])):
        raise LedgerError("runtime_operation_invalid", "operationId is invalid")
    for key in ("deploymentId", "statePath", "image", "targetEpoch", "bootstrapNonce",
                "createdFromEpoch", "cidFile", "epochSealedAt", "createdAt", "updatedAt"):
        if not isinstance(value[key], str) or not value[key]:
            raise LedgerError("runtime_operation_invalid", f"{key} must be a non-empty string")
    if not os.path.isabs(value["statePath"]) or not os.path.isabs(value["cidFile"]):
        raise LedgerError("runtime_operation_invalid", "operation paths must be absolute")
    if not IMAGE_DIGEST.fullmatch(value["imageDigest"]):
        raise LedgerError("runtime_operation_invalid", "imageDigest is invalid")
    if not EPOCH.fullmatch(value["targetEpoch"]) or not NONCE.fullmatch(value["bootstrapNonce"]):
        raise LedgerError("runtime_operation_invalid", "operation epoch or nonce is invalid")
    for key in ("bootstrapNonceSha256", "closureProofSha256", "previousHistoryClosureSha256"):
        _require_digest(value[key], key)
    for key in ("containerId", "hostCgroupPath", "epochManifestSha256",
                "maintenanceResultSha256", "failureCode", "previousCgroupPath"):
        if value[key] is not None and (not isinstance(value[key], str) or not value[key]):
            raise LedgerError("runtime_operation_invalid", f"{key} must be null or non-empty")
    if value["previousContainerId"] is not None and not CONTAINER_ID.fullmatch(value["previousContainerId"]):
        raise LedgerError("runtime_operation_invalid", "previousContainerId is invalid")
    if value["containerId"] is not None and not CONTAINER_ID.fullmatch(value["containerId"]):
        raise LedgerError("runtime_operation_invalid", "containerId is invalid")
    if value["epochManifestSha256"] is not None:
        _require_digest(value["epochManifestSha256"], "epochManifestSha256")
    if value["maintenanceResultSha256"] is not None:
        _require_digest(value["maintenanceResultSha256"], "maintenanceResultSha256")
    if value["phase"] not in {"intent", "failed"} and value["containerId"] is None:
        raise LedgerError("runtime_operation_invalid", "a post-create phase requires an exact container ID")
    if value["phase"] in {"sealed", "started", "ready", "current", "complete"}:
        if value["epochManifestSha256"] is None:
            raise LedgerError("runtime_operation_invalid", "a sealed phase requires an epoch manifest")
    if "succession" in value:
        validate_succession(value["succession"])
    return value


def read_operation(path: Path) -> dict | None:
    if not path.exists():
        return None
    value, _ = _read_json(path, 256 * 1024, "runtime operation")
    return validate_operation(value)


def write_operation(path: Path, value: dict) -> dict:
    validate_operation(value)
    atomic_write(path, pretty_json_bytes(value), 0o600)
    return value


def advance_operation(path: Path, value: dict, phase: str, **updates) -> dict:
    current_index = 9 if value["phase"] == "failed" else OPERATION_PHASES.index(value["phase"])
    wanted_index = 9 if phase == "failed" else OPERATION_PHASES.index(phase)
    if phase != "failed" and wanted_index < current_index:
        raise LedgerError("runtime_operation_transition_invalid", "operation phase cannot move backwards")
    next_value = {**value, **updates, "phase": phase, "updatedAt": utc_now()}
    return write_operation(path, next_value)


def archive_completed_operation(ledger_root: Path, operation: dict) -> Path:
    if operation.get("phase") != "complete":
        raise LedgerError("runtime_operation_transition_invalid", "only a complete operation can be archived")
    target = ledger_root / "operations" / f"{operation['operationId']}.json"
    raw = pretty_json_bytes(operation)
    if target.exists():
        existing = _require_regular(target, 256 * 1024, "archived runtime operation")
        if existing != raw:
            raise LedgerError("runtime_operation_conflict", "archived operation differs from the completed operation")
    else:
        atomic_write(target, raw, 0o600, overwrite=False)
    return target


def archive_failed_operation(ledger_root: Path, operation: dict) -> Path:
    if operation.get("phase") != "failed":
        raise LedgerError("runtime_operation_transition_invalid", "only a failed operation can be archived as failed")
    target = ledger_root / "operations" / f"{operation['operationId']}.failed.json"
    raw = pretty_json_bytes(operation)
    if target.exists():
        existing = _require_regular(target, 256 * 1024, "archived failed runtime operation")
        if existing != raw:
            raise LedgerError("runtime_operation_conflict", "archived failed operation differs from the durable record")
    else:
        atomic_write(target, raw, 0o600, overwrite=False)
    return target


def read_current(path: Path) -> dict | None:
    if not path.exists():
        return None
    value, raw = _read_json(path, 256 * 1024, "current epoch")
    required = {
        "schemaVersion", "deploymentId", "operationId", "targetEpoch",
        "containerId", "imageDigest", "hostCgroupPath", "pidNamespaceId",
        "epochManifestSha256", "recoveryTransactionId", "status",
        "startedAt", "exitCode", "exitedAt",
    }
    if not isinstance(value, dict) or set(value) != required:
        raise LedgerError("current_epoch_invalid", "current epoch has an invalid schema")
    if value["schemaVersion"] != "1" or value["status"] not in CURRENT_STATUSES:
        raise LedgerError("current_epoch_invalid", "current epoch schema or status is invalid")
    if not OPERATION_ID.fullmatch(str(value["operationId"])):
        raise LedgerError("current_epoch_invalid", "current operationId is invalid")
    if not EPOCH.fullmatch(str(value["targetEpoch"])) or not CONTAINER_ID.fullmatch(str(value["containerId"])):
        raise LedgerError("current_epoch_invalid", "current epoch or container identity is invalid")
    if not IMAGE_DIGEST.fullmatch(str(value["imageDigest"])):
        raise LedgerError("current_epoch_invalid", "current imageDigest is invalid")
    _require_digest(value["epochManifestSha256"], "epochManifestSha256")
    if value["recoveryTransactionId"] is not None:
        _require_digest(value["recoveryTransactionId"], "recoveryTransactionId")
    if not isinstance(value["hostCgroupPath"], str) or not value["hostCgroupPath"].startswith("/"):
        raise LedgerError("current_epoch_invalid", "current hostCgroupPath is invalid")
    if not isinstance(value["pidNamespaceId"], str) or not re.fullmatch(r"pid:\[[0-9]+\]", value["pidNamespaceId"]):
        raise LedgerError("current_epoch_invalid", "current pidNamespaceId is invalid")
    if value["status"] == "ready" and (value["exitCode"] is not None or value["exitedAt"] is not None):
        raise LedgerError("current_epoch_invalid", "a ready current record cannot carry exit fields")
    if value["status"] == "exited" and (
        not isinstance(value["exitCode"], int) or isinstance(value["exitCode"], bool)
        or not isinstance(value["exitedAt"], str) or not value["exitedAt"]
    ):
        raise LedgerError("current_epoch_invalid", "an exited current record requires exact exit fields")
    value["_rawSha256"] = sha256_bytes(raw)
    return value


def ensure_initial_state(state_path: Path, *, allow_non_root: bool = False) -> None:
    raise LedgerError(
        "runtime_state_host_writer_removed",
        "relation state initialization must use the in-image maintenance entry",
    )


def _journal_schema(journal: dict, transaction_id: str) -> None:
    required = {
        "schemaVersion", "transactionId", "status", "deploymentId", "policyVersion",
        "oldContainerId", "targetEpoch", "createdFromEpoch", "createdAt", "beforeRevision",
        "beforeRawSha256", "afterRevision", "afterRawSha256", "afterBytesSha256",
        "closureProofSha256", "scopeProjectionSha256", "historyClosureSha256",
        "previousHistoryClosureSha256", "inheritedDescriptors", "descriptors"
    }
    allowed = set(required)
    if journal.get("status") == "committed":
        allowed |= {"committedAt", "epochManifestSha256"}
    if set(journal) != allowed:
        raise LedgerError("recovery_journal_invalid", "recovery journal has an invalid schema")
    if journal.get("schemaVersion") != "1" or journal.get("transactionId") != transaction_id:
        raise LedgerError("recovery_journal_invalid", "recovery journal identity is invalid")
    if journal.get("status") not in {"prepared", "after-verified", "committed"}:
        raise LedgerError("recovery_journal_invalid", "recovery journal status is invalid")
    if not EPOCH.fullmatch(str(journal.get("targetEpoch", ""))):
        raise LedgerError("recovery_journal_invalid", "recovery target epoch is invalid")
    before = _require_int(journal.get("beforeRevision"), "beforeRevision")
    after = _require_int(journal.get("afterRevision"), "afterRevision")
    if after != before + 1:
        raise LedgerError("recovery_journal_invalid", "recovery revision must advance exactly once")
    for key in (
        "beforeRawSha256", "afterRawSha256", "afterBytesSha256", "closureProofSha256",
        "scopeProjectionSha256", "historyClosureSha256", "previousHistoryClosureSha256"
    ):
        _require_digest(journal.get(key), key)
    if journal["afterRawSha256"] != journal["afterBytesSha256"]:
        raise LedgerError("recovery_journal_invalid", "after hashes must identify the same bytes")
    if not isinstance(journal.get("inheritedDescriptors"), list) or not isinstance(journal.get("descriptors"), list):
        raise LedgerError("recovery_journal_invalid", "recovery descriptors must be arrays")


def _read_journal(path: Path, transaction_id: str) -> dict:
    journal, _ = _read_json(path, 16 * 1024 * 1024, "recovery journal")
    _journal_schema(journal, transaction_id)
    return journal


def _verify_history_closure(path: Path, journal: dict, after_bytes: bytes) -> None:
    closure, raw = _read_json(path, 16 * 1024 * 1024, "history closure")
    if sha256_bytes(raw) != journal["historyClosureSha256"]:
        raise LedgerError("recovery_history_invalid", "history closure bytes do not match the journal")
    expected_keys = {
        "schemaVersion", "transactionId", "previousHistoryClosureSha256",
        "scopeProjectionSha256", "descriptors"
    }
    if set(closure) != expected_keys:
        raise LedgerError("recovery_history_invalid", "history closure schema is invalid")
    if (
        closure.get("schemaVersion") != "1"
        or closure.get("transactionId") != journal["transactionId"]
        or closure.get("previousHistoryClosureSha256") != journal["previousHistoryClosureSha256"]
        or closure.get("scopeProjectionSha256") != journal["scopeProjectionSha256"]
        or closure.get("descriptors") != journal["descriptors"]
    ):
        raise LedgerError("recovery_history_invalid", "history closure identity or scope changed")
    try:
        state = json.loads(after_bytes.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise LedgerError("recovery_after_invalid", "after bytes are not valid JSON") from error
    if state.get("revision") != journal["afterRevision"]:
        raise LedgerError("recovery_after_invalid", "after revision does not match the journal")


def _update_journal(path: Path, journal: dict, status: str, **extra) -> dict:
    if journal["status"] != "prepared" or status != "after-verified":
        raise LedgerError("recovery_journal_transition_invalid", "invalid recovery journal transition")
    updated = {**journal, "status": status, **extra}
    atomic_write(path, pretty_json_bytes(updated), 0o600)
    return updated


def _pending_journals(recovery_dir: Path, *, include_unsealed_committed: bool = False) -> list[Path]:
    if not recovery_dir.exists():
        return []
    result = []
    for entry in sorted(recovery_dir.iterdir()):
        match = JOURNAL_NAME.fullmatch(entry.name)
        if not match or not entry.is_file():
            continue
        journal = _read_journal(entry, match.group(1))
        if journal["status"] in {"prepared", "after-verified"}:
            result.append(entry)
        elif include_unsealed_committed and journal["status"] == "committed":
            epoch_file = recovery_dir.parent / "epochs" / journal["targetEpoch"] / "epoch.json"
            if not epoch_file.exists():
                result.append(entry)
    return result


def resume_recovery(recovery_dir: Path, state_path: Path, *, allow_non_root: bool = False) -> dict | None:
    raise LedgerError(
        "runtime_recovery_host_writer_removed",
        "relation recovery must use the in-image maintenance entry",
    )


def allocate_epoch(ledger_root: Path, current: dict | None) -> str:
    epochs_dir = ledger_root / "epochs"
    maximum = 0
    if epochs_dir.exists():
        for entry in epochs_dir.iterdir():
            if EPOCH.fullmatch(entry.name):
                maximum = max(maximum, int(entry.name.split("-")[1]))
    if current and current.get("targetEpoch") and EPOCH.fullmatch(str(current["targetEpoch"])):
        maximum = max(maximum, int(current["targetEpoch"].split("-")[1]))
    return f"epoch-{maximum + 1:08d}"


def initial_closure_proof(ledger_root: Path, deployment_id: str, *,
                          docker_scan_ids: list[str], label_selector: str) -> str:
    if docker_scan_ids:
        raise LedgerError("initial_closure_conflict", "initial closure requires an empty exact deployment scan")
    proofs = ledger_root / "proofs"
    ensure_private_directory(proofs)
    value = {
        "schemaVersion": "1",
        "kind": "initial-no-previous-runtime",
        "deploymentId": deployment_id,
        "dockerLabelSelector": label_selector,
        "dockerScanIds": [],
        "observedAt": utc_now(),
    }
    raw = pretty_json_bytes(value)
    digest = sha256_bytes(raw)
    path = proofs / f"{digest}.json"
    if not path.exists():
        atomic_write(path, raw, 0o600, overwrite=False)
    return digest


def read_closure_proof(ledger_root: Path, digest: str, *, deployment_id: str) -> dict:
    _require_digest(digest, "closureProofSha256")
    path = ledger_root / "proofs" / f"{digest}.json"
    value, raw = _read_json(path, 256 * 1024, "closure proof")
    if sha256_bytes(raw) != digest:
        raise LedgerError("closure_proof_invalid", "closure proof bytes do not match their digest")
    if not isinstance(value, dict) or value.get("schemaVersion") != "1" or value.get("deploymentId") != deployment_id:
        raise LedgerError("closure_proof_invalid", "closure proof does not identify this deployment")
    return value


def build_epoch_manifest(*, deployment_id: str, target_epoch: str, container_id: str, image_digest: str,
                         host_cgroup_path: str, bootstrap_nonce_sha256: str, baseline: dict,
                         closure_proof_sha256: str, recovery: dict | None, sealed_at: str,
                         succession: dict | None = None) -> dict:
    if not EPOCH.fullmatch(target_epoch) or not CONTAINER_ID.fullmatch(container_id):
        raise LedgerError("ledger_manifest_invalid", "epoch or container identity is invalid")
    if not IMAGE_DIGEST.fullmatch(image_digest):
        raise LedgerError("ledger_manifest_invalid", "image digest is invalid")
    if recovery is None:
        recovery_record = {
            "transactionId": None,
            "status": None,
            "closureProofSha256": _require_digest(closure_proof_sha256, "closureProofSha256"),
            "previousHistoryClosureSha256": "0" * 64,
            "afterRevision": baseline["revision"],
            "afterRawSha256": baseline["rawSha256"],
            "scopeProjectionSha256": None,
            "historyClosureSha256": None,
        }
    else:
        recovery_record = {
            "transactionId": recovery["transactionId"],
            "status": "committed",
            "closureProofSha256": recovery["closureProofSha256"],
            "previousHistoryClosureSha256": recovery["previousHistoryClosureSha256"],
            "afterRevision": recovery["afterRevision"],
            "afterRawSha256": recovery["afterRawSha256"],
            "scopeProjectionSha256": recovery["scopeProjectionSha256"],
            "historyClosureSha256": recovery["historyClosureSha256"],
        }
    value = {
        "schemaVersion": "1",
        "deploymentId": deployment_id,
        "targetEpoch": target_epoch,
        "containerId": container_id,
        "imageDigest": image_digest,
        "hostCgroupPath": host_cgroup_path,
        "bootstrapNonceSha256": _require_digest(bootstrap_nonce_sha256, "bootstrapNonceSha256"),
        "stateBaseline": {"revision": baseline["revision"], "rawSha256": baseline["rawSha256"]},
        "recovery": recovery_record,
        "sealedAt": sealed_at,
    }
    if succession is not None:
        value["succession"] = validate_succession(succession)
    return value


def seal_epoch(ledger_root: Path, target_epoch: str, manifest: dict) -> tuple[Path, str]:
    epoch_dir = ledger_root / "epochs" / target_epoch
    ensure_private_directory(epoch_dir)
    epoch_path = epoch_dir / "epoch.json"
    raw = pretty_json_bytes(manifest)
    if epoch_path.exists():
        existing = epoch_path.read_bytes()
        if existing != raw:
            raise LedgerError("ledger_epoch_conflict", "an existing sealed epoch differs from the requested manifest")
        return epoch_path, sha256_bytes(existing)
    atomic_write(epoch_path, raw, 0o444, overwrite=False)
    return epoch_path, sha256_bytes(raw)


def publish_history_closure(ledger_root: Path, target_epoch: str, source_path: Path,
                            expected_sha256: str) -> Path:
    _require_digest(expected_sha256, "historyClosureSha256")
    source = _require_regular(source_path, 16 * 1024 * 1024, "recovery history closure")
    if sha256_bytes(source) != expected_sha256:
        raise LedgerError("recovery_history_invalid", "recovery history closure hash does not match")
    epoch_dir = ledger_root / "epochs" / target_epoch
    ensure_private_directory(epoch_dir)
    target = epoch_dir / "history-closure.json"
    if target.exists():
        existing = _require_regular(target, 16 * 1024 * 1024, "epoch history closure")
        if existing != source:
            raise LedgerError("ledger_epoch_conflict", "sealed history closure differs from the recovery transaction")
    else:
        atomic_write(target, source, 0o444, overwrite=False)
    return target


def commit_recovery_journal(recovery_dir: Path, transaction_id: str,
                            epoch_manifest_sha256: str) -> dict:
    _require_digest(transaction_id, "transactionId")
    _require_digest(epoch_manifest_sha256, "epochManifestSha256")
    journal_path = recovery_dir / f"{transaction_id}.json"
    journal, raw = _read_json(journal_path, 16 * 1024 * 1024, "recovery journal")
    base_keys = {
        "schemaVersion", "transactionId", "status", "deploymentId",
        "policyVersion", "oldContainerId", "targetEpoch", "createdFromEpoch",
        "createdAt", "beforeRevision", "beforeRawSha256", "afterRevision",
        "afterRawSha256", "afterBytesSha256", "closureProofSha256",
        "scopeProjectionSha256", "historyClosureSha256",
        "previousHistoryClosureSha256", "inheritedDescriptors", "descriptors",
    }
    if not isinstance(journal, dict) or journal.get("schemaVersion") != "1" or journal.get("transactionId") != transaction_id:
        raise LedgerError("recovery_journal_invalid", "recovery journal identity is invalid")
    status = journal.get("status")
    if status == "committed":
        if set(journal) != base_keys | {"committedAt", "epochManifestSha256"}:
            raise LedgerError("recovery_journal_invalid", "committed recovery journal schema is invalid")
        if journal.get("epochManifestSha256") != epoch_manifest_sha256:
            raise LedgerError("recovery_epoch_conflict", "recovery journal is bound to another epoch")
        return journal
    if status != "after-verified" or set(journal) != base_keys:
        raise LedgerError("recovery_journal_transition_invalid", "only an exact after-verified journal can commit")
    after_path = recovery_dir / f"{transaction_id}.after.json"
    after = _require_regular(after_path, 16 * 1024 * 1024, "recovery after bytes")
    history_path = recovery_dir / f"{transaction_id}.history-closure.json"
    history = _require_regular(history_path, 16 * 1024 * 1024, "recovery history closure")
    if sha256_bytes(after) != journal.get("afterBytesSha256") or sha256_bytes(history) != journal.get("historyClosureSha256"):
        raise LedgerError("recovery_journal_invalid", "recovery bytes changed before journal commit")
    committed = {
        **journal,
        "status": "committed",
        "committedAt": utc_now(),
        "epochManifestSha256": epoch_manifest_sha256,
    }
    atomic_write(journal_path, pretty_json_bytes(committed), 0o600)
    return committed


def read_committed_recovery_journal(recovery_dir: Path, transaction_id: str,
                                    *, expected_epoch_manifest_sha256: str | None = None) -> dict:
    _require_digest(transaction_id, "transactionId")
    if expected_epoch_manifest_sha256 is not None:
        _require_digest(expected_epoch_manifest_sha256, "epochManifestSha256")
    journal_path = recovery_dir / f"{transaction_id}.json"
    journal, _ = _read_json(journal_path, 16 * 1024 * 1024, "recovery journal")
    _journal_schema(journal, transaction_id)
    if journal.get("status") != "committed":
        raise LedgerError("recovery_journal_incomplete", "recovery journal is not committed")
    if (expected_epoch_manifest_sha256 is not None
            and journal.get("epochManifestSha256") != expected_epoch_manifest_sha256):
        raise LedgerError("recovery_epoch_conflict", "recovery journal is bound to another epoch")
    return journal


def commit_recovery_epoch(recovery: dict, epoch_manifest_sha256: str) -> dict:
    journal = recovery["journal"]
    if journal["status"] == "committed":
        if journal.get("epochManifestSha256") != epoch_manifest_sha256:
            raise LedgerError("recovery_epoch_conflict", "committed recovery journal is bound to another epoch")
        return journal
    committed = {
        **journal,
        "status": "committed",
        "committedAt": utc_now(),
        "epochManifestSha256": epoch_manifest_sha256,
    }
    atomic_write(recovery["journalPath"], pretty_json_bytes(committed), 0o600)
    recovery["journal"] = committed
    return committed


def read_runtime_ready(path: Path) -> dict:
    value, _ = _read_json(path, 256 * 1024, "runtime ready")
    required = {
        "schemaVersion", "targetEpoch", "containerId", "imageDigest",
        "hostCgroupPath", "bootstrapNonceSha256", "pidNamespaceId",
        "epochManifestSha256", "sealedAt",
    }
    if not isinstance(value, dict) or set(value) != required or value.get("schemaVersion") != "1":
        raise LedgerError("runtime_ready_invalid", "runtime-ready has an invalid schema")
    return value


def seal_runtime_ready(epoch_dir: Path, *, bootstrap_nonce_sha256: str, container_id: str,
                       image_digest: str, host_cgroup_path: str, pid_namespace_id: str,
                       epoch_manifest_sha256: str, target_epoch: str) -> tuple[Path, dict]:
    path = epoch_dir / "runtime-ready.json"
    expected_identity = {
        "targetEpoch": target_epoch,
        "containerId": container_id,
        "imageDigest": image_digest,
        "hostCgroupPath": host_cgroup_path,
        "bootstrapNonceSha256": bootstrap_nonce_sha256,
        "pidNamespaceId": pid_namespace_id,
        "epochManifestSha256": epoch_manifest_sha256,
    }
    if path.exists():
        existing = read_runtime_ready(path)
        if any(existing.get(key) != value for key, value in expected_identity.items()):
            raise LedgerError("runtime_ready_conflict", "runtime-ready already identifies another exact runtime")
        return path, existing
    ready = {
        "schemaVersion": "1",
        "targetEpoch": target_epoch,
        "containerId": container_id,
        "imageDigest": image_digest,
        "hostCgroupPath": host_cgroup_path,
        "bootstrapNonceSha256": bootstrap_nonce_sha256,
        "pidNamespaceId": pid_namespace_id,
        "epochManifestSha256": epoch_manifest_sha256,
        "sealedAt": utc_now(),
    }
    atomic_write(path, pretty_json_bytes(ready), 0o444, overwrite=False)
    return path, ready


def record_current(ledger_root: Path, record: dict) -> None:
    atomic_write(ledger_root / "current.json", pretty_json_bytes(record), 0o600)


def write_bootstrap_nonce(ledger_root: Path, target_epoch: str, nonce: str) -> None:
    if not EPOCH.fullmatch(target_epoch) or not NONCE.fullmatch(nonce):
        raise LedgerError("bootstrap_nonce_invalid", "bootstrap nonce must be 32-256 URL-safe characters")
    path = ledger_root / "nonces" / f"{target_epoch}.json"
    value = {
        "schemaVersion": "1",
        "targetEpoch": target_epoch,
        "nonce": nonce,
    }
    raw = pretty_json_bytes(value)
    if path.exists():
        existing = _require_regular(path, 64 * 1024, "bootstrap nonce")
        if existing != raw:
            raise LedgerError("bootstrap_nonce_conflict", "bootstrap nonce already exists with another value")
        return
    atomic_write(path, raw, 0o600, overwrite=False)


if __name__ == "__main__":
    raise SystemExit("runtime_epoch_ledger.py is imported by sfsc-runtime-launcher")
