#!/usr/bin/env python3
"""Linux-only probe for the filesystem immutable-inode primitive.

Design basis: chattr(1) documents that the immutable flag prevents writes,
deletion, renaming, hard-link creation, and most metadata changes; setting or
clearing it requires CAP_LINUX_IMMUTABLE. This probe tests the kernel primitive
only. It does not establish SFTP, product, N1 deployment, or crash acceptance.
"""

from __future__ import annotations

import argparse
import errno
import fcntl
import hashlib
import json
import os
import re
import shutil
import signal
import stat
import subprocess
import sys
import tempfile
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Callable


BASE_CHOICE = "/ssd"
FIXTURE_PREFIX = ".syncraft-p2-immutable-"
MARKER_NAME = ".syncraft-root.json"
STAGE_NAME = ".syncraft-root.stage-fixture"
CANARY_NAME = "canary.txt"
ALIAS_NAME = ".syncraft-p2-immutable-alias"
REPLACEMENT_NAME = ".syncraft-p2-immutable-replacement"
STAGE_ALIAS_NAME = ".syncraft-p2-immutable-stage-alias"
STAGE_REPLACEMENT_NAME = ".syncraft-p2-immutable-stage-replacement"
MARKER_MOVED_NAME = ".syncraft-p2-immutable-marker-moved"
STAGE_MOVED_NAME = ".syncraft-p2-immutable-stage-moved"
CONTROL_RENAME_SOURCE_NAME = ".syncraft-p2-control-rename-source"
CONTROL_RENAME_TARGET_NAME = ".syncraft-p2-control-rename-target"
CONTROL_UNLINK_NAME = ".syncraft-p2-control-unlink"
CONTROL_HARDLINK_NAME = ".syncraft-p2-control-hardlink"
CONTROL_HARDLINK_ALIAS_NAME = ".syncraft-p2-control-hardlink-alias"
STEP_TIMEOUT_SECONDS = 8

FS_IMMUTABLE_FL = 0x00000010
CAP_LINUX_IMMUTABLE = 9
FS_IOC_GETFLAGS = 0x80086601 if __import__("struct").calcsize("l") == 8 else 0x80046601
FS_IOC_SETFLAGS = 0x40086602 if __import__("struct").calcsize("l") == 8 else 0x40046602
PROTECTED_DENIAL_ERRNOS = frozenset((errno.EPERM, errno.EACCES))
PROTECTED_IDENTITY_KEYS = (
    "dev",
    "ino",
    "nlink",
    "size",
    "mode",
    "uid",
    "gid",
    "sha256",
)

WORKER_CLEAR_CODE = r"""
import array
import errno
import fcntl
import json
import os
import re
import struct
import sys

FS_IMMUTABLE_FL = 0x00000010
CAP_LINUX_IMMUTABLE = 9
FS_IOC_GETFLAGS = 0x80086601 if struct.calcsize("l") == 8 else 0x80046601
FS_IOC_SETFLAGS = 0x40086602 if struct.calcsize("l") == 8 else 0x40046602

def cap_present(value, bit):
    try:
        return bool(int(value, 16) & (1 << bit))
    except (TypeError, ValueError):
        return False

def read_flags(path):
    flags = array.array("l", [0])
    descriptor = os.open(path, os.O_RDONLY | os.O_CLOEXEC | os.O_NOFOLLOW)
    try:
        fcntl.ioctl(descriptor, FS_IOC_GETFLAGS, flags, True)
        value = int(flags[0])
        return {
            "ok": True,
            "value": value,
            "immutable": bool(value & FS_IMMUTABLE_FL),
        }
    finally:
        os.close(descriptor)

result = {
    "kind": "syncraft-immutable-worker-clear",
    "attempted": False,
    "cleared": None,
    "errno": None,
    "beforeFlags": None,
    "afterFlags": None,
    "flagsStable": False,
}
try:
    marker_path, stage_path = sys.argv[1:3]
    with open("/proc/self/status", "r", encoding="utf-8") as handle:
        status_text = handle.read()
    cap_lines = {
        key: value.strip()
        for key, value in re.findall(
            r"^(Cap(?:Inh|Prm|Eff|Bnd|Amb)):\s*(\S+)$",
            status_text,
            re.MULTILINE,
        )
    }
    result["capabilities"] = {
        key: {
            "value": value,
            "hasLinuxImmutable": cap_present(value, CAP_LINUX_IMMUTABLE),
        }
        for key, value in cap_lines.items()
    }

    result["beforeFlags"] = {
        "marker": read_flags(marker_path),
        "stage": read_flags(stage_path),
    }
    flags = array.array("l", [0])
    descriptor = os.open(marker_path, os.O_RDONLY | os.O_CLOEXEC | os.O_NOFOLLOW)
    try:
        fcntl.ioctl(descriptor, FS_IOC_GETFLAGS, flags, True)
        before = int(flags[0])
        flags[0] = before & ~FS_IMMUTABLE_FL
        try:
            fcntl.ioctl(descriptor, FS_IOC_SETFLAGS, flags)
            cleared = True
            error_number = None
        except OSError as error:
            cleared = False
            error_number = error.errno
    finally:
        os.close(descriptor)

    result["afterFlags"] = {
        "marker": read_flags(marker_path),
        "stage": read_flags(stage_path),
    }
    result.update(
        {
            "attempted": True,
            "cleared": cleared and not result["afterFlags"]["marker"]["immutable"],
            "errno": error_number,
            "errnoName": errno.errorcode.get(error_number),
            "flagsStable": result["beforeFlags"] == result["afterFlags"],
        }
    )
except Exception as error:
    result.update(
        {
            "attempted": False,
            "cleared": None,
            "error": {
                "type": type(error).__name__,
                "errno": getattr(error, "errno", None),
                "errnoName": errno.errorcode.get(getattr(error, "errno", None)),
            },
        }
    )

print(json.dumps(result, sort_keys=True, separators=(",", ":")))
"""


