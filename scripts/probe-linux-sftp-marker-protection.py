#!/usr/bin/env python3
"""Linux-only probe for native SFTP put protection of marker and stage.

This slice verifies only the exact put path through a writable rclone serve
SFTP instance. It does not test remove, rename, hard links, a general SSH
capability matrix, a proxy, N1 deployment, or product integration.
"""

from __future__ import annotations

import argparse
import array
import errno
import fcntl
import hashlib
import json
import os
import re
import shutil
import socket
import stat
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from typing import Any


BASE_CHOICE = "/ssd"
RUNTIME_PREFIX = ".syncraft-p2-runtime-"
FIXTURE_PREFIX = ".syncraft-p2-sftp-immutable-"
MARKER_NAME = ".syncraft-root.json"
CONTROL_STAGE_NAME = ".syncraft-root.stage-control"
PROTECTED_STAGE_NAME = ".syncraft-root.stage-protected"
CANARY_NAME = "canary.txt"
EXCLUDES = (
    f"/{MARKER_NAME}",
    "/.syncraft-root.stage-*",
)
STEP_TIMEOUT_SECONDS = 15
SERVICE_START_TIMEOUT_SECONDS = 20
SERVICE_STOP_TIMEOUT_SECONDS = 5

FS_IMMUTABLE_FL = 0x00000010
CAP_LINUX_IMMUTABLE = 9
FS_IOC_GETFLAGS = 0x80086601 if __import__("struct").calcsize("l") == 8 else 0x80046601
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

AUTH_PATTERN = re.compile(
    r"unable to authenticate|Permission denied \(publickey|no supported methods remain",
    re.IGNORECASE,
)
NETWORK_PATTERN = re.compile(
    r"connection refused|connection reset|connection closed|connection timed out|"
    r"i/o timeout|network is unreachable|no route to host|kex_exchange_identification|"
    r"broken pipe|socket is not connected",
    re.IGNORECASE,
)
PERMISSION_PATTERN = re.compile(
    r"permission denied|operation not permitted|\bEPERM\b|\bEACCES\b",
    re.IGNORECASE,
)
WRITE_LOG_PATTERN = re.compile(
    r"\b(?:OpenFile|Open:|Put|upload|size\s*=|md5\s*=|Moved|Deleted)\b",
    re.IGNORECASE,
)


class ProbeError(RuntimeError):
    pass


class BlockedError(ProbeError):
    pass


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


def run_command(
    command: list[str],
    timeout_seconds: int = STEP_TIMEOUT_SECONDS,
    env: dict[str, str] | None = None,
) -> dict[str, Any]:
    try:
        completed = subprocess.run(
            command,
            check=False,
            capture_output=True,
            text=True,
            timeout=timeout_seconds,
            env=env,
        )
        return {
            "ok": completed.returncode == 0,
            "exitCode": completed.returncode,
            "stdout": completed.stdout.strip(),
            "stderr": completed.stderr.strip(),
            "timedOut": False,
        }
    except subprocess.TimeoutExpired:
        return {
            "ok": False,
            "exitCode": None,
            "stdout": "",
            "stderr": "",
            "timedOut": True,
        }
    except OSError as error:
        return {
            "ok": False,
            "exitCode": None,
            "stdout": "",
            "stderr": "",
            "timedOut": False,
            "errno": error.errno,
            "errnoName": errno.errorcode.get(error.errno, "UNKNOWN"),
        }


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


def lstat_no_symlink(path: str, label: str) -> os.stat_result:
    try:
        info = os.lstat(path)
    except OSError as error:
        raise BlockedError(f"{label} cannot be inspected: {error}") from error
    if stat.S_ISLNK(info.st_mode):
        raise BlockedError(f"{label} is a symlink")
    return info


def validate_base(base: str) -> dict[str, Any]:
    if base != BASE_CHOICE:
        raise BlockedError(f"--base must be {BASE_CHOICE}")
    base_abs = os.path.abspath(base)
    real_base = os.path.realpath(base_abs)
    if base_abs != BASE_CHOICE or real_base != BASE_CHOICE:
        raise BlockedError("--base must resolve exactly to /ssd")

    current = os.path.sep
    for component in Path(real_base).parts[1:]:
        current = os.path.join(current, component)
        lstat_no_symlink(current, f"base ancestor {current}")

    base_info = lstat_no_symlink(real_base, "base")
    if not stat.S_ISDIR(base_info.st_mode):
        raise BlockedError("base is not a directory")

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
            if is_path_within(real_base, mount_point):
                mount_records.append(
                    {
                        "mountId": fields[0],
                        "majorMinor": fields[2],
                        "mountPoint": mount_point,
                        "fsType": fields[separator + 1],
                    }
                )
    if not mount_records:
        raise BlockedError("no mountinfo record covers /ssd")
    selected = max(mount_records, key=lambda item: len(item["mountPoint"]))
    if selected["fsType"] != "ext4":
        raise BlockedError(f"/ssd filesystem is {selected['fsType']}, expected ext4")
    observed = f"{os.major(base_info.st_dev)}:{os.minor(base_info.st_dev)}"
    if selected["majorMinor"] != observed:
        raise BlockedError("mountinfo major:minor does not match /ssd")
    return {
        "path": real_base,
        "mount": selected,
        "statDev": observed,
    }


