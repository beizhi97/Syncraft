param(
  [switch]$Apply,
  [string]$RemoteHost = "root@192.168.1.254",
  [string]$KeyPath = "C:\Users\Public\Documents\Codex\ssh\codex_n1_admin_20260628_ed25519",
  [string]$RemoteRoot = "/opt/sfsc-test",
  [string]$SmokeBaseUrl = "http://192.168.1.254:5177",
  [switch]$AllowMismatchedSmokeBaseUrl,
  [string]$ReportPath = "",
  [string]$JsonReportPath = "",
  [string]$SmokeJsonReportPath = ""
)

$ErrorActionPreference = "Stop"

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
. (Join-Path $PSScriptRoot "lib\report-secrets.ps1")
$workDir = Join-Path $repoRoot ".tmp\n1-apply"
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

$stepResults = @()
$failure = $null
$preApplyState = $null
$postApplyState = $null
$smokeReport = $null
$remoteRestarted = $false
$markApplied = $false
$targetAlignment = $null

function Info($message) {
  Write-Host "[sfsc-n1-apply] $message"
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
    if ($reportDir) {
      return Join-Path $reportDir "apply-server-smoke.json"
    }
  }
  return Join-Path $repoRoot "reports\n1\apply-server-smoke.json"
}

function Get-AdminToken {
  if ($env:SFSC_ADMIN_TOKEN) {
    return "$($env:SFSC_ADMIN_TOKEN)"
  }
  if ($env:ADMIN_TOKEN) {
    return "$($env:ADMIN_TOKEN)"
  }
  return ""
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

function Assert-ApplyTargets {
  $script:targetAlignment = Get-TargetAlignment
  if (!$script:targetAlignment.targetHostsMatch -and !$AllowMismatchedSmokeBaseUrl) {
    throw "RemoteHost and SmokeBaseUrl must point to the same host. Use -AllowMismatchedSmokeBaseUrl only for an intentional split-target test."
  }
}

function Get-StepErrorCode($name, $status) {
  if ($status -eq "passed") {
    return ""
  }
  $slug = ($name.ToLowerInvariant() -replace '[^a-z0-9]+', '_').Trim('_')
  if (!$slug) {
    $slug = "step"
  }
  return "apply_n1_${slug}_failed"
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
    throw "N1 sing-box apply step failed: $name ($($_.Exception.Message))"
  }
}

function Write-JsonFile($path, $payload) {
  $dir = Split-Path -Parent $path
  if ($dir) {
    New-Item -ItemType Directory -Force -Path $dir | Out-Null
  }
  Write-SafeJsonReport $path $payload "N1 sing-box apply JSON report" 12
}

function ConvertTo-StateSnapshot($state) {
  if (!$state) {
    return $null
  }
  $users = if ($state.PSObject.Properties.Name.Contains("users") -and $state.users) { @($state.users) } else { @() }
  $devices = if ($state.PSObject.Properties.Name.Contains("devices") -and $state.devices) { @($state.devices) } else { @() }
  $claims = if ($state.PSObject.Properties.Name.Contains("claims") -and $state.claims) { @($state.claims) } else { @() }
  return [ordered]@{
    appVersion = "$($state.appVersion)"
    restartRequired = [bool]$state.tunnel.restartRequired
    lastConfigWrittenAt = if ($state.tunnel.lastConfigWrittenAt) { "$($state.tunnel.lastConfigWrittenAt)" } else { $null }
    lastAppliedAt = if ($state.tunnel.lastAppliedAt) { "$($state.tunnel.lastAppliedAt)" } else { $null }
    tunnelUserCount = [int]($state.tunnel.userCount)
    userCount = $users.Count
    deviceCount = $devices.Count
    claimCount = $claims.Count
  }
}

function Invoke-ApiJson($method, $path, $body = $null) {
  $token = Get-AdminToken
  $headers = @{ accept = "application/json" }
  if ($token) {
    $headers.authorization = "Bearer $token"
  }
  $uri = "$($SmokeBaseUrl.TrimEnd('/'))$path"
  $params = @{
    Method = $method
    Uri = $uri
    Headers = $headers
    TimeoutSec = 15
  }
  if ($null -ne $body) {
    $headers["content-type"] = "application/json"
    $params.Body = ($body | ConvertTo-Json -Depth 8)
  }
  try {
    return Invoke-RestMethod @params
  } catch {
    $message = $_.Exception.Message
    if ($_.Exception.Response -and $_.Exception.Response.StatusCode) {
      $message = "HTTP $([int]$_.Exception.Response.StatusCode) $path`: $message"
    }
    throw $message
  }
}

function Invoke-Scp($source, $target) {
  & "C:\Windows\System32\OpenSSH\scp.exe" -i $KeyPath -o IdentitiesOnly=yes $source "${RemoteHost}:$target"
  if ($LASTEXITCODE -ne 0) {
    throw "SCP failed with exit code $LASTEXITCODE"
  }
}