class ProbeError(RuntimeError):
    pass


class StepTimeout(ProbeError):
    pass


@contextmanager
def time_limit(seconds: int = STEP_TIMEOUT_SECONDS):
    if not hasattr(signal, "SIGALRM") or not hasattr(signal, "setitimer"):
        raise ProbeError("per-step timeout requires Linux SIGALRM")

    def timeout_handler(_signum: int, _frame: Any) -> None:
        raise StepTimeout(f"step exceeded {seconds}s")

    previous_handler = signal.signal(signal.SIGALRM, timeout_handler)
    previous_timer = signal.setitimer(signal.ITIMER_REAL, seconds)
    try:
        yield
    finally:
        signal.setitimer(signal.ITIMER_REAL, *previous_timer)
        signal.signal(signal.SIGALRM, previous_handler)


def unescape_mountinfo(value: str) -> str:
    return re.sub(
        r"\\([0-7]{3})",
        lambda match: chr(int(match.group(1), 8)),
        value,
    )


def is_path_within(path: str, parent: str) -> bool:
    try:
        return os.path.commonpath((path, parent)) == parent
    except ValueError:
        return False


def lstat_no_symlink(path: str, expected: str) -> os.stat_result:
    info = os.lstat(path)
    if stat.S_ISLNK(info.st_mode):
        raise ProbeError(f"{expected} is a symlink")
    return info


def validate_base(base: str) -> dict[str, Any]:
    if base != BASE_CHOICE:
        raise ProbeError(f"--base must be {BASE_CHOICE}")

    base_abs = os.path.abspath(base)
    if base_abs != BASE_CHOICE:
        raise ProbeError("base path is not canonical")
    real_base = os.path.realpath(base_abs)
    if real_base != BASE_CHOICE:
        raise ProbeError(f"base realpath changed: {real_base}")

    current = os.path.sep
    for component in Path(real_base).parts[1:]:
        current = os.path.join(current, component)
        lstat_no_symlink(current, f"base ancestor {current}")

    base_info = lstat_no_symlink(real_base, "base")
    if not stat.S_ISDIR(base_info.st_mode):
        raise ProbeError("base is not a directory")

    mount_records: list[dict[str, Any]] = []
    with open("/proc/self/mountinfo", "r", encoding="utf-8") as handle:
        for line in handle:
            fields = line.rstrip("\n").split()
            try:
                separator = fields.index("-")
            except ValueError:
                continue
            if separator < 6 or len(fields) <= separator + 1:
                continue
            mount_point = unescape_mountinfo(fields[4])
            if not is_path_within(real_base, mount_point):
                continue
            mount_records.append(
                {
                    "mountId": fields[0],
                    "majorMinor": fields[2],
                    "mountPoint": mount_point,
                    "fsType": fields[separator + 1],
                }
            )

    if not mount_records:
        raise ProbeError("no mountinfo record covers base")
    selected = max(mount_records, key=lambda item: len(item["mountPoint"]))
    if selected["fsType"] != "ext4":
        raise ProbeError(f"base mount is {selected['fsType']}, expected ext4")

    observed_major_minor = f"{os.major(base_info.st_dev)}:{os.minor(base_info.st_dev)}"
    if selected["majorMinor"] != observed_major_minor:
        raise ProbeError("mountinfo major:minor does not match base stat")

    return {
        "path": real_base,
        "realpath": real_base,
        "mount": selected,
        "statDev": observed_major_minor,
    }


def require_binaries() -> dict[str, str]:
    binaries: dict[str, str] = {}
    for name in ("chattr", "lsattr", "setpriv"):
        resolved = shutil.which(name)
        if not resolved:
            raise ProbeError(f"required binary not found: {name}")
        binaries[name] = resolved
    return binaries


def read_flags(path: str) -> dict[str, Any]:
    flags = __import__("array").array("l", [0])
    descriptor = -1
    try:
        descriptor = os.open(path, os.O_RDONLY | os.O_CLOEXEC | os.O_NOFOLLOW)
        fcntl.ioctl(descriptor, FS_IOC_GETFLAGS, flags, True)
        value = int(flags[0])
        return {
            "ok": True,
            "value": value,
            "immutable": bool(value & FS_IMMUTABLE_FL),
        }
    except OSError as error:
        return {
            "ok": False,
            "errno": error.errno,
            "errnoName": errno.errorcode.get(error.errno, "UNKNOWN"),
        }
    finally:
        if descriptor >= 0:
            os.close(descriptor)


def sha256_file(path: str) -> str:
    digest = hashlib.sha256()
    descriptor = os.open(path, os.O_RDONLY | os.O_CLOEXEC | os.O_NOFOLLOW)
    try:
        while True:
            chunk = os.read(descriptor, 1024 * 1024)
            if not chunk:
                break
            digest.update(chunk)
    finally:
        os.close(descriptor)
    return digest.hexdigest()


