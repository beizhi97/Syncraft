function Assert-ReportTextSafe {
  param(
    [AllowNull()][object]$Value,
    [string]$Label = "report"
  )

  if ($null -eq $Value) {
    $text = ""
  } elseif ($Value -is [array]) {
    $text = ($Value | ForEach-Object { "$_" }) -join "`n"
  } else {
    $text = "$Value"
  }

  $patterns = @(
    @{ Name = "SyncKey"; Pattern = 'SFSC1-[A-Za-z0-9_-]+' },
    @{ Name = "sfsc import URI"; Pattern = 'sfsc://import/v1#' },
    @{ Name = "VLESS URI"; Pattern = 'vless://' },
    @{ Name = "SSH private key"; Pattern = '-----BEGIN OPENSSH PRIVATE KEY-----|BEGIN OPENSSH PRIVATE KEY' },
    @{ Name = "private key"; Pattern = '-----BEGIN [A-Z ]*PRIVATE KEY-----' },
    @{ Name = "admin token assignment"; Pattern = '\b(?:SFSC_ADMIN_TOKEN|ADMIN_TOKEN)\s*[:=]\s*["'']?[^"'',\s*.<>][^"'',\s]*' },
    @{ Name = "S3 secret assignment"; Pattern = '\b(?:S3_SECRET_ACCESS_KEY|MINIO_ROOT_PASSWORD)\s*[:=]\s*["'']?[^"'',\s*.<>][^"'',\s]*' },
    @{ Name = "secretAccessKey field"; Pattern = '["'']?secretAccessKey["'']?\s*[:=]\s*["''](?!\*{2,}|redacted|\[redacted\]|<redacted>|safe-|example|secretRef\b)[^"'']{4,}["'']' },
    @{ Name = "heartbeatSecret field"; Pattern = '["'']?heartbeatSecret["'']?\s*[:=]\s*["''](?!\*{2,}|redacted|\[redacted\]|<redacted>|safe-|example|secretRef\b)[^"'']{4,}["'']' },
    @{ Name = "heartbeat secret field"; Pattern = '["'']?heartbeat\.secret["'']?\s*[:=]\s*["''](?!\*{2,}|redacted|\[redacted\]|<redacted>|safe-|example|secretRef\b)[^"'']{4,}["'']' }
  )

  foreach ($entry in $patterns) {
    if ([regex]::IsMatch($text, $entry.Pattern, [System.Text.RegularExpressions.RegexOptions]::IgnoreCase)) {
      throw "$Label contains sensitive-looking $($entry.Name); refusing to write report."
    }
  }
}

function Assert-ReportObjectSafe {
  param(
    [AllowNull()][object]$Value,
    [string]$Label = "JSON report",
    [int]$Depth = 12
  )

  $json = if ($null -eq $Value) { "" } else { $Value | ConvertTo-Json -Depth $Depth }
  Assert-ReportTextSafe $json $Label
}

function Write-SafeTextReport {
  param(
    [string]$Path,
    [AllowNull()][object]$Value,
    [string]$Label = $Path
  )

  Assert-ReportTextSafe $Value $Label
  Set-Content -LiteralPath $Path -Value $Value -Encoding UTF8
}

function Write-SafeJsonReport {
  param(
    [string]$Path,
    [AllowNull()][object]$Value,
    [string]$Label = $Path,
    [int]$Depth = 12
  )

  $json = if ($null -eq $Value) { "null" } else { $Value | ConvertTo-Json -Depth $Depth }
  Assert-ReportTextSafe $json $Label
  [System.IO.File]::WriteAllText($Path, $json, [System.Text.UTF8Encoding]::new($false))
}

function Assert-ReportFileSafe {
  param(
    [string]$Path,
    [string]$Label = $Path
  )

  if (!(Test-Path -LiteralPath $Path -PathType Leaf)) {
    throw "Report file not found for safety scan: $Path"
  }
  Assert-ReportTextSafe (Get-Content -LiteralPath $Path -Raw) $Label
}

function Copy-SafeReport {
  param(
    [string]$Source,
    [string]$Destination,
    [string]$Label = $Source
  )

  Assert-ReportFileSafe $Source $Label
  Copy-Item -LiteralPath $Source -Destination $Destination -Force
}
