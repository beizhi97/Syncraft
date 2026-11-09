param(
  [switch]$Apply,
  [switch]$BuildArchive,
  [switch]$PostDeploySmoke,
  [switch]$ExerciseClaimLifecycle,
  [switch]$CleanupClaimLifecycle,
  [switch]$RollbackLatest,
  [string]$RemoteHost = "root@192.168.1.254",
  [string]$KeyPath = "C:\Users\Public\Documents\Codex\ssh\codex_n1_admin_20260628_ed25519",
  [string]$RemoteRoot = "/opt/sfsc-test",
  [string]$SmokeBaseUrl = "http://192.168.1.254:5177",
  [switch]$AllowMismatchedSmokeBaseUrl,
  [string]$ReportPath = "",
  [string]$JsonReportPath = "",
  [string]$SmokeJsonReportPath = "",
  [string]$ArchiveRoot = ""
)

$ErrorActionPreference = "Stop"

if ($CleanupClaimLifecycle -and !$ExerciseClaimLifecycle) {
  throw "-CleanupClaimLifecycle requires -ExerciseClaimLifecycle."
}

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
. (Join-Path $PSScriptRoot "lib\report-secrets.ps1")
. (Join-Path $PSScriptRoot "lib\build-fingerprint.ps1")
$sourceFingerprint = Get-SourceTreeFingerprint $repoRoot
$sourceTreeHash = "$($sourceFingerprint.hash)"
$sourceBuildId = "$($sourceFingerprint.buildId)"
$sourceBuildTime = (Get-Date).ToUniversalTime().ToString("o")
$repoRootFull = [System.IO.Path]::GetFullPath("$repoRoot")
$repoRootPrefix = $repoRootFull.TrimEnd([System.IO.Path]::DirectorySeparatorChar, [System.IO.Path]::AltDirectorySeparatorChar) + [System.IO.Path]::DirectorySeparatorChar
$requestedArchiveDir = if ($ArchiveRoot) {
  if ([System.IO.Path]::IsPathRooted($ArchiveRoot)) { $ArchiveRoot } else { Join-Path $repoRootFull $ArchiveRoot }
} else {
  Join-Path $repoRootFull ".tmp\n1-deploy"
}
$archiveDir = [System.IO.Path]::GetFullPath($requestedArchiveDir)
if (!$archiveDir.StartsWith($repoRootPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
  throw "Refusing to write N1 source archive outside project root: $archiveDir"
}
$archivePath = Join-Path $archiveDir "sfsc-server-source.tgz"
$remoteArchive = "/tmp/sfsc-server-source.tgz"
$remoteStage = "/tmp/sfsc-server-source"
$node = $env:SFSC_NODE
if (!$node) {
  $nodeCommand = Get-Command node -ErrorAction SilentlyContinue
  if ($nodeCommand) {
    $node = $nodeCommand.Source
  }
}
if (!$node) {
  $bundledNode = Join-Path $env:USERPROFILE ".cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
  if (Test-Path -LiteralPath $bundledNode) {
    $node = $bundledNode
  }
}

$targetAlignment = $null
$deployFailure = $null

function Info($message) {
  Write-Host "[sfsc-n1] $message"
}

$stepResults = @()

function Get-StepErrorCode($name, $status) {
  if ($status -eq "passed") {
    return ""
  }
  $slug = ($name.ToLowerInvariant() -replace '[^a-z0-9]+', '_').Trim('_')
  if (!$slug) {
    $slug = "step"
  }
  return "deploy_n1_${slug}_failed"
}

function Add-StepResult($name, $status, $duration, $detail) {
  $script:stepResults += [pscustomobject]@{
    Name = $name
    Status = $status
    ErrorCode = Get-StepErrorCode $name $status
    DurationSeconds = [math]::Round($duration.TotalSeconds, 2)
    Detail = $detail
  }
}

function Run-Step($name, $script) {
  Info $name
  $timer = [System.Diagnostics.Stopwatch]::StartNew()
  try {
    $global:LASTEXITCODE = 0
    & $script
    if ($null -ne $LASTEXITCODE -and $LASTEXITCODE -ne 0) {
      throw "exit code $LASTEXITCODE"
    }
    $timer.Stop()
    Add-StepResult $name "passed" $timer.Elapsed ""
  } catch {
    $timer.Stop()
    Add-StepResult $name "failed" $timer.Elapsed $_.Exception.Message
    throw "N1 deploy step failed: $name ($($_.Exception.Message))"
  }
}

function Resolve-ReportPath($path) {
  if ([System.IO.Path]::IsPathRooted($path)) {
    return $path
  }
  return Join-Path $repoRoot $path
}

function Resolve-SmokeJsonReportPath {
  if ($SmokeJsonReportPath) {
    return Resolve-ReportPath $SmokeJsonReportPath
  }
  if ($JsonReportPath) {
    $resolvedJsonReportPath = Resolve-ReportPath $JsonReportPath
    $reportDir = Split-Path -Parent $resolvedJsonReportPath
    if (!$reportDir) {
      $reportDir = "$repoRoot"
    }
    return Join-Path $reportDir "server-smoke.json"
  }
  return ""
}

function Get-DeployContext {
  $context = [ordered]@{
    GeneratedAt = (Get-Date).ToUniversalTime().ToString("o")
    RepoRoot = "$repoRoot"
    RemoteHost = $RemoteHost
    RemoteRoot = $RemoteRoot
    Apply = [bool]$Apply
    BuildArchive = [bool]$BuildArchive
    PostDeploySmoke = [bool]$PostDeploySmoke
    ExerciseClaimLifecycle = [bool]$ExerciseClaimLifecycle
    CleanupClaimLifecycle = [bool]$CleanupClaimLifecycle
    RollbackLatest = [bool]$RollbackLatest
    ArchivePath = $archivePath
    RemoteArchive = $remoteArchive
    RemoteStage = $remoteStage
    SmokeBaseUrl = $SmokeBaseUrl
    AllowMismatchedSmokeBaseUrl = [bool]$AllowMismatchedSmokeBaseUrl
    SourceTreeHash = $sourceTreeHash
    BuildId = $sourceBuildId
    BuildTime = $sourceBuildTime
  }
  if ($targetAlignment) {
    $context.RemoteHostName = "$($targetAlignment.remoteHostName)"
    $context.SmokeBaseUrlHost = "$($targetAlignment.smokeBaseUrlHost)"
    $context.TargetHostsMatch = [bool]$targetAlignment.targetHostsMatch
  }
  if ($node) {
    $context.Node = "$node"
  }
  if ($ReportPath) {
    $context.ReportPath = "$(Resolve-ReportPath $ReportPath)"
  }
  if ($JsonReportPath) {
    $context.JsonReportPath = "$(Resolve-ReportPath $JsonReportPath)"
  }
  if ($PostDeploySmoke -or $SmokeJsonReportPath) {
    $context.SmokeJsonReportPath = "$(Resolve-SmokeJsonReportPath)"
  }
  return [pscustomobject]$context
}

function Write-DeployReport {
  if ($stepResults.Count -eq 0) {
    return
  }
  $context = Get-DeployContext
  $summary = [ordered]@{
    passed = @($stepResults | Where-Object { $_.Status -eq "passed" }).Count
    failed = @($stepResults | Where-Object { $_.Status -eq "failed" }).Count
  }
  $lines = @()
  $lines += "N1 deploy report:"
  $lines += "  GeneratedAt: $($context.GeneratedAt)"
  $lines += "  RepoRoot: $($context.RepoRoot)"
  $lines += "  RemoteHost: $($context.RemoteHost)"
  $lines += "  RemoteRoot: $($context.RemoteRoot)"
  $lines += "  Apply: $($context.Apply)"
  $lines += "  BuildArchive: $($context.BuildArchive)"
  $lines += "  PostDeploySmoke: $($context.PostDeploySmoke)"
  $lines += "  ExerciseClaimLifecycle: $($context.ExerciseClaimLifecycle)"
  $lines += "  CleanupClaimLifecycle: $($context.CleanupClaimLifecycle)"
  $lines += "  SmokeBaseUrl: $($context.SmokeBaseUrl)"
  $lines += "  SourceTreeHash: $($context.SourceTreeHash)"
  $lines += "  BuildId: $($context.BuildId)"
  $lines += "  BuildTime: $($context.BuildTime)"
  if ($context.PSObject.Properties.Name.Contains("TargetHostsMatch")) {
    $lines += "  TargetHostsMatch: $($context.TargetHostsMatch)"
  }
  if ($ReportPath) {
    $lines += "  ReportPath: $($context.ReportPath)"
  }
  if ($JsonReportPath) {
    $lines += "  JsonReportPath: $($context.JsonReportPath)"
  }
  if ($context.PSObject.Properties.Name.Contains("SmokeJsonReportPath") -and $context.SmokeJsonReportPath) {
    $lines += "  SmokeJsonReportPath: $($context.SmokeJsonReportPath)"
  }
  foreach ($result in $stepResults) {
    $line = "  - $($result.Status): $($result.Name) ($($result.DurationSeconds)s)"
    if ($result.Detail) {
      $line = "$line - $($result.Detail)"
    }
    $lines += $line
  }
  foreach ($line in $lines) {
    Info $line
  }
  if ($ReportPath) {
    $resolvedReportPath = Resolve-ReportPath $ReportPath
    $reportDir = Split-Path -Parent $resolvedReportPath
    if ($reportDir) {
      New-Item -ItemType Directory -Force -Path $reportDir | Out-Null
    }
    Write-SafeTextReport $resolvedReportPath $lines "N1 deploy text report"
    Info "N1 deploy report written: $resolvedReportPath"
  }
  if ($JsonReportPath) {
    $resolvedJsonReportPath = Resolve-ReportPath $JsonReportPath
    $reportDir = Split-Path -Parent $resolvedJsonReportPath
    if ($reportDir) {
      New-Item -ItemType Directory -Force -Path $reportDir | Out-Null
    }
    $steps = @($stepResults | ForEach-Object {
      [pscustomobject]@{
        name = $_.Name
        status = $_.Status
        errorCode = $_.ErrorCode
        durationSeconds = $_.DurationSeconds
        detail = $_.Detail
      }
    })
    $payload = [ordered]@{
      schemaVersion = 1
      app = "singbox-folder-sync"
      type = "n1-deploy-report"
      ok = ($summary.failed -eq 0)
      context = $context
      summary = $summary
      steps = $steps
    }
    Write-SafeJsonReport $resolvedJsonReportPath $payload "N1 deploy JSON report" 6
    Info "N1 deploy JSON report written: $resolvedJsonReportPath"
  }
}

function Require-Tool($name) {
  if (-not (Get-Command $name -ErrorAction SilentlyContinue)) {
    throw "Required tool not found: $name"
  }
}

function Normalize-TargetHost($targetHost) {
  return "$targetHost".Trim().Trim([char[]]@('[', ']')).ToLowerInvariant()
}

function Get-RemoteHostName {
  $target = "$RemoteHost".Trim()
  if (!$target) {
    throw "RemoteHost must not be empty."
  }
  $atIndex = $target.LastIndexOf("@")
  if ($atIndex -ge 0) {
    $target = $target.Substring($atIndex + 1)
  }
  if ($target.StartsWith("[") -and $target.Contains("]")) {
    return (Normalize-TargetHost ($target.Substring(1, $target.IndexOf("]") - 1)))
  }
  if (([regex]::Matches($target, ":")).Count -eq 1) {
    $target = $target.Split(":")[0]
  }
  return (Normalize-TargetHost $target)
}

function Get-SmokeBaseUrlHost {
  try {
    $uri = [System.Uri]$SmokeBaseUrl
    if (!$uri.Host) {
      throw "missing host"
    }
    return (Normalize-TargetHost $uri.DnsSafeHost)
  } catch {
    throw "SmokeBaseUrl must be a valid URL with a host."
  }
}

function Get-TargetAlignment {
  $remoteHostName = Get-RemoteHostName
  $smokeBaseUrlHost = Get-SmokeBaseUrlHost
  return [ordered]@{
    remoteHostName = $remoteHostName
    smokeBaseUrlHost = $smokeBaseUrlHost
    targetHostsMatch = ($remoteHostName -eq $smokeBaseUrlHost)
  }
}

function Assert-RemoteRootSafe {
  if (!("$RemoteRoot" -match '^/[A-Za-z0-9._/-]+$')) {
    throw "RemoteRoot must be an absolute POSIX path containing only letters, numbers, '.', '_', '-', and '/'."
  }
}

function Assert-DeployTargets {
  $script:targetAlignment = Get-TargetAlignment
  if ($Apply -and $PostDeploySmoke -and !$script:targetAlignment.targetHostsMatch -and !$AllowMismatchedSmokeBaseUrl) {
    throw "RemoteHost and SmokeBaseUrl must point to the same host. Use -AllowMismatchedSmokeBaseUrl only for an intentional split-target test."
  }
}

function Show-Plan {
  Assert-RemoteRootSafe
  Assert-DeployTargets
  Info "Target: ${RemoteHost}:$RemoteRoot"
  Info "RemoteHost target: $($targetAlignment.remoteHostName); SmokeBaseUrl target: $($targetAlignment.smokeBaseUrlHost)"
  if ($RollbackLatest) {
    Info "Mode: rollback dry-run. Pass -Apply -RollbackLatest to restore the latest .deploy-backups/source-before-*.tgz backup and run the deploy health check."
  } else {
    Info "Mode: dry-run. Pass -BuildArchive to validate the local source archive, or -Apply to upload source, rebuild sync-server, and run the deploy health check."
  }
  Info "Preserved remote runtime paths:"
  Info "  $RemoteRoot/server/.env"
  Info "  $RemoteRoot/server/data"
  Info "  $RemoteRoot/server/sing-box"
  Info "Source paths to deploy:"
  Info "  package.json"
  Info "  src/"
  Info "  public/"
  Info "  server/Dockerfile"
  Info "  server/sing-box.Dockerfile"
  Info "  server/sing-box-supervisor.sh"
  Info "  server/.env.example"
  Info "  server/Caddyfile"
  Info "  server/sfscctl"
  Info "  server/docker-compose.yml"
  Info "  server/docker-compose.n1.yml"
  Info "  scripts/smoke-server.mjs"
  Info "  scripts/lib/runtimeContracts.mjs"
}

function New-SourceArchive {
  Require-Tool "tar"
  New-Item -ItemType Directory -Force -Path $archiveDir | Out-Null
  if (Test-Path -LiteralPath $archivePath) {
    Remove-Item -LiteralPath $archivePath -Force
  }
  Push-Location $repoRoot
  try {
    tar -czf $archivePath `
      --exclude=__pycache__ `
      --exclude=*/__pycache__ `
      --exclude=*.pyc `
      --exclude=*.pyo `
      package.json `
      src `
      public `
      server/Dockerfile `
      server/sing-box.Dockerfile `
      server/sing-box-supervisor.sh `
      server/.env.example `
      server/Caddyfile `
      server/sfscctl `
      server/docker-compose.yml `
      server/docker-compose.n1.yml `
      scripts/smoke-server.mjs `
      scripts/lib/runtimeContracts.mjs
  } finally {
    Pop-Location
  }
  Info "Created archive: $archivePath"
}

function Show-ArchiveContents {
  Require-Tool "tar"
  Info "Archive contents:"
  tar -tzf $archivePath
  if ($LASTEXITCODE -ne 0) {
    throw "Could not list archive contents"
  }
}

function Test-ArchiveContents {
  Require-Tool "tar"
  $entries = @(tar -tzf $archivePath)
  if ($LASTEXITCODE -ne 0) {
    throw "Could not validate archive contents"
  }

  $requiredEntries = @(
    "package.json",
    "src/",
    "src/server.js",
    "src/core/index.js",
    "public/",
    "public/index.html",
    "public/app.js",
    "public/styles.css",
    "server/Dockerfile",
    "server/sing-box.Dockerfile",
    "server/sing-box-supervisor.sh",
    "server/.env.example",
    "server/Caddyfile",
    "server/sfscctl",
    "server/docker-compose.yml",
    "server/docker-compose.n1.yml",
    "scripts/smoke-server.mjs",
    "scripts/lib/runtimeContracts.mjs"
  )
  foreach ($entry in $requiredEntries) {
    if ($entries -notcontains $entry) {
      throw "Archive validation failed: missing required entry $entry"
    }
  }

  $blockedPatterns = @(
    '^\.env$',
    '^server/\.env$',
    '^server/data(/|$)',
    '^server/sing-box(/|$)',
    '(^|/)node_modules(/|$)',
    '^dist(/|$)',
    '^\.tmp(/|$)',
    '(^|/)__pycache__(/|$)',
    '\.py[co]$',
    '^client(/|$)',
    '^tests(/|$)',
    '^docs(/|$)'
  )
  foreach ($entry in $entries) {
    foreach ($pattern in $blockedPatterns) {
      if ($entry -match $pattern) {
        throw "Archive validation failed: blocked entry $entry"
      }
    }
  }

  Info "Archive validation passed: required source paths present and runtime paths excluded."
}

function Invoke-Ssh($command) {
  New-Item -ItemType Directory -Force -Path $archiveDir | Out-Null
  $scriptId = [System.Guid]::NewGuid().ToString("N")
  $localScriptPath = Join-Path $archiveDir "sfsc-remote-$scriptId.sh"
  $remoteScriptPath = "/tmp/sfsc-remote-$scriptId.sh"
  $script = ([string]$command).TrimStart([char]0xfeff)
  [System.IO.File]::WriteAllText($localScriptPath, $script, [System.Text.UTF8Encoding]::new($false))
  try {
    Invoke-Scp $localScriptPath $remoteScriptPath
    & "C:\Windows\System32\OpenSSH\ssh.exe" -i $KeyPath -o IdentitiesOnly=yes $RemoteHost "sh" $remoteScriptPath
    $exitCode = $LASTEXITCODE
    if ($exitCode -ne 0) {
      throw "SSH command failed with exit code $exitCode"
    }
  } finally {
    Remove-Item -LiteralPath $localScriptPath -Force -ErrorAction SilentlyContinue
    & "C:\Windows\System32\OpenSSH\ssh.exe" -i $KeyPath -o IdentitiesOnly=yes $RemoteHost "rm" "-f" $remoteScriptPath > $null 2> $null
  }
}

function Invoke-Scp($source, $target) {
  & "C:\Windows\System32\OpenSSH\scp.exe" -i $KeyPath -o IdentitiesOnly=yes $source "${RemoteHost}:$target"
  if ($LASTEXITCODE -ne 0) {
    throw "SCP failed with exit code $LASTEXITCODE"
  }
}

function Invoke-PostDeploySmoke {
  if (!$node) {
    throw "Node.js not found. Install Node.js or set SFSC_NODE to node.exe."
  }
  if (!$env:SFSC_ADMIN_TOKEN -and !$env:ADMIN_TOKEN) {
    throw "Post-deploy server smoke requires SFSC_ADMIN_TOKEN or ADMIN_TOKEN in the local environment."
  }
  $smokeJsonReport = Resolve-SmokeJsonReportPath
  $smokeScript = Join-Path $repoRoot "scripts\smoke-server.mjs"
  $args = @($smokeScript, "--base-url", $SmokeBaseUrl)
  if ($ExerciseClaimLifecycle) {
    $args += "--exercise-claim-lifecycle"
  }
  if ($CleanupClaimLifecycle) {
    $args += "--cleanup-claim-lifecycle"
  }
  if ($smokeJsonReport) {
    $args += @("--json-report", $smokeJsonReport)
  }
  & $node $args
  if ($LASTEXITCODE -ne 0) {
    throw "post-deploy server smoke failed with exit code $LASTEXITCODE"
  }
  if ($smokeJsonReport) {
    Assert-ReportFileSafe $smokeJsonReport "N1 deploy server smoke report"
  }
}

$remoteHealthCheckFunction = @'
check_sfsc_health() {
  label="$1"
  marker="$2"
  rm -f /tmp/sfsc-health.json /tmp/sfsc-health-curl.err
  for attempt in $(seq 1 30); do
    if curl -fsS --max-time 5 http://127.0.0.1:5177/api/health >/tmp/sfsc-health.json 2>/tmp/sfsc-health-curl.err; then
      break
    fi
    if [ "$attempt" -eq 30 ]; then
      printf '%s health check failed: /api/health was not ready after %s attempts\n' "$label" "$attempt" >&2
      if [ -s /tmp/sfsc-health-curl.err ]; then
        cat /tmp/sfsc-health-curl.err >&2
      fi
      exit 1
    fi
    sleep 1
  done
  cat /tmp/sfsc-health.json
  require_health_field() {
    pattern="$1"
    message="$2"
    if ! grep -Eq "$pattern" /tmp/sfsc-health.json; then
      printf '%s health check failed: %s\n' "$label" "$message" >&2
      exit 1
    fi
  }
  require_health_field '"ok"[[:space:]]*:[[:space:]]*true' '/api/health ok=true missing'
  require_health_field '"diagnostics"[[:space:]]*:' '/api/health diagnostics missing'
  require_health_field '"protocols"[[:space:]]*:' '/api/health diagnostics.protocols missing'
  require_health_field '"adminAuth"[[:space:]]*:' '/api/health adminAuth missing'
  require_health_field '"enabled"[[:space:]]*:[[:space:]]*true' '/api/health adminAuth.enabled=true missing'
  printf '%s\n' "$marker"
}
'@

try {
  Run-Step "Plan" {
    Show-Plan
  }

  if ($RollbackLatest) {
    if (-not $Apply) {
      exit 0
    }

    Run-Step "SSH key check" {
      if (-not (Test-Path -LiteralPath $KeyPath)) {
        throw "SSH key not found: $KeyPath"
      }
    }

    $rollbackScript = @"
set -eu
REMOTE_ROOT="$RemoteRoot"
$remoteHealthCheckFunction

if [ ! -d "`$REMOTE_ROOT/server" ]; then
  echo "Remote server directory not found: `$REMOTE_ROOT/server" >&2
  exit 1
fi

cd "`$REMOTE_ROOT"
latest_backup=""
if [ -d .deploy-backups ]; then
  latest_backup="`$(ls -1t .deploy-backups/source-before-*.tgz 2>/dev/null | head -n 1)"
fi
if [ -z "`$latest_backup" ]; then
  echo "No N1 source backup found under `$REMOTE_ROOT/.deploy-backups" >&2
  exit 1
fi
echo "rollback-backup=`$latest_backup"

rollback_stage="`$(mktemp -d /tmp/sfsc-rollback.XXXXXX)"
tar xzf "`$latest_backup" -C "`$rollback_stage"

mkdir -p .deploy-backups
tar czf ".deploy-backups/source-before-rollback-`$(date +%Y%m%d-%H%M%S).tgz" \
  --exclude='./server/data' \
  --exclude='./server/sing-box' \
  --exclude='./server/.env' \
  --exclude='./.deploy-backups' \
  --exclude='./node_modules' \
  .

rm -rf src public scripts
mkdir -p server scripts
cp -a "`$rollback_stage/src" ./src
cp -a "`$rollback_stage/public" ./public
cp -a "`$rollback_stage/scripts/smoke-server.mjs" ./scripts/smoke-server.mjs
if [ -f "`$rollback_stage/scripts/lib/runtimeContracts.mjs" ]; then
  mkdir -p ./scripts/lib
  cp -a "`$rollback_stage/scripts/lib/runtimeContracts.mjs" ./scripts/lib/runtimeContracts.mjs
else
  rm -rf ./scripts/lib
  echo "rollback-runtime-contracts=not-present-in-backup"
fi
cp -a "`$rollback_stage/package.json" ./package.json
cp -a "`$rollback_stage/server/Dockerfile" ./server/Dockerfile
if [ -f "`$rollback_stage/server/sing-box.Dockerfile" ]; then
  cp -a "`$rollback_stage/server/sing-box.Dockerfile" ./server/sing-box.Dockerfile
  cp -a "`$rollback_stage/server/sing-box-supervisor.sh" ./server/sing-box-supervisor.sh
else
  rm -f ./server/sing-box.Dockerfile ./server/sing-box-supervisor.sh
fi
cp -a "`$rollback_stage/server/.env.example" ./server/.env.example
if [ -f "`$rollback_stage/server/Caddyfile" ]; then
  cp -a "`$rollback_stage/server/Caddyfile" ./server/Caddyfile
else
  rm -f ./server/Caddyfile
  echo "rollback-caddyfile=not-present-in-backup"
fi
if [ -f "`$rollback_stage/server/sfscctl" ]; then
  cp -a "`$rollback_stage/server/sfscctl" ./server/sfscctl
else
  rm -f ./server/sfscctl
  echo "rollback-sfscctl=not-present-in-backup"
fi
cp -a "`$rollback_stage/server/docker-compose.yml" ./server/docker-compose.yml
cp -a "`$rollback_stage/server/docker-compose.n1.yml" ./server/docker-compose.n1.yml
rm -rf "`$rollback_stage"

cd server
docker compose -f docker-compose.n1.yml up -d --build sync-server sing-box

singbox_health=""
for attempt in `$(seq 1 30); do
  if ! singbox_health=`$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}missing{{end}}' singbox-folder-sync-tunnel 2>/dev/null); then
    singbox_health="missing"
  fi
  if [ "`$singbox_health" = "healthy" ]; then
    echo "singbox-health=passed"
    break
  fi
  if [ "`$singbox_health" = "unhealthy" ]; then
    if ! docker logs --tail 80 singbox-folder-sync-tunnel >&2; then
      echo "Unable to read sing-box container logs" >&2
    fi
    echo "Deploy health check failed: sing-box container is unhealthy" >&2
    exit 1
  fi
  sleep 1
done
if [ "`$singbox_health" != "healthy" ]; then
  if ! docker logs --tail 80 singbox-folder-sync-tunnel >&2; then
    echo "Unable to read sing-box container logs" >&2
  fi
  echo "Deploy health check failed: sing-box container did not become healthy (status=`$singbox_health)" >&2
  exit 1
fi

if [ -f .env ] && grep -q '^SFSC_ADMIN_TOKEN=.' .env; then
  echo "SFSC_ADMIN_TOKEN=present"
else
  echo "Rollback health check failed: SFSC_ADMIN_TOKEN is missing or empty in server/.env" >&2
  exit 1
fi

check_sfsc_health "Rollback" "rollback-health=passed"
"@

    Run-Step "Rollback latest source backup and deploy health" {
      Info "Rolling back N1 source from latest backup..."
      Invoke-Ssh $rollbackScript
    }

    if ($PostDeploySmoke) {
      Run-Step "Post-rollback server smoke" {
        Invoke-PostDeploySmoke
      }
    }

    Info "N1 rollback finished and deploy health check passed."
    exit 0
  }

  if ($BuildArchive) {
    Run-Step "Build source archive" {
      New-SourceArchive
    }
    Run-Step "List archive contents" {
      Show-ArchiveContents
    }
    Run-Step "Archive validation" {
      Test-ArchiveContents
    }
    if (-not $Apply) {
      exit 0
    }
  }

  if (-not $Apply) {
    exit 0
  }

  Run-Step "SSH key check" {
    if (-not (Test-Path -LiteralPath $KeyPath)) {
      throw "SSH key not found: $KeyPath"
    }
  }

  if (-not $BuildArchive) {
    Run-Step "Build source archive" {
      New-SourceArchive
    }
  }
  Run-Step "Archive validation" {
    Test-ArchiveContents
  }
  Run-Step "Upload source archive" {
    Invoke-Scp $archivePath $remoteArchive
  }

  $remoteScript = @"
set -eu
REMOTE_ROOT="$RemoteRoot"
REMOTE_STAGE="$remoteStage"
REMOTE_ARCHIVE="$remoteArchive"
$remoteHealthCheckFunction

if [ ! -d "`$REMOTE_ROOT/server" ]; then
  echo "Remote server directory not found: `$REMOTE_ROOT/server" >&2
  exit 1
fi

rm -rf "`$REMOTE_STAGE"
mkdir -p "`$REMOTE_STAGE"
tar xzf "`$REMOTE_ARCHIVE" -C "`$REMOTE_STAGE"

cd "`$REMOTE_ROOT"
mkdir -p .deploy-backups
tar czf ".deploy-backups/source-before-`$(date +%Y%m%d-%H%M%S).tgz" \
  --exclude='./server/data' \
  --exclude='./server/sing-box' \
  --exclude='./server/.env' \
  --exclude='./.deploy-backups' \
  --exclude='./node_modules' \
  .

rm -rf src public scripts
mkdir -p server scripts
cp -a "`$REMOTE_STAGE/src" ./src
cp -a "`$REMOTE_STAGE/public" ./public
cp -a "`$REMOTE_STAGE/scripts/smoke-server.mjs" ./scripts/smoke-server.mjs
mkdir -p ./scripts/lib
cp -a "`$REMOTE_STAGE/scripts/lib/runtimeContracts.mjs" ./scripts/lib/runtimeContracts.mjs
cp -a "`$REMOTE_STAGE/package.json" ./package.json
cp -a "`$REMOTE_STAGE/server/Dockerfile" ./server/Dockerfile
cp -a "`$REMOTE_STAGE/server/sing-box.Dockerfile" ./server/sing-box.Dockerfile
cp -a "`$REMOTE_STAGE/server/sing-box-supervisor.sh" ./server/sing-box-supervisor.sh
cp -a "`$REMOTE_STAGE/server/.env.example" ./server/.env.example
cp -a "`$REMOTE_STAGE/server/Caddyfile" ./server/Caddyfile
cp -a "`$REMOTE_STAGE/server/sfscctl" ./server/sfscctl
cp -a "`$REMOTE_STAGE/server/docker-compose.yml" ./server/docker-compose.yml
cp -a "`$REMOTE_STAGE/server/docker-compose.n1.yml" ./server/docker-compose.n1.yml

if grep -q '^SFSC_BUILD_ID=' ./server/.env; then
  sed -i 's/^SFSC_BUILD_ID=.*/SFSC_BUILD_ID=$sourceBuildId/' ./server/.env
else
  printf '%s\n' 'SFSC_BUILD_ID=$sourceBuildId' >> ./server/.env
fi
if grep -q '^SFSC_BUILD_TIME=' ./server/.env; then
  sed -i 's/^SFSC_BUILD_TIME=.*/SFSC_BUILD_TIME=$sourceBuildTime/' ./server/.env
else
  printf '%s\n' 'SFSC_BUILD_TIME=$sourceBuildTime' >> ./server/.env
fi
chmod 0600 ./server/.env
chmod 0750 "`$REMOTE_ROOT" ./server
chmod 0640 ./server/docker-compose.yml ./server/docker-compose.n1.yml ./server/.env.example ./server/Caddyfile
chmod 0750 ./server/sfscctl ./server/sing-box-supervisor.sh

deploy_manifest_tmp="./deploy-manifest.json.tmp"
printf '%s\n' '{"schemaVersion":1,"app":"singbox-folder-sync","type":"n1-deploy-manifest","version":"0.2.0-beta.2","buildId":"$sourceBuildId","sourceTreeHash":"$sourceTreeHash","buildTime":"$sourceBuildTime"}' > "`$deploy_manifest_tmp"
chmod 0640 "`$deploy_manifest_tmp"
mv "`$deploy_manifest_tmp" ./deploy-manifest.json

cd server
docker compose -f docker-compose.n1.yml up -d --build sync-server sing-box

if [ -f .env ] && grep -q '^SFSC_ADMIN_TOKEN=.' .env; then
  echo "SFSC_ADMIN_TOKEN=present"
else
  echo "Deploy health check failed: SFSC_ADMIN_TOKEN is missing or empty in server/.env" >&2
  exit 1
fi

check_sfsc_health "Deploy" "deploy-health=passed"
if ! grep -Eq '"buildId"[[:space:]]*:[[:space:]]*"$sourceBuildId"' /tmp/sfsc-health.json; then
  echo "Deploy health check failed: runtime build ID does not match $sourceBuildId" >&2
  exit 1
fi
echo "deploy-build-id=passed"
"@

  Run-Step "Remote source update and deploy health" {
    Info "Applying source update on N1..."
    Invoke-Ssh $remoteScript
  }

  if ($PostDeploySmoke) {
    Run-Step "Post-deploy server smoke" {
      Invoke-PostDeploySmoke
    }
  }

  Info "N1 source update finished and deploy health check passed. Run scripts/smoke-server.mjs with SFSC_ADMIN_TOKEN after setting the token in server/.env for the full management contract smoke."
} catch {
  $deployFailure = $_.Exception.Message
  throw
} finally {
  try {
    Write-DeployReport
  } catch {
    $reportError = $_.Exception.Message
    Write-Warning "Failed to write N1 deploy report: $reportError"
    if (!$deployFailure) {
      throw "N1 deploy report failed: $reportError"
    }
  }
}