def evidence(path: str) -> dict[str, Any]:
    try:
        info = os.lstat(path)
    except FileNotFoundError:
        return {"exists": False}
    except OSError as error:
        return {
            "exists": None,
            "errno": error.errno,
            "errnoName": errno.errorcode.get(error.errno, "UNKNOWN"),
        }

    result: dict[str, Any] = {
        "exists": True,
        "dev": str(info.st_dev),
        "ino": str(info.st_ino),
        "mode": stat.S_IMODE(info.st_mode),
        "uid": info.st_uid,
        "gid": info.st_gid,
        "nlink": info.st_nlink,
        "isRegular": stat.S_ISREG(info.st_mode),
        "isDirectory": stat.S_ISDIR(info.st_mode),
        "isSymlink": stat.S_ISLNK(info.st_mode),
    }
    if stat.S_ISREG(info.st_mode):
        result["size"] = info.st_size
        try:
            result["sha256"] = sha256_file(path)
        except OSError as error:
            result["sha256"] = None
            result["sha256Errno"] = error.errno
            result["sha256ErrnoName"] = errno.errorcode.get(error.errno, "UNKNOWN")
        result["flags"] = read_flags(path)
    return result


def capture_files(paths: dict[str, str]) -> dict[str, Any]:
    return {name: evidence(path) for name, path in paths.items()}


def write_new_file(path: str, content: bytes) -> None:
    descriptor = os.open(
        path,
        os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_CLOEXEC | os.O_NOFOLLOW,
        0o600,
    )
    try:
        os.write(descriptor, content)
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def open_write_truncate(path: str, content: bytes) -> None:
    descriptor = os.open(
        path,
        os.O_WRONLY | os.O_TRUNC | os.O_CLOEXEC | os.O_NOFOLLOW,
    )
    try:
        os.write(descriptor, content)
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def read_file_no_follow(path: str) -> bytes:
    descriptor = os.open(path, os.O_RDONLY | os.O_CLOEXEC | os.O_NOFOLLOW)
    try:
        chunks: list[bytes] = []
        while True:
            chunk = os.read(descriptor, 1024 * 1024)
            if not chunk:
                break
            chunks.append(chunk)
        return b"".join(chunks)
    finally:
        os.close(descriptor)


def canary_round_trip(path: str) -> str:
    before = read_file_no_follow(path)
    replacement = b"syncraft immutable canary changed\n"
    open_write_truncate(path, replacement)
    after = read_file_no_follow(path)
    if before == after or after != replacement:
        raise ProbeError("canary read/write round trip did not change and verify content")
    return "read-write-read-verified"


def control_rename_overwrite(source: str, target: str) -> str:
    source_before = evidence(source)
    os.replace(source, target)
    source_after = evidence(source)
    target_after = evidence(target)
    if source_after.get("exists") is not False:
        raise ProbeError("control rename source still exists")
    for key in ("dev", "ino", "size", "sha256"):
        if target_after.get(key) != source_before.get(key):
            raise ProbeError(f"control rename target {key} does not match the source")
    return "rename-overwrite-verified"


def control_unlink(path: str) -> str:
    os.unlink(path)
    if evidence(path).get("exists") is not False:
        raise ProbeError("control unlink target still exists")
    return "unlink-verified"


def control_hardlink(source: str, alias: str) -> str:
    source_before = evidence(source)
    os.link(source, alias, follow_symlinks=False)
    source_after = evidence(source)
    alias_after = evidence(alias)
    if not alias_after.get("exists") or alias_after.get("isSymlink"):
        raise ProbeError("control hardlink alias is missing or is a symlink")
    for key in ("dev", "ino", "size", "sha256"):
        if source_after.get(key) != source_before.get(key):
            raise ProbeError(f"control hardlink source {key} changed")
        if alias_after.get(key) != source_before.get(key):
            raise ProbeError(f"control hardlink alias {key} does not match the source")
    if source_after.get("nlink") != 2 or alias_after.get("nlink") != 2:
        raise ProbeError("control hardlink link count is not 2")
    return "hardlink-verified"


def run_command(command: list[str]) -> dict[str, Any]:
    try:
        with time_limit():
            completed = subprocess.run(
                command,
                check=False,
                capture_output=True,
                text=True,
                timeout=STEP_TIMEOUT_SECONDS,
                env={**os.environ, "LC_ALL": "C", "PYTHONDONTWRITEBYTECODE": "1"},
            )
        return {
            "ok": completed.returncode == 0,
            "exitCode": completed.returncode,
            "stdout": completed.stdout.strip(),
            "stderr": completed.stderr.strip(),
        }
    except subprocess.TimeoutExpired:
        return {"ok": False, "timeout": True}
    except OSError as error:
        return {
            "ok": False,
            "errno": error.errno,
            "errnoName": errno.errorcode.get(error.errno, "UNKNOWN"),
        }


def lsattr_has_immutable(lsattr_binary: str, path: str) -> dict[str, Any]:
    result = run_command([lsattr_binary, "-d", path])
    if not result.get("ok"):
        return {**result, "immutable": None}
    first = (result.get("stdout") or "").split(None, 1)[0]
    return {**result, "immutable": "i" in first}