def validate_runtime_rclone(rclone_path: str, expected_sha256: str) -> dict[str, Any]:
    expected = expected_sha256.strip().lower()
    if not re.fullmatch(r"[a-f0-9]{64}", expected):
        raise BlockedError("--rclone-sha256 must be a lowercase or uppercase SHA256")
    requested = os.path.abspath(rclone_path)
    if not os.path.isabs(rclone_path):
        raise BlockedError("--rclone must be an absolute path")
    parent = os.path.dirname(requested)
    if os.path.dirname(parent) != BASE_CHOICE:
        raise BlockedError("rclone must be directly inside /ssd/.syncraft-p2-runtime-*")
    if not os.path.basename(parent).startswith(RUNTIME_PREFIX):
        raise BlockedError("rclone parent must start with .syncraft-p2-runtime-")
    if os.path.basename(requested) != "rclone":
        raise BlockedError("rclone binary basename must be exactly rclone")

    parent_info = lstat_no_symlink(parent, "runtime root")
    binary_info = lstat_no_symlink(requested, "rclone binary")
    if not stat.S_ISDIR(parent_info.st_mode):
        raise BlockedError("runtime root is not a directory")
    if not stat.S_ISREG(binary_info.st_mode):
        raise BlockedError("rclone binary is not a regular file")
    if stat.S_IMODE(parent_info.st_mode) != 0o700:
        raise BlockedError("runtime root mode must be 0700")
    if parent_info.st_uid != 0:
        raise BlockedError("runtime root must be owned by uid 0")
    if os.path.realpath(parent) != parent or os.path.realpath(requested) != requested:
        raise BlockedError("runtime root or rclone realpath changed")
    if not os.access(requested, os.X_OK):
        raise BlockedError("rclone binary is not executable")

    actual = sha256_file(requested)
    if actual != expected:
        raise BlockedError(
            f"rclone SHA256 mismatch: expected {expected}, observed {actual}"
        )

    version = run_command([requested, "version"], timeout_seconds=10)
    output = "\n".join(
        part for part in (version.get("stdout"), version.get("stderr")) if part
    )
    version_ok = (
        version.get("ok") is True
        and re.search(r"^rclone v1\.74\.3(?:\s|$)", output, re.MULTILINE) is not None
        and re.search(r"^-\s+os/type:\s*linux(?:\s|$)", output, re.MULTILINE)
        is not None
        and re.search(r"^-\s+os/arch:\s*arm64(?:\s|$)", output, re.MULTILINE)
        is not None
    )
    if not version_ok:
        raise BlockedError("rclone version output does not identify v1.74.3 linux/arm64")

    return {
        "path": requested,
        "runtimeRoot": parent,
        "runtimeRootMode": stat.S_IMODE(parent_info.st_mode),
        "runtimeRootUid": parent_info.st_uid,
        "runtimeRootGid": parent_info.st_gid,
        "binaryMode": stat.S_IMODE(binary_info.st_mode),
        "expectedSha256": expected,
        "actualSha256": actual,
        "versionOutput": output,
    }


def require_binaries() -> dict[str, str]:
    binaries: dict[str, str] = {}
    for name in ("chattr", "lsattr", "setpriv", "sftp", "ssh-keygen", "ss"):
        resolved = shutil.which(name)
        if not resolved:
            raise BlockedError(f"required binary not found: {name}")
        binaries[name] = os.path.realpath(resolved)
    return binaries


def read_flags(path: str) -> dict[str, Any]:
    flags = array.array("l", [0])
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


def file_evidence(path: str) -> dict[str, Any]:
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
        "nlink": info.st_nlink,
        "size": info.st_size,
        "mode": stat.S_IMODE(info.st_mode),
        "uid": info.st_uid,
        "gid": info.st_gid,
        "isRegular": stat.S_ISREG(info.st_mode),
        "isSymlink": stat.S_ISLNK(info.st_mode),
    }
    if stat.S_ISREG(info.st_mode):
        try:
            result["sha256"] = sha256_file(path)
        except OSError as error:
            result["sha256"] = None
            result["sha256Errno"] = error.errno
        result["flags"] = read_flags(path)
    return result


