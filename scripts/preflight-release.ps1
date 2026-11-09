param(
  [switch]$SkipTests,
  [switch]$AllowSkips,
  [string]$ReportPath = "",
  [string]$JsonReportPath = "",
  [string]$ClientPackageRoot = "",
  [string]$ReleaseBundleRoot = ""
)

$ErrorActionPreference = "Stop"

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$repoRootFull = [System.IO.Path]::GetFullPath("$repoRoot")
$repoRootPrefix = $repoRootFull.TrimEnd([System.IO.Path]::DirectorySeparatorChar, [System.IO.Path]::AltDirectorySeparatorChar) + [System.IO.Path]::DirectorySeparatorChar
$requestedClientPackageRoot = if ($ClientPackageRoot) {
  if ([System.IO.Path]::IsPathRooted($ClientPackageRoot)) { $ClientPackageRoot } else { Join-Path $repoRootFull $ClientPackageRoot }
} else {
  Join-Path $repoRootFull "dist"
}
$resolvedClientPackageRoot = [System.IO.Path]::GetFullPath($requestedClientPackageRoot)
if (!$resolvedClientPackageRoot.StartsWith($repoRootPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
  throw "Refusing to read client packages outside project root: $resolvedClientPackageRoot"
}
$requestedReleaseBundleRoot = if ($ReleaseBundleRoot) {
  if ([System.IO.Path]::IsPathRooted($ReleaseBundleRoot)) { $ReleaseBundleRoot } else { Join-Path $repoRootFull $ReleaseBundleRoot }
} else {
  Join-Path $resolvedClientPackageRoot "release-bundles"
}
$resolvedReleaseBundleRoot = [System.IO.Path]::GetFullPath($requestedReleaseBundleRoot)
if (!$resolvedReleaseBundleRoot.StartsWith($repoRootPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
  throw "Refusing to read release bundles outside project root: $resolvedReleaseBundleRoot"
}
$preflightRunId = [Guid]::NewGuid().ToString("N")
$preflightN1ArchiveRoot = Join-Path $repoRootFull ".tmp\preflight-release-$preflightRunId\n1-deploy"
. (Join-Path $PSScriptRoot "lib\report-secrets.ps1")
. (Join-Path $PSScriptRoot "lib\build-fingerprint.ps1")
$sourceFingerprint = Get-SourceTreeFingerprint $repoRoot
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
if (!$node) {
  throw "Node.js not found. Install Node.js or set SFSC_NODE to node.exe."
}

function Info($message) {
  Write-Host "[sfsc-preflight] $message"
}

$stepResults = @()
$clientPackageCandidates = @(
  [pscustomobject]@{
    Name = "desktop"
    Path = Join-Path $resolvedClientPackageRoot "SyncraftDesktop"
    BuildCommand = "powershell -ExecutionPolicy Bypass -File client/scripts/build-desktop.ps1 -OutputRoot `"$resolvedClientPackageRoot`""
  },
  [pscustomobject]@{
    Name = "portable"
    Path = Join-Path $resolvedClientPackageRoot "SyncraftClient"
    BuildCommand = "powershell -ExecutionPolicy Bypass -File client/scripts/build-client.ps1 -OutputRoot `"$resolvedClientPackageRoot`""
  }
)

function Add-StepResult($name, $status, $duration, $detail) {
  $script:stepResults += [pscustomobject]@{
    Name = $name
    Status = $status
    ErrorCode = Get-StepErrorCode $name $status
    DurationSeconds = [math]::Round($duration.TotalSeconds, 2)
    Detail = $detail
  }
}

function Get-StepErrorCode($name, $status) {
  if ($status -eq "passed") {
    return ""
  }
  if ($status -eq "skipped") {
    return "preflight_step_skipped"
  }
  $slug = ($name.ToLowerInvariant() -replace '[^a-z0-9]+', '_').Trim('_')
  if (!$slug) {
    $slug = "step"
  }
  return "preflight_${slug}_failed"
}

function Run-Step($name, $script) {
  Info $name
  $timer = [System.Diagnostics.Stopwatch]::StartNew()
  try {
    & $script
    if ($LASTEXITCODE -ne 0) {
      throw "exit code $LASTEXITCODE"
    }
    $timer.Stop()
    Add-StepResult $name "passed" $timer.Elapsed ""
  } catch {
    $timer.Stop()
    Add-StepResult $name "failed" $timer.Elapsed $_.Exception.Message
    throw "Preflight step failed: $name ($($_.Exception.Message))"
  }
}

function Skip-Step($name, $reason) {
  Add-StepResult $name "skipped" ([TimeSpan]::Zero) $reason
  Info "$name skipped; $reason"
}

function Fail-Step($name, $reason) {
  Add-StepResult $name "failed" ([TimeSpan]::Zero) $reason
  throw "Preflight step failed: $name ($reason)"
}

function Write-PreflightReport {
  if ($stepResults.Count -eq 0) {
    return
  }
  $context = Get-PreflightContext
  $lines = @()
  $lines += "Preflight report:"
  $lines += "  GeneratedAt: $($context.GeneratedAt)"
  $lines += "  RepoRoot: $($context.RepoRoot)"
  $lines += "  ClientPackageRoot: $($context.ClientPackageRoot)"
  $lines += "  ReleaseBundleRoot: $($context.ReleaseBundleRoot)"
  $lines += "  Node: $($context.Node)"
  $lines += "  SkipTests: $($context.SkipTests)"
  $lines += "  AllowSkips: $($context.AllowSkips)"
  if ($ReportPath) {
    $lines += "  ReportPath: $($context.ReportPath)"
  }
  if ($JsonReportPath) {
    $lines += "  JsonReportPath: $($context.JsonReportPath)"
    $lines += "  ClientPackageSmokeJsonReportPath: $($context.ClientPackageSmokeJsonReportPath)"
    foreach ($path in @($context.ClientPackageSmokeJsonReportPaths)) {
      $lines += "  ClientPackageSmokeJsonReportPaths: $path"
    }
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
    Write-SafeTextReport $resolvedReportPath $lines "preflight text report"
    Info "Preflight report written: $resolvedReportPath"
  }
  if ($JsonReportPath) {
    $resolvedJsonReportPath = Resolve-ReportPath $JsonReportPath
    Write-JsonReport $resolvedJsonReportPath $context
    Info "Preflight JSON report written: $resolvedJsonReportPath"
  }
}

function Get-PreflightContext {
  $context = [ordered]@{
    GeneratedAt = (Get-Date).ToUniversalTime().ToString("o")
    RepoRoot = "$repoRoot"
    Node = "$node"
    SourceTreeHash = $sourceFingerprint.hash
    BuildId = $sourceFingerprint.buildId
    SourceFingerprint = $sourceFingerprint
    SkipTests = [bool]$SkipTests
    AllowSkips = [bool]$AllowSkips
    ClientPackageRoot = $resolvedClientPackageRoot
    ReleaseBundleRoot = $resolvedReleaseBundleRoot
  }
  if ($ReportPath) {
    $context.ReportPath = "$(Resolve-ReportPath $ReportPath)"
  }
  if ($JsonReportPath) {
    $context.JsonReportPath = "$(Resolve-ReportPath $JsonReportPath)"
    $clientPackageReportPaths = @($clientPackageCandidates | ForEach-Object { Resolve-ClientPackageJsonReportPath $_.Name })
    $context.ClientPackageSmokeJsonReportPath = "$($clientPackageReportPaths[0])"
    $context.ClientPackageSmokeJsonReportPaths = $clientPackageReportPaths
  }
  return [pscustomobject]$context
}

function Write-JsonReport($path, $context) {
  $reportDir = Split-Path -Parent $path
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
  $summary = [ordered]@{
    passed = @($steps | Where-Object { $_.status -eq "passed" }).Count
    skipped = @($steps | Where-Object { $_.status -eq "skipped" }).Count
    failed = @($steps | Where-Object { $_.status -eq "failed" }).Count
  }
  $releaseOk = ($summary.failed -eq 0 -and $summary.skipped -eq 0)
  $payload = [ordered]@{
    schemaVersion = 1
    app = "singbox-folder-sync"
    type = "preflight-report"
    ok = $releaseOk
    releaseOk = $releaseOk
    context = $context
    summary = $summary
    steps = $steps
    clientPackageSmokeReports = @(Read-ClientPackageSmokeReports $context)
  }
  Write-SafeJsonReport $path $payload "preflight JSON report" 6
}

function Read-ClientPackageSmokeReports($context) {
  if (!$context.PSObject.Properties.Name.Contains("ClientPackageSmokeJsonReportPaths")) {
    return @()
  }
  $reports = @()
  foreach ($path in @($context.ClientPackageSmokeJsonReportPaths)) {
    if (!$path) {
      continue
    }
    if (!(Test-Path -LiteralPath $path)) {
      $reports += [pscustomobject]@{
        path = "$path"
        exists = $false
        ok = $false
        failureCheck = ""
        report = $null
        errorCode = "client_package_smoke_report_missing"
        message = "Client package smoke JSON report was not written."
      }
      continue
    }
    try {
      Assert-ReportFileSafe $path "client package smoke report"
      $report = Get-Content -LiteralPath $path -Raw | ConvertFrom-Json
      $failureCheck = ""
      if ($report.PSObject.Properties.Name.Contains("failure") -and $report.failure -and $report.failure.PSObject.Properties.Name.Contains("check")) {
        $failureCheck = "$($report.failure.check)"
      }
      $reports += [pscustomobject]@{
        path = "$path"
        exists = $true
        ok = [bool]$report.ok
        failureCheck = $failureCheck
        report = $report
        errorCode = ""
        message = ""
      }
    } catch {
      $reports += [pscustomobject]@{
        path = "$path"
        exists = $true
        ok = $false
        failureCheck = ""
        report = $null
        errorCode = "client_package_smoke_report_invalid"
        message = $_.Exception.Message
      }
    }
  }
  return $reports
}

function Resolve-ReportPath($path) {
  if ([System.IO.Path]::IsPathRooted($path)) {
    return $path
  }
  return Join-Path $repoRoot $path
}

function Resolve-ClientPackageJsonReportPath($packageName) {
  if (!$JsonReportPath) {
    return ""
  }
  $resolvedJsonReportPath = Resolve-ReportPath $JsonReportPath
  $reportDir = Split-Path -Parent $resolvedJsonReportPath
  if (!$reportDir) {
    $reportDir = "$repoRoot"
  }
  return Join-Path $reportDir "client-package-smoke-$packageName.json"
}

Push-Location $repoRoot
try {
  Run-Step "Release audit" {
    $hadClientPackageRoot = Test-Path Env:SFSC_CLIENT_PACKAGE_ROOT
    $previousClientPackageRoot = $env:SFSC_CLIENT_PACKAGE_ROOT
    $hadReleaseBundleRoot = Test-Path Env:SFSC_RELEASE_BUNDLE_ROOT
    $previousReleaseBundleRoot = $env:SFSC_RELEASE_BUNDLE_ROOT
    try {
      $env:SFSC_CLIENT_PACKAGE_ROOT = $resolvedClientPackageRoot
      $env:SFSC_RELEASE_BUNDLE_ROOT = $resolvedReleaseBundleRoot
      & $node scripts/audit-release.mjs
    } finally {
      if ($hadClientPackageRoot) { $env:SFSC_CLIENT_PACKAGE_ROOT = $previousClientPackageRoot }
      else { Remove-Item Env:SFSC_CLIENT_PACKAGE_ROOT -ErrorAction SilentlyContinue }
      if ($hadReleaseBundleRoot) { $env:SFSC_RELEASE_BUNDLE_ROOT = $previousReleaseBundleRoot }
      else { Remove-Item Env:SFSC_RELEASE_BUNDLE_ROOT -ErrorAction SilentlyContinue }
    }
  }

  Run-Step "N1 deploy dry-run" {
    & powershell -NoProfile -ExecutionPolicy Bypass -File scripts/deploy-n1.ps1
  }

  Run-Step "N1 deploy archive validation" {
    & powershell -NoProfile -ExecutionPolicy Bypass -File scripts/deploy-n1.ps1 -BuildArchive -ArchiveRoot $preflightN1ArchiveRoot
  }

  foreach ($clientPackage in $clientPackageCandidates) {
    $clientPackageDir = $clientPackage.Path
    if (Test-Path -LiteralPath $clientPackageDir) {
      Run-Step "Client package smoke ($($clientPackage.Name))" {
        if (!$AllowSkips -and !$SkipTests -and $env:SFSC_CLIENT_PACKAGE_SKIP_LAUNCH -eq "1") {
          throw "SFSC_CLIENT_PACKAGE_SKIP_LAUNCH=1 is not allowed during strict release preflight."
        }
        $hadClientPackageDir = Test-Path Env:SFSC_CLIENT_PACKAGE_DIR
        $previousClientPackageDir = $env:SFSC_CLIENT_PACKAGE_DIR
        try {
          $env:SFSC_CLIENT_PACKAGE_DIR = $clientPackageDir
          $clientPackageJsonReportPath = Resolve-ClientPackageJsonReportPath $clientPackage.Name
          if ($clientPackageJsonReportPath) {
            & $node scripts/smoke-client-package.mjs --json-report $clientPackageJsonReportPath
            if (Test-Path -LiteralPath $clientPackageJsonReportPath -PathType Leaf) {
              Assert-ReportFileSafe $clientPackageJsonReportPath "client package smoke report"
            }
          } else {
            & $node scripts/smoke-client-package.mjs
          }
        } finally {
          if ($hadClientPackageDir) {
            $env:SFSC_CLIENT_PACKAGE_DIR = $previousClientPackageDir
          } else {
            Remove-Item Env:SFSC_CLIENT_PACKAGE_DIR -ErrorAction SilentlyContinue
          }
        }
      }
    } else {
      $packageHint = "$($clientPackage.Path) with $($clientPackage.BuildCommand)"
      if ($AllowSkips -or $SkipTests) {
        Skip-Step "Client package smoke ($($clientPackage.Name))" "build $packageHint to validate the Windows package."
      } else {
        Fail-Step "Client package smoke ($($clientPackage.Name))" "Built client package not found: $packageHint."
      }
    }
  }

  if ($SkipTests) {
    Skip-Step "Node test suite" "-SkipTests was set; run pnpm test separately in a normal terminal or CI."
  } else {
    Run-Step "Node test suite" {
      & $node --test "tests/*.test.js"
    }
  }

  Info "Preflight passed."
} finally {
  Write-PreflightReport
  Pop-Location
}
