param([string]$OutputDirectory = "backups")

$ErrorActionPreference = "Stop"
$projectDirectory = Split-Path -Parent $PSScriptRoot
$envPath = Join-Path $projectDirectory ".env"
$pgDumpPath = "C:\Program Files\PostgreSQL\17\bin\pg_dump.exe"
$psqlPath = "C:\Program Files\PostgreSQL\17\bin\psql.exe"

if (-not (Test-Path -LiteralPath $envPath)) { throw "The local .env file does not exist." }
if (-not (Test-Path -LiteralPath $pgDumpPath)) { throw "PostgreSQL 17 pg_dump.exe was not found." }

$databaseUrlLine = Get-Content -LiteralPath $envPath | Where-Object { $_ -match '^DATABASE_URL=' } | Select-Object -First 1
if (-not $databaseUrlLine) { throw "DATABASE_URL is missing from .env." }
$databaseUri = [Uri](($databaseUrlLine -split '=', 2)[1])
$userParts = $databaseUri.UserInfo -split ':', 2
$databaseUser = [Uri]::UnescapeDataString($userParts[0])
$databasePassword = if ($userParts.Length -eq 2) { [Uri]::UnescapeDataString($userParts[1]) } else { "" }
$database = $databaseUri.AbsolutePath.TrimStart('/')
$port = if ($databaseUri.Port -gt 0) { $databaseUri.Port } else { 5432 }
$resolvedOutput = [IO.Path]::GetFullPath((Join-Path $projectDirectory $OutputDirectory))
$resolvedProject = [IO.Path]::GetFullPath($projectDirectory)
$resolvedProjectPrefix = $resolvedProject.TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar

if (-not $resolvedOutput.StartsWith($resolvedProjectPrefix, [StringComparison]::OrdinalIgnoreCase)) {
  throw "The backup directory must remain inside the project directory."
}

$env:PGPASSWORD = $databasePassword
try {
  $databaseBytes = & $psqlPath -w -h $databaseUri.Host -p $port -U $databaseUser -d $database -tAc "SELECT pg_database_size(current_database());"
  if ($LASTEXITCODE -ne 0) { throw "Could not determine database size." }
  $requiredBytes = [int64]$databaseBytes * 2 + 500MB
  $drive = Get-PSDrive -Name ([IO.Path]::GetPathRoot($resolvedOutput).Substring(0, 1))
  if ($null -ne $drive.Free -and $drive.Free -lt $requiredBytes) {
    throw "Insufficient free space for a safe database backup."
  }

  [IO.Directory]::CreateDirectory($resolvedOutput) | Out-Null
  $timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
  $target = Join-Path $resolvedOutput "authority-atlas-$timestamp.dump"
  & $pgDumpPath -w -h $databaseUri.Host -p $port -U $databaseUser -d $database --format=custom --compress=9 --file=$target
  if ($LASTEXITCODE -ne 0) { throw "PostgreSQL backup failed." }
  Write-Host "Database backup created: $target" -ForegroundColor Green
  Write-Host "Treat this file as confidential and store it only on an encrypted drive."
}
finally {
  $databasePassword = $null
  Remove-Item Env:PGPASSWORD -ErrorAction SilentlyContinue
}