def protected_state_errors(
    reference: dict[str, Any],
    current: dict[str, Any],
    require_immutable: bool,
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
                errors.append(f"{name} immutable flag is not readable and set")
            elif flags != (expected.get("flags") or {}):
                errors.append(f"{name} filesystem flags changed")
    marker = current.get("marker", {})
    stage = current.get("stage", {})
    if marker.get("exists") is True and stage.get("exists") is True:
        if marker.get("dev") != stage.get("dev") or marker.get("ino") != stage.get("ino"):
            errors.append("marker and stage no longer share one device and inode")
    return errors


def capture_protected(paths: dict[str, str]) -> dict[str, Any]:
    return {
        "marker": file_evidence(paths["protected_marker"]),
        "stage": file_evidence(paths["protected_stage"]),
    }


def cap_present(value: Any, bit: int) -> bool | None:
    try:
        return bool(int(str(value), 16) & (1 << bit))
    except (TypeError, ValueError):
        return None


def process_capability_errors(pid: int) -> tuple[dict[str, Any], list[str]]:
    status_path = f"/proc/{pid}/status"
    try:
        with open(status_path, "r", encoding="utf-8") as handle:
            text = handle.read()
    except OSError as error:
        raise BlockedError(f"cannot read {status_path}: {error}") from error
    capabilities = {
        key: value
        for key, value in re.findall(
            r"^(Cap(?:Inh|Prm|Eff|Bnd|Amb)):\s*(\S+)$",
            text,
            re.MULTILINE,
        )
    }
    no_new_privs_match = re.search(r"^NoNewPrivs:\s*(\d+)$", text, re.MULTILINE)
    no_new_privs = (
        no_new_privs_match.group(1) == "1"
        if no_new_privs_match is not None
        else None
    )
    evidence: dict[str, Any] = {
        "capabilities": capabilities,
        "noNewPrivs": no_new_privs,
    }
    errors: list[str] = []
    for key in ("CapEff", "CapPrm", "CapBnd"):
        if key not in capabilities:
            errors.append(f"{key} is missing")
            continue
        observed = cap_present(capabilities[key], CAP_LINUX_IMMUTABLE)
        if observed is not False:
            errors.append(f"{key} retains CAP_LINUX_IMMUTABLE or is invalid")
    for key in ("CapInh", "CapAmb"):
        if key in capabilities:
            observed = cap_present(capabilities[key], CAP_LINUX_IMMUTABLE)
            if observed is not False:
                errors.append(f"{key} retains CAP_LINUX_IMMUTABLE or is invalid")
    if no_new_privs is not True:
        errors.append("NoNewPrivs is not 1")
    return evidence, errors


def write_new_file(path: str, content: bytes) -> None:
    descriptor = os.open(
        path,
        os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_CLOEXEC | os.O_NOFOLLOW,
        0o600,
    )
    try:
        offset = 0
        while offset < len(content):
            written = os.write(descriptor, content[offset:])
            if written <= 0:
                raise ProbeError(f"write made no progress: {path}")
            offset += written
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def fsync_directory(path: str) -> None:
    descriptor = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def allocate_loopback_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as listener:
        listener.bind(("127.0.0.1", 0))
        return int(listener.getsockname()[1])


def port_accepts_connection(port: int) -> bool:
    try:
        with socket.create_connection(("127.0.0.1", port), timeout=0.25):
            return True
    except OSError:
        return False


def wait_for_service(port: int, child: subprocess.Popen[Any]) -> float:
    started = time.monotonic()
    while time.monotonic() - started < SERVICE_START_TIMEOUT_SECONDS:
        if child.poll() is not None:
            raise ProbeError(f"rclone exited before listening: {child.returncode}")
        if port_accepts_connection(port):
            return round((time.monotonic() - started) * 1000, 3)
        time.sleep(0.05)
    raise ProbeError("rclone did not listen within the bounded startup timeout")


def wait_for_port_closed(port: int) -> float:
    started = time.monotonic()
    while time.monotonic() - started < SERVICE_STOP_TIMEOUT_SECONDS:
        if not port_accepts_connection(port):
            return round((time.monotonic() - started) * 1000, 3)
        time.sleep(0.05)
    raise ProbeError(f"listener remained open on 127.0.0.1:{port}")


def listener_evidence(ss_path: str, pid: int, port: int) -> tuple[dict[str, Any], list[str]]:
    result = run_command([ss_path, "-H", "-ltnp"], timeout_seconds=10)
    evidence: dict[str, Any] = {
        "command": [ss_path, "-H", "-ltnp"],
        "process": result,
        "expectedHost": "127.0.0.1",
        "expectedPort": port,
        "matchingLines": [],
        "conflictingLines": [],
    }
    errors: list[str] = []
    if result.get("ok") is not True:
        errors.append("ss listener inspection failed")
        return evidence, errors

    for line in (result.get("stdout") or "").splitlines():
        fields = line.split()
        if len(fields) < 4:
            continue
        local_address = fields[3]
        host, separator, port_text = local_address.rpartition(":")
        if not separator or not port_text.isdigit() or int(port_text) != port:
            continue
        normalized_host = host.strip("[]")
        pid_match = re.search(r"\bpid=(\d+)\b", line)
        if normalized_host == "127.0.0.1" and pid_match is not None and int(pid_match.group(1)) == pid:
            evidence["matchingLines"].append(line)
        else:
            evidence["conflictingLines"].append(line)

    if not evidence["matchingLines"]:
        errors.append("ss did not show the spawned rclone PID on 127.0.0.1:<port>")
    if evidence["conflictingLines"]:
        errors.append("ss showed a conflicting listener on the allocated port")
    return evidence, errors


def stop_process(child: subprocess.Popen[Any] | None) -> dict[str, Any]:
    if child is None:
        return {
            "attempted": False,
            "exited": True,
            "pid": None,
        }
    pid = child.pid
    attempted = child.poll() is None
    if attempted:
        child.terminate()
    try:
        child.wait(timeout=SERVICE_STOP_TIMEOUT_SECONDS)
    except subprocess.TimeoutExpired:
        child.kill()
        child.wait(timeout=SERVICE_STOP_TIMEOUT_SECONDS)
    return {
        "attempted": attempted,
        "exited": child.poll() is not None,
        "pid": pid,
        "returnCode": child.returncode,
    }


def make_known_hosts(host_public_key: str, port: int, output_path: str) -> None:
    fields = host_public_key.strip().split()
    if len(fields) < 2:
        raise ProbeError("host public key is malformed")
    write_new_file(
        output_path,
        f"[127.0.0.1]:{port} {' '.join(fields[:2])}\n".encode("utf-8"),
    )


def generate_key(ssh_keygen: str, path: str) -> None:
    result = run_command(
        [ssh_keygen, "-q", "-t", "ed25519", "-N", "", "-f", path],
        timeout_seconds=10,
    )
    if not result.get("ok"):
        raise ProbeError("ssh-keygen failed")
    os.chmod(path, 0o600)
    os.chmod(f"{path}.pub", 0o600)


def sftp_quote(path: str) -> str:
    return '"' + path.replace("\\", "\\\\").replace('"', '\\"') + '"'


def sftp_arguments(
    binaries: dict[str, str],
    paths: dict[str, str],
    port: int,
    batch_path: str,
    known_hosts_name: str,
) -> list[str]:
    return [
        binaries["sftp"],
        "-F",
        "/dev/null",
        "-b",
        batch_path,
        "-i",
        paths["client_key"],
        "-o",
        "BatchMode=yes",
        "-o",
        "IdentitiesOnly=yes",
        "-o",
        "StrictHostKeyChecking=yes",
        "-o",
        f"UserKnownHostsFile={paths[known_hosts_name]}",
        "-o",
        "ConnectTimeout=10",
        "-P",
        str(port),
        "probe@127.0.0.1",
    ]


def run_sftp(
    binaries: dict[str, str],
    paths: dict[str, str],
    port: int,
    known_hosts_name: str,
    batch_path: str,
    commands: list[str],
) -> dict[str, Any]:
    write_new_file(batch_path, ("\n".join(commands) + "\n").encode("utf-8"))
    return run_command(
        sftp_arguments(
            binaries,
            paths,
            port,
            batch_path,
            known_hosts_name,
        ),
        timeout_seconds=STEP_TIMEOUT_SECONDS,
        env={
            **os.environ,
            "LC_ALL": "C",
            "PYTHONDONTWRITEBYTECODE": "1",
        },
    )


def classify_sftp_error(stderr: str) -> str:
    if AUTH_PATTERN.search(stderr):
        return "authentication"
    if NETWORK_PATTERN.search(stderr):
        return "network"
    if re.search(r"permission denied|failure|failed to upload", stderr, re.IGNORECASE):
        return "remote-error"
    return "other"


def log_size(path: str) -> int:
    try:
        return os.path.getsize(path)
    except FileNotFoundError:
        return 0


def log_segment(path: str, offset: int) -> str:
    try:
        with open(path, "rb") as handle:
            handle.seek(offset)
            return handle.read(1024 * 1024).decode("utf-8", errors="replace")
    except FileNotFoundError:
        return ""


def target_log_evidence(segment: str, target_name: str) -> dict[str, Any]:
    lines = segment.splitlines()
    target_lines = [line for line in lines if target_name in line]
    permission_lines = [line for line in lines if PERMISSION_PATTERN.search(line)]
    write_for_target = [
        line
        for line in target_lines
        if WRITE_LOG_PATTERN.search(line) is not None
    ]
    permission_for_target = [
        line
        for line in target_lines
        if PERMISSION_PATTERN.search(line) is not None
    ]
    return {
        "targetName": target_name,
        "targetLogged": bool(target_lines),
        "writeForTarget": bool(write_for_target),
        "permissionLogged": bool(permission_lines),
        "permissionForTarget": bool(permission_for_target),
        "targetLines": target_lines[-10:],
        "permissionLines": permission_lines[-10:],
    }


def service_environment(paths: dict[str, str]) -> dict[str, str]:
    return {
        "PATH": os.environ.get("PATH", "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"),
        "HOME": paths["keys_dir"],
        "XDG_CONFIG_HOME": paths["keys_dir"],
        "RCLONE_CONFIG": "/dev/null",
        "LC_ALL": "C",
        "PYTHONDONTWRITEBYTECODE": "1",
    }


def start_rclone_service(
    binaries: dict[str, str],
    rclone_path: str,
    paths: dict[str, str],
    served_dir_name: str,
    authorized_keys_name: str,
    host_key_name: str,
    log_name: str,
    port: int,
) -> subprocess.Popen[Any]:
    args = [
        binaries["setpriv"],
        "--bounding-set=-linux_immutable",
        "--no-new-privs",
        "--",
        rclone_path,
        "serve",
        "sftp",
        f":local:{paths[served_dir_name]}",
        "--addr",
        f"127.0.0.1:{port}",
        "--authorized-keys",
        paths[authorized_keys_name],
        "--key",
        paths[host_key_name],
        "--dir-cache-time",
        "0",
        "--poll-interval",
        "0",
        "--vfs-cache-mode",
        "off",
    ]
    for pattern in EXCLUDES:
        args.extend(["--exclude", pattern])
    args.extend(["--log-level", "DEBUG"])

    with open(paths[log_name], "xb") as output:
        return subprocess.Popen(
            args,
            cwd=paths["root"],
            env=service_environment(paths),
            stdin=subprocess.DEVNULL,
            stdout=output,
            stderr=subprocess.STDOUT,
            close_fds=True,
        )


def fixture_paths(root: str) -> dict[str, str]:
    paths = {
        "root": root,
        "control_dir": os.path.join(root, "control"),
        "protected_dir": os.path.join(root, "protected"),
        "keys_dir": os.path.join(root, "keys"),
        "logs_dir": os.path.join(root, "logs"),
        "sources_dir": os.path.join(root, "sources"),
        "batches_dir": os.path.join(root, "batches"),
        "control_marker": os.path.join(root, "control", MARKER_NAME),
        "control_stage": os.path.join(root, "control", CONTROL_STAGE_NAME),
        "protected_marker": os.path.join(root, "protected", MARKER_NAME),
        "protected_stage": os.path.join(root, "protected", PROTECTED_STAGE_NAME),
        "protected_canary": os.path.join(root, "protected", CANARY_NAME),
        "control_log": os.path.join(root, "logs", "control-rclone.log"),
        "protected_log": os.path.join(root, "logs", "protected-rclone.log"),
        "host_key": os.path.join(root, "keys", "host_ed25519"),
        "host_key_public": os.path.join(root, "keys", "host_ed25519.pub"),
        "client_key": os.path.join(root, "keys", "client_ed25519"),
        "client_key_public": os.path.join(root, "keys", "client_ed25519.pub"),
        "authorized_keys": os.path.join(root, "keys", "authorized_keys"),
        "control_known_hosts": os.path.join(root, "keys", "known_hosts-control"),
        "protected_known_hosts": os.path.join(root, "keys", "known_hosts-protected"),
        "control_put_source": os.path.join(root, "sources", "control-put.bin"),
        "protected_put_source": os.path.join(root, "sources", "protected-put.bin"),
        "canary_update_source": os.path.join(root, "sources", "canary-update.bin"),
        "canary_before_download": os.path.join(root, "sources", "canary-before.bin"),
        "canary_after_download": os.path.join(root, "sources", "canary-after.bin"),
        "control_marker_batch": os.path.join(root, "batches", "control-marker-put.batch"),
        "control_stage_batch": os.path.join(root, "batches", "control-stage-put.batch"),
        "protected_marker_batch": os.path.join(root, "batches", "protected-marker-put.batch"),
        "protected_stage_batch": os.path.join(root, "batches", "protected-stage-put.batch"),
        "canary_before_batch": os.path.join(root, "batches", "canary-get-before.batch"),
        "canary_put_batch": os.path.join(root, "batches", "canary-put.batch"),
        "canary_after_batch": os.path.join(root, "batches", "canary-get-after.batch"),
    }
    return paths


def create_fixture() -> dict[str, str]:
    root = tempfile.mkdtemp(prefix=FIXTURE_PREFIX, dir=BASE_CHOICE)
    created_dirs: list[str] = []
    try:
        os.chmod(root, 0o700)
        root_real = os.path.realpath(root)
        if (
            os.path.dirname(root_real) != BASE_CHOICE
            or not os.path.basename(root_real).startswith(FIXTURE_PREFIX)
        ):
            raise ProbeError("mkdtemp escaped the validated base")
        paths = fixture_paths(root_real)
        root_info = lstat_no_symlink(root_real, "fixture root")
        paths["rootExpectedDev"] = str(root_info.st_dev)
        paths["rootExpectedIno"] = str(root_info.st_ino)
        paths["rootExpectedMode"] = str(stat.S_IMODE(root_info.st_mode))
        paths["rootExpectedUid"] = str(root_info.st_uid)
        paths["rootExpectedGid"] = str(root_info.st_gid)
        for name in (
            "control_dir",
            "protected_dir",
            "keys_dir",
            "logs_dir",
            "sources_dir",
            "batches_dir",
        ):
            os.mkdir(paths[name], 0o700)
            created_dirs.append(paths[name])
        return paths
    except Exception:
        for directory in reversed(created_dirs):
            try:
                os.rmdir(directory)
            except OSError:
                pass
        try:
            os.rmdir(root)
        except OSError:
            pass
        raise


def prepare_keys(paths: dict[str, str], binaries: dict[str, str]) -> dict[str, Any]:
    generate_key(binaries["ssh-keygen"], paths["host_key"])
    generate_key(binaries["ssh-keygen"], paths["client_key"])
    host_public = Path(paths["host_key_public"]).read_text(encoding="utf-8").strip()
    client_public = Path(paths["client_key_public"]).read_text(encoding="utf-8").strip()
    write_new_file(paths["authorized_keys"], (client_public + "\n").encode("utf-8"))
    os.chmod(paths["authorized_keys"], 0o600)
    host_fp = run_command(
        [binaries["ssh-keygen"], "-lf", paths["host_key_public"], "-E", "sha256"],
        timeout_seconds=10,
    )
    client_fp = run_command(
        [binaries["ssh-keygen"], "-lf", paths["client_key_public"], "-E", "sha256"],
        timeout_seconds=10,
    )
    if not host_fp.get("ok") or not client_fp.get("ok"):
        raise ProbeError("ssh-keygen fingerprint verification failed")
    return {
        "hostPublicFingerprint": host_fp["stdout"],
        "clientPublicFingerprint": client_fp["stdout"],
        "privateKeyMaterialPersisted": True,
    }


def service_start(
    binaries: dict[str, str],
    rclone: dict[str, Any],
    paths: dict[str, str],
    served_dir_name: str,
    log_name: str,
) -> tuple[subprocess.Popen[Any], int, dict[str, Any]]:
    port = allocate_loopback_port()
    child: subprocess.Popen[Any] | None = None
    try:
        child = start_rclone_service(
            binaries,
            rclone["path"],
            paths,
            served_dir_name,
            "authorized_keys",
            "host_key",
            log_name,
            port,
        )
        startup_ms = wait_for_service(port, child)
        capability_evidence, capability_errors = process_capability_errors(child.pid)
        if capability_errors:
            raise BlockedError(
                "rclone capability evidence failed: " + "; ".join(capability_errors)
            )
        listener, listener_errors = listener_evidence(binaries["ss"], child.pid, port)
        if listener_errors:
            raise BlockedError(
                "rclone listener evidence failed: " + "; ".join(listener_errors)
            )
        return child, port, {
            "bindHost": "127.0.0.1",
            "port": port,
            "startupMs": startup_ms,
            "pid": child.pid,
            "capabilityEvidence": capability_evidence,
            "listenerEvidence": listener,
        }
    except Exception:
        stop_process(child)
        try:
            wait_for_port_closed(port)
        except Exception:
            pass
        raise


def control_group(
    binaries: dict[str, str],
    rclone: dict[str, Any],
    paths: dict[str, str],
) -> dict[str, Any]:
    write_new_file(
        paths["control_marker"],
        b"syncraft control marker before native sftp put\n",
    )
    write_new_file(
        paths["control_stage"],
        b"syncraft control stage before native sftp put\n",
    )
    write_new_file(
        paths["control_put_source"],
        b"syncraft control replacement from native sftp put\n",
    )
    expected_source_sha256 = sha256_file(paths["control_put_source"])

    child: subprocess.Popen[Any] | None = None
    results: dict[str, Any] = {}
    service: dict[str, Any] | None = None
    port: int | None = None
    try:
        child, port, service = service_start(
            binaries,
            rclone,
            paths,
            "control_dir",
            "control_log",
        )
        make_known_hosts(
            Path(paths["host_key_public"]).read_text(encoding="utf-8").strip(),
            port,
            paths["control_known_hosts"],
        )
        for name, remote_name, batch_name in (
            ("marker", MARKER_NAME, "control_marker_batch"),
            ("stage", CONTROL_STAGE_NAME, "control_stage_batch"),
        ):
            remote_path = f"/{remote_name}"
            offset = log_size(paths["control_log"])
            before = file_evidence(
                paths["control_marker" if name == "marker" else "control_stage"]
            )
            result = run_sftp(
                binaries,
                paths,
                port,
                "control_known_hosts",
                paths[batch_name],
                [
                    f"put {sftp_quote(paths['control_put_source'])} "
                    f"{sftp_quote(remote_path)}"
                ],
            )
            after = file_evidence(
                paths["control_marker" if name == "marker" else "control_stage"]
            )
            appended_log = log_segment(paths["control_log"], offset)
            log_evidence = target_log_evidence(appended_log, remote_name)
            changed = (
                before.get("sha256") is not None
                and after.get("sha256") is not None
                and before.get("sha256") != after.get("sha256")
            )
            matches_source = after.get("sha256") == expected_source_sha256
            classification = classify_sftp_error(result.get("stderr") or "")
            transfer_succeeded = (
                result.get("ok") is True
                and changed
                and matches_source
                and after.get("isRegular") is True
                and after.get("isSymlink") is False
            )
            passed = transfer_succeeded and log_evidence["writeForTarget"] is True
            results[name] = {
                "status": (
                    "passed"
                    if passed
                    else "blocked"
                    if (
                        classification in ("authentication", "network")
                        or (transfer_succeeded and not log_evidence["writeForTarget"])
                    )
                    else "failed"
                ),
                "remotePath": remote_path,
                "before": before,
                "after": after,
                "expectedSourceSha256": expected_source_sha256,
                "contentChanged": changed,
                "contentMatchesSource": matches_source,
                "sftp": result,
                "errorClassification": classification,
                "rcloneLogEvidence": log_evidence,
                "rcloneLogSegment": appended_log[-12000:],
            }
            if not passed:
                break
    finally:
        cleanup = stop_process(child)
        closed_ms = None
        closure_error = None
        if service is not None:
            try:
                closed_ms = wait_for_port_closed(service["port"])
            except Exception as error:
                closure_error = str(error)
    results["service"] = service
    results["processCleanup"] = cleanup
    results["listenerClosedMs"] = closed_ms
    results["listenerClosureError"] = closure_error
    if closure_error is not None:
        results["status"] = "failed"
    elif len(results) < 3:
        results["status"] = "blocked"
    elif any(
        results[name]["status"] != "passed"
        for name in ("marker", "stage")
        if name in results
    ) or not all(name in results for name in ("marker", "stage")):
        statuses = [
            results[name]["status"]
            for name in ("marker", "stage")
            if name in results
        ]
        results["status"] = "blocked" if "blocked" in statuses else "failed"
    else:
        results["status"] = "passed"
    return results


def prepare_protected_fixture(
    paths: dict[str, str],
    binaries: dict[str, str],
    immutable_state: dict[str, bool],
) -> dict[str, Any]:
    write_new_file(
        paths["protected_put_source"],
        b"syncraft protected replacement from native sftp put\n",
    )
    write_new_file(
        paths["protected_stage"],
        b"syncraft protected marker stage complete content\n",
    )
    stage_before_link = file_evidence(paths["protected_stage"])
    os.link(paths["protected_stage"], paths["protected_marker"])
    fsync_directory(paths["protected_dir"])
    initial = capture_protected(paths)
    initial_errors = protected_state_errors(initial, initial, require_immutable=False)
    if initial_errors:
        raise ProbeError("; ".join(initial_errors))
    if initial["marker"].get("nlink") != 2:
        raise ProbeError("marker/stage hard link count is not 2")

    immutable_state["mayBeSet"] = True
    set_result = run_command(
        [binaries["chattr"], "+i", paths["protected_marker"]],
        timeout_seconds=10,
    )
    reference = capture_protected(paths)
    identity_after_set_errors = protected_state_errors(
        initial,
        reference,
        require_immutable=False,
    )
    reference_errors = protected_state_errors(reference, reference, require_immutable=True)
    marker_lsattr = run_command(
        [binaries["lsattr"], "-d", paths["protected_marker"]],
        timeout_seconds=10,
    )
    stage_lsattr = run_command(
        [binaries["lsattr"], "-d", paths["protected_stage"]],
        timeout_seconds=10,
    )
    lsattr_ok = (
        marker_lsattr.get("ok") is True
        and stage_lsattr.get("ok") is True
        and "i" in (marker_lsattr.get("stdout") or "").split(None, 1)[0]
        and "i" in (stage_lsattr.get("stdout") or "").split(None, 1)[0]
    )
    if (
        set_result.get("ok") is not True
        or identity_after_set_errors
        or reference_errors
        or not lsattr_ok
    ):
        raise BlockedError("immutable could not be set and verified on marker/stage")
    return {
        "stageBeforeLink": stage_before_link,
        "initial": initial,
        "immutableReference": reference,
        "identityAfterImmutableErrors": identity_after_set_errors,
        "chattr": set_result,
        "markerLsattr": marker_lsattr,
        "stageLsattr": stage_lsattr,
        "immutableVerified": True,
    }


def protected_group(
    binaries: dict[str, str],
    rclone: dict[str, Any],
    paths: dict[str, str],
    prepared: dict[str, Any],
) -> dict[str, Any]:
    reference = prepared["immutableReference"]
    initial_canary = b"syncraft canary initial content\n"
    updated_canary = b"syncraft canary updated content\n"
    write_new_file(paths["protected_canary"], initial_canary)
    write_new_file(paths["canary_update_source"], updated_canary)

    port = allocate_loopback_port()

    child: subprocess.Popen[Any] | None = None
    service: dict[str, Any] | None = None
    results: dict[str, Any] = {"status": "failed"}
    try:
        child, port, service = service_start(
            binaries,
            rclone,
            paths,
            "protected_dir",
            "protected_log",
        )
        make_known_hosts(
            Path(paths["host_key_public"]).read_text(encoding="utf-8").strip(),
            port,
            paths["protected_known_hosts"],
        )

        before_get = run_sftp(
            binaries,
            paths,
            port,
            "protected_known_hosts",
            paths["canary_before_batch"],
            [f"get {sftp_quote(f'/{CANARY_NAME}')} {sftp_quote(paths['canary_before_download'])}"],
        )
        before_hash = (
            sha256_file(paths["canary_before_download"])
            if before_get.get("ok") is True
            else None
        )
        canary_before_direct = file_evidence(paths["protected_canary"])
        canary_put = run_sftp(
            binaries,
            paths,
            port,
            "protected_known_hosts",
            paths["canary_put_batch"],
            [
                f"put {sftp_quote(paths['canary_update_source'])} "
                f"{sftp_quote(f'/{CANARY_NAME}')}"
            ],
        )
        after_get = run_sftp(
            binaries,
            paths,
            port,
            "protected_known_hosts",
            paths["canary_after_batch"],
            [f"get {sftp_quote(f'/{CANARY_NAME}')} {sftp_quote(paths['canary_after_download'])}"],
        )
        after_hash = (
            sha256_file(paths["canary_after_download"])
            if after_get.get("ok") is True
            else None
        )
        canary_after_direct = file_evidence(paths["protected_canary"])
        expected_before = hashlib.sha256(initial_canary).hexdigest()
        expected_after = hashlib.sha256(updated_canary).hexdigest()
        canary_ok = (
            before_get.get("ok") is True
            and canary_put.get("ok") is True
            and after_get.get("ok") is True
            and before_hash == expected_before
            and after_hash == expected_after
            and canary_before_direct.get("sha256") == expected_before
            and canary_after_direct.get("sha256") == expected_after
        )
        results["canary"] = {
            "status": "passed" if canary_ok else "blocked",
            "beforeGet": before_get,
            "put": canary_put,
            "afterGet": after_get,
            "beforeDirectEvidence": canary_before_direct,
            "afterDirectEvidence": canary_after_direct,
            "expectedBeforeSha256": expected_before,
            "observedBeforeSha256": before_hash,
            "expectedAfterSha256": expected_after,
            "observedAfterSha256": after_hash,
        }
        if not canary_ok:
            results["status"] = "blocked"
            return results

        protected_results: dict[str, Any] = {}
        for name, remote_name, batch_name in (
            ("marker", MARKER_NAME, "protected_marker_batch"),
            ("stage", PROTECTED_STAGE_NAME, "protected_stage_batch"),
        ):
            if child.poll() is not None:
                raise ProbeError("rclone exited before protected put")
            remote_path = f"/{remote_name}"
            offset = log_size(paths["protected_log"])
            result = run_sftp(
                binaries,
                paths,
                port,
                "protected_known_hosts",
                paths[batch_name],
                [
                    f"put {sftp_quote(paths['protected_put_source'])} "
                    f"{sftp_quote(remote_path)}"
                ],
            )
            current = capture_protected(paths)
            invariant_errors = protected_state_errors(
                reference,
                current,
                require_immutable=True,
            )
            appended_log = log_segment(paths["protected_log"], offset)
            log_evidence = target_log_evidence(appended_log, remote_name)
            classification = classify_sftp_error(result.get("stderr") or "")
            client_failed = (
                result.get("ok") is False
                and result.get("timedOut") is False
                and result.get("exitCode") not in (None, 0)
            )
            if result.get("ok") is True or invariant_errors:
                status = "failed"
            elif classification in ("authentication", "network") or not client_failed:
                status = "blocked"
            elif classification != "remote-error":
                status = "blocked"
            elif not log_evidence["permissionForTarget"]:
                status = "blocked"
            else:
                status = "passed"
            protected_results[name] = {
                "status": status,
                "remotePath": remote_path,
                "sftp": result,
                "errorClassification": classification,
                "clientFailedWithoutTimeout": client_failed,
                "rcloneLogEvidence": log_evidence,
                "rcloneLogSegment": appended_log[-12000:],
                "directEvidence": current,
                "invariantErrors": invariant_errors,
            }
            if status != "passed":
                break
        results["protectedPuts"] = protected_results
        final = capture_protected(paths)
        final_errors = protected_state_errors(
            reference,
            final,
            require_immutable=True,
        )
        results["finalDirectEvidence"] = final
        results["finalInvariantErrors"] = final_errors
        statuses = [item["status"] for item in protected_results.values()]
        if (
            len(protected_results) == 2
            and statuses == ["passed", "passed"]
            and not final_errors
        ):
            results["status"] = "passed"
        elif "blocked" in statuses or any(
            item["status"] == "blocked" for item in protected_results.values()
        ):
            results["status"] = "blocked"
        else:
            results["status"] = "failed"
    finally:
        cleanup = stop_process(child)
        closed_ms = None
        closure_error = None
        if service is not None:
            try:
                closed_ms = wait_for_port_closed(service["port"])
            except Exception as error:
                closure_error = str(error)
    results["service"] = service
    results["processCleanup"] = cleanup
    results["listenerClosedMs"] = closed_ms
    results["listenerClosureError"] = closure_error
    if closure_error is not None:
        results["status"] = "failed"
    return results


def expected_fixture_entries(paths: dict[str, str]) -> dict[str, set[str]]:
    return {
        paths["root"]: {
            "control",
            "protected",
            "keys",
            "logs",
            "sources",
            "batches",
        },
        paths["control_dir"]: {MARKER_NAME, CONTROL_STAGE_NAME},
        paths["protected_dir"]: {
            MARKER_NAME,
            PROTECTED_STAGE_NAME,
            CANARY_NAME,
        },
        paths["keys_dir"]: {
            "host_ed25519",
            "host_ed25519.pub",
            "client_ed25519",
            "client_ed25519.pub",
            "authorized_keys",
            "known_hosts-control",
            "known_hosts-protected",
        },
        paths["logs_dir"]: {"control-rclone.log", "protected-rclone.log"},
        paths["sources_dir"]: {
            "control-put.bin",
            "protected-put.bin",
            "canary-update.bin",
            "canary-before.bin",
            "canary-after.bin",
        },
        paths["batches_dir"]: {
            "control-marker-put.batch",
            "control-stage-put.batch",
            "protected-marker-put.batch",
            "protected-stage-put.batch",
            "canary-get-before.batch",
            "canary-put.batch",
            "canary-get-after.batch",
        },
    }


def validate_known_tree(paths: dict[str, str]) -> list[str]:
    errors: list[str] = []
    for directory, expected in expected_fixture_entries(paths).items():
        try:
            info = os.lstat(directory)
        except FileNotFoundError:
            if directory == paths["root"]:
                errors.append("fixture root is missing")
            continue
        except OSError as error:
            errors.append(f"{directory} cannot be inspected: {error}")
            continue
        if stat.S_ISLNK(info.st_mode) or not stat.S_ISDIR(info.st_mode):
            errors.append(f"{directory} is not a regular directory")
            continue
        try:
            entries = set(os.listdir(directory))
        except OSError as error:
            errors.append(f"{directory} cannot be listed: {error}")
            continue
        unknown = sorted(entries - expected)
        if unknown:
            errors.append(f"{directory} contains unknown entries: {unknown}")
    return errors


def remove_known_file(path: str) -> None:
    try:
        info = os.lstat(path)
    except FileNotFoundError:
        return
    if stat.S_ISLNK(info.st_mode) or not stat.S_ISREG(info.st_mode):
        raise ProbeError("cleanup target is not a regular non-symlink file")
    os.unlink(path)


def cleanup_fixture(
    paths: dict[str, str] | None,
    binaries: dict[str, str] | None,
    initial: dict[str, Any] | None,
    immutable_may_be_set: bool,
) -> dict[str, Any]:
    result: dict[str, Any] = {
        "attempted": False,
        "removed": False,
        "leftInPlace": False,
    }
    if paths is None:
        return result
    result["attempted"] = True
    root = paths["root"]
    try:
        root_real = os.path.realpath(root)
        if (
            root_real != root
            or os.path.dirname(root_real) != BASE_CHOICE
            or not os.path.basename(root_real).startswith(FIXTURE_PREFIX)
        ):
            raise ProbeError("fixture realpath changed")
        root_info = lstat_no_symlink(root, "fixture root")
        expected_root = {
            "dev": int(paths["rootExpectedDev"]),
            "ino": int(paths["rootExpectedIno"]),
            "mode": int(paths["rootExpectedMode"]),
            "uid": int(paths["rootExpectedUid"]),
            "gid": int(paths["rootExpectedGid"]),
        }
        observed_root = {
            "dev": root_info.st_dev,
            "ino": root_info.st_ino,
            "mode": stat.S_IMODE(root_info.st_mode),
            "uid": root_info.st_uid,
            "gid": root_info.st_gid,
        }
        result["rootIdentity"] = {
            "expected": expected_root,
            "observed": observed_root,
        }
        if observed_root != expected_root:
            raise ProbeError("fixture root identity changed")
        tree_errors = validate_known_tree(paths)
        result["treeErrors"] = tree_errors
        if tree_errors:
            raise ProbeError("; ".join(tree_errors))

        if initial is not None:
            current = capture_protected(paths)
            identity_errors = protected_state_errors(
                initial,
                current,
                require_immutable=False,
            )
            result["identityErrorsBeforeClear"] = identity_errors
            if identity_errors:
                raise ProbeError("protected identity changed before cleanup")

        marker_flags = read_flags(paths["protected_marker"])
        stage_flags = read_flags(paths["protected_stage"])
        result["flagsBeforeClear"] = {
            "marker": marker_flags,
            "stage": stage_flags,
        }
        flags_set = bool(
            marker_flags.get("immutable") or stage_flags.get("immutable")
        )
        if flags_set and not (
            marker_flags.get("immutable") and stage_flags.get("immutable")
        ):
            raise ProbeError("only one protected path reports immutable")
        if immutable_may_be_set or flags_set:
            if binaries is None:
                raise ProbeError("cannot clear immutable without binaries")
            clear_result = run_command(
                [binaries["chattr"], "-i", paths["protected_marker"]],
                timeout_seconds=10,
            )
            result["clearImmutable"] = clear_result
            if not clear_result.get("ok"):
                raise ProbeError("chattr -i failed")
            marker_flags = read_flags(paths["protected_marker"])
            stage_flags = read_flags(paths["protected_stage"])
            result["flagsAfterClear"] = {
                "marker": marker_flags,
                "stage": stage_flags,
            }
            if marker_flags.get("immutable") or stage_flags.get("immutable"):
                raise ProbeError("immutable remains set after chattr -i")

        if initial is not None:
            current = capture_protected(paths)
            identity_errors = protected_state_errors(
                initial,
                current,
                require_immutable=False,
            )
            result["identityErrorsAfterClear"] = identity_errors
            if identity_errors:
                raise ProbeError("protected identity changed after clearing immutable")

        for key in (
            "host_key",
            "host_key_public",
            "client_key",
            "client_key_public",
            "authorized_keys",
            "control_known_hosts",
            "protected_known_hosts",
            "control_marker",
            "control_stage",
            "protected_marker",
            "protected_stage",
            "protected_canary",
            "control_log",
            "protected_log",
            "control_put_source",
            "protected_put_source",
            "canary_update_source",
            "canary_before_download",
            "canary_after_download",
            "control_marker_batch",
            "control_stage_batch",
            "protected_marker_batch",
            "protected_stage_batch",
            "canary_before_batch",
            "canary_put_batch",
            "canary_after_batch",
        ):
            remove_known_file(paths[key])

        for key in (
            "batches_dir",
            "sources_dir",
            "logs_dir",
            "keys_dir",
            "protected_dir",
            "control_dir",
        ):
            if os.listdir(paths[key]):
                raise ProbeError(f"{paths[key]} is not empty after known-file cleanup")
            os.rmdir(paths[key])
        if os.listdir(root):
            raise ProbeError("fixture root is not empty after directory cleanup")
        os.rmdir(root)
        result["removed"] = True
        result["privateKeyMaterialPersisted"] = False
    except Exception as error:
        result["leftInPlace"] = True
        result["path"] = root
        result["privateKeyMaterialPersisted"] = True
        result["error"] = {
            "type": type(error).__name__,
            "message": str(error),
        }
    return result


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Linux native SFTP put protection probe for marker/stage"
    )
    parser.add_argument("--base", choices=(BASE_CHOICE,), required=True)
    parser.add_argument("--rclone", required=True)
    parser.add_argument("--rclone-sha256", required=True)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    if not sys.platform.startswith("linux"):
        print(
            json.dumps(
                {
                    "kind": "syncraft-linux-sftp-marker-protection",
                    "status": "unsupported",
                    "error": "Linux only",
                },
                sort_keys=True,
                separators=(",", ":"),
            )
        )
        return 2

    report: dict[str, Any] = {
        "kind": "syncraft-linux-sftp-marker-protection",
        "status": "failed",
        "scope": (
            "Linux native SFTP put only; no remove, rename, hardlink, proxy, "
            "N1 deployment, or product acceptance"
        ),
        "prerequisite": (
            "Run only after the Linux immutable primitive has passed review and "
            "an authorized N1 execution"
        ),
        "base": BASE_CHOICE,
        "server": {
            "bindHost": "127.0.0.1",
            "excludePatterns": list(EXCLUDES),
            "capabilityDrop": (
                "setpriv --bounding-set=-linux_immutable --no-new-privs"
            ),
        },
        "failures": [],
        "limitations": [
            "No SFTP remove, rename, hardlink, symlink, proxy, or path-escape test.",
            "No crash, power-loss, race, N1 deployment, or product integration proof.",
            "A passed result does not validate the full P2 adapter.",
        ],
    }
    paths: dict[str, str] | None = None
    binaries: dict[str, str] | None = None
    protected_initial: dict[str, Any] | None = None
    immutable_state = {"mayBeSet": False}

    try:
        report["baseEvidence"] = validate_base(args.base)
        rclone = validate_runtime_rclone(args.rclone, args.rclone_sha256)
        report["rclone"] = rclone
        binaries = require_binaries()
        report["binaries"] = binaries
        paths = create_fixture()
        report["fixture"] = {
            "root": paths["root"],
            "prefix": FIXTURE_PREFIX,
            "servedDirectories": [paths["control_dir"], paths["protected_dir"]],
            "runtimeRootWillBeCleaned": False,
        }
        report["keys"] = prepare_keys(paths, binaries)

        control = control_group(binaries, rclone, paths)
        report["controlGroup"] = control
        if control.get("status") != "passed":
            report["status"] = (
                "blocked" if control.get("status") == "blocked" else "failed"
            )
            report["failures"].append("unprotected native SFTP put control did not pass")
        else:
            prepared = prepare_protected_fixture(paths, binaries, immutable_state)
            protected_initial = prepared["initial"]
            report["protectedFixture"] = prepared
            protected = protected_group(binaries, rclone, paths, prepared)
            report["protectedGroup"] = protected
            report["status"] = protected.get("status", "failed")
            if report["status"] != "passed":
                report["failures"].append(
                    "protected native SFTP put or canary evidence did not pass"
                )
    except BlockedError as error:
        report["status"] = "blocked"
        report["failures"].append(f"BlockedError: {error}")
    except ProbeError as error:
        report["status"] = "failed"
        report["failures"].append(f"ProbeError: {error}")
    except Exception as error:
        report["status"] = "failed"
        report["failures"].append(f"{type(error).__name__}: {error}")
    finally:
        cleanup = cleanup_fixture(
            paths,
            binaries,
            protected_initial,
            immutable_state["mayBeSet"],
        )
        report["cleanup"] = cleanup
        private_key_material_persisted = cleanup.get("leftInPlace") is True
        report["privateKeyMaterialPersisted"] = private_key_material_persisted
        if isinstance(report.get("keys"), dict):
            report["keys"]["privateKeyMaterialPersisted"] = private_key_material_persisted
        if cleanup.get("leftInPlace"):
            report["status"] = "fixture-left"
            report["fixtureLeft"] = cleanup.get("path")
        elif report["status"] == "passed" and report["failures"]:
            report["status"] = "failed"

    print(json.dumps(report, sort_keys=True, separators=(",", ":")))
    if report["status"] == "passed":
        return 0
    if report["status"] in ("blocked", "unsupported"):
        return 2
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