def protected_state_errors(
    reference: dict[str, Any],
    current: dict[str, Any],
    require_immutable: bool = True,
) -> list[str]:
    errors: list[str] = []
    for name in ("marker", "stage"):
        expected = reference.get(name, {})
        actual = current.get(name, {})
        if expected.get("exists") is not True:
            errors.append(f"{name} reference does not exist")
            continue
        if actual.get("exists") is not True:
            errors.append(f"{name} no longer exists")
            continue
        if actual.get("isRegular") is not True or actual.get("isSymlink") is not False:
            errors.append(f"{name} is not a regular non-symlink file")
        for key in PROTECTED_IDENTITY_KEYS:
            if actual.get(key) != expected.get(key):
                errors.append(
                    f"{name} {key} changed from {expected.get(key)!r} to {actual.get(key)!r}"
                )
        if require_immutable:
            flags = actual.get("flags") or {}
            if flags.get("ok") is not True or flags.get("immutable") is not True:
                errors.append(f"{name} immutable flag is not set and readable")
            elif flags != (expected.get("flags") or {}):
                errors.append(f"{name} full filesystem flags changed")

    marker = current.get("marker", {})
    stage = current.get("stage", {})
    if marker.get("exists") is True and stage.get("exists") is True:
        if marker.get("dev") != stage.get("dev") or marker.get("ino") != stage.get("ino"):
            errors.append("marker and stage no longer share one device and inode")
    return errors


def capability_value_has_linux_immutable(value: Any) -> bool | None:
    try:
        return bool(int(str(value), 16) & (1 << CAP_LINUX_IMMUTABLE))
    except (TypeError, ValueError):
        return None


def capability_evidence_errors(capabilities: Any) -> list[str]:
    if not isinstance(capabilities, dict):
        return ["worker capability evidence is missing"]
    errors: list[str] = []
    for key in ("CapEff", "CapPrm", "CapBnd"):
        value = capabilities.get(key)
        if not isinstance(value, dict):
            errors.append(f"worker capability {key} is missing")
            continue
        observed = capability_value_has_linux_immutable(value.get("value"))
        if observed is None:
            errors.append(f"worker capability {key} value is invalid")
        elif observed is not False:
            errors.append(f"worker capability {key} retains CAP_LINUX_IMMUTABLE")
        elif value.get("hasLinuxImmutable") is not False:
            errors.append(f"worker capability {key} flag is inconsistent")
    for key in ("CapInh", "CapAmb"):
        value = capabilities.get(key)
        if isinstance(value, dict):
            observed = capability_value_has_linux_immutable(value.get("value"))
            if observed is None:
                errors.append(f"worker capability {key} value is invalid")
            elif observed is not False:
                errors.append(f"worker capability {key} retains CAP_LINUX_IMMUTABLE")
            elif value.get("hasLinuxImmutable") is not False:
                errors.append(f"worker capability {key} flag is inconsistent")
    return errors


def record_attempt(
    steps: list[dict[str, Any]],
    name: str,
    expected: str,
    action: Callable[[], Any],
    paths: dict[str, str],
    protected_reference: dict[str, Any] | None = None,
    postcondition: Callable[[dict[str, Any]], list[str]] | None = None,
) -> bool:
    entry: dict[str, Any] = {"name": name, "expected": expected}
    entry["before"] = capture_files(paths)
    if expected == "denied":
        entry["allowedDenialErrnos"] = sorted(PROTECTED_DENIAL_ERRNOS)
    outcome = "success"
    error_details: dict[str, Any] | None = None
    try:
        with time_limit():
            result = action()
        entry["result"] = result if isinstance(result, (str, int, bool, type(None))) else None
    except OSError as error:
        outcome = "denied"
        error_details = {
            "errno": error.errno,
            "errnoName": errno.errorcode.get(error.errno, "UNKNOWN"),
        }
    except StepTimeout as error:
        outcome = "timeout"
        error_details = {"message": str(error)}
    except Exception as error:  # Keep the fixture report truthful for unexpected errors.
        outcome = "error"
        error_details = {
            "type": type(error).__name__,
            "message": str(error),
        }
    entry["outcome"] = outcome
    if error_details is not None:
        entry["error"] = error_details
    entry["after"] = capture_files(paths)
    passed = outcome == expected
    if expected == "denied":
        denied_errno = (error_details or {}).get("errno")
        errno_allowed = denied_errno in PROTECTED_DENIAL_ERRNOS
        entry["denialErrnoAllowed"] = errno_allowed
        passed = passed and errno_allowed
    if protected_reference is not None:
        invariant_errors = protected_state_errors(protected_reference, entry["after"])
        entry["protectedInvariantErrors"] = invariant_errors
        passed = passed and not invariant_errors
    if postcondition is not None:
        try:
            postcondition_errors = postcondition(entry)
        except Exception as error:
            postcondition_errors = [
                f"{type(error).__name__}: {error}"
            ]
        entry["postconditionErrors"] = postcondition_errors
        passed = passed and not postcondition_errors
    entry["passed"] = passed
    steps.append(entry)
    return passed


