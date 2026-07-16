param(
  [switch]$Apply,
  [string]$RemoteHost = "root@192.168.1.254",
  [string]$RemoteRoot = "/opt/sfsc-test",
  [string]$KeyPath = "C:\Users\Public\Documents\Codex\ssh\codex_n1_admin_20260628_ed25519"
)

$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $PSScriptRoot
$archive = Join-Path $repoRoot ".tmp\sfsc-appliance-source.tgz"
$ssh = "C:\Windows\System32\OpenSSH\ssh.exe"
$scp = "C:\Windows\System32\OpenSSH\scp.exe"

if ($RemoteRoot -notmatch '^/[A-Za-z0-9._/-]+$') {
  throw "RemoteRoot must be a safe absolute POSIX path."
}

$sourcePaths = @(
  "package.json",
  "src",
  "public",
  "server/appliance.Dockerfile",
  "server/sing-box-supervisor.sh",
  "server/install-n1-appliance.sh",
  "server/rootfs",
  "server/systemd",
  "server/sfscctl",
  "server/.env.example"
)

Write-Host "Target: $RemoteHost`:$RemoteRoot"
Write-Host "Runtime data preserved: server/.env, server/data, server/sing-box, /ssd/sfsc-test/minio"
Write-Host "Lifecycle: systemd -> sfsc-appliance + independent sfsc-minio"
if (!$Apply) {
  Write-Host "Dry run only. Pass -Apply to upload, build, install, and verify the appliance."
  exit 0
}

if (!(Test-Path -LiteralPath $KeyPath)) {
  throw "SSH key not found: $KeyPath"
}

New-Item -ItemType Directory -Force (Split-Path -Parent $archive) | Out-Null
Push-Location $repoRoot
try {
  & tar -czf $archive @sourcePaths
  if ($LASTEXITCODE -ne 0) { throw "Failed to build appliance source archive." }
} finally {
  Pop-Location
}

$remoteArchive = "/tmp/sfsc-appliance-source.tgz"
& $scp -i $KeyPath -o IdentitiesOnly=yes $archive "${RemoteHost}:$remoteArchive"
if ($LASTEXITCODE -ne 0) { throw "Failed to upload appliance source archive." }

$remoteScript = @"
set -eu
root='$RemoteRoot'
archive='$remoteArchive'
stage=`$(mktemp -d /tmp/sfsc-appliance-deploy.XXXXXX)
trap 'rm -rf "`$stage"' EXIT INT TERM
tar -xmzf "`$archive" -C "`$stage"
mkdir -p "`$root/.deploy-backups" "`$root/server"
tar -czf "`$root/.deploy-backups/source-before-appliance-`$(date +%Y%m%d-%H%M%S).tgz" \
  --exclude='./server/data' --exclude='./server/sing-box' --exclude='./server/.env' \
  --exclude='./.deploy-backups' --exclude='./node_modules' -C "`$root" .
cp -a "`$stage/src/." "`$root/src/"
cp -a "`$stage/public/." "`$root/public/"
cp -a "`$stage/package.json" "`$root/package.json"
cp -a "`$stage/server/." "`$root/server/"
chmod 0750 "`$root/server/sfscctl" "`$root/server/install-n1-appliance.sh"
chmod 0755 "`$root/server/sing-box-supervisor.sh"
sh "`$root/server/install-n1-appliance.sh"
cd "`$root/server"
./sfscctl health
"@

& $ssh -i $KeyPath -o IdentitiesOnly=yes -o BatchMode=yes $RemoteHost $remoteScript
if ($LASTEXITCODE -ne 0) { throw "N1 appliance deployment failed." }

Write-Host "N1 appliance deployment and health verification passed."
