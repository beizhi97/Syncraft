param(
  [switch]$Apply,
  [switch]$PrintLatest,
  [switch]$ExerciseClaimLifecycle,
  [switch]$CleanupClaimLifecycle,
  [string]$ReportRoot = "reports\n1",
  [string]$RunId = "",
  [string]$RemoteHost = "root@192.168.1.254",
  [string]$KeyPath = "C:\Users\Public\Documents\Codex\ssh\codex_n1_admin_20260628_ed25519",
  [string]$RemoteRoot = "/opt/sfsc-test",
  [string]$SmokeBaseUrl = "http://192.168.1.254:5177",
  [string]$DeployJsonPath = "",
  [string]$SmokeJsonPath = "",
  [string]$FinalSmokeJsonPath = "",
  [string]$ReleaseBundleManifestPath = "",
  [string]$ClientRealSyncJsonPath = "",
  [string]$SsdObjectVerificationJsonPath = "",
  [string]$TestDataCleanupJsonPath = "",
  [switch]$ReleaseAcceptance,
  [switch]$AllowMismatchedSmokeBaseUrl,
  [switch]$AllowUnverifiedReleaseBundle
)

$ErrorActionPreference = "Stop"

if ($CleanupClaimLifecycle -and !$ExerciseClaimLifecycle) {
  throw "-CleanupClaimLifecycle requires -ExerciseClaimLifecycle."
}
if ($ReleaseAcceptance -and $AllowUnverifiedReleaseBundle) {
  throw "-ReleaseAcceptance cannot be combined with -AllowUnverifiedReleaseBundle."
}

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
. (Join-Path $PSScriptRoot "lib\report-secrets.ps1")
if (!$RunId) {
  $RunId = (Get-Date).ToUniversalTime().ToString("yyyyMMdd-HHmmss")
}

function Info($message) {
  Write-Host "[sfsc-n1-postdeploy] $message"
}

function Normalize-TargetHost($targetHost) {
  return "$targetHost".Trim().Trim([char[]]@('[', ']')).ToLowerInvariant()
}