def create_fixture(base: str) -> dict[str, Any]:
    root = tempfile.mkdtemp(prefix=FIXTURE_PREFIX, dir=base)
    created: list[str] = []
    try:
        os.chmod(root, 0o700)
        root_real = os.path.realpath(root)
        if os.path.dirname(root_real) != base or not os.path.basename(root_real).startswith(FIXTURE_PREFIX):
            raise ProbeError("mkdtemp escaped the validated base")

        paths = {
            "root": root_real,
            "marker": os.path.join(root_real, MARKER_NAME),
            "stage": os.path.join(root_real, STAGE_NAME),
            "canary": os.path.join(root_real, CANARY_NAME),
            "alias": os.path.join(root_real, ALIAS_NAME),
            "replacement": os.path.join(root_real, REPLACEMENT_NAME),
            "stage_alias": os.path.join(root_real, STAGE_ALIAS_NAME),
            "stage_replacement": os.path.join(root_real, STAGE_REPLACEMENT_NAME),
            "marker_moved": os.path.join(root_real, MARKER_MOVED_NAME),
            "stage_moved": os.path.join(root_real, STAGE_MOVED_NAME),
            "control_rename_source": os.path.join(root_real, CONTROL_RENAME_SOURCE_NAME),
            "control_rename_target": os.path.join(root_real, CONTROL_RENAME_TARGET_NAME),
            "control_unlink": os.path.join(root_real, CONTROL_UNLINK_NAME),
            "control_hardlink": os.path.join(root_real, CONTROL_HARDLINK_NAME),
            "control_hardlink_alias": os.path.join(root_real, CONTROL_HARDLINK_ALIAS_NAME),
        }

        write_new_file(paths["marker"], b"syncraft immutable fixture marker\n")
        created.append(paths["marker"])
        os.link(paths["marker"], paths["stage"])
        created.append(paths["stage"])
        write_new_file(paths["canary"], b"syncraft immutable canary initial\n")
        created.append(paths["canary"])
        control_files = {
            "control_rename_source": b"syncraft control rename source\n",
            "control_rename_target": b"syncraft control rename target\n",
            "control_unlink": b"syncraft control unlink\n",
            "control_hardlink": b"syncraft control hardlink\n",
        }
        for name, content in control_files.items():
            write_new_file(paths[name], content)
            created.append(paths[name])

        initial = {
            "root": evidence(paths["root"]),
            "marker": evidence(paths["marker"]),
            "stage": evidence(paths["stage"]),
            "canary": evidence(paths["canary"]),
            "control_rename_source": evidence(paths["control_rename_source"]),
            "control_rename_target": evidence(paths["control_rename_target"]),
            "control_unlink": evidence(paths["control_unlink"]),
            "control_hardlink": evidence(paths["control_hardlink"]),
        }
        if initial["marker"]["dev"] != initial["stage"]["dev"]:
            raise ProbeError("marker and stage are not on the same device")
        if initial["marker"]["ino"] != initial["stage"]["ino"]:
            raise ProbeError("marker and stage are not hard links to one inode")
        if initial["marker"]["nlink"] != 2:
            raise ProbeError("marker/stage link count is not 2")
        return {
            "root": root_real,
            "paths": paths,
            "initial": initial,
            "created": created,
        }
    except Exception:
        for path in reversed(created):
            try:
                info = os.lstat(path)
                if stat.S_ISREG(info.st_mode) and not stat.S_ISLNK(info.st_mode):
                    os.unlink(path)
            except OSError:
                pass
        try:
            if not os.listdir(root):
                os.rmdir(root)
        except OSError:
            pass
        raise


def cleanup_known_path(path: str, root: str) -> None:
    if os.path.dirname(path) != root:
        raise ProbeError("cleanup path escaped fixture root")
    try:
        info = os.lstat(path)
    except FileNotFoundError:
        return
    if stat.S_ISLNK(info.st_mode) or not stat.S_ISREG(info.st_mode):
        raise ProbeError("cleanup path is not a regular non-link file")
    os.unlink(path)


