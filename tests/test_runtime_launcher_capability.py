import importlib.util
import json
import sys
import tempfile
import unittest
from importlib.machinery import SourceFileLoader
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch


PROJECT_ROOT = Path(__file__).resolve().parents[1]
LAUNCHER_PATH = PROJECT_ROOT / "server/runtime/sfsc-runtime-launcher"
sys.path.insert(0, str(LAUNCHER_PATH.parent))
SPEC = importlib.util.spec_from_loader(
    "sfsc_runtime_launcher_capability_test",
    SourceFileLoader("sfsc_runtime_launcher_capability_test", str(LAUNCHER_PATH)),
)
LAUNCHER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(LAUNCHER)


class RuntimeLauncherCapabilityTests(unittest.TestCase):
    def test_appliance_create_gets_only_linux_immutable_and_maintenance_stays_dropped(self):
        with tempfile.TemporaryDirectory(prefix="sfsc-launcher-capability-") as temp:
            root = Path(temp)
            ledger_root = root / "ledger"
            container_id = "a" * 64
            operation = {
                "containerId": None,
                "cidFile": str(root / "operations/op.cid"),
                "deploymentId": "capability-test",
                "operationId": "b" * 64,
                "targetEpoch": "epoch-00000001",
                "bootstrapNonce": "c" * 48,
                "phase": "intent",
                "imageDigest": "sha256:" + "d" * 64,
            }
            labels = {
                "io.syncraft.deployment-id": operation["deploymentId"],
                "io.syncraft.operation-id": operation["operationId"],
                "io.syncraft.runtime-epoch": operation["targetEpoch"],
            }
            record = {
                "Id": container_id,
                "Image": operation["imageDigest"],
                "Config": {"Labels": labels},
                "State": {"CgroupPath": f"/system.slice/docker-{container_id}.scope"},
            }
            calls = []

            def runner(argv, timeout=120):
                calls.append(list(argv))
                if argv[1] == "ps":
                    return SimpleNamespace(returncode=0, stdout="", stderr="")
                if argv[1] == "create":
                    return SimpleNamespace(returncode=0, stdout=container_id + "\n", stderr="")
                if argv[1] == "inspect":
                    return SimpleNamespace(returncode=0, stdout=json.dumps([record]), stderr="")
                if argv[1] == "run":
                    return SimpleNamespace(returncode=0, stdout="", stderr="")
                raise AssertionError(argv)

            def advance(_path, value, phase, **changes):
                return {**value, **changes, "phase": phase}

            def local_atomic_write(path, data, _mode, *, overwrite=True):
                path = Path(path)
                path.parent.mkdir(parents=True, exist_ok=True)
                if path.exists() and not overwrite:
                    raise FileExistsError(path)
                path.write_bytes(data)

            with patch.object(LAUNCHER, "ensure_private_directory", side_effect=lambda path, **_: Path(path).mkdir(parents=True, exist_ok=True)), \
                    patch.object(LAUNCHER, "_find_exact_operation_container", return_value=None), \
                    patch.object(LAUNCHER, "advance_operation", side_effect=advance), \
                    patch.object(LAUNCHER, "atomic_write", side_effect=local_atomic_write), \
                    patch.object(LAUNCHER, "_validate_maintenance_result", return_value={"_rawSha256": "a" * 64}), \
                    patch.object(LAUNCHER, "_crash"):
                LAUNCHER._ensure_container(
                    root / "operation.json",
                    operation,
                    ledger_root=ledger_root,
                    runner=runner,
                    docker="docker",
                    image="sfsc-appliance:test",
                    volumes=[],
                    env_files=[],
                    environment=[],
                    crash_hook=None,
                )

                maintenance_operation = {
                    "operationId": "f" * 64,
                    "deploymentId": "capability-test",
                    "targetEpoch": "epoch-00000002",
                    "phase": "intent",
                    "previousContainerId": None,
                    "createdFromEpoch": "initial",
                    "closureProofSha256": "e" * 64,
                    "previousHistoryClosureSha256": "0" * 64,
                    "succession": None,
                }

                LAUNCHER._run_maintenance(
                    ledger_root=ledger_root,
                    state_path=root / "data/relation-services.json",
                    operation_path=root / "operation.json",
                    operation=maintenance_operation,
                    runner=runner,
                    docker="docker",
                    image="sfsc-appliance:test",
                    crash_hook=None,
                    allow_non_root=True,
                )

            create = next(call for call in calls if call[1] == "create")
            maintenance = next(call for call in calls if call[1] == "run")
            self.assertEqual(create[create.index("--cap-add") + 1], "LINUX_IMMUTABLE")
            self.assertNotIn("--cap-drop", create)
            self.assertEqual(maintenance[maintenance.index("--cap-drop") + 1], "ALL")
            self.assertNotIn("--cap-add", maintenance)


if __name__ == "__main__":
    unittest.main()