function Get-RemoteHostNameFromValue($remoteHost) {
  $target = "$remoteHost".Trim()
  if (!$target) {
    return ""
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

function Get-SmokeBaseUrlHostFromValue($baseUrl) {
  try {
    $uri = [System.Uri]"$baseUrl"
    if (!$uri.Host) {
      return ""
    }
    return (Normalize-TargetHost $uri.DnsSafeHost)
  } catch {
    return ""
  }
}

function Get-TargetAlignmentSnapshot($remoteHost, $smokeBaseUrl) {
  $remoteHostName = Get-RemoteHostNameFromValue $remoteHost
  $smokeBaseUrlHost = Get-SmokeBaseUrlHostFromValue $smokeBaseUrl
  return [ordered]@{
    remoteHostName = $remoteHostName
    smokeBaseUrlHost = $smokeBaseUrlHost
    targetHostsMatch = ($remoteHostName -ne "" -and $remoteHostName -eq $smokeBaseUrlHost)
    allowMismatchedSmokeBaseUrl = [bool]$AllowMismatchedSmokeBaseUrl
  }
}

function Assert-RemoteRootSafe {
  if (!("$RemoteRoot" -match '^/[A-Za-z0-9._/-]+$')) {
    throw "RemoteRoot must be an absolute POSIX path containing only letters, numbers, '.', '_', '-', and '/'."
  }
}

function Resolve-ReportPath($path) {
  if ([System.IO.Path]::IsPathRooted($path)) {
    return $path
  }
  return Join-Path $repoRoot $path
}

function Read-JsonFile($path, $label) {
  if (!(Test-Path -LiteralPath $path -PathType Leaf)) {
    throw "$label JSON report not found: $path"
  }
  try {
    return Get-Content -LiteralPath $path -Raw | ConvertFrom-Json
  } catch {
    throw "$label JSON report could not be parsed: $($_.Exception.Message)"
  }
}

function Write-JsonFile($path, $payload) {
  $dir = Split-Path -Parent $path
  if ($dir) {
    New-Item -ItemType Directory -Force -Path $dir | Out-Null
  }
  Write-SafeJsonReport $path $payload "N1 post-deploy JSON report" 12
}

function Copy-Report($source, $destination) {
  if ([System.IO.Path]::GetFullPath($source) -ieq [System.IO.Path]::GetFullPath($destination)) {
    return
  }
  $dir = Split-Path -Parent $destination
  if ($dir) {
    New-Item -ItemType Directory -Force -Path $dir | Out-Null
  }
  Copy-SafeReport $source $destination "N1 post-deploy copied report"
}

function Get-FileSummary($path, $label) {
  if (!$path -or !(Test-Path -LiteralPath $path -PathType Leaf)) {
    return $null
  }
  $item = Get-Item -LiteralPath $path
  $hash = Get-FileHash -LiteralPath $path -Algorithm SHA256
  return [ordered]@{
    path = "$path"
    label = "$label"
    size = [int64]$item.Length
    sha256 = $hash.Hash.ToLowerInvariant()
  }
}

function Test-Sha256($value) {
  return "$value" -match '^[a-fA-F0-9]{64}$'
}

function Get-EvidenceFileSnapshot($sourcePath, $bundledPath, $label, $expectedType) {
  if (!$sourcePath) {
    return [ordered]@{
      provided = $false
      type = $expectedType
      report = $null
      source = $null
      bundled = $null
    }
  }
  $resolvedPath = Resolve-ReportPath $sourcePath
  $report = Read-JsonFile $resolvedPath $label
  if ("$($report.type)" -ne $expectedType) {
    throw "$label has unexpected type: $($report.type)"
  }
  Copy-Report $resolvedPath $bundledPath
  return [ordered]@{
    provided = $true
    type = $expectedType
    report = $report
    source = Get-FileSummary $resolvedPath "source $label"
    bundled = Get-FileSummary $bundledPath "bundled $label"
  }
}

function Get-ClientRealSyncEvidence($evidenceFile, $releaseBundle) {
  $report = $evidenceFile.report
  $context = if ($report) { Get-ObjectProperty $report "context" } else { $null }
  $summary = if ($report) { Get-ObjectProperty $report "summary" } else { $null }
  $clientPackage = Get-ObjectProperty $context "clientPackage"
  $bundleBuildId = Get-StringProperty $releaseBundle "buildId"
  $bundleSourceTreeHash = Get-StringProperty $releaseBundle "sourceTreeHash"
  $bundleVersion = Get-StringProperty $releaseBundle "version"
  $buildId = Get-StringProperty $clientPackage "buildId"
  $sourceTreeHash = Get-StringProperty $clientPackage "sourceTreeHash"
  $version = Get-StringProperty $clientPackage "version"
  $executableSha256 = Get-StringProperty $clientPackage "executableSha256"
  $releaseManifestSha256 = Get-StringProperty $clientPackage "releaseManifestSha256"
  $packageZipSha256 = Get-StringProperty $clientPackage "packageZipSha256"
  $desktopPackage = Get-ObjectProperty (Get-ObjectProperty $releaseBundle "clientPackages") "desktop"
  $desktopExecutableSha256 = Get-StringProperty (Get-ObjectProperty $desktopPackage "executable") "sha256"
  $desktopReleaseManifestSha256 = Get-StringProperty (Get-ObjectProperty $desktopPackage "manifest") "sha256"
  $desktopPackageZipSha256 = Get-StringProperty (Get-ObjectProperty $desktopPackage "zip") "sha256"
  $aligned = (
    $bundleBuildId -ne "" -and
    $buildId -eq $bundleBuildId -and
    $sourceTreeHash -eq $bundleSourceTreeHash -and
    $version -eq $bundleVersion
  )
  $artifactHashesAligned = (
    (Get-StringProperty $clientPackage "packageType") -eq "desktop" -and
    (Get-StringProperty $clientPackage "package") -eq (Get-StringProperty $desktopPackage "package") -and
    (Test-Sha256 $desktopExecutableSha256) -and
    (Test-Sha256 $desktopReleaseManifestSha256) -and
    (Test-Sha256 $desktopPackageZipSha256) -and
    $executableSha256 -eq $desktopExecutableSha256 -and
    $releaseManifestSha256 -eq $desktopReleaseManifestSha256 -and
    $packageZipSha256 -eq $desktopPackageZipSha256
  )
  $ok = (
    [bool]$evidenceFile.provided -and
    [bool]$report.ok -and
    (Get-StringProperty $report "mode") -eq "real-sync" -and
    (Get-BoolProperty $context "runSync") -and
    !(Get-BoolProperty $context "dryRun") -and
    (Get-IntProperty $summary "failed") -eq 0 -and
    $aligned -and
    $artifactHashesAligned
  )
  return [ordered]@{
    provided = [bool]$evidenceFile.provided
    ok = [bool]$ok
    source = $evidenceFile.source
    bundled = $evidenceFile.bundled
    buildAligned = [bool]$aligned
    artifactHashesAligned = [bool]$artifactHashesAligned
    releaseBundleArtifactHashes = [ordered]@{
      executableSha256 = $desktopExecutableSha256.ToLowerInvariant()
      releaseManifestSha256 = $desktopReleaseManifestSha256.ToLowerInvariant()
      packageZipSha256 = $desktopPackageZipSha256.ToLowerInvariant()
    }
    clientPackage = [ordered]@{
      packageType = Get-StringProperty $clientPackage "packageType"
      package = Get-StringProperty $clientPackage "package"
      version = $version
      buildId = $buildId
      sourceTreeHash = $sourceTreeHash
      executableSha256 = $executableSha256.ToLowerInvariant()
      releaseManifestSha256 = $releaseManifestSha256.ToLowerInvariant()
      packageZipSha256 = $packageZipSha256.ToLowerInvariant()
    }
    passed = Get-IntProperty $summary "passed"
    failed = Get-IntProperty $summary "failed"
  }
}

function Get-SsdObjectEvidence($evidenceFile, $releaseBundle) {
  $report = $evidenceFile.report
  $expectedSize = Get-IntProperty $report "expectedSize"
  $actualSize = Get-IntProperty $report "actualSize"
  $expectedSha256 = Get-StringProperty $report "expectedSha256"
  $actualSha256 = Get-StringProperty $report "actualSha256"
  $buildId = Get-StringProperty $report "buildId"
  $minioMountSource = Get-StringProperty $report "minioMountSource"
  $buildAligned = ($buildId -ne "" -and $buildId -eq (Get-StringProperty $releaseBundle "buildId"))
  $ok = (
    [bool]$evidenceFile.provided -and
    [bool]$report.ok -and
    $buildAligned -and
    $expectedSize -ge 0 -and
    $actualSize -eq $expectedSize -and
    (Test-Sha256 $expectedSha256) -and
    $actualSha256 -eq $expectedSha256 -and
    $minioMountSource -match '^/ssd/'
  )
  return [ordered]@{
    provided = [bool]$evidenceFile.provided
    ok = [bool]$ok
    source = $evidenceFile.source
    bundled = $evidenceFile.bundled
    buildId = $buildId
    buildAligned = [bool]$buildAligned
    expectedSize = $expectedSize
    actualSize = $actualSize
    expectedSha256 = $expectedSha256.ToLowerInvariant()
    actualSha256 = $actualSha256.ToLowerInvariant()
    minioMountSource = $minioMountSource
    minioContainerPath = Get-StringProperty $report "minioContainerPath"
  }
}

function Get-TestDataCleanupEvidence($evidenceFile, $releaseBundle) {
  $report = $evidenceFile.report
  $buildId = Get-StringProperty $report "buildId"
  $buildAligned = ($buildId -ne "" -and $buildId -eq (Get-StringProperty $releaseBundle "buildId"))
  $unexpectedContainers = @(Get-ObjectProperty $report "unexpectedSfscContainers")
  $minioMountSource = Get-StringProperty $report "minioMountSource"
  $restartRequired = Get-BoolProperty $report "restartRequired"
  $ok = (
    [bool]$evidenceFile.provided -and
    [bool]$report.ok -and
    $buildAligned -and
    (Get-IntProperty $report "remainingTestUsers") -eq 0 -and
    (Get-IntProperty $report "remainingTestClaims") -eq 0 -and
    (Get-IntProperty $report "remainingTestObjectPrefixes") -eq 0 -and
    !$restartRequired -and
    (Get-IntProperty $report "minioTrashBytes") -eq 0 -and
    $minioMountSource -match '^/ssd/' -and
    $unexpectedContainers.Count -eq 0
  )
  return [ordered]@{
    provided = [bool]$evidenceFile.provided
    ok = [bool]$ok
    source = $evidenceFile.source
    bundled = $evidenceFile.bundled
    buildId = $buildId
    buildAligned = [bool]$buildAligned
    remainingTestUsers = Get-IntProperty $report "remainingTestUsers"
    remainingTestClaims = Get-IntProperty $report "remainingTestClaims"
    remainingTestObjectPrefixes = Get-IntProperty $report "remainingTestObjectPrefixes"
    restartRequired = [bool]$restartRequired
    minioMountSource = $minioMountSource
    minioTrashBytes = Get-IntProperty $report "minioTrashBytes"
    unexpectedSfscContainers = $unexpectedContainers
  }
}

function Get-ReportSnapshot($report) {
  if (!$report) {
    return $null
  }
  $failure = $null
  if ($report.PSObject.Properties.Name.Contains("failure")) {
    $failure = $report.failure
  }
  return [ordered]@{
    schemaVersion = $report.schemaVersion
    type = "$($report.type)"
    ok = [bool]$report.ok
    context = $report.context
    summary = $report.summary
    failure = $failure
  }
}

function Read-TextFile($path, $label) {
  if (!(Test-Path -LiteralPath $path -PathType Leaf)) {
    throw "$label not found: $path"
  }
  return Get-Content -LiteralPath $path -Raw
}

function Get-EnvDefaults {
  $envPath = Join-Path $repoRoot "server\.env.example"
  $text = Read-TextFile $envPath "server .env example"
  $values = [ordered]@{}
  foreach ($line in ($text -split "`r?`n")) {
    if ($line -match '^([A-Z0-9_]+)=(.*)$') {
      $values[$matches[1]] = $matches[2].Trim()
    }
  }
  return $values
}

function Get-ImageTag($envDefaults, $name, $fallback) {
  if ($envDefaults.Contains($name) -and $envDefaults[$name]) {
    return "$($envDefaults[$name])"
  }
  return $fallback
}

function Get-DeliverySnapshot {
  param(
    $releaseBundle
  )
  $envDefaults = Get-EnvDefaults
  $appVersion = Get-PackageVersion
  return [ordered]@{
    appVersion = $appVersion
    composeFiles = @("server/docker-compose.yml", "server/docker-compose.n1.yml")
    images = [ordered]@{
      singBox = [ordered]@{
        image = "sfsc-sing-box"
        baseImage = "ghcr.io/sagernet/sing-box"
        env = "SING_BOX_IMAGE_TAG"
        tag = Get-ImageTag $envDefaults "SING_BOX_IMAGE_TAG" "v1.13.14"
      }
      minio = [ordered]@{
        image = "quay.io/minio/minio"
        env = "MINIO_IMAGE_TAG"
        tag = Get-ImageTag $envDefaults "MINIO_IMAGE_TAG" "RELEASE.2025-09-07T16-13-09Z"
      }
      minioClient = [ordered]@{
        image = "quay.io/minio/mc"
        env = "MINIO_MC_IMAGE_TAG"
        tag = Get-ImageTag $envDefaults "MINIO_MC_IMAGE_TAG" "RELEASE.2025-08-13T08-35-41Z"
      }
    }
    releaseBundle = $releaseBundle
    versionAlignment = Get-VersionAlignmentSnapshot $appVersion $releaseBundle
    sourceAlignment = Get-SourceAlignmentSnapshot $releaseBundle
  }
}

function Find-BundleArtifact($manifest, $pattern) {
  if (!$manifest -or !$manifest.PSObject.Properties.Name.Contains("artifacts") -or !$manifest.artifacts) {
    return $null
  }
  foreach ($artifact in @($manifest.artifacts)) {
    if ("$($artifact.path)" -match $pattern) {
      return $artifact
    }
  }
  return $null
}

function Read-OptionalJsonFile($path) {
  if (!$path -or !(Test-Path -LiteralPath $path -PathType Leaf)) {
    return $null
  }
  try {
    return Get-Content -LiteralPath $path -Raw | ConvertFrom-Json
  } catch {
    return $null
  }
}

function Find-ClientManifestFile($clientManifest, $name) {
  if (!$clientManifest -or !$clientManifest.PSObject.Properties.Name.Contains("files") -or !$clientManifest.files) {
    return $null
  }
  foreach ($file in @($clientManifest.files)) {
    if ((Get-StringProperty $file "name") -eq $name) {
      return $file
    }
  }
  return $null
}

function Get-ClientPackageSnapshot($manifestDir, $manifest, $name, $zipPattern, $checksumPattern, $manifestPattern) {
  $manifestArtifact = Find-BundleArtifact $manifest $manifestPattern
  $manifestPath = if ($manifestArtifact) { Join-Path $manifestDir "$($manifestArtifact.path)" } else { "" }
  $clientManifest = Read-OptionalJsonFile $manifestPath
  $fileCount = 0
  if ($clientManifest -and $clientManifest.PSObject.Properties.Name.Contains("files") -and $clientManifest.files) {
    $fileCount = @($clientManifest.files).Count
  }
  return [ordered]@{
    name = $name
    package = if ($clientManifest) { Get-StringProperty $clientManifest "package" } else { "" }
    version = if ($clientManifest) { Get-StringProperty $clientManifest "version" } else { "" }
    builtAt = if ($clientManifest) { Get-StringProperty $clientManifest "builtAt" } else { "" }
    sourceTreeHash = if ($clientManifest) { Get-StringProperty $clientManifest "sourceTreeHash" } else { "" }
    buildId = if ($clientManifest) { Get-StringProperty $clientManifest "buildId" } else { "" }
    fileCount = $fileCount
    executable = Find-ClientManifestFile $clientManifest "Syncraft.exe"
    zip = Find-BundleArtifact $manifest $zipPattern
    checksum = Find-BundleArtifact $manifest $checksumPattern
    manifest = $manifestArtifact
  }
}

function Get-ClientPackagesSnapshot($manifestDir, $manifest) {
  return [ordered]@{
    desktop = Get-ClientPackageSnapshot `
      $manifestDir `
      $manifest `
      "desktop" `
      "release-artifacts/windows-client/SyncraftDesktop\.zip$" `
      "release-artifacts/windows-client/SyncraftDesktop\.zip\.sha256$" `
      "release-artifacts/windows-client/SyncraftDesktop\.release-manifest\.json$"
    portable = Get-ClientPackageSnapshot `
      $manifestDir `
      $manifest `
      "portable" `
      "release-artifacts/windows-client/SyncraftClient\.zip$" `
      "release-artifacts/windows-client/SyncraftClient\.zip\.sha256$" `
      "release-artifacts/windows-client/SyncraftClient\.release-manifest\.json$"
  }
}

function Get-SourceAlignmentSnapshot($releaseBundle) {
  if (!$releaseBundle) {
    return [ordered]@{
      ok = $true
      sourceTreeHash = ""
      buildId = ""
      desktopSourceTreeHash = ""
      portableSourceTreeHash = ""
      desktopBuildId = ""
      portableBuildId = ""
    }
  }
  $sourceTreeHash = Get-StringProperty $releaseBundle "sourceTreeHash"
  $buildId = Get-StringProperty $releaseBundle "buildId"
  $desktopSourceTreeHash = Get-StringProperty $releaseBundle.clientPackages.desktop "sourceTreeHash"
  $portableSourceTreeHash = Get-StringProperty $releaseBundle.clientPackages.portable "sourceTreeHash"
  $desktopBuildId = Get-StringProperty $releaseBundle.clientPackages.desktop "buildId"
  $portableBuildId = Get-StringProperty $releaseBundle.clientPackages.portable "buildId"
  return [ordered]@{
    ok = (
      $sourceTreeHash -ne "" -and
      $buildId -ne "" -and
      $sourceTreeHash -eq $desktopSourceTreeHash -and
      $sourceTreeHash -eq $portableSourceTreeHash -and
      $buildId -eq $desktopBuildId -and
      $buildId -eq $portableBuildId
    )
    sourceTreeHash = "$sourceTreeHash"
    buildId = "$buildId"
    desktopSourceTreeHash = "$desktopSourceTreeHash"
    portableSourceTreeHash = "$portableSourceTreeHash"
    desktopBuildId = "$desktopBuildId"
    portableBuildId = "$portableBuildId"
  }
}

function Get-VersionAlignmentSnapshot($appVersion, $releaseBundle) {
  if (!$releaseBundle) {
    return [ordered]@{
      ok = $true
      appVersion = "$appVersion"
      releaseBundleVersion = ""
      desktopVersion = ""
      portableVersion = ""
    }
  }
  $desktopVersion = Get-StringProperty $releaseBundle.clientPackages.desktop "version"
  $portableVersion = Get-StringProperty $releaseBundle.clientPackages.portable "version"
  $bundleVersion = Get-StringProperty $releaseBundle "version"
  return [ordered]@{
    ok = (
      "$appVersion" -eq "$bundleVersion" -and
      "$appVersion" -eq "$desktopVersion" -and
      "$appVersion" -eq "$portableVersion"
    )
    appVersion = "$appVersion"
    releaseBundleVersion = "$bundleVersion"
    desktopVersion = "$desktopVersion"
    portableVersion = "$portableVersion"
  }
}

function Get-ReleaseBundleSnapshot($manifestPath, $bundledManifestPath) {
  if (!$manifestPath) {
    return $null
  }
  $resolvedManifestPath = Resolve-ReportPath $manifestPath
  $manifest = Read-JsonFile $resolvedManifestPath "release bundle manifest"
  if ("$($manifest.type)" -ne "release-bundle-manifest") {
    throw "release bundle manifest has unexpected type: $($manifest.type)"
  }
  Copy-Report $resolvedManifestPath $bundledManifestPath

  $manifestDir = Split-Path -Parent $resolvedManifestPath
  $bundleName = Get-StringProperty $manifest "bundleName"
  $bundleZipPath = if ($bundleName) { Join-Path (Split-Path -Parent $manifestDir) "$bundleName.zip" } else { "" }
  $bundleChecksumPath = if ($bundleName) { Join-Path (Split-Path -Parent $manifestDir) "$bundleName.zip.sha256" } else { "" }
  $clientPackages = Get-ClientPackagesSnapshot $manifestDir $manifest

  return [ordered]@{
    name = $bundleName
    version = Get-StringProperty $manifest "version"
    generatedAt = Get-StringProperty $manifest "generatedAt"
    sourceTreeHash = Get-StringProperty $manifest "sourceTreeHash"
    buildId = Get-StringProperty $manifest "buildId"
    preflightVerified = Get-BoolProperty $manifest "preflightVerified"
    preflightVerification = $manifest.preflightVerification
    strictPreflight = Get-BoolProperty $manifest "strictPreflight"
    preflight = $manifest.preflight
    sourceManifest = Get-FileSummary $resolvedManifestPath "source release bundle manifest"
    bundledManifest = Get-FileSummary $bundledManifestPath "bundled release bundle manifest"
    bundleZip = Get-FileSummary $bundleZipPath "release bundle ZIP"
    bundleChecksum = Get-FileSummary $bundleChecksumPath "release bundle ZIP checksum"
    desktopZip = Find-BundleArtifact $manifest "release-artifacts/windows-client/SyncraftDesktop\.zip$"
    desktopManifest = Find-BundleArtifact $manifest "release-artifacts/windows-client/SyncraftDesktop\.release-manifest\.json$"
    portableZip = Find-BundleArtifact $manifest "release-artifacts/windows-client/SyncraftClient\.zip$"
    portableManifest = Find-BundleArtifact $manifest "release-artifacts/windows-client/SyncraftClient\.release-manifest\.json$"
    clientPackages = $clientPackages
  }
}

function Get-PackageVersion {
  $packagePath = Join-Path $repoRoot "package.json"
  try {
    $pkg = Read-JsonFile $packagePath "package"
    if ($pkg.PSObject.Properties.Name.Contains("version") -and $pkg.version) {
      return "$($pkg.version)"
    }
  } catch {}
  return ""
}

function Get-ProtocolSnapshot($smokeReport) {
  $adminState = Find-CheckDetail $smokeReport "admin-state"
  return [ordered]@{
    aligned = $adminState -match 'protocols=aligned'
    adminStateDetail = $adminState
  }
}

function ConvertTo-SmokeBool($value, $fallback = $false) {
  if ($null -eq $value) {
    return [bool]$fallback
  }
  if ($value -is [bool]) {
    return [bool]$value
  }
  $text = "$value".Trim().ToLowerInvariant()
  return @("true", "1", "yes").Contains($text)
}

function ConvertTo-SmokeInt($value, $fallback = 0) {
  if ($null -eq $value) {
    return [int]$fallback
  }
  try {
    return [int]$value
  } catch {
    return [int]$fallback
  }
}

function Get-SmokeSummaryValue($smokeReport, $name) {
  if (!$smokeReport -or !$smokeReport.PSObject.Properties.Name.Contains("summary") -or !$smokeReport.summary) {
    return $null
  }
  return Get-ObjectProperty $smokeReport.summary $name
}

function Get-SmokeStateSnapshot($smokeReport) {
  $adminState = Find-CheckDetail $smokeReport "admin-state"
  $restartRequired = Get-SmokeSummaryValue $smokeReport "restartRequired"
  $userCount = Get-SmokeSummaryValue $smokeReport "userCount"
  $deviceCount = Get-SmokeSummaryValue $smokeReport "deviceCount"
  $claimCount = Get-SmokeSummaryValue $smokeReport "claimCount"
  $appVersion = Get-SmokeSummaryValue $smokeReport "appVersion"
  $buildId = Get-SmokeSummaryValue $smokeReport "buildId"

  if ($null -eq $restartRequired -and $adminState -match 'restartRequired=(true|false)') {
    $restartRequired = $Matches[1]
  }
  if ($null -eq $userCount -and $adminState -match 'users=(\d+)') {
    $userCount = $Matches[1]
  }
  if ($null -eq $deviceCount -and $adminState -match 'devices=(\d+)') {
    $deviceCount = $Matches[1]
  }
  if ($null -eq $claimCount -and $adminState -match 'claims=(\d+)') {
    $claimCount = $Matches[1]
  }
  if ($null -eq $appVersion -and $adminState -match 'version=([^,\s]+)') {
    $appVersion = $Matches[1]
  }

  return [ordered]@{
    appVersion = if ($null -ne $appVersion) { "$appVersion" } else { "" }
    buildId = if ($null -ne $buildId) { "$buildId" } else { "" }
    restartRequired = ConvertTo-SmokeBool $restartRequired $false
    userCount = ConvertTo-SmokeInt $userCount 0
    deviceCount = ConvertTo-SmokeInt $deviceCount 0
    claimCount = ConvertTo-SmokeInt $claimCount 0
  }
}

function Get-SmokeLifecycleSnapshot($smokeReport) {
  $context = if ($smokeReport -and $smokeReport.PSObject.Properties.Name.Contains("context")) { $smokeReport.context } else { $null }
  return [ordered]@{
    exercised = Get-BoolProperty $context "exerciseClaimLifecycle"
    clientName = Get-StringProperty $context "claimLifecycleClientName"
    deviceName = Get-StringProperty $context "claimLifecycleDeviceName"
    cleanupRequested = Get-BoolProperty $context "cleanupClaimLifecycle"
    cleanupUserDeleted = Get-BoolProperty $context "cleanupClaimLifecycleUserDeleted"
    cleanupClaimRetained = Get-BoolProperty $context "cleanupClaimLifecycleClaimRetained"
    cleanupRestartRequired = Get-ObjectProperty $context "cleanupClaimLifecycleRestartRequired"
  }
}

function Find-CheckDetail($report, $name) {
  if (!$report -or !$report.PSObject.Properties.Name.Contains("checks") -or !$report.checks) {
    return ""
  }
  foreach ($check in @($report.checks)) {
    if ("$($check.name)" -eq $name) {
      return "$($check.detail)"
    }
  }
  return ""
}

function Get-CheckSummary($report) {
  $checks = @()
  if ($report -and $report.PSObject.Properties.Name.Contains("checks") -and $report.checks) {
    $checks = @($report.checks | ForEach-Object {
      [pscustomobject]@{
        name = "$($_.name)"
        detail = "$($_.detail)"
      }
    })
  }
  return [ordered]@{
    count = $checks.Count
    names = @($checks | ForEach-Object { $_.name })
    checks = $checks
  }
}

function Get-ObjectProperty($object, $name) {
  if (!$object) {
    return $null
  }
  if ($object -is [System.Collections.IDictionary] -and $object.Contains($name)) {
    return $object[$name]
  }
  if ($object.PSObject.Properties.Name.Contains($name) -and $null -ne $object.$name) {
    return $object.$name
  }
  return $null
}

function Get-IntProperty($object, $name) {
  $value = Get-ObjectProperty $object $name
  if ($null -ne $value) {
    return [int]$value
  }
  return 0
}

function Get-BoolProperty($object, $name) {
  $value = Get-ObjectProperty $object $name
  if ($null -ne $value) {
    return [bool]$value
  }
  return $false
}

function Get-StringProperty($object, $name) {
  $value = Get-ObjectProperty $object $name
  if ($null -ne $value) {
    return "$value"
  }
  return ""
}

function Get-ReleaseAcceptanceSnapshot($releaseBundle, $releaseBundleVerified, $smokeState, $smokeLifecycle, $evidence) {
  $enabled = [bool]$ReleaseAcceptance
  $releaseBundleProvided = [bool]$releaseBundle
  $finalRestartClear = !([bool]$smokeState.restartRequired)
  $releaseBundleGateOk = (!$enabled -or ($releaseBundleProvided -and [bool]$releaseBundleVerified))
  $lifecycleGateOk = (
    !$enabled -or (
      [bool]$smokeLifecycle.exercised -and
      [bool]$smokeLifecycle.cleanupRequested -and
      [bool]$smokeLifecycle.cleanupUserDeleted -and
      [bool]$smokeLifecycle.cleanupClaimRetained
    )
  )
  $evidenceGateOk = (
    !$enabled -or (
      [bool]$evidence.clientRealSync.ok -and
      [bool]$evidence.ssdObjectVerification.ok -and
      [bool]$evidence.testDataCleanup.ok
    )
  )

  return [ordered]@{
    enabled = $enabled
    ok = ($releaseBundleGateOk -and $lifecycleGateOk -and $evidenceGateOk -and $finalRestartClear)
    releaseBundleRequired = $enabled
    releaseBundleProvided = $releaseBundleProvided
    releaseBundleVerified = [bool]$releaseBundleVerified
    lifecycleRequired = $enabled
    lifecycleExercised = [bool]$smokeLifecycle.exercised
    cleanupRequired = $enabled
    cleanupRequested = [bool]$smokeLifecycle.cleanupRequested
    cleanupUserDeleted = [bool]$smokeLifecycle.cleanupUserDeleted
    cleanupClaimRetained = [bool]$smokeLifecycle.cleanupClaimRetained
    clientRealSyncRequired = $enabled
    clientRealSyncVerified = [bool]$evidence.clientRealSync.ok
    ssdObjectVerificationRequired = $enabled
    ssdObjectVerified = [bool]$evidence.ssdObjectVerification.ok
    testDataCleanupRequired = $enabled
    testDataCleanupVerified = [bool]$evidence.testDataCleanup.ok
    evidence = $evidence
    restartRequired = [bool]$smokeState.restartRequired
    finalRestartClear = $finalRestartClear
  }
}

function Get-SmokeAdminAuthProvided($smokeReport) {
  if ($smokeReport.PSObject.Properties.Name.Contains("context") -and $smokeReport.context -and $smokeReport.context.PSObject.Properties.Name.Contains("adminAuthProvided")) {
    return [bool]$smokeReport.context.adminAuthProvided
  }
  return $false
}

function Get-AcceptanceSnapshot($deployReport, $lifecycleSmokeReport, $finalSmokeReport, $smokeAdminAuthProvided, $releaseBundle, $releaseBundleVerified, $evidence) {
  $delivery = Get-DeliverySnapshot $releaseBundle
  $remoteHost = Get-StringProperty $deployReport.context "RemoteHost"
  $remoteRoot = Get-StringProperty $deployReport.context "RemoteRoot"
  $smokeBaseUrl = Get-StringProperty $finalSmokeReport.context "baseUrl"
  $targetAlignment = Get-TargetAlignmentSnapshot $remoteHost $smokeBaseUrl
  $targetAccepted = ([bool]$targetAlignment.targetHostsMatch -or [bool]$AllowMismatchedSmokeBaseUrl)
  $smokeState = Get-SmokeStateSnapshot $finalSmokeReport
  $smokeLifecycle = Get-SmokeLifecycleSnapshot $lifecycleSmokeReport
  $n1BuildId = Get-StringProperty $smokeState "buildId"
  $bundleBuildId = Get-StringProperty $delivery.sourceAlignment "buildId"
  $n1BuildMatches = ($bundleBuildId -ne "" -and $n1BuildId -eq $bundleBuildId)
  $delivery.sourceAlignment["n1BuildId"] = $n1BuildId
  $delivery.sourceAlignment["n1BuildMatches"] = [bool]$n1BuildMatches
  $delivery.sourceAlignment["ok"] = ([bool]$delivery.sourceAlignment.ok -and (!$releaseBundle -or $n1BuildMatches))
  $releaseAcceptance = Get-ReleaseAcceptanceSnapshot $releaseBundle $releaseBundleVerified $smokeState $smokeLifecycle $evidence
  return [ordered]@{
    ok = ([bool]$deployReport.ok -and [bool]$lifecycleSmokeReport.ok -and [bool]$finalSmokeReport.ok -and [bool]$smokeAdminAuthProvided -and [bool]$releaseBundleVerified -and [bool]$delivery.versionAlignment.ok -and [bool]$delivery.sourceAlignment.ok -and [bool]$targetAccepted -and [bool]$releaseAcceptance.ok)
    releaseAcceptance = $releaseAcceptance
    delivery = $delivery
    target = [ordered]@{
      remoteHost = $remoteHost
      remoteRoot = $remoteRoot
      smokeBaseUrl = $smokeBaseUrl
      remoteHostName = $targetAlignment.remoteHostName
      smokeBaseUrlHost = $targetAlignment.smokeBaseUrlHost
      targetHostsMatch = [bool]$targetAlignment.targetHostsMatch
      allowMismatchedSmokeBaseUrl = [bool]$AllowMismatchedSmokeBaseUrl
    }
    deploy = [ordered]@{
      ok = [bool]$deployReport.ok
      passed = Get-IntProperty $deployReport.summary "passed"
      failed = Get-IntProperty $deployReport.summary "failed"
      postDeploySmoke = Get-BoolProperty $deployReport.context "PostDeploySmoke"
    }
    smoke = [ordered]@{
      ok = [bool]$finalSmokeReport.ok
      lifecycleSmokeOk = [bool]$lifecycleSmokeReport.ok
      finalSmokeOk = [bool]$finalSmokeReport.ok
      adminAuthProvided = [bool]$smokeAdminAuthProvided
      requestTimeoutMs = Get-IntProperty $finalSmokeReport.context "requestTimeoutMs"
      passed = Get-IntProperty $finalSmokeReport.summary "passed"
      failed = Get-IntProperty $finalSmokeReport.summary "failed"
      protocols = Get-ProtocolSnapshot $finalSmokeReport
      state = $smokeState
      lifecycle = $smokeLifecycle
      checks = Get-CheckSummary $finalSmokeReport
    }
  }
}

function Format-ListValue($values) {
  if (!$values) {
    return ""
  }
  return (@($values) | ForEach-Object { "$_" }) -join ", "
}

function Print-LatestSummary($latest, $latestPath) {
  $acceptance = $latest.acceptance
  Info "N1 latest post-deploy summary"
  Info "RunId: $($latest.runId)"
  Info "Ok: $([bool]$latest.ok)"
  Info "UpdatedAt: $($latest.updatedAt)"
  Info "SummaryJson: $($latest.summaryJson)"
  if ($acceptance) {
    Info "Target: $($acceptance.target.remoteHost) $($acceptance.target.remoteRoot) $($acceptance.target.smokeBaseUrl)"
    Info "Version: $($acceptance.delivery.appVersion)"
    if ($acceptance.delivery.releaseBundle) {
      Info "ReleaseBundle: $($acceptance.delivery.releaseBundle.name)"
      Info "ClientPackages: desktop=$($acceptance.delivery.releaseBundle.clientPackages.desktop.version), portable=$($acceptance.delivery.releaseBundle.clientPackages.portable.version)"
    }
    Info "VersionAlignment: $([bool]$acceptance.delivery.versionAlignment.ok)"
    Info "SourceAlignment: $([bool]$acceptance.delivery.sourceAlignment.ok), buildId=$($acceptance.delivery.sourceAlignment.buildId)"
    Info "Images: sing-box=$($acceptance.delivery.images.singBox.tag), minio=$($acceptance.delivery.images.minio.tag), mc=$($acceptance.delivery.images.minioClient.tag)"
    Info "Deploy: passed=$($acceptance.deploy.passed), failed=$($acceptance.deploy.failed), postDeploySmoke=$([bool]$acceptance.deploy.postDeploySmoke)"
    Info "Smoke: passed=$($acceptance.smoke.passed), failed=$($acceptance.smoke.failed), adminAuthProvided=$([bool]$acceptance.smoke.adminAuthProvided), timeoutMs=$($acceptance.smoke.requestTimeoutMs)"
    Info "SmokeState: restartRequired=$([bool]$acceptance.smoke.state.restartRequired), users=$($acceptance.smoke.state.userCount), devices=$($acceptance.smoke.state.deviceCount), claims=$($acceptance.smoke.state.claimCount)"
    Info "SmokeLifecycle: exercised=$([bool]$acceptance.smoke.lifecycle.exercised), client=$($acceptance.smoke.lifecycle.clientName), device=$($acceptance.smoke.lifecycle.deviceName), cleanupRequested=$([bool]$acceptance.smoke.lifecycle.cleanupRequested), cleanupUserDeleted=$([bool]$acceptance.smoke.lifecycle.cleanupUserDeleted), cleanupClaimRetained=$([bool]$acceptance.smoke.lifecycle.cleanupClaimRetained)"
    Info "ProtocolsAligned: $([bool]$acceptance.smoke.protocols.aligned)"
    Info "Checks: $(Format-ListValue $acceptance.smoke.checks.names)"
  }
  if ($latest.PSObject.Properties.Name.Contains("failure") -and $latest.failure) {
    Info "Failure: $($latest.failure | ConvertTo-Json -Compress -Depth 8)"
  }
  Info "LatestJson: $latestPath"
}

$resolvedReportRoot = Resolve-ReportPath $ReportRoot
$runDir = Join-Path $resolvedReportRoot $RunId
$deployTextReportPath = Join-Path $runDir "deploy.txt"
$deployJsonReportPath = Join-Path $runDir "deploy.json"
$smokeJsonReportPath = Join-Path $runDir "server-smoke.json"
$finalSmokeJsonReportPath = Join-Path $runDir "final-server-smoke.json"
$releaseBundleManifestReportPath = Join-Path $runDir "release-bundle-manifest.json"
$clientRealSyncReportPath = Join-Path $runDir "client-real-sync.json"
$ssdObjectVerificationReportPath = Join-Path $runDir "ssd-object-verification.json"
$testDataCleanupReportPath = Join-Path $runDir "test-data-cleanup.json"
$summaryJsonPath = Join-Path $runDir "post-deploy-summary.json"
$latestJsonPath = Join-Path $resolvedReportRoot "latest-post-deploy.json"

if ($PrintLatest) {
  $latest = Read-JsonFile $latestJsonPath "latest post-deploy"
  Print-LatestSummary $latest $latestJsonPath
  if (!([bool]$latest.ok)) {
    throw "N1 latest post-deploy verification failed. See $($latest.summaryJson)"
  }
  exit 0
}

New-Item -ItemType Directory -Force -Path $runDir | Out-Null

if ($Apply) {
  Assert-RemoteRootSafe
  if (!$env:SFSC_ADMIN_TOKEN -and !$env:ADMIN_TOKEN) {
    throw "N1 post-deploy -Apply requires SFSC_ADMIN_TOKEN or ADMIN_TOKEN in the local environment so management smoke cannot pass against an unauthenticated admin API."
  }
  Info "Running N1 deploy with post-deploy smoke..."
  $deployArgs = @(
    "-Apply",
    "-PostDeploySmoke",
    "-RemoteHost",
    $RemoteHost,
    "-KeyPath",
    $KeyPath,
    "-RemoteRoot",
    $RemoteRoot,
    "-SmokeBaseUrl",
    $SmokeBaseUrl,
    "-ReportPath",
    $deployTextReportPath,
    "-JsonReportPath",
    $deployJsonReportPath,
    "-SmokeJsonReportPath",
    $smokeJsonReportPath
  )
  if ($AllowMismatchedSmokeBaseUrl) {
    $deployArgs += "-AllowMismatchedSmokeBaseUrl"
  }
  if ($ExerciseClaimLifecycle) {
    $deployArgs += "-ExerciseClaimLifecycle"
  }
  if ($CleanupClaimLifecycle) {
    $deployArgs += "-CleanupClaimLifecycle"
  }
  & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $repoRoot "scripts\deploy-n1.ps1") @deployArgs
  if ($LASTEXITCODE -ne 0) {
    throw "N1 deploy with post-deploy smoke failed with exit code $LASTEXITCODE"
  }

  if ($CleanupClaimLifecycle) {
    Info "Applying the sing-box configuration changed by claim lifecycle cleanup, then running the final smoke..."
    $applyArgs = @(
      "-Apply",
      "-RemoteHost",
      $RemoteHost,
      "-KeyPath",
      $KeyPath,
      "-RemoteRoot",
      $RemoteRoot,
      "-SmokeBaseUrl",
      $SmokeBaseUrl,
      "-JsonReportPath",
      (Join-Path $runDir "singbox-apply.json"),
      "-SmokeJsonReportPath",
      $finalSmokeJsonReportPath
    )
    if ($AllowMismatchedSmokeBaseUrl) {
      $applyArgs += "-AllowMismatchedSmokeBaseUrl"
    }
    & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $repoRoot "scripts\apply-n1-singbox.ps1") @applyArgs
    if ($LASTEXITCODE -ne 0) {
      throw "N1 sing-box apply after claim lifecycle cleanup failed with exit code $LASTEXITCODE"
    }
  }
} else {
  if (!$DeployJsonPath -or !$SmokeJsonPath) {
    throw "Use -Apply to run N1 deployment, or provide both -DeployJsonPath and -SmokeJsonPath to aggregate existing reports."
  }
  $sourceDeployJson = Resolve-ReportPath $DeployJsonPath
  $sourceSmokeJson = Resolve-ReportPath $SmokeJsonPath
  Copy-Report $sourceDeployJson $deployJsonReportPath
  Copy-Report $sourceSmokeJson $smokeJsonReportPath
  if ($FinalSmokeJsonPath) {
    $sourceFinalSmokeJson = Resolve-ReportPath $FinalSmokeJsonPath
    Copy-Report $sourceFinalSmokeJson $finalSmokeJsonReportPath
  }
}

