param(
  [string]$OutputDir = "",
  [string]$BundleName = "",
  [switch]$SkipPreflight,
  [string]$PreflightReportPath = "",
  [string]$PreflightJsonReportPath = ""
)

$ErrorActionPreference = "Stop"

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
. (Join-Path $PSScriptRoot "lib\report-secrets.ps1")
. (Join-Path $PSScriptRoot "lib\build-fingerprint.ps1")
$packageJson = Get-Content -LiteralPath (Join-Path $repoRoot "package.json") -Raw | ConvertFrom-Json
$version = $packageJson.version
$sourceFingerprint = Get-SourceTreeFingerprint $repoRoot
if (!$OutputDir) {
  $OutputDir = Join-Path $repoRoot "dist\release-bundles"
}
if (!$BundleName) {
  $safeVersion = "$version" -replace '[^a-zA-Z0-9._-]+', '-'
  $BundleName = "singbox-folder-sync-$safeVersion-release"
}

$resolvedOutputDir = [System.IO.Path]::GetFullPath($OutputDir)
$stageRoot = Join-Path $resolvedOutputDir $BundleName
$zipPath = Join-Path $resolvedOutputDir "$BundleName.zip"
$checksumPath = Join-Path $resolvedOutputDir "$BundleName.zip.sha256"
$preflightReportDir = Join-Path $repoRoot ".tmp\release-bundle\reports"
$preflightTextReport = Join-Path $preflightReportDir "preflight.txt"
$preflightJsonReport = Join-Path $preflightReportDir "preflight.json"
$preflightEvidenceSource = "strict"

function Info($message) {
  Write-Host "[sfsc-bundle] $message"
}

function Assert-SafeOutputPath($path) {
  $fullPath = [System.IO.Path]::GetFullPath($path)
  $repoRootFull = [System.IO.Path]::GetFullPath($repoRoot)
  if ($fullPath -eq $repoRootFull) {
    throw "Refusing to use repository root as an output path: $fullPath"
  }
}

function Require-File($path, $label) {
  if (!(Test-Path -LiteralPath $path -PathType Leaf)) {
    throw "Missing required $label`: $path"
  }
}