def cleanup_fixture(
    fixture: dict[str, Any] | None,
    binaries: dict[str, str] | None,
    base: str,
    immutable_may_be_set: bool,
) -> dict[str, Any]:
    result: dict[str, Any] = {"attempted": False, "removed": False, "leftInPlace": False}
    if fixture is None:
        return result
    result["attempted"] = True
    root = fixture["root"]
    paths = fixture["paths"]
    initial = fixture["initial"]

    try:
        root_real = os.path.realpath(root)
        if root_real != root or os.path.dirname(root_real) != base:
            raise ProbeError("fixture realpath changed")
        if not os.path.basename(root_real).startswith(FIXTURE_PREFIX):
            raise ProbeError("fixture prefix changed")

        root_info = lstat_no_symlink(root, "fixture root")
        if not stat.S_ISDIR(root_info.st_mode):
            raise ProbeError("fixture root is not a directory")
        for key, label in (("dev", "root device"), ("ino", "root inode"), ("uid", "root uid"), ("gid", "root gid"), ("mode", "root mode")):
            if initial["root"].get(key) != evidence(root).get(key):
                raise ProbeError(f"{label} changed")

        current_protected = capture_files(
            {"marker": paths["marker"], "stage": paths["stage"]}
        )
        invariant_errors = protected_state_errors(
            initial,
            current_protected,
            require_immutable=False,
        )
        result["identityErrorsBeforeClear"] = invariant_errors
        if invariant_errors:
            raise ProbeError("marker/stage identity changed before cleanup")

        known = [
            paths["alias"],
            paths["replacement"],
            paths["stage_alias"],
            paths["stage_replacement"],
            paths["marker_moved"],
            paths["stage_moved"],
            paths["canary"],
            paths["control_rename_source"],
            paths["control_rename_target"],
            paths["control_unlink"],
            paths["control_hardlink"],
            paths["control_hardlink_alias"],
            paths["stage"],
            paths["marker"],
        ]
        known_names = {os.path.basename(path) for path in known}
        entries = sorted(os.listdir(root))
        unknown_entries = sorted(set(entries) - known_names)
        result["entriesBeforeCleanup"] = entries
        if unknown_entries:
            raise ProbeError(f"unknown fixture entries present: {unknown_entries}")

        marker_flags_before_clear = read_flags(paths["marker"])
        stage_flags_before_clear = read_flags(paths["stage"])
        result["flagsBeforeClear"] = {
            "marker": marker_flags_before_clear,
            "stage": stage_flags_before_clear,
        }
        flags_currently_set = bool(
            marker_flags_before_clear.get("immutable")
            or stage_flags_before_clear.get("immutable")
        )
        if flags_currently_set and not (
            marker_flags_before_clear.get("immutable")
            and stage_flags_before_clear.get("immutable")
        ):
            raise ProbeError("only one marker/stage path reported immutable before cleanup")
        if immutable_may_be_set or flags_currently_set:
            if binaries is None:
                raise ProbeError("immutable state cannot be cleared without binaries")
            clear_result = run_command([binaries["chattr"], "-i", paths["marker"]])
            result["clearImmutable"] = clear_result
            if not clear_result.get("ok"):
                raise ProbeError("chattr -i failed")
            marker_flags = read_flags(paths["marker"])
            stage_flags = read_flags(paths["stage"])
            result["flagsAfterClear"] = {
                "marker": marker_flags,
                "stage": stage_flags,
            }
            if marker_flags.get("immutable") or stage_flags.get("immutable"):
                raise ProbeError("immutable flag remains set")

        current_protected = capture_files(
            {"marker": paths["marker"], "stage": paths["stage"]}
        )
        invariant_errors = protected_state_errors(
            initial,
            current_protected,
            require_immutable=False,
        )
        result["identityErrorsAfterClear"] = invariant_errors
        if invariant_errors:
            raise ProbeError("marker/stage identity changed after clearing immutable")

        for path in known:
            cleanup_known_path(path, root)

        remaining = sorted(os.listdir(root))
        result["remainingEntries"] = remaining
        if remaining:
            raise ProbeError("unknown fixture entries remain")

        root_before_rmdir = evidence(root)
        for key in ("dev", "ino", "uid", "gid", "mode"):
            if root_before_rmdir.get(key) != initial["root"].get(key):
                raise ProbeError(f"root {key} changed before rmdir")
        with time_limit():
            os.rmdir(root)
        result["removed"] = True
    except Exception as error:
        result["leftInPlace"] = True
        result["path"] = root
        result["error"] = {
            "type": type(error).__name__,
            "message": str(error),
        }
    return result


def parse_main_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Linux immutable-inode primitive probe")
    parser.add_argument("--base", choices=(BASE_CHOICE,), required=True)
    args = parser.parse_args()
    return args


