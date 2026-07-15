param(
  [switch]$RunStrictPreflight
)

$ErrorActionPreference = "Stop"

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
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

function Run-Step($name, $script) {
  Write-Host "[sfsc-ci] $name"
  & $script
  if ($LASTEXITCODE -ne 0) {
    throw "CI step failed: $name (exit code $LASTEXITCODE)"
  }
}

Push-Location $repoRoot
try {
  Run-Step "Release audit" {
    & $node scripts/audit-release.mjs
  }

  Run-Step "Node test suite" {
    & $node --test "tests/*.test.js"
  }

  if ($RunStrictPreflight) {
    Run-Step "Strict release preflight" {
      & powershell -NoProfile -ExecutionPolicy Bypass -File scripts/preflight-release.ps1
    }
  }

  Write-Host "[sfsc-ci] CI verification passed."
} finally {
  Pop-Location
}
