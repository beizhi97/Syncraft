import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));

test("appliance image bundles Node, sing-box, rclone, and s6 services", async () => {
  const dockerfile = await read("server/appliance.Dockerfile");
  const nodeService = await read("server/rootfs/etc/s6-overlay/s6-rc.d/sfsc-node/run");
  const singboxService = await read("server/rootfs/etc/s6-overlay/s6-rc.d/sfsc-singbox/run");

  assert.match(dockerfile, /baseimage-alpine/);
  assert.match(dockerfile, /COPY --from=singbox .*sing-box/);
  assert.match(dockerfile, /COPY --from=rclone .*rclone/);
  assert.match(dockerfile, /HEALTHCHECK[\s\S]*\/healthz/);
  assert.match(nodeService, /node \/app\/src\/server\.js/);
  assert.match(nodeService, /SFSC_INSTANCE_ID/);
  assert.match(singboxService, /sfsc-sing-box-supervisor/);
});

test("systemd owns appliance and independent MinIO lifecycles without Compose", async () => {
  const applianceUnit = await read("server/systemd/sfsc-appliance.service");
  const minioUnit = await read("server/systemd/sfsc-minio.service");

  assert.match(applianceUnit, /docker run --name sfsc-appliance/);
  assert.match(applianceUnit, /Requires=docker\.service sfsc-minio\.service/);
  assert.match(applianceUnit, /sfsc-appliance:local/);
  assert.doesNotMatch(applianceUnit, /docker compose/);
  assert.match(minioUnit, /docker run --name singbox-folder-sync-minio/);
  assert.match(minioUnit, /\/ssd\/sfsc-test\/minio:\/data/);
  assert.doesNotMatch(minioUnit, /sfsc-appliance/);
});

test("N1 installer enables both units and gates appliance on unified health", async () => {
  const installer = await read("server/install-n1-appliance.sh");
  assert.match(installer, /systemctl enable --now sfsc-minio\.service/);
  assert.match(installer, /systemctl enable --now sfsc-appliance\.service/);
  assert.match(installer, /127\.0\.0\.1:5177\/healthz/);
});

test("operator CLI automatically uses the appliance systemd lifecycle", async () => {
  const cli = await read("server/sfscctl");
  assert.match(cli, /SFSC_RUNTIME:-auto/);
  assert.match(cli, /systemctl is-active/);
  assert.match(cli, /\/healthz/);
  assert.match(cli, /install-n1-appliance\.sh/);
});

test("the default N1 deployment command targets the appliance", async () => {
  const packageJson = JSON.parse(await read("package.json"));
  const deployer = await read("scripts/deploy-n1-appliance.ps1");
  assert.match(packageJson.scripts["deploy:n1"], /deploy-n1-appliance\.ps1/);
  assert.match(packageJson.scripts["deploy:n1:legacy"], /deploy-n1\.ps1/);
  assert.match(deployer, /install-n1-appliance\.sh/);
  assert.match(deployer, /\.\/sfscctl health/);
});

function read(path) {
  return readFile(join(root, path), "utf8");
}
