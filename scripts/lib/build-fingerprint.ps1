function Get-SourceTreeFingerprint {
  param(
    [Parameter(Mandatory = $true)]
    [string]$RepoRoot
  )

  $repoRootFull = [System.IO.Path]::GetFullPath($RepoRoot)
  $entries = @()
  foreach ($path in Get-SourceFingerprintFiles $repoRootFull) {
    $relative = Get-FingerprintRelativePath $repoRootFull $path
    $hash = Get-Sha256HexFromFile $path
    $item = Get-Item -LiteralPath $path
    $entries += [pscustomobject]@{
      path = $relative
      size = [int64]$item.Length
      sha256 = $hash
    }
  }

  $hashInput = ($entries | ForEach-Object { "$($_.path)`t$($_.size)`t$($_.sha256)" }) -join "`n"
  $sourceTreeHash = Get-Sha256HexFromText $hashInput
  return [ordered]@{
    algorithm = "sfsc-source-tree-sha256-v1"
    hash = $sourceTreeHash
    buildId = "sfsc-$($sourceTreeHash.Substring(0, 12))"
    fileCount = @($entries).Count
    inputs = $entries
  }
}

function Get-SourceFingerprintFiles($repoRootFull) {
  $roots = @(
    "package.json",
    "pnpm-lock.yaml",
    "pnpm-workspace.yaml",
    "README.md",
    "src",
    "public",
    # The complete server source/runtime tree is shipped in the release bundle.
    # Test-FingerprintBlockedPath below excludes local state and credentials.
    "server",
    # Native source is also shipped in full and fingerprinted independently.
    "native",
    "client\src",
    "client\public",
    "client\electron",
    "client\scripts",
    # The lock pins the exact SHA-256 of every bundled third-party binary, so
    # fingerprinting it transitively fingerprints the binaries themselves (the
    # package smoke verifies the shipped exes against this lock). The exe blobs
    # stay excluded below: they are downloads, not sources, and their identity
    # is exactly what the lock records.
    "client\resources\bin\win32\binaries.lock.json",
    "docs",
    "scripts",
    "tests"
  )
  $files = @()
  foreach ($root in $roots) {
    $path = Join-Path $repoRootFull $root
    if (!(Test-Path -LiteralPath $path)) {
      continue
    }
    $item = Get-Item -LiteralPath $path
    if ($item.PSIsContainer) {
      $files += Get-ChildItem -LiteralPath $path -Recurse -File -Force | ForEach-Object { $_.FullName }
    } else {
      $files += $item.FullName
    }
  }
  return @($files |
    Where-Object { -not (Test-FingerprintBlockedPath (Get-FingerprintRelativePath $repoRootFull $_)) } |
    Sort-Object -Unique { $_.ToLowerInvariant() })
}

function Test-FingerprintBlockedPath($relativePath) {
  $normalized = "$relativePath".Replace("\", "/")
  # These checked-in templates are controlled inputs; all other server env
  # files are runtime credentials/configuration and must stay out of hashes.
  if ($normalized -in @("server/.env.example", "server/.env.directory.example", "server/systemd/sfsc-directory.env.example")) {
    return $false
  }
  foreach ($pattern in @(
    '(^|/)\.git(/|$)',
    '(^|/)node_modules(/|$)',
    '(^|/)\.tmp(/|$)',
    '(^|/)dist(/|$)',
    '(^|/)reports(/|$)',
    '(^|/)__pycache__(/|$)',
    '\.py[co]$',
    '(^|/)\.env$',
    '(^|/)[^/]+\.env\.local$',
    '(^|/)\.env\..+$',
    '^server/\.env$',
    '^server/data(/|$)',
    '^server/sing-box/config\.json$',
    '^server/sing-box/.*\.(key|pem)$',
    '^client/data(/|$)',
    '^client/resources/bin/(?!win32/binaries\.lock\.json$)'
  )) {
    if ($normalized -match $pattern) {
      return $true
    }
  }
  return $false
}

function Get-FingerprintRelativePath($basePath, $childPath) {
  $baseFullPath = [System.IO.Path]::GetFullPath($basePath)
  if (!$baseFullPath.EndsWith([System.IO.Path]::DirectorySeparatorChar)) {
    $baseFullPath = "$baseFullPath$([System.IO.Path]::DirectorySeparatorChar)"
  }
  $childFullPath = [System.IO.Path]::GetFullPath($childPath)
  $baseUri = [System.Uri]::new($baseFullPath)
  $childUri = [System.Uri]::new($childFullPath)
  return [System.Uri]::UnescapeDataString($baseUri.MakeRelativeUri($childUri).ToString()).Replace("/", "\").Replace("\", "/")
}

function Get-Sha256HexFromText($text) {
  $sha256 = [System.Security.Cryptography.SHA256]::Create()
  try {
    $bytes = [System.Text.Encoding]::UTF8.GetBytes("$text")
    $hashBytes = $sha256.ComputeHash($bytes)
    return (($hashBytes | ForEach-Object { $_.ToString("x2") }) -join "")
  } finally {
    $sha256.Dispose()
  }
}

function Get-Sha256HexFromFile($path) {
  $sha256 = [System.Security.Cryptography.SHA256]::Create()
  try {
    $stream = [System.IO.File]::Open(
      $path,
      [System.IO.FileMode]::Open,
      [System.IO.FileAccess]::Read,
      [System.IO.FileShare]::Read
    )
    try {
      $hashBytes = $sha256.ComputeHash($stream)
      return (($hashBytes | ForEach-Object { $_.ToString("x2") }) -join "")
    } finally {
      $stream.Dispose()
    }
  } finally {
    $sha256.Dispose()
  }
}
