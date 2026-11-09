import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import test from "node:test";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const installerSource = join(repoRoot, "server", "install-n1-directory-appliance.sh");
const shellAvailable = process.platform !== "win32"
  && spawnSync("sh", ["-n", installerSource], { encoding: "utf8" }).status === 0;

async function fixture(t, { old = { enabled: true, active: true }, directory = { enabled: false, active: false }, mode = "ok" } = {}) {
  const root = await mkdtemp(join(tmpdir(), "sfsc-installer-rollback-"));
  const project = join(root, "project");
  const bin = join(root, "bin");
  const systemd = join(root, "systemd");
  const config = join(root, "config");
  const hostRoot = join(root, "host-shares");
  await Promise.all([
    mkdir(join(project, "server", "sing-box"), { recursive: true }),
    mkdir(join(project, "server", "runtime"), { recursive: true }),
    mkdir(join(project, "server", "systemd"), { recursive: true }),
    mkdir(bin), mkdir(systemd), mkdir(config), mkdir(hostRoot)
  ]);
  await copyFile(installerSource, join(project, "server", "install-n1-directory-appliance.sh"));
  await copyFile(join(repoRoot, "server", "systemd", "sfsc-appliance-directory.service"), join(project, "server", "systemd", "sfsc-appliance-directory.service"));
  await copyFile(join(repoRoot, "server", "systemd", "sfsc-appliance.service"), join(project, "server", "systemd", "sfsc-appliance.service"));
  const fixtureAdminToken = `fixture-${randomBytes(32).toString("hex")}`;
  const adminTokenKey = ["SFSC", "ADMIN", "TOKEN"].join("_");
  await writeFile(join(project, "server", ".env.directory"), ["SFSC_REQUIRE_ADMIN_TOKEN=1", `${adminTokenKey}=${fixtureAdminToken}`, ""].join("\n"));
  await writeFile(join(project, "server", "appliance.Dockerfile"), "FROM busybox\n");
  const launcher = join(project, "server", "runtime", "sfsc-runtime-launcher");
  await writeFile(launcher, "#!/bin/sh\nexit 0\n");
  await chmod(launcher, 0o755);

  const statePath = join(root, "state.json");
  await writeFile(statePath, JSON.stringify({
    old: { ...old }, directory: { ...directory }
  }));
  const fakeCommand = `#!/usr/bin/env node
const { readFileSync, writeFileSync } = require('node:fs');
const { basename, isAbsolute, relative, resolve, sep } = require('node:path');
const name = basename(process.argv[1]);
const args = process.argv.slice(2);
const fixtureRoot = resolve(process.env.FAKE_FIXTURE_ROOT || '');
for (const [key, label] of [['SFSC_ROOT', 'project root'], ['SFSC_SYSTEMD_DIR', 'systemd directory'], ['SFSC_CONFIG_DIR', 'config directory'], ['TMPDIR', 'temporary directory']]) {
  const target = resolve(process.env[key] || '');
  const rel = relative(fixtureRoot, target);
  if (!process.env[key] || rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel)) {
    process.stderr.write(label + ' escaped fake fixture: ' + (process.env[key] || '<missing>') + '\\n');
    process.exit(97);
  }
}
if (name === 'docker') process.exit(process.env.FAKE_MODE === 'build-fail' ? 41 : 0);
if (name === 'curl') {
  if (process.env.FAKE_MODE === 'wait-fail') process.exit(0);
  const url = args.at(-1) || '';
  process.stdout.write(url.endsWith('/api/health')
    ? JSON.stringify({ ok: true, adminAuth: { enabled: true } })
    : JSON.stringify({ ok: true, checks: { node: { ok: true }, storage: { mode: 'directory', dataWritable: true, directoryRootWritable: true } } }));
  process.exit(0);
}
const statePath = process.env.FAKE_STATE_PATH;
const state = JSON.parse(readFileSync(statePath, 'utf8'));
const unitArg = args.find(value => value.startsWith('sfsc-appliance'));
const key = unitArg === 'sfsc-appliance.service' ? 'old' : 'directory';
const action = args[0];
if (action === 'is-enabled' || action === 'is-active') {
  const ok = state[key][action === 'is-enabled' ? 'enabled' : 'active'];
  if (!args.includes('--quiet')) process.stdout.write(ok ? 'enabled\\n' : 'disabled\\n');
  process.exit(ok ? 0 : 1);
}
if (action === 'disable' || action === 'enable') {
  const turnOn = action === 'enable';
  state[key].enabled = turnOn;
  if (args.includes('--now')) state[key].active = turnOn;
  writeFileSync(statePath, JSON.stringify(state));
if (action === 'enable' && args.includes('--now') && key === 'directory' && ['enable-fail', 'external-fail'].includes(process.env.FAKE_MODE)) {
  if (process.env.FAKE_MODE === 'external-fail') {
    writeFileSync(process.env.FAKE_DIRECTORY_ENV, 'EXTERNAL_CHANGE=keep\\n');
    writeFileSync(process.env.FAKE_DIRECTORY_UNIT, '# external unit change\\n');
  }
  process.exit(42);
}
  process.exit(0);
}
if (action === 'start' || action === 'stop') {
  state[key].active = action === 'start';
  writeFileSync(statePath, JSON.stringify(state));
  process.exit(0);
}
if (action === 'status' || action === 'daemon-reload') process.exit(0);
process.exit(2);
`;
  for (const name of ["docker", "curl", "systemctl"]) {
    const path = join(bin, name);
    await writeFile(path, fakeCommand);
    await chmod(path, 0o755);
  }
  const directoryEnvPath = join(config, "sfsc-directory.env");
  const directoryUnitPath = join(systemd, "sfsc-appliance-directory.service");
  const oldUnitPath = join(systemd, "sfsc-appliance.service");
  const oldEnvBytes = Buffer.from("OLD_DIRECTORY_ROOT=preserve-exactly\n");
  const oldDirectoryUnitBytes = Buffer.from("# old directory unit exact bytes\n");
  if (old.enabled || old.active) await copyFile(join(project, "server", "systemd", "sfsc-appliance.service"), oldUnitPath);
  if (directory.enabled || directory.active) await writeFile(directoryUnitPath, oldDirectoryUnitBytes);
  else if (mode !== "first-install") await writeFile(directoryUnitPath, oldDirectoryUnitBytes);
  if (mode !== "first-install") await writeFile(directoryEnvPath, oldEnvBytes);
  t.after(() => rm(root, { recursive: true, force: true }));
  return {
    root, project, bin, systemd, config, hostRoot, statePath,
    directoryEnvPath, directoryUnitPath, oldUnitPath,
    oldEnvBytes, oldDirectoryUnitBytes, mode
  };
}