function Copy-FileIntoBundle($source, $relativeDestination) {
  Require-File $source $relativeDestination
  if ($relativeDestination.Replace("\", "/").StartsWith("reports/release-bundle/")) {
    Assert-ReportFileSafe $source "release bundle report $relativeDestination"
  }
  $destination = Join-Path $stageRoot $relativeDestination
  $destinationDir = Split-Path -Parent $destination
  if ($destinationDir) {
    New-Item -ItemType Directory -Force -Path $destinationDir | Out-Null
  }
  Copy-Item -LiteralPath $source -Destination $destination -Force
}

function Copy-TreeIntoBundle($source, $relativeDestination, $blockedPatterns = @()) {
  if (!(Test-Path -LiteralPath $source -PathType Container)) {
    throw "Missing required directory: $source"
  }
  $sourceRoot = [System.IO.Path]::GetFullPath($source)
  foreach ($item in Get-ChildItem -LiteralPath $sourceRoot -Recurse -Force) {
    $relative = Get-RelativePath $sourceRoot $item.FullName
    $bundleRelative = (Join-Path $relativeDestination $relative).Replace("\", "/")
    if (Test-BlockedPath $bundleRelative $blockedPatterns) {
      continue
    }
    $destination = Join-Path $stageRoot $bundleRelative
    if ($item.PSIsContainer) {
      New-Item -ItemType Directory -Force -Path $destination | Out-Null
    } else {
      if ($relativeDestination.Replace("\", "/") -eq "reports/release-bundle") {
        Assert-ReportFileSafe $item.FullName "release bundle report $bundleRelative"
      }
      $destinationDir = Split-Path -Parent $destination
      if ($destinationDir) {
        New-Item -ItemType Directory -Force -Path $destinationDir | Out-Null
      }
      Copy-Item -LiteralPath $item.FullName -Destination $destination -Force
    }
  }
}

function Resolve-RepoPath($path) {
  if (!$path) {
    return ""
  }
  if ([System.IO.Path]::IsPathRooted($path)) {
    return [System.IO.Path]::GetFullPath($path)
  }
  return [System.IO.Path]::GetFullPath((Join-Path $repoRoot $path))
}

function Test-BlockedPath($relativePath, $extraPatterns = @()) {
  $normalized = $relativePath.Replace("\", "/")
  $blockedPatterns = @(
    '(^|/)\.git(/|$)',
    '(^|/)node_modules(/|$)',
    '(^|/)\.tmp(/|$)',
    '(^|/)dist(/|$)',
    '(^|/)\.env$',
    '(^|/)[^/]+\.env\.local$',
    '^server/\.env$',
    '^server/\.env\.(?!example$)',
    '^server/data(/|$)',
    '^server/sing-box/config\.json$',
    '^server/sing-box/.*\.(key|pem)$',
    '^client/data(/|$)',
    '^release-artifacts/.*/data(/|$)'
  ) + $extraPatterns
  foreach ($pattern in $blockedPatterns) {
    if ($normalized -match $pattern) {
      return $true
    }
  }
  return $false
}

function Assert-NoBlockedBundleEntries {
  foreach ($item in Get-ChildItem -LiteralPath $stageRoot -Recurse -Force) {
    $relative = Get-RelativePath $stageRoot $item.FullName
    if (Test-BlockedPath $relative) {
      throw "Release bundle contains blocked runtime or secret path: $relative"
    }
  }
}

function Assert-StagedReportsSafe {
  $reportRoot = Join-Path $stageRoot "reports\release-bundle"
  if (!(Test-Path -LiteralPath $reportRoot -PathType Container)) {
    return
  }
  foreach ($item in Get-ChildItem -LiteralPath $reportRoot -Recurse -Force -File) {
    $relative = Get-RelativePath $stageRoot $item.FullName
    Assert-ReportFileSafe $item.FullName "staged release bundle report $relative"
  }
}

function Test-ZipChecksum($zip, $checksum) {
  Require-File $zip "release zip"
  Require-File $checksum "release zip checksum"
  $expected = ((Get-Content -LiteralPath $checksum -Raw).Trim() -split '\s+')[0].ToLowerInvariant()
  if ($expected -notmatch '^[a-f0-9]{64}$') {
    throw "Invalid SHA256 sidecar format: $checksum"
  }
  $actual = Get-Sha256HexFromFile $zip
  if ($expected -ne $actual) {
    throw "SHA256 sidecar does not match ZIP: $zip"
  }
}

function Get-RelativePath($basePath, $childPath) {
  $baseFullPath = [System.IO.Path]::GetFullPath($basePath)
  if (!$baseFullPath.EndsWith([System.IO.Path]::DirectorySeparatorChar)) {
    $baseFullPath = "$baseFullPath$([System.IO.Path]::DirectorySeparatorChar)"
  }
  $childFullPath = [System.IO.Path]::GetFullPath($childPath)
  $baseUri = [System.Uri]::new($baseFullPath)
  $childUri = [System.Uri]::new($childFullPath)
  return [System.Uri]::UnescapeDataString($baseUri.MakeRelativeUri($childUri).ToString()).Replace("/", "\").Replace("\", "/")
}

function Get-FileSummary($path, $relativePath) {
  $item = Get-Item -LiteralPath $path
  $hash = Get-Sha256HexFromFile $path
  return [ordered]@{
    path = $relativePath.Replace("\", "/")
    size = $item.Length
    sha256 = $hash
  }
}

function Read-JsonFile($path, $label) {
  Require-File $path $label
  try {
    return Get-Content -LiteralPath $path -Raw | ConvertFrom-Json
  } catch {
    throw "$label could not be parsed: $($_.Exception.Message)"
  }
}

function Assert-PreflightReleaseOk($report, $path) {
  if (!$report) {
    throw "Missing preflight JSON report object: $path"
  }
  if ($report.releaseOk -ne $true) {
    throw "Preflight JSON report is not releaseOk=true: $path"
  }
  if (!$report.PSObject.Properties.Name.Contains("summary") -or !$report.summary) {
    throw "Preflight JSON report is missing summary: $path"
  }
  if ([int]$report.summary.failed -ne 0 -or [int]$report.summary.skipped -ne 0) {
    throw "Preflight JSON report must have failed=0 and skipped=0: $path"
  }
  $preflightSourceTreeHash = Get-ReportStringProperty $report.context "SourceTreeHash"
  if ($preflightSourceTreeHash -and $preflightSourceTreeHash -ne $sourceFingerprint.hash) {
    throw "Preflight JSON report sourceTreeHash does not match current source tree: $path"
  }
}

function Get-ReportStringProperty($object, $name) {
  if ($object -and $object.PSObject.Properties.Name.Contains($name)) {
    return "$($object.$name)"
  }
  return ""
}

function Assert-ClientManifestMatchesSource($path, $label) {
  $manifest = Read-JsonFile $path $label
  $manifestSourceTreeHash = Get-ReportStringProperty $manifest "sourceTreeHash"
  if (!$manifestSourceTreeHash) {
    throw "$label is missing sourceTreeHash: $path"
  }
  if ($manifestSourceTreeHash -ne $sourceFingerprint.hash) {
    throw "$label sourceTreeHash does not match current source tree: $path"
  }
  return $manifest
}

function Get-ClientPackageBatchSummary($desktopManifestPath, $portableManifestPath) {
  $desktop = Assert-ClientManifestMatchesSource $desktopManifestPath "desktop release manifest"
  $portable = Assert-ClientManifestMatchesSource $portableManifestPath "portable release manifest"
  $desktopBuildId = Get-ReportStringProperty $desktop "buildId"
  $portableBuildId = Get-ReportStringProperty $portable "buildId"
  if (!$desktopBuildId -or !$portableBuildId -or $desktopBuildId -ne $sourceFingerprint.buildId -or $portableBuildId -ne $sourceFingerprint.buildId) {
    throw "Client package buildId values must match current source fingerprint."
  }
  return [ordered]@{
    desktop = [ordered]@{
      package = Get-ReportStringProperty $desktop "package"
      version = Get-ReportStringProperty $desktop "version"
      builtAt = Get-ReportStringProperty $desktop "builtAt"
      sourceTreeHash = Get-ReportStringProperty $desktop "sourceTreeHash"
      buildId = Get-ReportStringProperty $desktop "buildId"
    }
    portable = [ordered]@{
      package = Get-ReportStringProperty $portable "package"
      version = Get-ReportStringProperty $portable "version"
      builtAt = Get-ReportStringProperty $portable "builtAt"
      sourceTreeHash = Get-ReportStringProperty $portable "sourceTreeHash"
      buildId = Get-ReportStringProperty $portable "buildId"
    }
  }
}

function Get-PreflightEvidenceSummary($jsonPath, $textPath, $mode) {
  $jsonReport = Read-JsonFile $jsonPath "preflight JSON report"
  Assert-PreflightReleaseOk $jsonReport $jsonPath
  $sourceReports = @()
  $bundledReports = @()
  $sourceReports += Get-FileSummary $jsonPath (Get-RelativePath $repoRoot $jsonPath)
  $bundledReports += Get-FileSummary (Join-Path $stageRoot "reports\release-bundle\preflight.json") "reports/release-bundle/preflight.json"
  if ($textPath) {
    Require-File $textPath "preflight text report"
    $sourceReports += Get-FileSummary $textPath (Get-RelativePath $repoRoot $textPath)
    $bundledReports += Get-FileSummary (Join-Path $stageRoot "reports\release-bundle\preflight.txt") "reports/release-bundle/preflight.txt"
  }
  foreach ($child in @($jsonReport.context.ClientPackageSmokeJsonReportPaths)) {
    if (!$child) {
      continue
    }
    $childPath = Resolve-RepoPath "$child"
    if (Test-Path -LiteralPath $childPath -PathType Leaf) {
      $name = Split-Path -Leaf $childPath
      $sourceReports += Get-FileSummary $childPath (Get-RelativePath $repoRoot $childPath)
      $bundledReports += Get-FileSummary (Join-Path $stageRoot "reports\release-bundle\$name") "reports/release-bundle/$name"
    }
  }
  return [ordered]@{
    mode = $mode
    releaseOk = [bool]$jsonReport.releaseOk
    summary = [ordered]@{
      passed = [int]$jsonReport.summary.passed
      failed = [int]$jsonReport.summary.failed
      skipped = [int]$jsonReport.summary.skipped
    }
    sourceReports = $sourceReports
    bundledReports = $bundledReports
  }
}

Assert-SafeOutputPath $resolvedOutputDir
Assert-SafeOutputPath $stageRoot
New-Item -ItemType Directory -Force -Path $resolvedOutputDir | Out-Null

if (!$SkipPreflight) {
  foreach ($stalePath in @($stageRoot, $zipPath, $checksumPath)) {
    if (Test-Path -LiteralPath $stalePath) {
      Remove-Item -LiteralPath $stalePath -Recurse -Force
    }
  }
}

if (!$SkipPreflight) {
  Info "Running strict release preflight..."
  New-Item -ItemType Directory -Force -Path $preflightReportDir | Out-Null
  & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $repoRoot "scripts\preflight-release.ps1") -ReportPath $preflightTextReport -JsonReportPath $preflightJsonReport
  if ($LASTEXITCODE -ne 0) {
    throw "Strict release preflight failed."
  }
} elseif ($PreflightJsonReportPath) {
  $preflightEvidenceSource = "external"
  $preflightJsonReport = Resolve-RepoPath $PreflightJsonReportPath
  if ($PreflightReportPath) {
    $preflightTextReport = Resolve-RepoPath $PreflightReportPath
  } else {
    $preflightTextReport = ""
  }
  Assert-PreflightReleaseOk (Read-JsonFile $preflightJsonReport "preflight JSON report") $preflightJsonReport
} else {
  $preflightEvidenceSource = "skipped"
}

$requiredArtifacts = @(
  @{ Source = Join-Path $repoRoot "dist\SyncraftDesktop.zip"; Destination = "release-artifacts/windows-client/SyncraftDesktop.zip"; Label = "desktop ZIP" },
  @{ Source = Join-Path $repoRoot "dist\SyncraftDesktop.zip.sha256"; Destination = "release-artifacts/windows-client/SyncraftDesktop.zip.sha256"; Label = "desktop ZIP checksum" },
  @{ Source = Join-Path $repoRoot "dist\SyncraftDesktop\release-manifest.json"; Destination = "release-artifacts/windows-client/SyncraftDesktop.release-manifest.json"; Label = "desktop release manifest" },
  @{ Source = Join-Path $repoRoot "dist\SyncraftClient.zip"; Destination = "release-artifacts/windows-client/SyncraftClient.zip"; Label = "portable ZIP" },
  @{ Source = Join-Path $repoRoot "dist\SyncraftClient.zip.sha256"; Destination = "release-artifacts/windows-client/SyncraftClient.zip.sha256"; Label = "portable ZIP checksum" },
  @{ Source = Join-Path $repoRoot "dist\SyncraftClient\release-manifest.json"; Destination = "release-artifacts/windows-client/SyncraftClient.release-manifest.json"; Label = "portable release manifest" }
)

Test-ZipChecksum (Join-Path $repoRoot "dist\SyncraftDesktop.zip") (Join-Path $repoRoot "dist\SyncraftDesktop.zip.sha256")
Test-ZipChecksum (Join-Path $repoRoot "dist\SyncraftClient.zip") (Join-Path $repoRoot "dist\SyncraftClient.zip.sha256")

if (Test-Path -LiteralPath $stageRoot) {
  Remove-Item -LiteralPath $stageRoot -Recurse -Force
}
if (Test-Path -LiteralPath $zipPath) {
  Remove-Item -LiteralPath $zipPath -Force
}
if (Test-Path -LiteralPath $checksumPath) {
  Remove-Item -LiteralPath $checksumPath -Force
}
New-Item -ItemType Directory -Force -Path $stageRoot | Out-Null

foreach ($file in @("README.md", "package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", "run.ps1", "test.ps1")) {
  Copy-FileIntoBundle (Join-Path $repoRoot $file) $file
}
foreach ($dir in @("docs", "src", "public", "tests", "scripts", "client")) {
  Copy-TreeIntoBundle (Join-Path $repoRoot $dir) $dir
}
New-Item -ItemType Directory -Force -Path (Join-Path $stageRoot "server\sing-box") | Out-Null
foreach ($file in @("README.md", "Dockerfile", "sing-box.Dockerfile", "sing-box-supervisor.sh", ".env.example", "docker-compose.yml", "docker-compose.n1.yml", "sing-box/config.example.json")) {
  Copy-FileIntoBundle (Join-Path $repoRoot "server\$file") "server/$($file.Replace('\', '/'))"
}
foreach ($artifact in $requiredArtifacts) {
  Copy-FileIntoBundle $artifact.Source $artifact.Destination
}
if ($preflightEvidenceSource -eq "strict") {
  Copy-TreeIntoBundle $preflightReportDir "reports/release-bundle"
} elseif ($preflightEvidenceSource -eq "external") {
  Copy-FileIntoBundle $preflightJsonReport "reports/release-bundle/preflight.json"
  if ($preflightTextReport) {
    Copy-FileIntoBundle $preflightTextReport "reports/release-bundle/preflight.txt"
  }
  $externalPreflight = Read-JsonFile $preflightJsonReport "preflight JSON report"
  foreach ($child in @($externalPreflight.context.ClientPackageSmokeJsonReportPaths)) {
    if (!$child) {
      continue
    }
    $childPath = Resolve-RepoPath "$child"
    if (Test-Path -LiteralPath $childPath -PathType Leaf) {
      Copy-FileIntoBundle $childPath "reports/release-bundle/$(Split-Path -Leaf $childPath)"
    }
  }
}

Assert-NoBlockedBundleEntries

$artifactSummaries = @()
foreach ($artifact in $requiredArtifacts) {
  $artifactSummaries += Get-FileSummary (Join-Path $stageRoot $artifact.Destination) $artifact.Destination
}
$clientPackages = Get-ClientPackageBatchSummary `
  (Join-Path $repoRoot "dist\SyncraftDesktop\release-manifest.json") `
  (Join-Path $repoRoot "dist\SyncraftClient\release-manifest.json")
$preflightEvidence = if ($preflightEvidenceSource -eq "skipped") {
  [ordered]@{
    mode = "skipped"
    releaseOk = $false
    summary = $null
    sourceReports = @()
    bundledReports = @()
  }
} else {
  Get-PreflightEvidenceSummary $preflightJsonReport $preflightTextReport $preflightEvidenceSource
}
$preflightVerified = [bool](
  $preflightEvidence.releaseOk -eq $true -and
  $preflightEvidence.summary -and
  [int]$preflightEvidence.summary.failed -eq 0 -and
  [int]$preflightEvidence.summary.skipped -eq 0
)
$preflightVerification = [ordered]@{
  verified = $preflightVerified
  mode = "$($preflightEvidence.mode)"
  strictPreflightRanInBundleBuild = -not [bool]$SkipPreflight
  evidence = if ($preflightVerified) { "release preflight passed with failed=0 and skipped=0" } else { "release preflight evidence missing or not release-ready" }
  releaseOk = [bool]$preflightEvidence.releaseOk
  summary = $preflightEvidence.summary
}
$bundleManifest = [ordered]@{
  schemaVersion = 1
  app = "singbox-folder-sync"
  type = "release-bundle-manifest"
  version = "$version"
  generatedAt = (Get-Date).ToUniversalTime().ToString("o")
  bundleName = $BundleName
  sourceTreeHash = $sourceFingerprint.hash
  buildId = $sourceFingerprint.buildId
  sourceFingerprint = $sourceFingerprint
  clientPackages = $clientPackages
  preflightVerified = $preflightVerified
  preflightVerification = $preflightVerification
  strictPreflight = -not [bool]$SkipPreflight
  preflight = $preflightEvidence
  artifacts = $artifactSummaries
  excludedRuntimePaths = @(
    ".env",
    "server/.env",
    "server/data",
    "server/sing-box/config.json",
    "server/sing-box/*.key",
    "server/sing-box/*.pem",
    "client/data",
    "dist/*/data",
    "node_modules",
    ".tmp"
  )
}
$bundleManifestPath = Join-Path $stageRoot "release-bundle-manifest.json"
Write-SafeJsonReport $bundleManifestPath $bundleManifest "release bundle manifest" 6

Assert-StagedReportsSafe
Compress-Archive -LiteralPath $stageRoot -DestinationPath $zipPath -Force
$bundleHash = Get-Sha256HexFromFile $zipPath
"$bundleHash  $BundleName.zip" | Set-Content -LiteralPath $checksumPath -Encoding ASCII

Info "Release bundle directory: $stageRoot"
Info "Release bundle ZIP: $zipPath"
Info "Release bundle SHA256: $checksumPath"
