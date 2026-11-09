param(
  [switch]$SkipBinaryCheck,
  [string]$OutputRoot
)

$ErrorActionPreference = "Stop"

$clientRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$projectRoot = Resolve-Path (Join-Path $clientRoot "..")
. (Join-Path $projectRoot "scripts\lib\build-fingerprint.ps1")
$rootPackage = Get-Content -LiteralPath (Join-Path $projectRoot "package.json") -Raw | ConvertFrom-Json
$appVersion = $rootPackage.version
$sourceFingerprint = Get-SourceTreeFingerprint $projectRoot
$electronDist = Join-Path $projectRoot "node_modules\electron\dist"
$outputRootPath = if ($OutputRoot) { $OutputRoot } else { Join-Path $projectRoot "dist" }
$outputRootFull = [System.IO.Path]::GetFullPath($outputRootPath)
$distRoot = Join-Path $outputRootFull "SyncraftDesktop"
$zipPath = Join-Path $outputRootFull "SyncraftDesktop.zip"
$checksumPath = Join-Path $outputRootFull "SyncraftDesktop.zip.sha256"

$nodeExe = $env:SFSC_NODE
if (!$nodeExe) {
  $nodeCommand = Get-Command node -ErrorAction SilentlyContinue
  if ($nodeCommand) {
    $nodeExe = $nodeCommand.Source
  }
}
if (!$nodeExe) {
  $bundledNode = Join-Path $env:USERPROFILE ".cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
  if (Test-Path -LiteralPath $bundledNode) {
    $nodeExe = $bundledNode
  }
}

if (!(Test-Path -LiteralPath (Join-Path $electronDist "electron.exe"))) {
  throw "Electron runtime not found. Run pnpm install first."
}
if (!(Test-Path -LiteralPath $nodeExe)) {
  throw "Node.js not found. Install Node.js or set SFSC_NODE to node.exe."
}