async function runInstaller(f, { args = [], mode = f.mode } = {}) {
  const child = spawn("sh", [join(f.project, "server", "install-n1-directory-appliance.sh"), ...args, f.hostRoot], {
    cwd: f.project, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      PATH: `${f.bin}:${process.env.PATH}`,
      SFSC_ROOT: f.project,
      SFSC_SYSTEMD_DIR: f.systemd,
      SFSC_CONFIG_DIR: f.config,
      TMPDIR: f.root,
      FAKE_FIXTURE_ROOT: f.root,
      SFSC_DIRECTORY_STARTUP_ATTEMPTS: "1",
      FAKE_STATE_PATH: f.statePath,
      FAKE_DIRECTORY_ENV: f.directoryEnvPath,
      FAKE_DIRECTORY_UNIT: f.directoryUnitPath,
      FAKE_MODE: mode
    }
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", chunk => { stdout += chunk; });
  child.stderr.on("data", chunk => { stderr += chunk; });
  const [code, signal] = await once(child, "exit");
  return { code, signal, stdout, stderr };
}

async function state(f) { return JSON.parse(await readFile(f.statePath, "utf8")); }

test("directory installer shell syntax is valid", { skip: !shellAvailable }, async () => {
  const result = spawnSync("sh", ["-n", installerSource], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
});

test("directory installer build failure leaves previous service and target bytes unchanged", { skip: !shellAvailable }, async t => {
  const f = await fixture(t);
  const result = await runInstaller(f, { args: ["--replace-active-appliance", "--replace-directory-root"], mode: "build-fail" });
  assert.equal(result.code, 41, `${result.stdout}\n${result.stderr}`);
  assert.deepEqual(await state(f), { old: { enabled: true, active: true }, directory: { enabled: false, active: false } });
  assert.deepEqual(await readFile(f.directoryEnvPath), f.oldEnvBytes);
  assert.deepEqual(await readFile(f.directoryUnitPath), f.oldDirectoryUnitBytes);
  assert.deepEqual(await readFile(f.oldUnitPath), await readFile(join(f.project, "server", "systemd", "sfsc-appliance.service")));
});

test("directory installer restores previous states and exact unit/environment bytes after partial enable failure", { skip: !shellAvailable }, async t => {
  const f = await fixture(t);
  const result = await runInstaller(f, { args: ["--replace-active-appliance", "--replace-directory-root"], mode: "enable-fail" });
  assert.notEqual(result.code, 0);
  assert.match(`${result.stdout}\n${result.stderr}`, /prior appliance unit state and owned unit\/environment files were restored/);
  assert.deepEqual(await state(f), { old: { enabled: true, active: true }, directory: { enabled: false, active: false } });
  assert.deepEqual(await readFile(f.directoryEnvPath), f.oldEnvBytes);
  assert.deepEqual(await readFile(f.directoryUnitPath), f.oldDirectoryUnitBytes);
});

test("directory installer restores prior appliance after startup evidence timeout", { skip: !shellAvailable }, async t => {
  const f = await fixture(t);
  const result = await runInstaller(f, { args: ["--replace-active-appliance", "--replace-directory-root"], mode: "wait-fail" });
  assert.notEqual(result.code, 0);
  assert.match(`${result.stdout}\n${result.stderr}`, /prior appliance unit state and owned unit\/environment files were restored/);
  assert.deepEqual(await state(f), { old: { enabled: true, active: true }, directory: { enabled: false, active: false } });
  assert.deepEqual(await readFile(f.directoryEnvPath), f.oldEnvBytes);
  assert.deepEqual(await readFile(f.directoryUnitPath), f.oldDirectoryUnitBytes);
});

test("first directory install failure stops its unit and removes only its new unit/environment", { skip: !shellAvailable }, async t => {
  const f = await fixture(t, { old: { enabled: false, active: false }, directory: { enabled: false, active: false }, mode: "first-install" });
  const result = await runInstaller(f, { mode: "enable-fail" });
  assert.notEqual(result.code, 0);
  assert.match(`${result.stdout}\n${result.stderr}`, /prior appliance unit state and owned unit\/environment files were restored/);
  assert.deepEqual(await state(f), { old: { enabled: false, active: false }, directory: { enabled: false, active: false } });
  assert.equal(await readFile(f.directoryEnvPath).then(() => true, () => false), false);
  assert.equal(await readFile(f.directoryUnitPath).then(() => true, () => false), false);
  assert.equal(await readFile(f.oldUnitPath).then(() => true, () => false), false);
});

test("successful directory install commits the new unit without rollback", { skip: !shellAvailable }, async t => {
  const f = await fixture(t);
  const result = await runInstaller(f, { args: ["--replace-active-appliance", "--replace-directory-root"] });
  assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);
  assert.deepEqual(await state(f), { old: { enabled: false, active: false }, directory: { enabled: true, active: true } });
  assert.match(await readFile(f.directoryEnvPath, "utf8"), /SFSC_DIRECTORY_HOST_ROOT=/);
  assert.deepEqual(await readFile(f.directoryUnitPath), await readFile(join(f.project, "server", "systemd", "sfsc-appliance-directory.service")));
});

test("rollback refuses to overwrite unit or environment bytes changed externally", { skip: !shellAvailable }, async t => {
  const f = await fixture(t);
  const result = await runInstaller(f, { args: ["--replace-active-appliance", "--replace-directory-root"], mode: "external-fail" });
  assert.notEqual(result.code, 0);
  assert.match(`${result.stdout}\n${result.stderr}`, /did not overwrite .* because its bytes changed after this installer wrote it/);
  assert.match(`${result.stdout}\n${result.stderr}`, /Installer rollback was incomplete/);
  assert.equal(await readFile(f.directoryEnvPath, "utf8"), "EXTERNAL_CHANGE=keep\n");
  assert.equal(await readFile(f.directoryUnitPath, "utf8"), "# external unit change\n");
  assert.deepEqual(await state(f), { old: { enabled: true, active: true }, directory: { enabled: false, active: false } });
});
