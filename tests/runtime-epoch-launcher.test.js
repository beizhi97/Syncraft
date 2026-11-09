import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);
const projectRoot = join(import.meta.dirname, "..");
const scratchParent = join(projectRoot, ".tmp", "runtime-epoch-launcher-tests");
const imageDigest = `sha256:${"a".repeat(64)}`;
const transactionId = "b".repeat(64);
const scopeProjectionSha256 = "c".repeat(64);

await mkdir(scratchParent, { recursive: true });

async function runPythonScenario(t, source) {
  const root = await mkdtemp(join(scratchParent, "run-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const statePath = join(root, "relation-services.json");
  const ledgerRoot = join(root, "ledger");
  const script = String.raw`
import copy
import importlib.util
import json
import os
import stat
import sys
from importlib.machinery import SourceFileLoader
from pathlib import Path

module_path = Path(${JSON.stringify(join(projectRoot, "server", "runtime", "sfsc-runtime-launcher"))})
sys.path.insert(0, str(module_path.parent))
spec = importlib.util.spec_from_loader(
    "sfsc_runtime_launcher",
    SourceFileLoader("sfsc_runtime_launcher", str(module_path)),
)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
ledger = sys.modules["runtime_epoch_ledger"]

state_path = Path(${JSON.stringify(statePath)})
ledger_root = Path(${JSON.stringify(ledgerRoot)})
image_digest = ${JSON.stringify(imageDigest)}
transaction_id = ${JSON.stringify(transactionId)}
scope_projection_sha256 = ${JSON.stringify(scopeProjectionSha256)}
zero = "0" * 64
docker = "/usr/bin/docker"
image = "sfsc-appliance:local"
deployment_id = "dep-launcher"


class Result:
    def __init__(self, returncode=0, stdout="", stderr=""):
        self.returncode = returncode
        self.stdout = stdout
        self.stderr = stderr


def json_bytes(value):
    return (json.dumps(value, sort_keys=True, indent=2) + "\n").encode("utf-8")


def write_bytes(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(value)
    if os.name != "nt":
        os.chmod(path, 0o600)


def write_json(path, value):
    write_bytes(path, json_bytes(value))


def mount_sources(argv):
    result = {}
    for index, value in enumerate(argv):
        if value != "--mount":
            continue
        fields = {}
        for part in argv[index + 1].split(","):
            key, separator, item = part.partition("=")
            assert key and key not in fields, f"invalid or duplicate mount field: {part}"
            fields[key] = item if separator else True
        assert "src" in fields and "dst" in fields, f"mount lacks src or dst: {argv[index + 1]}"
        result[fields["dst"]] = fields
    return result


class Store:
    def __init__(self):
        self.containers = {}
        self.calls = []
        self.next_id = 1

    def new_id(self):
        value = f"{self.next_id:064x}"
        self.next_id += 1
        return value

    def add(self, identifier, labels, image_id=image_digest, running=False, pid=0, exit_code=0):
        self.containers[identifier] = {
            "Id": identifier,
            "Image": image_id,
            "Config": {"Labels": dict(labels)},
            "State": {
                "Running": running,
                "Pid": pid if running else 0,
                "ExitCode": None if running else exit_code,
                "CgroupPath": f"/system.slice/docker-{identifier}.scope",
            },
        }

    def cgroup_closed(self, path):
        for record in self.containers.values():
            if record["State"]["CgroupPath"] == path and record["State"]["Running"]:
                return False
        return True

    def cgroup_for_pid(self, pid):
        for record in self.containers.values():
            if record["State"]["Running"] and record["State"]["Pid"] == pid:
                return record["State"]["CgroupPath"]
        raise AssertionError(f"unknown pid {pid}")

    def runner(self, argv, timeout=120):
        self.calls.append(list(argv))
        if argv[1:3] == ["image", "inspect"]:
            return Result(stdout=image_digest + "\n")
        if argv[1] == "create":
            labels = {}
            cidfile = None
            for index, value in enumerate(argv):
                if value == "--label":
                    key, item = argv[index + 1].split("=", 1)
                    labels[key] = item
                elif value == "--cidfile":
                    cidfile = Path(argv[index + 1])
            identifier = self.new_id()
            self.add(identifier, labels)
            if cidfile is not None:
                cidfile.parent.mkdir(parents=True, exist_ok=True)
                cidfile.write_text(identifier, encoding="ascii")
            return Result(stdout=identifier + "\n")
        if argv[1] == "ps":
            selector = next(
                value.split("label=", 1)[1]
                for value in argv
                if value.startswith("label=")
            )
            key, wanted = selector.split("=", 1)
            identifiers = sorted(
                identifier
                for identifier, record in self.containers.items()
                if record["Config"]["Labels"].get(key) == wanted
            )
            return Result(stdout="\n".join(identifiers) + ("\n" if identifiers else ""))
        if argv[1] == "inspect":
            identifier = argv[-1]
            record = self.containers.get(identifier)
            if record is None:
                return Result(returncode=1, stderr="missing\n")
            return Result(stdout=json.dumps([copy.deepcopy(record)]))
        if argv[1] == "start":
            record = self.containers[argv[-1]]
            record["State"]["Running"] = True
            record["State"]["Pid"] = 4242
            record["State"]["ExitCode"] = None
            return Result()
        if argv[1] == "wait":
            record = self.containers[argv[-1]]
            record["State"]["Running"] = False
            record["State"]["Pid"] = 0
            record["State"]["ExitCode"] = 0
            return Result(stdout="0\n")
        if argv[1] == "stop":
            record = self.containers.get(argv[-1])
            if record is not None:
                record["State"]["Running"] = False
                record["State"]["Pid"] = 0
            return Result()
        if argv[1] == "rm":
            self.containers.pop(argv[-1], None)
            return Result()
        if argv[1] == "run":
            return self.run_maintenance(argv)
        raise AssertionError(argv)

    def run_maintenance(self, argv):
        mounts = mount_sources(argv)
        maintenance_dir = Path(mounts["/run/sfsc-maintenance"]["src"])
        recovery_dir = Path(mounts["/run/sfsc-maintenance/recovery"]["src"])
        config = json.loads((maintenance_dir / "config.json").read_text(encoding="utf-8"))
        result_path = maintenance_dir / "maintenance-result.json"
        expects_history_mount = config["previousHistoryClosureSha256"] != "0" * 64
        if expects_history_mount:
            history_mount = mounts.get("/run/sfsc-maintenance/history-closure.json")
            assert history_mount is not None, "maintenance history mount is missing"
            assert history_mount["type"] == "bind", "maintenance history mount is not a bind mount"
            assert Path(history_mount["src"]).name == "history-closure.json", (
                "maintenance history mount has the wrong source"
            )
            assert history_mount.get("readonly") is True, (
                "maintenance history mount must be readonly"
            )
        if result_path.exists():
            return Result()
        succession = config.get("succession")
        if succession is not None and succession["mode"] == "reuse-after":
            if succession["sourceTransactionId"] is None:
                current_state = json.loads(state_path.read_text(encoding="utf-8"))
                result = {
                    "schemaVersion": "1",
                    "status": "ok",
                    "deploymentId": config["deploymentId"],
                    "targetEpoch": config["targetEpoch"],
                    "initialized": False,
                    "required": False,
                    "transactionId": None,
                    "revision": current_state["revision"],
                    "rawSha256": ledger.sha256_bytes(state_path.read_bytes()),
                    "scopeProjectionSha256": None,
                    "historyClosureSha256": None,
                    "previousHistoryClosureSha256": None,
                    "closureProofSha256": config["closureProofSha256"],
                    "completedAt": "2026-10-23T00:00:02.000Z",
                }
                write_json(result_path, result)
                return Result()
            transaction = succession["sourceTransactionId"]
            journal = read_json(recovery_dir / f"{transaction}.json")
            current = state_path.read_bytes()
            if (journal["status"] != "committed"
                    or ledger.sha256_bytes(current) != journal["afterRawSha256"]
                    or journal["epochManifestSha256"]
                    != succession["transactionEpochManifestSha256"]):
                raise AssertionError("synthetic maintenance did not find exact reusable source")
            result = {
                "schemaVersion": "1",
                "status": "ok",
                "deploymentId": config["deploymentId"],
                "targetEpoch": config["targetEpoch"],
                "initialized": False,
                "required": True,
                "transactionId": transaction,
                "revision": journal["afterRevision"],
                "rawSha256": journal["afterRawSha256"],
                "scopeProjectionSha256": journal["scopeProjectionSha256"],
                "historyClosureSha256": journal["historyClosureSha256"],
                "previousHistoryClosureSha256": journal["previousHistoryClosureSha256"],
                "closureProofSha256": config["closureProofSha256"],
                "completedAt": "2026-10-23T00:00:02.000Z",
            }
            write_json(result_path, result)
            return Result()
        active_transaction_id = (
            "f" * 64
            if succession is not None and succession["mode"] == "recover-current"
            else transaction_id
        )
        state_exists = state_path.exists()
        if state_exists:
            before = state_path.read_bytes()
            before_state = json.loads(before.decode("utf-8"))
        else:
            before_state = {
                "version": 2,
                "kind": "relation-file-service-manager-state",
                "storageContract": "single-manager-owner+injected-scoped-locks+durable-json-replace-v2",
                "revision": 0,
                "createdAt": "2026-10-23T00:00:00.000Z",
                "updatedAt": "2026-10-23T00:00:00.000Z",
                "operations": {},
                "relations": {},
            }
            before = json_bytes(before_state)
        required = bool(before_state.get("relations"))
        after_state = copy.deepcopy(before_state)
        if required:
            after_state["revision"] = before_state["revision"] + 1
            after_state["updatedAt"] = "2026-10-23T00:00:01.000Z"
        after = json_bytes(after_state)
        write_bytes(state_path, after)
        result = {
            "schemaVersion": "1",
            "status": "ok",
            "deploymentId": config["deploymentId"],
            "targetEpoch": config["targetEpoch"],
            "initialized": not state_exists,
            "required": required,
            "transactionId": active_transaction_id if required else None,
            "revision": after_state["revision"],
            "rawSha256": ledger.sha256_bytes(after),
            "scopeProjectionSha256": scope_projection_sha256 if required else None,
            "historyClosureSha256": None,
            "previousHistoryClosureSha256": None,
            "closureProofSha256": config["closureProofSha256"],
            "completedAt": "2026-10-23T00:00:01.000Z",
        }
        if required:
            history = json_bytes({
                "schemaVersion": "1",
                "transactionId": active_transaction_id,
                "previousHistoryClosureSha256": config["previousHistoryClosureSha256"],
                "scopeProjectionSha256": scope_projection_sha256,
                "descriptors": [],
            })
            write_bytes(recovery_dir / f"{active_transaction_id}.history-closure.json", history)
            write_bytes(recovery_dir / f"{active_transaction_id}.after.json", after)
            journal = {
                "schemaVersion": "1",
                "transactionId": active_transaction_id,
                "status": "after-verified",
                "deploymentId": config["deploymentId"],
                "policyVersion": config["policyVersion"],
                "oldContainerId": config["oldContainerId"],
                "targetEpoch": config["targetEpoch"],
                "createdFromEpoch": config["createdFromEpoch"],
                "createdAt": "2026-10-23T00:00:01.000Z",
                "beforeRevision": before_state["revision"],
                "beforeRawSha256": ledger.sha256_bytes(before),
                "afterRevision": after_state["revision"],
                "afterRawSha256": ledger.sha256_bytes(after),
                "afterBytesSha256": ledger.sha256_bytes(after),
                "closureProofSha256": config["closureProofSha256"],
                "scopeProjectionSha256": scope_projection_sha256,
                "historyClosureSha256": ledger.sha256_bytes(history),
                "previousHistoryClosureSha256": config["previousHistoryClosureSha256"],
                "inheritedDescriptors": [],
                "descriptors": [],
            }
            write_json(recovery_dir / f"{active_transaction_id}.json", journal)
            result["historyClosureSha256"] = journal["historyClosureSha256"]
            result["previousHistoryClosureSha256"] = config["previousHistoryClosureSha256"]
        write_json(result_path, result)
        return Result()


def state_v2(revision=7):
    return {
        "version": 2,
        "kind": "relation-file-service-manager-state",
        "storageContract": "single-manager-owner+injected-scoped-locks+durable-json-replace-v2",
        "revision": revision,
        "createdAt": "2026-10-23T00:00:00.000Z",
        "updatedAt": "2026-10-23T00:00:00.000Z",
        "operations": {},
        "relations": {"rel-current": {"relationId": "rel-current"}},
    }


def seed_current(store, state, old_id="1" * 64, running=False):
    store.next_id = 2
    raw = json_bytes(state)
    write_bytes(state_path, raw)
    old_cgroup = f"/system.slice/docker-{old_id}.scope"
    labels = {
        "io.syncraft.deployment-id": deployment_id,
        "io.syncraft.operation-id": "4" * 64,
        "io.syncraft.runtime-epoch": "epoch-00000001",
    }
    store.add(old_id, labels, running=running, pid=4000 if running else 0, exit_code=0)
    manifest = ledger.build_epoch_manifest(
        deployment_id=deployment_id,
        target_epoch="epoch-00000001",
        container_id=old_id,
        image_digest=image_digest,
        host_cgroup_path=old_cgroup,
        bootstrap_nonce_sha256="d" * 64,
        baseline={"revision": state["revision"], "rawSha256": ledger.sha256_bytes(raw)},
        closure_proof_sha256="e" * 64,
        recovery=None,
        sealed_at="2026-10-23T00:00:00.000Z",
    )
    _, manifest_sha = ledger.seal_epoch(ledger_root, "epoch-00000001", manifest)
    _, ready = ledger.seal_runtime_ready(
        ledger_root / "epochs" / "epoch-00000001",
        bootstrap_nonce_sha256="d" * 64,
        container_id=old_id,
        image_digest=image_digest,
        host_cgroup_path=old_cgroup,
        pid_namespace_id="pid:[4026532000]",
        epoch_manifest_sha256=manifest_sha,
        target_epoch="epoch-00000001",
    )
    ledger.record_current(ledger_root, {
        "schemaVersion": "1",
        "deploymentId": deployment_id,
        "operationId": "4" * 64,
        "targetEpoch": "epoch-00000001",
        "containerId": old_id,
        "imageDigest": image_digest,
        "hostCgroupPath": old_cgroup,
        "pidNamespaceId": "pid:[4026532000]",
        "epochManifestSha256": manifest_sha,
        "recoveryTransactionId": None,
        "status": "ready" if running else "exited",
        "startedAt": "2026-10-23T00:00:00.000Z",
        "exitCode": None if running else 0,
        "exitedAt": None if running else "2026-10-23T00:00:00.500Z",
    })
    return old_id, manifest_sha


def config():
    return {
        "ledger_root": str(ledger_root),
        "state_path": str(state_path),
        "image": image,
        "deployment_id": deployment_id,
        "docker": docker,
        "volumes": ["type=bind,src=/host/app,dst=/data/app"],
        "environment": ["HOST=0.0.0.0", "PORT=5177"],
        "env_files": ["/host/runtime.env"],
        "ready_timeout_seconds": 1,
        "allow_non_root": True,
    }


def run_once(store, boundary=None, read_cgroup=None, runner=None, failure_boundary=None):
    def crash_hook(value, operation):
        if value == boundary:
            raise module.SimulatedCrash(value)
        if value == failure_boundary:
            raise RuntimeError(f"injected failure at {value}")

    return module.run_appliance_once(
        config(),
        runner=runner or store.runner,
        read_cgroup=read_cgroup or store.cgroup_for_pid,
        read_pid_namespace=lambda pid: "pid:[4026532000]",
        cgroup_closed=store.cgroup_closed,
        sleep=lambda value: None,
        crash_hook=crash_hook,
    )


def read_json(path):
    return json.loads(path.read_text(encoding="utf-8"))


${source}
`;
  const { stdout, stderr } = await execFileAsync("python", ["-c", script], {
    cwd: projectRoot,
    timeout: 60_000,
    maxBuffer: 4 * 1024 * 1024
  });
  return {
    value: stdout.trim() ? JSON.parse(stdout) : null,
    stderr,
    root,
    ledgerRoot,
    statePath
  };
}

test("launcher source requires serial root-only exact runtime proof", async () => {
  const launcher = await readFile(
    join(projectRoot, "server", "runtime", "sfsc-runtime-launcher"),
    "utf8"
  );
  const ledger = await readFile(
    join(projectRoot, "server", "runtime", "runtime_epoch_ledger.py"),
    "utf8"
  );
  assert.match(launcher, /physical_state_launch_lock/);
  assert.match(launcher, /serial_launcher_lock/);
  assert.match(launcher, /container_image_mismatch/);
  assert.match(launcher, /container_cgroup_mismatch/);
  assert.match(launcher, /dst=\/run\/sfsc-runtime,readonly/);
  assert.match(launcher, /startupMaintenanceCli\.js/);
  assert.match(ledger, /must be owned by root/);
  assert.match(ledger, /must not be group or world writable/);
  assert.match(ledger, /runtime-ready\.json/);
  assert.doesNotMatch(ledger, /def ensure_initial_state[\s\S]{0,200}atomic_write\(state_path/);
  assert.doesNotMatch(ledger, /def resume_recovery[\s\S]{0,200}atomic_write\(state_path/);
});

test("normal V2 without a pending journal closes the old exact runtime and uses the production maintenance entry", {
  skip: process.platform === "win32"
    ? "Windows sandbox blocks Node child-process proof; root runs the same Python scenario directly"
    : false
}, async t => {
  const result = await runPythonScenario(t, String.raw`
store = Store()
state = state_v2()
old_id, old_manifest_sha = seed_current(store, state)
result = run_once(store)
current = read_json(ledger_root / "current.json")
operation = read_json(ledger_root / "operation.json")
manifest = read_json(ledger_root / "epochs" / "epoch-00000002" / "epoch.json")
maintenance = next(call for call in store.calls if call[1] == "run")
create = next(call for call in store.calls if call[1] == "create")
stop_index = next(index for index, call in enumerate(store.calls) if call[1] == "stop" and call[-1] == old_id)
remove_index = next(index for index, call in enumerate(store.calls) if call[1] == "rm" and call[-1] == old_id)
create_index = store.calls.index(create)
after = read_json(state_path)
print(json.dumps({
    "result": result,
    "current": current,
    "operation": operation,
    "manifest": manifest,
    "maintenance": maintenance,
    "create": create,
    "oldContainerRetained": old_id in store.containers,
    "stopBeforeCreate": stop_index < remove_index < create_index,
    "state": after,
    "oldManifestSha": old_manifest_sha,
}))
`);
  assert.equal(result.value.result.exitCode, 0);
  assert.equal(result.value.current.status, "exited");
  assert.equal(result.value.current.targetEpoch, "epoch-00000002");
  assert.equal(result.value.current.recoveryTransactionId, transactionId);
  assert.equal(result.value.operation.phase, "complete");
  assert.equal(result.value.operation.previousContainerId, "1".repeat(64));
  assert.equal(result.value.manifest.recovery.transactionId, transactionId);
  assert.equal(result.value.state.revision, 8);
  assert.equal(result.value.oldContainerRetained, false);
  assert.equal(result.value.stopBeforeCreate, true);
  assert.equal(result.value.maintenance.at(-3), "/app/src/service/startupMaintenanceCli.js");
  assert.deepEqual(result.value.maintenance.slice(-2), [
    "--config",
    "/run/sfsc-maintenance/config.json"
  ]);
  assert.ok(result.value.maintenance.includes("--network"));
  assert.ok(result.value.maintenance.includes("none"));
  assert.ok(result.value.maintenance.includes("--cap-drop"));
  assert.equal(result.value.maintenance[result.value.maintenance.indexOf("--cap-drop") + 1], "ALL");
  assert.ok(result.value.maintenance.includes("sfsc-appliance:local"));
  assert.ok(result.value.maintenance.every(value => (
    !value.includes("docker.sock") && !value.includes("/run/sfsc-runtime")
  )));
  assert.ok(result.value.create.includes(
    `type=bind,src=${result.value.result.runtimeReadyPath.replace(/[\\/]runtime-ready\.json$/, "")},dst=/run/sfsc-runtime,readonly`
  ));
  assert.ok(result.value.create.includes("--cap-add"));
  assert.equal(result.value.create[result.value.create.indexOf("--cap-add") + 1], "LINUX_IMMUTABLE");
  assert.equal(result.value.create.includes("--cap-drop"), false);
});

test("a running exact current is waited once before the next launch allocates a new epoch", {
  skip: process.platform === "win32"
    ? "Windows sandbox blocks Node child-process proof; root runs the same Python scenario directly"
    : false
}, async t => {
  const result = await runPythonScenario(t, String.raw`
store = Store()
state = state_v2()
old_id, old_manifest_sha = seed_current(store, state, running=True)
first = run_once(store)
first_current = read_json(ledger_root / "current.json")
first_wait_calls = sum(1 for call in store.calls if call[1] == "wait")
first_wait_ids = [call[-1] for call in store.calls if call[1] == "wait"]
operation_after_first = (ledger_root / "operation.json").exists()
second = run_once(store)
operation = read_json(ledger_root / "operation.json")
current = read_json(ledger_root / "current.json")
print(json.dumps({
    "first": first,
    "firstCurrent": first_current,
    "firstWaitCalls": first_wait_calls,
    "firstWaitIds": first_wait_ids,
    "operationAfterFirst": operation_after_first,
    "second": second,
    "operation": operation,
    "current": current,
    "state": read_json(state_path),
    "waitCalls": sum(1 for call in store.calls if call[1] == "wait"),
    "waitIds": [call[-1] for call in store.calls if call[1] == "wait"],
    "oldId": old_id,
    "oldManifestSha": old_manifest_sha,
}))
`);
  assert.equal(result.value.first.targetEpoch, "epoch-00000001");
  assert.equal(result.value.firstCurrent.status, "exited");
  assert.equal(result.value.firstCurrent.exitCode, 0);
  assert.equal(result.value.firstWaitCalls, 1);
  assert.deepEqual(result.value.firstWaitIds, [result.value.oldId]);
  assert.equal(result.value.operationAfterFirst, false);
  assert.equal(result.value.waitCalls, 2);
  assert.equal(result.value.second.targetEpoch, "epoch-00000002");
  assert.equal(result.value.operation.phase, "complete");
  assert.equal(result.value.current.status, "exited");
  assert.equal(result.value.current.targetEpoch, "epoch-00000002");
  assert.deepEqual(result.value.waitIds, [
    result.value.oldId,
    result.value.current.containerId
  ]);
  assert.equal(result.value.state.revision, 8);
});

test("a ready nonce mismatch rejects current runtime before Docker or launch side effects", {
  skip: process.platform === "win32"
    ? "Windows sandbox blocks Node child-process proof; root runs the same Python scenario directly"
    : false
}, async t => {
  const result = await runPythonScenario(t, String.raw`
store = Store()
state = state_v2()
old_id, manifest_sha = seed_current(store, state, running=True)
ready_path = ledger_root / "epochs" / "epoch-00000001" / "runtime-ready.json"
ready_path.unlink()
_, mismatched_ready = ledger.seal_runtime_ready(
    ready_path.parent,
    bootstrap_nonce_sha256="f" * 64,
    container_id=old_id,
    image_digest=image_digest,
    host_cgroup_path=f"/system.slice/docker-{old_id}.scope",
    pid_namespace_id="pid:[4026532000]",
    epoch_manifest_sha256=manifest_sha,
    target_epoch="epoch-00000001",
)
failure = None
try:
    run_once(store)
except module.LauncherError as error:
    failure = error.code
manifest = read_json(ledger_root / "epochs" / "epoch-00000001" / "epoch.json")
current = read_json(ledger_root / "current.json")
print(json.dumps({
    "failure": failure,
    "ready": mismatched_ready,
    "manifestNonceSha256": manifest["bootstrapNonceSha256"],
    "current": current,
    "state": read_json(state_path),
    "calls": store.calls,
    "containerRetained": old_id in store.containers,
    "operationExists": (ledger_root / "operation.json").exists(),
}))
`);
  assert.equal(result.value.failure, "current_epoch_invalid");
  assert.equal(result.value.ready.schemaVersion, "1");
  assert.equal(result.value.ready.bootstrapNonceSha256, "f".repeat(64));
  assert.equal(result.value.manifestNonceSha256, "d".repeat(64));
  assert.deepEqual(result.value.calls, []);
  assert.equal(result.value.containerRetained, true);
  assert.equal(result.value.operationExists, false);
  assert.equal(result.value.current.status, "ready");
  assert.equal(result.value.current.epochManifestSha256, result.value.ready.epochManifestSha256);
  assert.equal(result.value.state.revision, 7);
});

test("host crash boundaries re-enter the same operation, epoch, and recovery transaction", {
  skip: process.platform === "win32"
    ? "Windows sandbox blocks Node child-process proof; root runs the same Python scenario directly"
    : false
}, async t => {
  const boundaries = [
    "operation-intent-persisted",
    "container-create-returned-before-id-record",
    "container-id-recorded",
    "maintenance-completed",
    "maintenance-result-recorded",
    "epoch-sealed",
    "runtime-start-returned",
    "runtime-ready-sealed",
    "current-before-record",
    "current-recorded",
    "operation-completed"
  ];
  for (const boundary of boundaries) {
    const result = await runPythonScenario(t, `
boundary = ${JSON.stringify(boundary)}
store = Store()
state = state_v2()
seed_current(store, state)
try:
    run_once(store, boundary=boundary)
    raise AssertionError("crash was not injected")
except module.SimulatedCrash as error:
    assert error.boundary == boundary
first_operation = read_json(ledger_root / "operation.json")
before_resume = read_json(state_path)
result = run_once(store)
operation = read_json(ledger_root / "operation.json")
current = read_json(ledger_root / "current.json")
after_resume = read_json(state_path)
maintenance_calls = sum(1 for call in store.calls if call[1] == "run")
create_calls = sum(1 for call in store.calls if call[1] == "create")
print(json.dumps({
    "boundary": boundary,
    "firstOperation": first_operation,
    "result": result,
    "operation": operation,
    "current": current,
    "beforeResume": before_resume,
    "afterResume": after_resume,
    "maintenanceCalls": maintenance_calls,
    "createCalls": create_calls,
}))
`);
    assert.equal(result.value.operation.operationId,
      result.value.firstOperation.operationId, boundary);
    assert.equal(result.value.current.operationId,
      result.value.operation.operationId, boundary);
    assert.equal(result.value.operation.targetEpoch, "epoch-00000002", boundary);
    assert.equal(result.value.current.targetEpoch, "epoch-00000002", boundary);
    assert.equal(result.value.current.recoveryTransactionId, transactionId, boundary);
    assert.equal(result.value.operation.phase, "complete", boundary);
    assert.equal(result.value.afterResume.revision, 8, boundary);
    assert.equal(result.value.maintenanceCalls, 1, boundary);
    assert.ok([1, 2].includes(result.value.createCalls), boundary);
  }
});

test("create interruption adopts one exact operation-labelled container without a cidfile", {
  skip: process.platform === "win32"
    ? "Windows sandbox blocks Node child-process proof; root runs the same Python scenario directly"
    : false
}, async t => {
  const result = await runPythonScenario(t, String.raw`
store = Store()
state = state_v2()
seed_current(store, state)
try:
    run_once(store, boundary="container-create-returned-before-id-record")
except module.SimulatedCrash:
    pass
operation = read_json(ledger_root / "operation.json")
created = [
    call[call.index("--cidfile") + 1]
    for call in store.calls
    if call[1] == "create"
][0]
cidfile = Path(created)
container_id = cidfile.read_text(encoding="ascii").strip()
cidfile.unlink()
result = run_once(store)
current = read_json(ledger_root / "current.json")
operation = read_json(ledger_root / "operation.json")
print(json.dumps({
    "result": result,
    "current": current,
    "operation": operation,
    "containerId": container_id,
    "createCalls": sum(1 for call in store.calls if call[1] == "create"),
}))
`);
  assert.equal(result.value.createCalls, 1);
  assert.equal(result.value.current.containerId, result.value.containerId);
  assert.equal(result.value.operation.containerId, result.value.containerId);
  assert.equal(result.value.current.targetEpoch, "epoch-00000002");
});

test("two containers with the same operation label fail closed without claiming either one", {
  skip: process.platform === "win32"
    ? "Windows sandbox blocks Node child-process proof; root runs the same Python scenario directly"
    : false
}, async t => {
  const result = await runPythonScenario(t, String.raw`
store = Store()
state = state_v2()
seed_current(store, state)
try:
    run_once(store, boundary="container-create-returned-before-id-record")
except module.SimulatedCrash:
    pass
operation = read_json(ledger_root / "operation.json")
cidfile = Path(operation["cidFile"])
first_id = cidfile.read_text(encoding="ascii").strip()
cidfile.unlink()
second_id = "9" * 64
store.add(second_id, {
    "io.syncraft.deployment-id": deployment_id,
    "io.syncraft.operation-id": operation["operationId"],
    "io.syncraft.runtime-epoch": operation["targetEpoch"],
})
failure = None
try:
    run_once(store)
except module.LauncherError as error:
    failure = error.code
failed_operation = read_json(ledger_root / "operation.json")
print(json.dumps({
    "failure": failure,
    "firstIdRetained": first_id in store.containers,
    "secondIdRetained": second_id in store.containers,
    "operation": failed_operation,
    "stateRevision": read_json(state_path)["revision"],
}))
`);
  assert.equal(result.value.failure, "container_claim_ambiguous");
  assert.equal(result.value.firstIdRetained, true);
  assert.equal(result.value.secondIdRetained, true);
  assert.equal(result.value.operation.phase, "failed");
  assert.equal(result.value.stateRevision, 7);
});

test("different ledger roots cannot launch concurrently against the same physical state", {
  skip: process.platform === "win32"
    ? "Windows sandbox blocks Node child-process proof; root runs the same Python scenario directly"
    : false
}, async t => {
  const result = await runPythonScenario(t, String.raw`
store = Store()
write_json(state_path, state_v2())
failure = None
with module.physical_state_launch_lock(state_path):
    try:
        run_once(store)
    except module.LauncherError as error:
        failure = error.code
print(json.dumps({
    "failure": failure,
    "calls": store.calls,
    "state": read_json(state_path),
}))
`);
  assert.equal(result.value.failure, "runtime_launch_busy");
  assert.deepEqual(result.value.calls, []);
  assert.equal(result.value.state.revision, 7);
});

test("an exact self-created failed operation is cleaned, archived, and does not require manual state", {
  skip: process.platform === "win32"
    ? "Windows sandbox blocks Node child-process proof; root runs the same Python scenario directly"
    : false
}, async t => {
  const result = await runPythonScenario(t, String.raw`
store = Store()
state = state_v2()
seed_current(store, state)

def failing_runner(argv, timeout=120):
    if argv[1] == "create":
        store.calls.append(list(argv))
        raise module.LauncherError("injected_before_create", "synthetic create failure")
    return store.runner(argv, timeout)

try:
    run_once(store, runner=failing_runner)
except module.LauncherError as error:
    first_failure = error.code
else:
    raise AssertionError("injected failure was not raised")
failed = read_json(ledger_root / "operation.json")
failed_nonce_path = ledger_root / "nonces" / f"{failed['targetEpoch']}.json"
failed_nonce_before = failed_nonce_path.read_bytes()
result = run_once(store)
failed_archived = (ledger_root / "operations" / f"{failed['operationId']}.failed.json").exists()
current = read_json(ledger_root / "current.json")
operation = read_json(ledger_root / "operation.json")
print(json.dumps({
    "firstFailure": first_failure,
    "failed": failed,
    "failedArchived": failed_archived,
    "result": result,
    "current": current,
    "operation": operation,
    "state": read_json(state_path),
    "failedNonceUnchanged": failed_nonce_path.read_bytes() == failed_nonce_before,
}))
`);
  assert.equal(result.value.firstFailure, "injected_before_create");
  assert.equal(result.value.failedArchived, true);
  assert.equal(result.value.failed.targetEpoch, "epoch-00000002");
  assert.equal(result.value.failed.epochManifestSha256, null);
  assert.equal(result.value.failedNonceUnchanged, true);
  assert.equal(result.value.operation.targetEpoch, "epoch-00000003");
  assert.equal(result.value.current.targetEpoch, "epoch-00000003");
  assert.equal(result.value.operation.phase, "complete");
  assert.equal(result.value.state.revision, 8);
});

test("sealed failures continue through one immutable successor without rewriting state or history", {
  skip: process.platform === "win32"
    ? "Windows sandbox blocks Node child-process proof; root runs the same Python scenario directly"
    : false
}, async t => {
  for (const boundary of [
    "epoch-sealed",
    "runtime-ready-sealed",
    "current-recorded"
  ]) {
    const result = await runPythonScenario(t, `
boundary = ${JSON.stringify(boundary)}
store = Store()
state = state_v2()
seed_current(store, state)
try:
    run_once(store, failure_boundary=boundary)
    raise AssertionError("failure was not injected")
except RuntimeError as error:
    assert str(error) == f"injected failure at {boundary}"
failed = read_json(ledger_root / "operation.json")
failed_epoch_before = (ledger_root / "epochs" / failed["targetEpoch"] / "epoch.json").read_bytes()
journal_path = ledger_root / "recovery" / f"{transaction_id}.json"
journal_before = journal_path.read_bytes()
journal_metadata = read_json(journal_path)
state_before = state_path.read_bytes()
result = run_once(store)
current = read_json(ledger_root / "current.json")
operation = read_json(ledger_root / "operation.json")
manifest = read_json(ledger_root / "epochs" / "epoch-00000003" / "epoch.json")
print(json.dumps({
    "boundary": boundary,
    "failed": failed,
    "failedArchived": (ledger_root / "operations" / f"{failed['operationId']}.failed.json").exists(),
    "result": result,
    "current": current,
    "operation": operation,
    "manifest": manifest,
    "state": read_json(state_path),
    "stateUnchanged": state_path.read_bytes() == state_before,
    "failedEpochUnchanged": (ledger_root / "epochs" / failed["targetEpoch"] / "epoch.json").read_bytes() == failed_epoch_before,
    "journalUnchanged": journal_path.read_bytes() == journal_before,
    "journalMetadata": journal_metadata,
    "maintenanceCalls": sum(1 for call in store.calls if call[1] == "run"),
}))
`);
    assert.equal(result.value.failed.phase, "failed", boundary);
    assert.equal(result.value.failedArchived, true, boundary);
    assert.equal(result.value.current.targetEpoch, "epoch-00000003", boundary);
    assert.equal(result.value.current.recoveryTransactionId, transactionId, boundary);
    assert.equal(result.value.operation.phase, "complete", boundary);
    assert.equal(result.value.operation.succession.mode, "reuse-after", boundary);
    assert.equal(result.value.operation.succession.previousEpochManifestSha256,
      result.value.failed.epochManifestSha256, boundary);
    assert.equal(result.value.manifest.recovery.transactionId, transactionId, boundary);
    assert.equal(result.value.manifest.succession.transactionEpochManifestSha256,
      result.value.failed.epochManifestSha256, boundary);
    assert.equal(result.value.manifest.recovery.closureProofSha256,
      result.value.journalMetadata.closureProofSha256, boundary);
    assert.equal(result.value.manifest.recovery.previousHistoryClosureSha256,
      result.value.journalMetadata.previousHistoryClosureSha256, boundary);
    assert.equal(result.value.manifest.recovery.scopeProjectionSha256,
      result.value.journalMetadata.scopeProjectionSha256, boundary);
    assert.equal(result.value.manifest.recovery.historyClosureSha256,
      result.value.journalMetadata.historyClosureSha256, boundary);
    assert.equal(result.value.state.revision, 8, boundary);
    assert.equal(result.value.stateUnchanged, true, boundary);
    assert.equal(result.value.failedEpochUnchanged, true, boundary);
    assert.equal(result.value.journalUnchanged, true, boundary);
    assert.equal(result.value.maintenanceCalls, 2, boundary);
  }
});

test("repeated sealed reuse failures retain one source journal before final succession", {
  skip: process.platform === "win32"
    ? "Windows sandbox blocks Node child-process proof; root runs the same Python scenario directly"
    : false
}, async t => {
  const result = await runPythonScenario(t, String.raw`
store = Store()
state = state_v2()
seed_current(store, state)
try:
    run_once(store, failure_boundary="epoch-sealed")
except RuntimeError as error:
    assert str(error) == "injected failure at epoch-sealed"
initial_failed = read_json(ledger_root / "operation.json")
journal_path = ledger_root / "recovery" / f"{transaction_id}.json"
journal_bytes = journal_path.read_bytes()
journal = read_json(journal_path)
state_bytes = state_path.read_bytes()
failures = []
for expected_epoch in ("epoch-00000003", "epoch-00000004"):
    try:
        run_once(store, failure_boundary="epoch-sealed")
        raise AssertionError("reused recovery failure was not injected")
    except RuntimeError as error:
        assert str(error) == "injected failure at epoch-sealed"
    failed = read_json(ledger_root / "operation.json")
    manifest = read_json(ledger_root / "epochs" / failed["targetEpoch"] / "epoch.json")
    failures.append({
        "expectedEpoch": expected_epoch,
        "failed": failed,
        "manifest": manifest,
        "stateUnchanged": state_path.read_bytes() == state_bytes,
        "journalUnchanged": journal_path.read_bytes() == journal_bytes,
    })
result = run_once(store)
operation = read_json(ledger_root / "operation.json")
current = read_json(ledger_root / "current.json")
manifest = read_json(ledger_root / "epochs" / "epoch-00000005" / "epoch.json")
print(json.dumps({
    "result": result,
    "initialFailed": initial_failed,
    "journal": journal,
    "failures": failures,
    "operation": operation,
    "current": current,
    "manifest": manifest,
    "state": read_json(state_path),
    "stateUnchanged": state_path.read_bytes() == state_bytes,
    "journalUnchanged": journal_path.read_bytes() == journal_bytes,
    "maintenanceCalls": sum(1 for call in store.calls if call[1] == "run"),
}))
`);
  assert.equal(result.value.failures.length, 2);
  for (const failure of result.value.failures) {
    assert.equal(failure.failed.targetEpoch, failure.expectedEpoch);
    assert.equal(failure.failed.succession.mode, "reuse-after");
    assert.equal(
      failure.failed.succession.transactionEpochManifestSha256,
      result.value.initialFailed.epochManifestSha256
    );
    assert.equal(
      failure.manifest.recovery.transactionId,
      result.value.journal.transactionId
    );
    assert.equal(
      failure.manifest.recovery.closureProofSha256,
      result.value.journal.closureProofSha256
    );
    assert.equal(
      failure.manifest.recovery.previousHistoryClosureSha256,
      result.value.journal.previousHistoryClosureSha256
    );
    assert.equal(failure.stateUnchanged, true);
    assert.equal(failure.journalUnchanged, true);
  }
  assert.equal(result.value.operation.targetEpoch, "epoch-00000005");
  assert.equal(result.value.operation.phase, "complete");
  assert.equal(result.value.operation.succession.mode, "reuse-after");
  assert.equal(result.value.operation.succession.previousTargetEpoch, "epoch-00000004");
  assert.equal(result.value.current.targetEpoch, "epoch-00000005");
  assert.equal(result.value.current.recoveryTransactionId, result.value.journal.transactionId);
  assert.equal(
    result.value.manifest.recovery.closureProofSha256,
    result.value.journal.closureProofSha256
  );
  assert.equal(
    result.value.manifest.recovery.previousHistoryClosureSha256,
    result.value.journal.previousHistoryClosureSha256
  );
  assert.equal(
    result.value.manifest.succession.closedProofSha256,
    result.value.operation.succession.closedProofSha256
  );
  assert.equal(result.value.state.revision, 8);
  assert.equal(result.value.stateUnchanged, true);
  assert.equal(result.value.journalUnchanged, true);
  assert.equal(result.value.maintenanceCalls, 4);
});

test("a crash after successor intent reuses the same operation and recovery transaction", {
  skip: process.platform === "win32"
    ? "Windows sandbox blocks Node child-process proof; root runs the same Python scenario directly"
    : false
}, async t => {
  const result = await runPythonScenario(t, String.raw`
store = Store()
state = state_v2()
seed_current(store, state)
try:
    run_once(store, failure_boundary="epoch-sealed")
except RuntimeError:
    pass
journal_path = ledger_root / "recovery" / f"{transaction_id}.json"
journal_before = journal_path.read_bytes()
try:
    run_once(store, boundary="succession-intent-persisted")
    raise AssertionError("successor crash was not injected")
except module.SimulatedCrash as error:
    assert error.boundary == "succession-intent-persisted"
successor_before = read_json(ledger_root / "operation.json")
state_before = state_path.read_bytes()
result = run_once(store)
operation = read_json(ledger_root / "operation.json")
current = read_json(ledger_root / "current.json")
print(json.dumps({
    "result": result,
    "operation": operation,
    "current": current,
    "successorBefore": successor_before,
    "state": read_json(state_path),
    "stateUnchanged": state_path.read_bytes() == state_before,
    "journalUnchanged": journal_path.read_bytes() == journal_before,
}))
`);
  assert.equal(result.value.operation.operationId,
    result.value.successorBefore.operationId);
  assert.equal(result.value.operation.targetEpoch,
    result.value.successorBefore.targetEpoch);
  assert.equal(result.value.current.targetEpoch, "epoch-00000003");
  assert.equal(result.value.current.recoveryTransactionId, transactionId);
  assert.equal(result.value.state.revision, 8);
  assert.equal(result.value.stateUnchanged, true);
  assert.equal(result.value.journalUnchanged, true);
});

test("ambiguous sealed-failure identity remains blocked without a successor", {
  skip: process.platform === "win32"
    ? "Windows sandbox blocks Node child-process proof; root runs the same Python scenario directly"
    : false
}, async t => {
  const result = await runPythonScenario(t, String.raw`
store = Store()
state = state_v2()
seed_current(store, state)
try:
    run_once(store, failure_boundary="epoch-sealed")
except RuntimeError:
    pass
failed = read_json(ledger_root / "operation.json")
labels = {
    "io.syncraft.deployment-id": deployment_id,
    "io.syncraft.operation-id": failed["operationId"],
    "io.syncraft.runtime-epoch": failed["targetEpoch"],
}
store.add("8" * 64, labels)
store.add("9" * 64, labels)
failure = None
try:
    run_once(store)
except module.LauncherError as error:
    failure = error.code
print(json.dumps({
    "failure": failure,
    "operation": read_json(ledger_root / "operation.json"),
    "state": read_json(state_path),
    "successorEpochExists": (ledger_root / "epochs" / "epoch-00000003").exists(),
}))
`);
  assert.equal(result.value.failure, "container_claim_ambiguous");
  assert.equal(result.value.operation.phase, "failed");
  assert.equal(result.value.state.revision, 8);
  assert.equal(result.value.successorEpochExists, false);
});

test("a changed state after sealed failure requires one new recovery transaction", {
  skip: process.platform === "win32"
    ? "Windows sandbox blocks Node child-process proof; root runs the same Python scenario directly"
    : false
}, async t => {
  const result = await runPythonScenario(t, String.raw`
store = Store()
state = state_v2()
seed_current(store, state)
try:
    run_once(store, failure_boundary="epoch-sealed")
except RuntimeError:
    pass
changed = read_json(state_path)
changed["updatedAt"] = "2026-10-23T00:00:09.000Z"
write_json(state_path, changed)
result = run_once(store)
operation = read_json(ledger_root / "operation.json")
current = read_json(ledger_root / "current.json")
print(json.dumps({
    "result": result,
    "operation": operation,
    "current": current,
    "state": read_json(state_path),
    "originalJournalStatus": read_json(ledger_root / "recovery" / f"{transaction_id}.json")["status"],
    "newJournalStatus": read_json(ledger_root / "recovery" / f"{'f' * 64}.json")["status"],
}))
`);
  assert.equal(result.value.operation.succession.mode, "recover-current");
  assert.equal(result.value.operation.succession.sourceTransactionId, transactionId);
  assert.equal(result.value.operation.succession.transactionEpochManifestSha256, null);
  assert.equal(result.value.current.targetEpoch, "epoch-00000003");
  assert.equal(result.value.current.recoveryTransactionId, "f".repeat(64));
  assert.equal(result.value.state.revision, 9);
  assert.equal(result.value.originalJournalStatus, "committed");
  assert.equal(result.value.newJournalStatus, "committed");
});

test("a fresh recovery epoch that fails after sealing retains its own journal binding", {
  skip: process.platform === "win32"
    ? "Windows sandbox blocks Node child-process proof; root runs the same Python scenario directly"
    : false
}, async t => {
  const result = await runPythonScenario(t, String.raw`
store = Store()
state = state_v2()
seed_current(store, state)
try:
    run_once(store, failure_boundary="epoch-sealed")
    raise AssertionError("initial sealed failure was not injected")
except RuntimeError as error:
    assert str(error) == "injected failure at epoch-sealed"
changed = read_json(state_path)
changed["updatedAt"] = "2026-10-23T00:00:09.000Z"
write_json(state_path, changed)
try:
    run_once(store, failure_boundary="epoch-sealed")
    raise AssertionError("fresh recovery sealed failure was not injected")
except RuntimeError as error:
    assert str(error) == "injected failure at epoch-sealed"
fresh_failed = read_json(ledger_root / "operation.json")
fresh_epoch_bytes = (
    ledger_root / "epochs" / fresh_failed["targetEpoch"] / "epoch.json"
).read_bytes()
journal_path = ledger_root / "recovery" / f"{'f' * 64}.json"
journal_bytes = journal_path.read_bytes()
state_bytes = state_path.read_bytes()
result = run_once(store)
operation = read_json(ledger_root / "operation.json")
current = read_json(ledger_root / "current.json")
manifest = read_json(ledger_root / "epochs" / "epoch-00000004" / "epoch.json")
print(json.dumps({
    "result": result,
    "freshFailed": fresh_failed,
    "operation": operation,
    "current": current,
    "manifest": manifest,
    "state": read_json(state_path),
    "stateUnchanged": state_path.read_bytes() == state_bytes,
    "freshEpochUnchanged": (
        ledger_root / "epochs" / fresh_failed["targetEpoch"] / "epoch.json"
    ).read_bytes() == fresh_epoch_bytes,
    "journalUnchanged": journal_path.read_bytes() == journal_bytes,
    "maintenanceCalls": sum(1 for call in store.calls if call[1] == "run"),
}))
`);
  assert.equal(result.value.freshFailed.targetEpoch, "epoch-00000003");
  assert.equal(result.value.freshFailed.succession.mode, "recover-current");
  assert.equal(
    result.value.freshFailed.succession.transactionEpochManifestSha256,
    null
  );
  assert.equal(result.value.current.targetEpoch, "epoch-00000004");
  assert.equal(result.value.current.recoveryTransactionId, "f".repeat(64));
  assert.equal(result.value.operation.phase, "complete");
  assert.equal(result.value.operation.succession.mode, "reuse-after");
  assert.equal(
    result.value.operation.succession.previousTargetEpoch,
    result.value.freshFailed.targetEpoch
  );
  assert.equal(
    result.value.operation.succession.transactionEpochManifestSha256,
    result.value.freshFailed.epochManifestSha256
  );
  assert.equal(
    result.value.manifest.succession.transactionEpochManifestSha256,
    result.value.freshFailed.epochManifestSha256
  );
  assert.equal(result.value.state.revision, 9);
  assert.equal(result.value.stateUnchanged, true);
  assert.equal(result.value.freshEpochUnchanged, true);
  assert.equal(result.value.journalUnchanged, true);
  assert.equal(result.value.maintenanceCalls, 3);
});

test("initial launch uses the same maintenance image to initialize state before the require-existing main container", {
  skip: process.platform === "win32"
    ? "Windows sandbox blocks Node child-process proof; root runs the same Python scenario directly"
    : false
}, async t => {
  const result = await runPythonScenario(t, String.raw`
store = Store()
result = run_once(store)
current = read_json(ledger_root / "current.json")
operation = read_json(ledger_root / "operation.json")
maintenance = next(call for call in store.calls if call[1] == "run")
create = next(call for call in store.calls if call[1] == "create")
config_path = Path(mount_sources(maintenance)["/run/sfsc-maintenance"]["src"]) / "config.json"
maintenance_config = read_json(config_path)
print(json.dumps({
    "result": result,
    "current": current,
    "operation": operation,
    "state": read_json(state_path),
    "maintenance": maintenance,
    "create": create,
    "maintenanceConfig": maintenance_config,
}))
`);
  assert.equal(result.value.state.revision, 0);
  assert.equal(result.value.current.targetEpoch, "epoch-00000001");
  assert.equal(result.value.current.recoveryTransactionId, null);
  assert.equal(result.value.maintenanceConfig.mode, "initialize-if-missing");
  assert.ok(result.value.maintenance.includes("sfsc-appliance:local"));
  assert.ok(result.value.create.includes("SFSC_RUNTIME_ADMISSION_REQUIRED=1"));
  assert.ok(result.value.create.includes(
    `type=bind,src=${result.value.result.runtimeReadyPath.replace(/[\\/]runtime-ready\.json$/, "")},dst=/run/sfsc-runtime,readonly`
  ));
});

test("launcher removes only its exact newly created container when image identity drifts", {
  skip: process.platform === "win32"
    ? "Windows sandbox blocks Node child-process proof; root runs the same Python scenario directly"
    : false
}, async t => {
  const result = await runPythonScenario(t, String.raw`
store = Store()

def drifting_runner(argv, timeout=120):
    result = store.runner(argv, timeout)
    if argv[1] == "create":
        identifier = result.stdout.strip()
        store.containers[identifier]["Image"] = "sha256:" + "f" * 64
    return result

def fail_run():
    return module.run_appliance_once(
        config(),
        runner=drifting_runner,
        read_cgroup=store.cgroup_for_pid,
        read_pid_namespace=lambda pid: "pid:[4026532000]",
        cgroup_closed=store.cgroup_closed,
        sleep=lambda value: None,
    )

failure = None
try:
    fail_run()
except module.LauncherError as error:
    failure = error.code
operation = read_json(ledger_root / "operation.json")
print(json.dumps({
    "failure": failure,
    "operation": operation,
    "containers": store.containers,
    "calls": store.calls,
}))
`);
  assert.equal(result.value.failure, "container_image_mismatch");
  assert.deepEqual(result.value.containers, {});
  assert.equal(result.value.operation.phase, "failed");
  assert.ok(result.value.calls.some(call => call[1] === "stop"));
  assert.ok(result.value.calls.some(call => call[1] === "rm"));
});
