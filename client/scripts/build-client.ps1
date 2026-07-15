param(
  [switch]$SkipBinaryCheck
)

$ErrorActionPreference = "Stop"

$clientRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$projectRoot = Resolve-Path (Join-Path $clientRoot "..")
. (Join-Path $projectRoot "scripts\lib\build-fingerprint.ps1")
$rootPackage = Get-Content -LiteralPath (Join-Path $projectRoot "package.json") -Raw | ConvertFrom-Json
$appVersion = $rootPackage.version
$sourceFingerprint = Get-SourceTreeFingerprint $projectRoot
$distRoot = Join-Path $projectRoot "dist\SyncraftClient"
$zipPath = Join-Path $projectRoot "dist\SyncraftClient.zip"
$checksumPath = Join-Path $projectRoot "dist\SyncraftClient.zip.sha256"
$cscExe = "C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe"

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

if (!(Test-Path -LiteralPath $nodeExe)) {
  throw "Node.js not found. Install Node.js or set SFSC_NODE to node.exe."
}
if (!(Test-Path -LiteralPath $cscExe)) {
  throw "C# compiler not found: $cscExe"
}

$projectRootFull = [System.IO.Path]::GetFullPath($projectRoot)
$distRootFull = [System.IO.Path]::GetFullPath($distRoot)
$zipPathFull = [System.IO.Path]::GetFullPath($zipPath)
$checksumPathFull = [System.IO.Path]::GetFullPath($checksumPath)
if (!$distRootFull.StartsWith($projectRootFull, [System.StringComparison]::OrdinalIgnoreCase)) {
  throw "Refusing to write outside project root: $distRootFull"
}
if (!$zipPathFull.StartsWith($projectRootFull, [System.StringComparison]::OrdinalIgnoreCase)) {
  throw "Refusing to write outside project root: $zipPathFull"
}
if (!$checksumPathFull.StartsWith($projectRootFull, [System.StringComparison]::OrdinalIgnoreCase)) {
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

New-Item -ItemType Directory -Force -Path $distRootFull | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $distRootFull "runtime") | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $distRootFull "app") | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $distRootFull "resources\app\docs") | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $distRootFull "resources\bin\win32") | Out-Null

Copy-Item -LiteralPath $nodeExe -Destination (Join-Path $distRootFull "runtime\node.exe") -Force
Copy-Item -LiteralPath (Join-Path $projectRoot "client\src") -Destination (Join-Path $distRootFull "app\client\src") -Recurse
Copy-Item -LiteralPath (Join-Path $projectRoot "client\public") -Destination (Join-Path $distRootFull "app\client\public") -Recurse
Copy-Item -LiteralPath (Join-Path $projectRoot "src\core") -Destination (Join-Path $distRootFull "app\src\core") -Recurse
Copy-Item -LiteralPath (Join-Path $projectRoot "docs\INTERFACE_CONTRACT.md") -Destination (Join-Path $distRootFull "resources\app\docs\INTERFACE_CONTRACT.md")
Copy-Item -LiteralPath (Join-Path $projectRoot "docs\API_MATRIX.md") -Destination (Join-Path $distRootFull "resources\app\docs\API_MATRIX.md")
Copy-Item -LiteralPath (Join-Path $projectRoot "docs\DEPLOYMENT_AND_MIGRATION_GUIDE.md") -Destination (Join-Path $distRootFull "resources\app\docs\DEPLOYMENT_AND_MIGRATION_GUIDE.md")
Copy-Item -LiteralPath (Join-Path $projectRoot "docs\INTERNAL_TRIAL_CHECKLIST.md") -Destination (Join-Path $distRootFull "resources\app\docs\INTERNAL_TRIAL_CHECKLIST.md")
Copy-Item -LiteralPath (Join-Path $projectRoot "docs\PILOT_RUNBOOK.md") -Destination (Join-Path $distRootFull "resources\app\docs\PILOT_RUNBOOK.md")
Copy-Item -LiteralPath (Join-Path $projectRoot "docs\PILOT_ACCEPTANCE_CRITERIA.md") -Destination (Join-Path $distRootFull "resources\app\docs\PILOT_ACCEPTANCE_CRITERIA.md")
Copy-Item -LiteralPath (Join-Path $projectRoot "docs\PILOT_SUPPORT_GUIDE.md") -Destination (Join-Path $distRootFull "resources\app\docs\PILOT_SUPPORT_GUIDE.md")
Get-ChildItem -LiteralPath (Join-Path $projectRoot "client\resources\bin\win32") |
  ForEach-Object {
    Copy-Item -LiteralPath $_.FullName -Destination (Join-Path $distRootFull "resources\bin\win32") -Recurse -Force
  }

$appPackageJson = @'
{
  "version": "__APP_VERSION__",
  "type": "module"
}
'@
[System.IO.File]::WriteAllText((Join-Path $distRootFull "app\package.json"), $appPackageJson.Replace("__APP_VERSION__", $appVersion), [System.Text.UTF8Encoding]::new($false))