function Invoke-Ssh($command) {
  New-Item -ItemType Directory -Force -Path $workDir | Out-Null
  $scriptId = [System.Guid]::NewGuid().ToString("N")
  $localScriptPath = Join-Path $workDir "sfsc-apply-remote-$scriptId.sh"
  $remoteScriptPath = "/tmp/sfsc-apply-remote-$scriptId.sh"
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

function Wait-ServerHealth {
  for ($attempt = 1; $attempt -le 30; $attempt += 1) {
    try {
      $health = Invoke-ApiJson "GET" "/api/health"
      if ($health.ok -eq $true -and $health.adminAuth -and $health.diagnostics) {
        return
      }
    } catch {}
    Start-Sleep -Seconds 1
  }
  throw "Server health was not ready after restarting sing-box."
}

function Invoke-ServerSmoke {
  if (!$node) {
    throw "Node.js not found. Install Node.js or set SFSC_NODE to node.exe."
  }
  if (!(Get-AdminToken)) {
    throw "Server smoke requires SFSC_ADMIN_TOKEN or ADMIN_TOKEN in the local environment."
  }
  $smokeJsonReport = Resolve-SmokeJsonReportPath
  $smokeScript = Join-Path $repoRoot "scripts\smoke-server.mjs"
  $args = @($smokeScript, "--base-url", $SmokeBaseUrl, "--json-report", $smokeJsonReport)
  & $node $args
  if ($LASTEXITCODE -ne 0) {
    throw "server smoke failed with exit code $LASTEXITCODE"
  }
  Assert-ReportFileSafe $smokeJsonReport "N1 apply server smoke report"
  $script:smokeReport = Get-Content -LiteralPath $smokeJsonReport -Raw | ConvertFrom-Json
  if ($script:smokeReport.summary.restartRequired -ne $false) {
    throw "server smoke still reports restartRequired=true after mark-applied"
  }
}

function Get-ReportSnapshot($report) {
  if (!$report) {
    return $null
  }
  return [ordered]@{
    schemaVersion = $report.schemaVersion
    type = "$($report.type)"
    ok = [bool]$report.ok
    context = $report.context
    summary = $report.summary
    failure = $report.failure
  }
}

function Write-ApplyReport {
  if ($stepResults.Count -eq 0) {
    return
  }
  $failedCount = @($stepResults | Where-Object { $_.Status -eq "failed" }).Count
  $passedCount = @($stepResults | Where-Object { $_.Status -eq "passed" }).Count
  $ok = ($failedCount -eq 0)
  $smokeJsonReportPath = Resolve-SmokeJsonReportPath
  $payload = [ordered]@{
    schemaVersion = 1
    app = "singbox-folder-sync"
    type = "n1-singbox-apply-report"
    ok = $ok
    generatedAt = (Get-Date).ToUniversalTime().ToString("o")
    context = [ordered]@{
      remoteHost = $RemoteHost
      remoteRoot = $RemoteRoot
      smokeBaseUrl = $SmokeBaseUrl
      apply = [bool]$Apply
      adminAuthProvided = [bool](Get-AdminToken)
      smokeJsonReportPath = $smokeJsonReportPath
      remoteHostName = if ($targetAlignment) { $targetAlignment.remoteHostName } else { $null }
      smokeBaseUrlHost = if ($targetAlignment) { $targetAlignment.smokeBaseUrlHost } else { $null }
      targetHostsMatch = if ($targetAlignment) { [bool]$targetAlignment.targetHostsMatch } else { $null }
      allowMismatchedSmokeBaseUrl = [bool]$AllowMismatchedSmokeBaseUrl
    }
    summary = [ordered]@{
      passed = $passedCount
      failed = $failedCount
      remoteRestarted = [bool]$remoteRestarted
      markApplied = [bool]$markApplied
      preRestartRequired = if ($preApplyState) { [bool]$preApplyState.restartRequired } else { $null }
      postRestartRequired = if ($postApplyState) { [bool]$postApplyState.restartRequired } else { $null }
    }
    preApplyState = $preApplyState
    postApplyState = $postApplyState
    steps = @($stepResults)
    serverSmoke = Get-ReportSnapshot $smokeReport
    failure = $failure
  }

  $lines = @()
  $lines += "N1 sing-box apply report:"
  $lines += "  GeneratedAt: $($payload.generatedAt)"
  $lines += "  RemoteHost: $RemoteHost"
  $lines += "  RemoteRoot: $RemoteRoot"
  $lines += "  SmokeBaseUrl: $SmokeBaseUrl"
  $lines += "  Apply: $([bool]$Apply)"
  $lines += "  AdminAuthProvided: $([bool](Get-AdminToken))"
  $lines += "  RemoteRestarted: $([bool]$remoteRestarted)"
  $lines += "  MarkApplied: $([bool]$markApplied)"
  $lines += "  PreRestartRequired: $($payload.summary.preRestartRequired)"
  $lines += "  PostRestartRequired: $($payload.summary.postRestartRequired)"
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
    Write-SafeTextReport $resolvedReportPath $lines "N1 sing-box apply text report"
    Info "N1 sing-box apply text report written: $resolvedReportPath"
  }
  if ($JsonReportPath) {
    $resolvedJsonReportPath = Resolve-ReportPath $JsonReportPath
    Write-JsonFile $resolvedJsonReportPath $payload
    Info "N1 sing-box apply JSON report written: $resolvedJsonReportPath"
  }
}