$deployReport = Read-JsonFile $deployJsonReportPath "deploy"
$smokeReport = Read-JsonFile $smokeJsonReportPath "server smoke"
$finalSmokeReport = if (Test-Path -LiteralPath $finalSmokeJsonReportPath -PathType Leaf) {
  Read-JsonFile $finalSmokeJsonReportPath "final server smoke"
} else {
  $smokeReport
}
$releaseBundle = Get-ReleaseBundleSnapshot $ReleaseBundleManifestPath $releaseBundleManifestReportPath
$releaseBundleVerified = (!$releaseBundle -or [bool]$releaseBundle.preflightVerified -or [bool]$AllowUnverifiedReleaseBundle)
$clientRealSyncFile = Get-EvidenceFileSnapshot $ClientRealSyncJsonPath $clientRealSyncReportPath "client real sync" "client-trial-runner-report"
$ssdObjectVerificationFile = Get-EvidenceFileSnapshot $SsdObjectVerificationJsonPath $ssdObjectVerificationReportPath "SSD object verification" "n1-ssd-object-verification"
$testDataCleanupFile = Get-EvidenceFileSnapshot $TestDataCleanupJsonPath $testDataCleanupReportPath "test data cleanup" "n1-test-data-cleanup-report"
$releaseEvidence = [ordered]@{
  clientRealSync = Get-ClientRealSyncEvidence $clientRealSyncFile $releaseBundle
  ssdObjectVerification = Get-SsdObjectEvidence $ssdObjectVerificationFile $releaseBundle
  testDataCleanup = Get-TestDataCleanupEvidence $testDataCleanupFile $releaseBundle
}
$smokeAdminAuthProvided = Get-SmokeAdminAuthProvided $finalSmokeReport
$acceptance = Get-AcceptanceSnapshot $deployReport $smokeReport $finalSmokeReport $smokeAdminAuthProvided $releaseBundle $releaseBundleVerified $releaseEvidence
$ok = [bool]$acceptance.ok
$failure = $null
if (!$ok) {
  $failure = [ordered]@{
    deployOk = [bool]$deployReport.ok
    smokeOk = [bool]$finalSmokeReport.ok
    lifecycleSmokeOk = [bool]$smokeReport.ok
    finalSmokeOk = [bool]$finalSmokeReport.ok
    smokeAdminAuthProvided = $smokeAdminAuthProvided
    releaseBundlePreflightVerified = if ($releaseBundle) { [bool]$releaseBundle.preflightVerified } else { $null }
    releaseAcceptance = $acceptance.releaseAcceptance
    allowUnverifiedReleaseBundle = [bool]$AllowUnverifiedReleaseBundle
    versionAlignment = $acceptance.delivery.versionAlignment
    sourceAlignment = $acceptance.delivery.sourceAlignment
    target = $acceptance.target
    smokeFailure = if ($smokeReport.PSObject.Properties.Name.Contains("failure")) { $smokeReport.failure } else { $null }
  }
}

