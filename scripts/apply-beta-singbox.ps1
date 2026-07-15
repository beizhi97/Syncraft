param(
  [switch]$Apply,
  [string]$RemoteHost = "root@67.215.236.230",
  [string]$KeyPath = "C:\Users\Public\Documents\Codex\ssh\sfsc_beta_67_215_236_230_ed25519",
  [string]$RemoteRoot = "/opt/sfsc-beta",
  [string]$BaseUrl = "https://sync.970506.xyz",
  [string]$JsonReportPath = "reports/beta-host/apply-singbox.json"
)

$ErrorActionPreference = "Stop"

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
. (Join-Path $PSScriptRoot "lib\report-secrets.ps1")

function Resolve-RepoPath($path) {
  if ([System.IO.Path]::IsPathRooted($path)) { return $path }
  return Join-Path $repoRoot $path
}

function Assert-RemoteRoot($path) {
  if (!("$path" -match '^/[A-Za-z0-9._/-]+$')) {
    throw "RemoteRoot must be a safe absolute POSIX path."
  }
}

function Invoke-Remote($command) {
  & "$env:WINDIR\System32\OpenSSH\ssh.exe" -i $KeyPath -o IdentitiesOnly=yes -o PasswordAuthentication=no -o ConnectTimeout=15 -o ServerAliveInterval=10 -o ServerAliveCountMax=3 $RemoteHost $command
  if ($LASTEXITCODE -ne 0) { throw "SSH command failed with exit code $LASTEXITCODE." }
}

function Get-AdminToken {
  if ($env:SFSC_ADMIN_TOKEN) { return "$($env:SFSC_ADMIN_TOKEN)" }
  if ($env:ADMIN_TOKEN) { return "$($env:ADMIN_TOKEN)" }
  throw "Set SFSC_ADMIN_TOKEN or ADMIN_TOKEN before applying sing-box."
}

Assert-RemoteRoot $RemoteRoot
if (!(Test-Path -LiteralPath $KeyPath -PathType Leaf)) { throw "SSH key not found: $KeyPath" }

$reportPath = Resolve-RepoPath $JsonReportPath
$report = [ordered]@{
  schemaVersion = 1
  app = "singbox-folder-sync"
  type = "beta-singbox-apply-report"
  generatedAt = (Get-Date).ToUniversalTime().ToString("o")
  applyRequested = [bool]$Apply
  target = [ordered]@{
    remoteHost = $RemoteHost
    remoteRoot = $RemoteRoot
    baseUrl = $BaseUrl
  }
  summary = [ordered]@{
    remoteRestarted = $false
    markApplied = $false
    restartRequired = $null
    appVersion = ""
    buildId = ""
  }
  safety = [ordered]@{
    adminTokenStored = $false
    sshPrivateKeyStored = $false
  }
}

try {
  if (!$Apply) {
    $report.summary.plan = "Would restart only the sing-box compose service, then call mark-applied against BaseUrl."
  } else {
    $token = Get-AdminToken
    Invoke-Remote "cd '$RemoteRoot/server' && docker compose restart sing-box && sleep 2 && docker compose exec -T sing-box sing-box check -c /etc/sing-box/config.json"
    $report.summary.remoteRestarted = $true

    $headers = @{ Authorization = "Bearer $token"; "Content-Type" = "application/json" }
    $mark = Invoke-RestMethod -Method Post -Uri "$BaseUrl/api/admin/singbox/mark-applied" -Headers $headers -Body '{"confirmMarkApplied":true}' -TimeoutSec 20
    $report.summary.markApplied = $true
    $report.summary.restartRequired = [bool]$mark.state.tunnel.restartRequired
    if ($report.summary.restartRequired) { throw "mark-applied returned restartRequired=true." }

    $health = Invoke-RestMethod -Method Get -Uri "$BaseUrl/api/health" -TimeoutSec 20
    if (!$health.ok -or $health.serviceHealth.restartRequired) { throw "Health check did not confirm an applied configuration." }
    $report.summary.appVersion = "$($health.version)"
    $report.summary.buildId = "$($health.diagnostics.buildId)"
  }
  $report.ok = $true
} catch {
  $report.ok = $false
  $report.failure = @{ message = "$($_.Exception.Message)" }
  throw
} finally {
  Write-SafeJsonReport $reportPath $report "Beta sing-box apply JSON report" 12
  Write-Host "Beta sing-box apply report written: $reportPath"
}
