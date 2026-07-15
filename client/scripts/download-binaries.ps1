param(
  [string]$OutDir = "",
  [string]$LockFile = "",
  [string]$SingBoxVersion = "",
  [string]$RcloneVersion = "",
  [switch]$Force
)

$ErrorActionPreference = "Stop"

$clientRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
if (!$OutDir) {
  $OutDir = Join-Path $clientRoot "resources\bin\win32"
}
if (!$LockFile) {
  $LockFile = Join-Path $clientRoot "resources\bin\win32\binaries.lock.json"
}
$OutDir = [System.IO.Path]::GetFullPath($OutDir)
$LockFile = [System.IO.Path]::GetFullPath($LockFile)
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

function Read-BinaryLock($path) {
  if (!(Test-Path -LiteralPath $path -PathType Leaf)) {
    throw "Binary lock file not found: $path"
  }
  $lock = Get-Content -LiteralPath $path -Raw | ConvertFrom-Json
  if ($lock.schemaVersion -ne 1 -or !$lock.tools) {
    throw "Binary lock file is invalid: $path"
  }
  return $lock
}

function Get-ToolLock($lock, $name) {
  $property = $lock.tools.PSObject.Properties[$name]
  if (!$property -or !$property.Value) {
    throw "Binary lock file is missing tool: $name"
  }
  return $property.Value
}

function Get-ExpectedHash($tool) {
  $hash = "$($tool.sha256)".Trim().ToLowerInvariant()
  if ($hash -and $hash -notmatch '^[a-f0-9]{64}$') {
    throw "Invalid SHA256 in binary lock for $($tool.exe): $hash"
  }
  return $hash
}

function Test-ExistingBinary($path, $expectedHash) {
  if (!(Test-Path -LiteralPath $path -PathType Leaf)) {
    return $false
  }
  if (!$expectedHash) {
    Write-Host "$(Split-Path -Leaf $path) already exists; no lock hash is available, skipping."
    return $true
  }
  $actual = (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($actual -eq $expectedHash) {
    Write-Host "$(Split-Path -Leaf $path) already exists and matches binaries.lock.json."
    return $true
  }
  if (!$Force) {
    throw "$(Split-Path -Leaf $path) exists but does not match binaries.lock.json. Use -Force to download the locked version."
  }
  Write-Host "$(Split-Path -Leaf $path) hash mismatch; -Force set, replacing it."
  Remove-Item -LiteralPath $path -Force
  return $false
}

function Get-Release($repo, $tag) {
  $headers = @{ "User-Agent" = "singbox-folder-sync-client-builder" }
  if ($tag -eq "latest") {
    return Invoke-RestMethod -Headers $headers -Uri "https://api.github.com/repos/$repo/releases/latest"
  }
  return Invoke-RestMethod -Headers $headers -Uri "https://api.github.com/repos/$repo/releases/tags/$tag"
}

function Resolve-ToolVersion($tool, $overrideVersion) {
  if ($overrideVersion) {
    return [pscustomobject]@{
      Version = $overrideVersion.TrimStart("v")
      Tag = if ($overrideVersion -eq "latest") { "latest" } else { "v$($overrideVersion.TrimStart("v"))" }
      ExpectedHash = ""
    }
  }
  return [pscustomobject]@{
    Version = "$($tool.version)"
    Tag = "$($tool.tag)"
    ExpectedHash = Get-ExpectedHash $tool
  }
}

function Install-Tool($name, $tool, $overrideVersion, $tmp) {
  $resolved = Resolve-ToolVersion $tool $overrideVersion
  $exePath = Join-Path $OutDir $tool.exe
  if (Test-ExistingBinary $exePath $resolved.ExpectedHash) {
    return
  }

  $repo = "$($tool.repo)"
  $assetPattern = "$($tool.assetPattern)"
  $assetRejectPattern = "$($tool.assetRejectPattern)"
  Write-Host "Resolving $name $($resolved.Tag) from $repo..."
  $release = Get-Release $repo $resolved.Tag
  $asset = $release.assets |
    Where-Object {
      $_.name -match $assetPattern -and (!$assetRejectPattern -or $_.name -notmatch $assetRejectPattern)
    } |
    Select-Object -First 1
  if (!$asset) {
    throw "Could not find $name windows-amd64 zip in release $($resolved.Tag)."
  }

  $headers = @{ "User-Agent" = "singbox-folder-sync-client-builder" }
  $zipPath = Join-Path $tmp $asset.name
  $extractDir = Join-Path $tmp $name
  Write-Host "Downloading $($asset.name)..."
  Invoke-WebRequest -Headers $headers -Uri $asset.browser_download_url -OutFile $zipPath
  Expand-Archive -LiteralPath $zipPath -DestinationPath $extractDir -Force
  $exe = Get-ChildItem -LiteralPath $extractDir -Recurse -Filter $tool.exe | Select-Object -First 1
  if (!$exe) {
    throw "$($tool.exe) not found after extraction."
  }
  Copy-Item -LiteralPath $exe.FullName -Destination $exePath -Force

  $actualHash = (Get-FileHash -LiteralPath $exePath -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($resolved.ExpectedHash -and $actualHash -ne $resolved.ExpectedHash) {
    throw "$($tool.exe) SHA256 mismatch after download. Expected $($resolved.ExpectedHash), got $actualHash."
  }
  Write-Host "$($tool.exe) installed: version=$($resolved.Version), sha256=$actualHash"
}

$lock = Read-BinaryLock $LockFile
$tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("sfsc-bin-" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Force -Path $tmp | Out-Null

try {
  Install-Tool "sing-box" (Get-ToolLock $lock "sing-box") $SingBoxVersion $tmp
  Install-Tool "rclone" (Get-ToolLock $lock "rclone") $RcloneVersion $tmp

  Get-Item (Join-Path $OutDir "sing-box.exe"), (Join-Path $OutDir "rclone.exe") |
    Select-Object FullName, Length, LastWriteTime
}
finally {
  if (Test-Path -LiteralPath $tmp) {
    Remove-Item -LiteralPath $tmp -Recurse -Force
  }
}