if (!$SkipBinaryCheck) {
  foreach ($name in @("sing-box.exe", "rclone.exe")) {
    $path = Join-Path $distRootFull "resources\bin\win32\$name"
    if (!(Test-Path -LiteralPath $path)) {
      throw "Missing bundled binary: $path. Run .\client\scripts\download-binaries.ps1 first."
    }
  }
}

$clientExe = Join-Path $distRootFull "Syncraft.exe"
$launcherSource = Join-Path $projectRoot "client\src\Launcher.cs"
& $cscExe /nologo /target:winexe /platform:x64 /optimize+ /out:$clientExe /reference:System.Windows.Forms.dll $launcherSource
if ($LASTEXITCODE -ne 0) {
  throw "Failed to compile Windows launcher."
}

$manifestFiles = @(
  @{ name = "Syncraft.exe"; path = Join-Path $distRootFull "Syncraft.exe" },
  @{ name = "app/package.json"; path = Join-Path $distRootFull "app\package.json" },
  @{ name = "app/client/src/clientServer.js"; path = Join-Path $distRootFull "app\client\src\clientServer.js" },
  @{ name = "app/client/src/paths.js"; path = Join-Path $distRootFull "app\client\src\paths.js" },
  @{ name = "app/client/src/store.js"; path = Join-Path $distRootFull "app\client\src\store.js" },
  @{ name = "app/client/src/diagnosticBundle.js"; path = Join-Path $distRootFull "app\client\src\diagnosticBundle.js" },
  @{ name = "app/client/src/processRunner.js"; path = Join-Path $distRootFull "app\client\src\processRunner.js" },
  @{ name = "app/client/src/rcloneStats.js"; path = Join-Path $distRootFull "app\client\src\rcloneStats.js" },
  @{ name = "app/client/src/profileImport.js"; path = Join-Path $distRootFull "app\client\src\profileImport.js" },
  @{ name = "app/client/src/launcher.cjs"; path = Join-Path $distRootFull "app\client\src\launcher.cjs" },
  @{ name = "app/client/src/Launcher.cs"; path = Join-Path $distRootFull "app\client\src\Launcher.cs" },
  @{ name = "app/client/public/index.html"; path = Join-Path $distRootFull "app\client\public\index.html" },
  @{ name = "app/client/public/app.js"; path = Join-Path $distRootFull "app\client\public\app.js" },
  @{ name = "app/client/public/styles.css"; path = Join-Path $distRootFull "app\client\public\styles.css" },
  @{ name = "app/src/core/index.js"; path = Join-Path $distRootFull "app\src\core\index.js" },
  @{ name = "resources/app/docs/INTERFACE_CONTRACT.md"; path = Join-Path $distRootFull "resources\app\docs\INTERFACE_CONTRACT.md" },
  @{ name = "resources/app/docs/API_MATRIX.md"; path = Join-Path $distRootFull "resources\app\docs\API_MATRIX.md" },
  @{ name = "resources/app/docs/DEPLOYMENT_AND_MIGRATION_GUIDE.md"; path = Join-Path $distRootFull "resources\app\docs\DEPLOYMENT_AND_MIGRATION_GUIDE.md" },
  @{ name = "resources/app/docs/INTERNAL_TRIAL_CHECKLIST.md"; path = Join-Path $distRootFull "resources\app\docs\INTERNAL_TRIAL_CHECKLIST.md" },
  @{ name = "resources/app/docs/PILOT_RUNBOOK.md"; path = Join-Path $distRootFull "resources\app\docs\PILOT_RUNBOOK.md" },
  @{ name = "resources/app/docs/PILOT_ACCEPTANCE_CRITERIA.md"; path = Join-Path $distRootFull "resources\app\docs\PILOT_ACCEPTANCE_CRITERIA.md" },
  @{ name = "resources/app/docs/PILOT_SUPPORT_GUIDE.md"; path = Join-Path $distRootFull "resources\app\docs\PILOT_SUPPORT_GUIDE.md" },
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
  package = "SyncraftClient"
  version = $appVersion
  builtAt = (Get-Date).ToUniversalTime().ToString("o")
  sourceTreeHash = $sourceFingerprint.hash
  buildId = $sourceFingerprint.buildId
  sourceFingerprint = $sourceFingerprint
  files = $manifestFiles
}
$releaseManifestJson = $releaseManifest | ConvertTo-Json -Depth 5
[System.IO.File]::WriteAllText((Join-Path $distRootFull "release-manifest.json"), $releaseManifestJson, [System.Text.UTF8Encoding]::new($false))

Get-Item $clientExe,
  (Join-Path $distRootFull "release-manifest.json"),
  (Join-Path $distRootFull "runtime\node.exe"),
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
"$zipHash  SyncraftClient.zip" | Set-Content -LiteralPath $checksumPathFull -Encoding ASCII
Get-Item -LiteralPath $zipPathFull | Select-Object FullName, Length, LastWriteTime
Get-Item -LiteralPath $checksumPathFull | Select-Object FullName, Length, LastWriteTime