$exitCode = 0
try {
  Run-Step "Plan N1 sing-box apply" {
    Assert-RemoteRootSafe
    Assert-ApplyTargets
    Info "RemoteHost target: $($targetAlignment.remoteHostName); SmokeBaseUrl target: $($targetAlignment.smokeBaseUrlHost)"
    if ($Apply) {
      Info "Apply mode will restart N1 sing-box, mark the server state applied, and run server smoke."
    } else {
      Info "Dry-run mode only writes the apply plan report. Use -Apply to restart N1 sing-box."
    }
  }

  if ($Apply) {
    Run-Step "Local apply prerequisites" {
      if (!(Get-AdminToken)) {
        throw "N1 sing-box apply requires SFSC_ADMIN_TOKEN or ADMIN_TOKEN in the local environment."
      }
      if (-not (Test-Path -LiteralPath $KeyPath)) {
        throw "SSH key not found: $KeyPath"
      }
      if (!$node) {
        throw "Node.js not found. Install Node.js or set SFSC_NODE to node.exe."
      }
    }

    Run-Step "Read pre-apply admin state" {
      $state = Invoke-ApiJson "GET" "/api/admin/state"
      $script:preApplyState = ConvertTo-StateSnapshot $state
    }

    if ($preApplyState -and [bool]$preApplyState.restartRequired) {
      $remoteScript = @"
set -eu
REMOTE_ROOT="$RemoteRoot"
if [ ! -d "`$REMOTE_ROOT/server" ]; then
  echo "Remote server directory not found: `$REMOTE_ROOT/server" >&2
  exit 1
fi
cd "`$REMOTE_ROOT/server"
if [ ! -f docker-compose.n1.yml ]; then
  echo "docker-compose.n1.yml not found in `$REMOTE_ROOT/server" >&2
  exit 1
fi
docker compose -f docker-compose.n1.yml restart sing-box
for attempt in `$(seq 1 30); do
  if docker compose -f docker-compose.n1.yml ps sing-box | grep -Eq 'Up|running'; then
    docker compose -f docker-compose.n1.yml ps sing-box
    echo "singbox-restart=passed"
    exit 0
  fi
  sleep 1
done
echo "sing-box container was not running after restart" >&2
docker compose -f docker-compose.n1.yml ps sing-box >&2 || true
exit 1
"@

      Run-Step "Restart remote sing-box service" {
        Invoke-Ssh $remoteScript
        $script:remoteRestarted = $true
      }

      Run-Step "Wait for server health after sing-box restart" {
        Wait-ServerHealth
      }

      Run-Step "Mark sing-box config applied" {
        $marked = Invoke-ApiJson "POST" "/api/admin/singbox/mark-applied" @{ confirmMarkApplied = $true }
        $script:postApplyState = ConvertTo-StateSnapshot $marked.state
        if ($script:postApplyState.restartRequired -ne $false) {
          throw "mark-applied did not clear restartRequired"
        }
        $script:markApplied = $true
      }
    } else {
      Run-Step "Skip apply without pending restart" {
        Info "Server state does not require sing-box apply; remote restart and mark-applied were skipped."
      }
    }

    if (!$postApplyState) {
      Run-Step "Read post-apply admin state" {
        $state = Invoke-ApiJson "GET" "/api/admin/state"
        $script:postApplyState = ConvertTo-StateSnapshot $state
      }
    }

    Run-Step "Post-apply server smoke" {
      Invoke-ServerSmoke
    }
  }
} catch {
  $exitCode = 1
  $failure = [ordered]@{
    message = $_.Exception.Message
    step = if ($stepResults.Count -gt 0) { $stepResults[-1].Name } else { "" }
  }
} finally {
  try {
    Write-ApplyReport
  } catch {
    $reportError = $_.Exception.Message
    Write-Warning "Failed to write N1 sing-box apply report: $reportError"
    if ($exitCode -eq 0) {
      $exitCode = 1
      $failure = [ordered]@{
        message = $reportError
        step = "Write N1 sing-box apply report"
      }
    }
  }
}

if ($exitCode -ne 0) {
  throw "N1 sing-box apply failed. See report output above."
}