$projectRootFull = [System.IO.Path]::GetFullPath($projectRoot)
$distRootFull = [System.IO.Path]::GetFullPath($distRoot)
$zipPathFull = [System.IO.Path]::GetFullPath($zipPath)
$checksumPathFull = [System.IO.Path]::GetFullPath($checksumPath)
$projectRootPrefix = $projectRootFull.TrimEnd([System.IO.Path]::DirectorySeparatorChar, [System.IO.Path]::AltDirectorySeparatorChar) + [System.IO.Path]::DirectorySeparatorChar
$outputRootPrefix = $outputRootFull.TrimEnd([System.IO.Path]::DirectorySeparatorChar, [System.IO.Path]::AltDirectorySeparatorChar) + [System.IO.Path]::DirectorySeparatorChar
if (!$outputRootFull.StartsWith($projectRootPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
  throw "Refusing to write outside project root: $outputRootFull"
}
if (!$distRootFull.StartsWith($outputRootPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
  throw "Refusing to write outside project root: $distRootFull"
}
if (!$zipPathFull.StartsWith($outputRootPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
  throw "Refusing to write outside project root: $zipPathFull"
}
if (!$checksumPathFull.StartsWith($outputRootPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
  throw "Refusing to write outside project root: $checksumPathFull"
}

if (Test-Path -LiteralPath $distRootFull) {
  Remove-Item -LiteralPath $distRootFull -Recurse -Force
}
if (Test-Path -LiteralPath $zipPathFull) {
  Remove-Item -LiteralPath $zipPathFull -Force
}
if (Test-Path -LiteralPath $checksumPathFull) {
  Remove-Item -LiteralPath $checksumPathFull -Force
}

Copy-Item -LiteralPath $electronDist -Destination $distRootFull -Recurse
Rename-Item -LiteralPath (Join-Path $distRootFull "electron.exe") -NewName "Syncraft.exe"

$appRoot = Join-Path $distRootFull "resources\app"
New-Item -ItemType Directory -Force -Path $appRoot | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $distRootFull "resources\bin\win32") | Out-Null

Copy-Item -LiteralPath (Join-Path $projectRoot "client\electron") -Destination (Join-Path $appRoot "client\electron") -Recurse
Copy-Item -LiteralPath (Join-Path $projectRoot "client\src") -Destination (Join-Path $appRoot "client\src") -Recurse
Copy-Item -LiteralPath (Join-Path $projectRoot "client\public") -Destination (Join-Path $appRoot "client\public") -Recurse
Copy-Item -LiteralPath (Join-Path $projectRoot "src\core") -Destination (Join-Path $appRoot "src\core") -Recurse
New-Item -ItemType Directory -Force -Path (Join-Path $appRoot "docs") | Out-Null
Copy-Item -LiteralPath (Join-Path $projectRoot "docs\INTERFACE_CONTRACT.md") -Destination (Join-Path $appRoot "docs\INTERFACE_CONTRACT.md")
Copy-Item -LiteralPath (Join-Path $projectRoot "docs\API_MATRIX.md") -Destination (Join-Path $appRoot "docs\API_MATRIX.md")
Copy-Item -LiteralPath (Join-Path $projectRoot "docs\DEPLOYMENT_AND_MIGRATION_GUIDE.md") -Destination (Join-Path $appRoot "docs\DEPLOYMENT_AND_MIGRATION_GUIDE.md")
Copy-Item -LiteralPath (Join-Path $projectRoot "docs\INTERNAL_TRIAL_CHECKLIST.md") -Destination (Join-Path $appRoot "docs\INTERNAL_TRIAL_CHECKLIST.md")
Copy-Item -LiteralPath (Join-Path $projectRoot "docs\PILOT_RUNBOOK.md") -Destination (Join-Path $appRoot "docs\PILOT_RUNBOOK.md")
Copy-Item -LiteralPath (Join-Path $projectRoot "docs\PILOT_ACCEPTANCE_CRITERIA.md") -Destination (Join-Path $appRoot "docs\PILOT_ACCEPTANCE_CRITERIA.md")
Copy-Item -LiteralPath (Join-Path $projectRoot "docs\PILOT_SUPPORT_GUIDE.md") -Destination (Join-Path $appRoot "docs\PILOT_SUPPORT_GUIDE.md")

Get-ChildItem -LiteralPath (Join-Path $projectRoot "client\resources\bin\win32") |
  ForEach-Object {
    Copy-Item -LiteralPath $_.FullName -Destination (Join-Path $distRootFull "resources\bin\win32") -Recurse -Force
  }

$appPackageJson = @'
{
  "name": "syncraft-desktop",
  "version": "__APP_VERSION__",
  "type": "module",
  "main": "client/electron/main.cjs"
}
'@
[System.IO.File]::WriteAllText((Join-Path $appRoot "package.json"), $appPackageJson.Replace("__APP_VERSION__", $appVersion), [System.Text.UTF8Encoding]::new($false))

$manifestFiles = @(
  @{ name = "Syncraft.exe"; path = Join-Path $distRootFull "Syncraft.exe" },
  @{ name = "resources/app/package.json"; path = Join-Path $appRoot "package.json" },
  @{ name = "resources/app/client/electron/main.cjs"; path = Join-Path $appRoot "client\electron\main.cjs" },
  @{ name = "resources/app/client/electron/preload.cjs"; path = Join-Path $appRoot "client\electron\preload.cjs" },
  @{ name = "resources/app/client/src/clientServer.js"; path = Join-Path $appRoot "client\src\clientServer.js" },
  @{ name = "resources/app/client/src/paths.js"; path = Join-Path $appRoot "client\src\paths.js" },
  @{ name = "resources/app/client/src/store.js"; path = Join-Path $appRoot "client\src\store.js" },
  @{ name = "resources/app/client/src/enrollmentSession.js"; path = Join-Path $appRoot "client\src\enrollmentSession.js" },
  @{ name = "resources/app/client/src/enrollmentDiagnostics.js"; path = Join-Path $appRoot "client\src\enrollmentDiagnostics.js" },
  @{ name = "resources/app/client/src/sftpAccessMarker.js"; path = Join-Path $appRoot "client\src\sftpAccessMarker.js" },
  @{ name = "resources/app/client/src/connectionRepair.js"; path = Join-Path $appRoot "client\src\connectionRepair.js" },
  @{ name = "resources/app/client/src/firstBisyncConflict.js"; path = Join-Path $appRoot "client\src\firstBisyncConflict.js" },
  @{ name = "resources/app/client/src/syncRecovery.js"; path = Join-Path $appRoot "client\src\syncRecovery.js" },
  @{ name = "resources/app/src/core/dataAuthorization.js"; path = Join-Path $appRoot "src\core\dataAuthorization.js" },
  @{ name = "resources/app/client/src/bootstrapTransport.js"; path = Join-Path $appRoot "client\src\bootstrapTransport.js" },
  @{ name = "resources/app/client/src/diagnosticBundle.js"; path = Join-Path $appRoot "client\src\diagnosticBundle.js" },
  @{ name = "resources/app/client/src/processRunner.js"; path = Join-Path $appRoot "client\src\processRunner.js" },
  @{ name = "resources/app/client/src/rcloneStats.js"; path = Join-Path $appRoot "client\src\rcloneStats.js" },
  @{ name = "resources/app/client/src/profileImport.js"; path = Join-Path $appRoot "client\src\profileImport.js" },
  @{ name = "resources/app/client/src/launcher.cjs"; path = Join-Path $appRoot "client\src\launcher.cjs" },
  @{ name = "resources/app/client/src/Launcher.cs"; path = Join-Path $appRoot "client\src\Launcher.cs" },
  @{ name = "resources/app/client/public/index.html"; path = Join-Path $appRoot "client\public\index.html" },
  @{ name = "resources/app/client/public/app.js"; path = Join-Path $appRoot "client\public\app.js" },
  @{ name = "resources/app/client/public/styles.css"; path = Join-Path $appRoot "client\public\styles.css" },
  @{ name = "resources/app/src/core/index.js"; path = Join-Path $appRoot "src\core\index.js" },
  @{ name = "resources/app/src/core/channelImportCode.js"; path = Join-Path $appRoot "src\core\channelImportCode.js" },
  @{ name = "resources/app/docs/INTERFACE_CONTRACT.md"; path = Join-Path $appRoot "docs\INTERFACE_CONTRACT.md" },
  @{ name = "resources/app/docs/API_MATRIX.md"; path = Join-Path $appRoot "docs\API_MATRIX.md" },
  @{ name = "resources/app/docs/DEPLOYMENT_AND_MIGRATION_GUIDE.md"; path = Join-Path $appRoot "docs\DEPLOYMENT_AND_MIGRATION_GUIDE.md" },
  @{ name = "resources/app/docs/INTERNAL_TRIAL_CHECKLIST.md"; path = Join-Path $appRoot "docs\INTERNAL_TRIAL_CHECKLIST.md" },
  @{ name = "resources/app/docs/PILOT_RUNBOOK.md"; path = Join-Path $appRoot "docs\PILOT_RUNBOOK.md" },
  @{ name = "resources/app/docs/PILOT_ACCEPTANCE_CRITERIA.md"; path = Join-Path $appRoot "docs\PILOT_ACCEPTANCE_CRITERIA.md" },
  @{ name = "resources/app/docs/PILOT_SUPPORT_GUIDE.md"; path = Join-Path $appRoot "docs\PILOT_SUPPORT_GUIDE.md" },
  @{ name = "resources/bin/win32/binaries.lock.json"; path = Join-Path $distRootFull "resources\bin\win32\binaries.lock.json" },
  @{ name = "resources/bin/win32/sing-box.exe"; path = Join-Path $distRootFull "resources\bin\win32\sing-box.exe" },
  @{ name = "resources/bin/win32/rclone.exe"; path = Join-Path $distRootFull "resources\bin\win32\rclone.exe" }
) | ForEach-Object {
  if (Test-Path -LiteralPath $_.path) {
    $item = Get-Item -LiteralPath $_.path
    $hash = Get-Sha256HexFromFile $_.path
    [ordered]@{
      name = $_.name
      size = $item.Length
      sha256 = $hash
    }
  } else {
    [ordered]@{
      name = $_.name
      size = 0
      sha256 = ""
      missing = $true
    }
  }
}
$releaseManifest = [ordered]@{
  schemaVersion = 1
  app = "singbox-folder-sync"
  package = "SyncraftDesktop"
  version = $appVersion
  builtAt = (Get-Date).ToUniversalTime().ToString("o")
  sourceTreeHash = $sourceFingerprint.hash
  buildId = $sourceFingerprint.buildId
  sourceFingerprint = $sourceFingerprint
  files = $manifestFiles
}
$releaseManifestJson = $releaseManifest | ConvertTo-Json -Depth 5
[System.IO.File]::WriteAllText((Join-Path $distRootFull "release-manifest.json"), $releaseManifestJson, [System.Text.UTF8Encoding]::new($false))

if (!$SkipBinaryCheck) {
  foreach ($name in @("sing-box.exe", "rclone.exe")) {
    $path = Join-Path $distRootFull "resources\bin\win32\$name"
    if (!(Test-Path -LiteralPath $path)) {
      throw "Missing bundled binary: $path. Run .\client\scripts\download-binaries.ps1 first."
    }
  }
}

Get-Item (Join-Path $distRootFull "Syncraft.exe"),
  (Join-Path $distRootFull "resources\bin\win32\sing-box.exe"),
  (Join-Path $distRootFull "resources\bin\win32\rclone.exe") |
  Select-Object FullName, Length, LastWriteTime

$env:SFSC_CLIENT_PACKAGE_DIR = $distRootFull
& $nodeExe (Join-Path $projectRoot "scripts\smoke-client-package.mjs")
if ($LASTEXITCODE -ne 0) {
  throw "Client package smoke check failed."
}

Compress-Archive -LiteralPath $distRootFull -DestinationPath $zipPathFull -Force
$zipHash = Get-Sha256HexFromFile $zipPathFull
"$zipHash  SyncraftDesktop.zip" | Set-Content -LiteralPath $checksumPathFull -Encoding ASCII
Get-Item -LiteralPath $zipPathFull | Select-Object FullName, Length, LastWriteTime
Get-Item -LiteralPath $checksumPathFull | Select-Object FullName, Length, LastWriteTime