$summary = [ordered]@{
  schemaVersion = 1
  app = "singbox-folder-sync"
  type = "n1-post-deploy-report"
  ok = $ok
  generatedAt = (Get-Date).ToUniversalTime().ToString("o")
  runId = $RunId
  reportDir = "$runDir"
  target = $acceptance.target
  reports = [ordered]@{
    deployText = "$deployTextReportPath"
    deployJson = "$deployJsonReportPath"
    serverSmokeJson = "$smokeJsonReportPath"
    finalServerSmokeJson = if (Test-Path -LiteralPath $finalSmokeJsonReportPath -PathType Leaf) { "$finalSmokeJsonReportPath" } else { "" }
    releaseBundleManifest = if ($releaseBundle) { "$releaseBundleManifestReportPath" } else { "" }
    clientRealSyncJson = if ($clientRealSyncFile.provided) { "$clientRealSyncReportPath" } else { "" }
    ssdObjectVerificationJson = if ($ssdObjectVerificationFile.provided) { "$ssdObjectVerificationReportPath" } else { "" }
    testDataCleanupJson = if ($testDataCleanupFile.provided) { "$testDataCleanupReportPath" } else { "" }
    summaryJson = "$summaryJsonPath"
  }
  acceptance = $acceptance
  deploy = Get-ReportSnapshot $deployReport
  serverSmoke = Get-ReportSnapshot $smokeReport
  finalServerSmoke = if (Test-Path -LiteralPath $finalSmokeJsonReportPath -PathType Leaf) { Get-ReportSnapshot $finalSmokeReport } else { $null }
  failure = $failure
}

Write-JsonFile $summaryJsonPath $summary
Write-JsonFile $latestJsonPath ([ordered]@{
  schemaVersion = 1
  app = "singbox-folder-sync"
  type = "n1-post-deploy-latest"
  ok = $ok
  updatedAt = $summary.generatedAt
  runId = $RunId
  summaryJson = "$summaryJsonPath"
  reportDir = "$runDir"
  acceptance = $acceptance
})

Info "N1 post-deploy summary written: $summaryJsonPath"
Info "N1 post-deploy latest pointer written: $latestJsonPath"
if (!$ok) {
  throw "N1 post-deploy verification failed. See $summaryJsonPath"
}
