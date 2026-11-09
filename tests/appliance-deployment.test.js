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
  assert.match(dockerfile, /COPY server\/runtime \.\/server\/runtime/);
  assert.match(dockerfile, /sfsc-node\/finish/);
  assert.match(
    dockerfile,
    /\/app\/server\/runtime\/native\/linux-arm64\/relation\/sfsc-relation-supervisor/
  );
  assert.match(
    dockerfile,
    /\/app\/server\/runtime\/native\/linux-arm64\/relation\/sfsc-root-guard/
  );
  assert.match(dockerfile, /HEALTHCHECK[\s\S]*\/healthz/);
  assert.match(nodeService, /node \/app\/src\/server\.js/);
  assert.match(nodeService, /SFSC_INSTANCE_ID/);
  assert.match(singboxService, /sfsc-sing-box-supervisor/);
});

test("systemd owns appliance and independent MinIO lifecycles without Compose", async () => {
  const applianceUnit = await read("server/systemd/sfsc-appliance.service");
  const minioUnit = await read("server/systemd/sfsc-minio.service");
  const launcher = await read("server/runtime/sfsc-runtime-launcher");
  const finish = await read("server/rootfs/etc/s6-overlay/s6-rc.d/sfsc-node/finish");

  assert.match(applianceUnit, /ExecStart=.*sfsc-runtime-launcher/);
  assert.match(applianceUnit, /--ledger-root \/var\/lib\/sfsc-runtime/);
  assert.match(applianceUnit, /--env-file \/opt\/sfsc-test\/server\/\.env/);
  assert.match(applianceUnit, /Requires=docker\.service sfsc-minio\.service/);
  assert.match(applianceUnit, /sfsc-appliance:local/);
  assert.doesNotMatch(applianceUnit, /docker run --name sfsc-appliance/);
  assert.doesNotMatch(applianceUnit, /docker compose/);
  assert.match(launcher, /serial_launcher_lock/);
  assert.match(launcher, /dst=\/run\/sfsc-runtime,readonly/);
  assert.match(finish, /exec \/run\/s6\/basedir\/bin\/halt/);
  assert.doesNotMatch(finish, /s6-svscanctl/);
  assert.doesNotMatch(finish, /kill -TERM 1/);
  assert.match(minioUnit, /docker run --name singbox-folder-sync-minio/);
  assert.match(minioUnit, /\/ssd\/sfsc-test\/minio:\/data/);
  assert.doesNotMatch(minioUnit, /sfsc-appliance/);
});

test("ordinary-directory N1 unit reuses runtime state without a MinIO dependency", async () => {
  const unit = await read("server/systemd/sfsc-appliance-directory.service");
  const installer = await read("server/install-n1-directory-appliance.sh");
  const envExample = await read("server/.env.directory.example");
  const directoryEnv = await read("server/systemd/sfsc-directory.env.example");
  const launcher = await read("server/runtime/sfsc-runtime-launcher");
  const deployment = await read("server/DEPLOYMENT.md");

  assert.match(unit, /Requires=docker\.service/);
  assert.doesNotMatch(unit, /sfsc-minio\.service/);
  assert.match(unit, /sfsc-runtime-launcher/);
  assert.match(unit, /--ledger-root \/var\/lib\/sfsc-runtime/);
  assert.match(unit, /--state-path \$\{SFSC_ROOT\}\/server\/data\/app\/relation-services\.json/);
  assert.match(unit, /SFSC_STORAGE_MODE=directory/);
  assert.match(unit, /SFSC_DIRECTORY_ROOT=\/srv\/syncraft\/shared/);
  assert.match(unit, /dst=\/srv\/syncraft\/shared/);
  assert.doesNotMatch(unit, /dst=\/srv\/syncraft\/shared,rw/);
  assert.match(launcher, /--cap-add", "LINUX_IMMUTABLE"/);
  assert.match(installer, /realpath\(sys\.argv\[1\], strict=True\)/);
  assert.match(installer, /--replace-active-appliance/);
  assert.doesNotMatch(installer, /systemctl disable --now sfsc-minio\.service/);
  assert.match(installer, /directoryRootWritable/);
  assert.match(installer, /fullHealthzOk/);
  assert.match(envExample, /SFSC_REQUIRE_ADMIN_TOKEN=1/);
  assert.doesNotMatch(envExample, /MINIO_ROOT_PASSWORD|S3_SECRET_ACCESS_KEY/);
  assert.match(directoryEnv, /SFSC_DIRECTORY_HOST_ROOT=/);
  assert.match(deployment, /首次两码接入/);
  assert.match(deployment, /回滚到旧 S3\/MinIO appliance/);
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

test("Compose probes sing-box through the network boundary it actually uses", async () => {
  const compose = await read("server/docker-compose.yml");
  const n1Compose = await read("server/docker-compose.n1.yml");
  const composeServer = compose.slice(compose.indexOf("  sync-server:"), compose.indexOf("\n  caddy:"));
  const n1ComposeServer = n1Compose.slice(n1Compose.indexOf("  sync-server:"), n1Compose.indexOf("\n  sing-box:"));

  assert.match(composeServer, /SINGBOX_PROBE_HOST:\s*sing-box/);
  assert.ok(composeServer.includes('VLESS_LISTEN_PORT: ${VLESS_PORT:-45678}'));
  assert.match(n1ComposeServer, /SINGBOX_PROBE_HOST:\s*host\.docker\.internal/);
  assert.ok(n1ComposeServer.includes('VLESS_LISTEN_PORT: ${VLESS_PORT:-45679}'));
  assert.match(n1ComposeServer, /host\.docker\.internal:host-gateway/);
});

function read(path) {
  return readFile(join(root, path), "utf8");
}