def main() -> int:
    args = parse_main_args()
    if not sys.platform.startswith("linux"):
        print(json.dumps({"kind": "syncraft-linux-marker-immutable", "status": "unsupported", "error": "Linux only"}))
        return 2

    report: dict[str, Any] = {
        "kind": "syncraft-linux-marker-immutable",
        "scope": "Linux filesystem immutable primitive only; not SFTP or product acceptance",
        "designBasis": "https://man7.org/linux/man-pages/man1/chattr.1.html",
        "status": "failed",
        "base": BASE_CHOICE,
        "steps": [],
        "failures": [],
        "limitations": [
            "No SFTP, rclone, proxy, container, or N1 deployment behavior is exercised.",
            "A passed result does not establish crash recovery or protection from privileged processes.",
        ],
    }
    fixture: dict[str, Any] | None = None
    binaries: dict[str, str] | None = None
    immutable_may_be_set = False

    try:
        report["baseEvidence"] = validate_base(BASE_CHOICE)
        binaries = require_binaries()
        report["binaries"] = binaries
        fixture = create_fixture(report["baseEvidence"]["realpath"])
        report["fixture"] = {
            "root": fixture["root"],
            "initial": fixture["initial"],
            "markerStageHardlink": True,
        }
        paths = fixture["paths"]

        set_result = run_command([binaries["chattr"], "+i", paths["marker"]])
        immutable_may_be_set = set_result.get("ok", False)
        marker_flags = read_flags(paths["marker"])
        stage_flags = read_flags(paths["stage"])
        marker_lsattr = lsattr_has_immutable(binaries["lsattr"], paths["marker"])
        stage_lsattr = lsattr_has_immutable(binaries["lsattr"], paths["stage"])
        immutable_verified = bool(
            set_result.get("ok")
            and marker_flags.get("immutable")
            and stage_flags.get("immutable")
            and marker_lsattr.get("immutable")
            and stage_lsattr.get("immutable")
        )
        report["immutableSetup"] = {
            "chattr": set_result,
            "markerFlags": marker_flags,
            "stageFlags": stage_flags,
            "markerLsattr": marker_lsattr,
            "stageLsattr": stage_lsattr,
            "verified": immutable_verified,
        }
        if not immutable_verified:
            report["failures"].append("immutable flag could not be set and verified")
            report["status"] = "unsupported"
        else:
            protected_paths = {
                "marker": paths["marker"],
                "stage": paths["stage"],
            }
            protected_reference = capture_files(protected_paths)
            protected_reference_errors = protected_state_errors(
                protected_reference,
                protected_reference,
            )
            report["protectedReference"] = protected_reference
            report["protectedReferenceErrors"] = protected_reference_errors
            if protected_reference_errors:
                raise ProbeError("immutable setup did not preserve marker/stage invariants")

            files = {
                **protected_paths,
                "canary": paths["canary"],
            }
            canary_ok = record_attempt(
                report["steps"],
                "canaryReadWriteRoundTrip",
                "success",
                lambda: canary_round_trip(paths["canary"]),
                files,
                protected_reference=protected_reference,
            )
            if not canary_ok:
                report["failures"].append("ordinary canary read/write round trip did not succeed")

            positive_controls = {
                "renameOverwrite": record_attempt(
                    report["steps"],
                    "controlRenameOverwrite",
                    "success",
                    lambda: control_rename_overwrite(
                        paths["control_rename_source"],
                        paths["control_rename_target"],
                    ),
                    {
                        "marker": paths["marker"],
                        "stage": paths["stage"],
                        "control_rename_source": paths["control_rename_source"],
                        "control_rename_target": paths["control_rename_target"],
                    },
                    protected_reference=protected_reference,
                ),
                "unlink": record_attempt(
                    report["steps"],
                    "controlUnlink",
                    "success",
                    lambda: control_unlink(paths["control_unlink"]),
                    {
                        "marker": paths["marker"],
                        "stage": paths["stage"],
                        "control_unlink": paths["control_unlink"],
                    },
                    protected_reference=protected_reference,
                ),
                "hardlink": record_attempt(
                    report["steps"],
                    "controlHardlink",
                    "success",
                    lambda: control_hardlink(
                        paths["control_hardlink"],
                        paths["control_hardlink_alias"],
                    ),
                    {
                        "marker": paths["marker"],
                        "stage": paths["stage"],
                        "control_hardlink": paths["control_hardlink"],
                        "control_hardlink_alias": paths["control_hardlink_alias"],
                    },
                    protected_reference=protected_reference,
                ),
            }
            report["positiveControls"] = positive_controls
            control_ok = all(positive_controls.values())
            if not control_ok:
                report["failures"].append(
                    "ordinary rename-overwrite, unlink, or hardlink positive control failed"
                )

            write_new_file(paths["replacement"], b"syncraft immutable replacement\n")
            write_new_file(
                paths["stage_replacement"],
                b"syncraft immutable stage replacement\n",
            )

            def unchanged_path(name: str) -> Callable[[dict[str, Any]], list[str]]:
                def check(entry: dict[str, Any]) -> list[str]:
                    if entry["after"].get(name) != entry["before"].get(name):
                        return [f"{name} changed during a denied operation"]
                    return []

                return check

            def absent_path(name: str) -> Callable[[dict[str, Any]], list[str]]:
                def check(entry: dict[str, Any]) -> list[str]:
                    if entry["after"].get(name, {}).get("exists") is not False:
                        return [f"{name} exists after a denied operation"]
                    return []

                return check

            attempt_paths = {
                **protected_paths,
                "replacement": paths["replacement"],
                "stage_replacement": paths["stage_replacement"],
                "alias": paths["alias"],
                "stage_alias": paths["stage_alias"],
                "marker_moved": paths["marker_moved"],
                "stage_moved": paths["stage_moved"],
            }
            protected_attempts: list[
                tuple[
                    str,
                    Callable[[], Any],
                    Callable[[dict[str, Any]], list[str]] | None,
                ]
            ] = [
                (
                    "markerTruncate",
                    lambda: os.truncate(paths["marker"], 0),
                    None,
                ),
                (
                    "markerOpenWriteTruncate",
                    lambda: open_write_truncate(paths["marker"], b"marker overwrite\n"),
                    None,
                ),
                (
                    "markerRenameToNew",
                    lambda: os.rename(paths["marker"], paths["marker_moved"]),
                    absent_path("marker_moved"),
                ),
                (
                    "markerRenameOverwrite",
                    lambda: os.replace(paths["replacement"], paths["marker"]),
                    unchanged_path("replacement"),
                ),
                (
                    "markerUnlink",
                    lambda: os.unlink(paths["marker"]),
                    None,
                ),
                (
                    "markerChmod",
                    lambda: os.chmod(paths["marker"], 0o640),
                    None,
                ),
                (
                    "markerHardlinkAlias",
                    lambda: os.link(
                        paths["marker"],
                        paths["alias"],
                        follow_symlinks=False,
                    ),
                    absent_path("alias"),
                ),
                (
                    "stageTruncate",
                    lambda: os.truncate(paths["stage"], 0),
                    None,
                ),
                (
                    "stageOpenWriteTruncate",
                    lambda: open_write_truncate(paths["stage"], b"stage overwrite\n"),
                    None,
                ),
                (
                    "stageRenameToNew",
                    lambda: os.rename(paths["stage"], paths["stage_moved"]),
                    absent_path("stage_moved"),
                ),
                (
                    "stageRenameOverwrite",
                    lambda: os.replace(paths["stage_replacement"], paths["stage"]),
                    unchanged_path("stage_replacement"),
                ),
                (
                    "stageUnlink",
                    lambda: os.unlink(paths["stage"]),
                    None,
                ),
                (
                    "stageChmod",
                    lambda: os.chmod(paths["stage"], 0o640),
                    None,
                ),
                (
                    "stageHardlinkAlias",
                    lambda: os.link(
                        paths["stage"],
                        paths["stage_alias"],
                        follow_symlinks=False,
                    ),
                    absent_path("stage_alias"),
                ),
            ]
            preserve_evidence = False
            for name, action, postcondition in protected_attempts:
                if preserve_evidence:
                    report["steps"].append(
                        {
                            "name": name,
                            "expected": "denied",
                            "outcome": "skipped",
                            "passed": False,
                            "reason": "earlier protection failure; preserving fixture evidence",
                        }
                    )
                    continue
                passed = record_attempt(
                    report["steps"],
                    name,
                    "denied",
                    action,
                    attempt_paths,
                    protected_reference=protected_reference,
                    postcondition=postcondition,
                )
                if not passed:
                    preserve_evidence = True
                    report["failures"].append(
                        f"{name} failed its denial, errno, invariant, or postcondition evidence"
                    )

            worker_passed = False
            worker_command_result: dict[str, Any] | None = None
            worker_payload: dict[str, Any] | None = None
            worker_before: dict[str, Any] | None = None
            worker_after: dict[str, Any] | None = None
            worker_evidence_errors: list[str] = []
            if canary_ok and control_ok and not preserve_evidence:
                worker_before = capture_files(protected_paths)
                worker_command = [
                    binaries["setpriv"],
                    "--bounding-set=-linux_immutable",
                    "--",
                    sys.executable,
                    "-c",
                    WORKER_CLEAR_CODE,
                    paths["marker"],
                    paths["stage"],
                ]
                worker_command_result = run_command(worker_command)
                if worker_command_result.get("ok"):
                    try:
                        worker_payload = json.loads(
                            worker_command_result.get("stdout") or ""
                        )
                    except json.JSONDecodeError:
                        worker_payload = None
                worker_after = capture_files(protected_paths)

                if worker_payload is None:
                    worker_evidence_errors.append("worker payload is missing or invalid")
                else:
                    if worker_payload.get("kind") != "syncraft-immutable-worker-clear":
                        worker_evidence_errors.append("worker payload kind is invalid")
                    if worker_payload.get("attempted") is not True:
                        worker_evidence_errors.append("worker did not attempt the clear ioctl")
                    if worker_payload.get("cleared") is not False:
                        worker_evidence_errors.append("worker unexpectedly cleared immutable")
                    if worker_payload.get("errno") not in PROTECTED_DENIAL_ERRNOS:
                        worker_evidence_errors.append(
                            "worker clear errno is not EPERM or EACCES"
                        )
                    if worker_payload.get("errnoName") not in {"EPERM", "EACCES"}:
                        worker_evidence_errors.append(
                            "worker clear errnoName is not EPERM or EACCES"
                        )
                    worker_evidence_errors.extend(
                        capability_evidence_errors(worker_payload.get("capabilities"))
                    )
                    before_flags = worker_payload.get("beforeFlags")
                    after_flags = worker_payload.get("afterFlags")
                    flags_valid = (
                        isinstance(before_flags, dict)
                        and isinstance(after_flags, dict)
                        and worker_payload.get("flagsStable") is True
                        and before_flags == after_flags
                        and all(
                            isinstance(before_flags.get(name), dict)
                            and before_flags[name].get("ok") is True
                            and before_flags[name].get("immutable") is True
                            and before_flags[name]
                            == (protected_reference.get(name, {}).get("flags") or {})
                            for name in ("marker", "stage")
                        )
                    )
                    if not flags_valid:
                        worker_evidence_errors.append(
                            "worker marker/stage flags were not stable and immutable"
                        )
                worker_evidence_errors.extend(
                    protected_state_errors(protected_reference, worker_after)
                )
                worker_passed = (
                    worker_command_result.get("ok") is True
                    and not worker_evidence_errors
                )
                if not worker_passed:
                    report["failures"].append(
                        "capability-dropped worker evidence was incomplete or invalid"
                    )
            else:
                worker_evidence_errors.append(
                    "worker skipped because an earlier positive or protected case failed"
                )
                report["failures"].append(worker_evidence_errors[-1])

            report["workerClearAttempt"] = {
                "command": "setpriv --bounding-set=-linux_immutable -- python3 -c <inline-worker> <marker> <stage>",
                "process": worker_command_result,
                "worker": worker_payload,
                "before": worker_before,
                "after": worker_after,
                "evidenceErrors": worker_evidence_errors,
                "passed": worker_passed,
            }

            final_invariant_errors = protected_state_errors(
                protected_reference,
                capture_files(protected_paths),
            )
            report["finalProtectedInvariantErrors"] = final_invariant_errors
            if final_invariant_errors:
                report["failures"].append(
                    "final marker/stage invariant check failed"
                )

            if (
                canary_ok
                and control_ok
                and not preserve_evidence
                and worker_passed
                and not final_invariant_errors
            ):
                report["status"] = "passed"
            else:
                report["status"] = "failed"
    except StepTimeout as error:
        report["failures"].append(str(error))
    except Exception as error:
        report["failures"].append(
            f"{type(error).__name__}: {error}"
        )

    cleanup = cleanup_fixture(
        fixture,
        binaries,
        report.get("baseEvidence", {}).get("realpath", BASE_CHOICE),
        immutable_may_be_set,
    )
    report["cleanup"] = cleanup
    if cleanup.get("leftInPlace"):
        report["status"] = "fixture-left"
        report["fixtureLeft"] = cleanup.get("path")
    elif report["status"] == "passed" and report["failures"]:
        report["status"] = "failed"

    print(json.dumps(report, sort_keys=True, separators=(",", ":")))
    if report["status"] == "passed":
        return 0
    if report["status"] == "unsupported":
        return 2
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
