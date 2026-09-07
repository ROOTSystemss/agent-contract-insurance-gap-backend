param(
  [string]$CredentialSource = "",
  [string]$DatabaseName = "authority_atlas",
  [string]$ApplicationRole = "authority_atlas_app"
)

$ErrorActionPreference = "Stop"
$projectDirectory = Split-Path -Parent $PSScriptRoot
$envPath = Join-Path $projectDirectory ".env"
$psqlPath = "C:\Program Files\PostgreSQL\17\bin\psql.exe"
$createdbPath = "C:\Program Files\PostgreSQL\17\bin\createdb.exe"
if (-not $CredentialSource) {
  $CredentialSource = Join-Path (Split-Path -Parent $projectDirectory) "hipaa-compliance\.env"
}

if (Test-Path -LiteralPath $envPath) { throw ".env already exists; refusing to overwrite it." }
foreach ($requiredPath in @($CredentialSource, $psqlPath, $createdbPath)) {
  if (-not (Test-Path -LiteralPath $requiredPath)) { throw "Required path was not found: $requiredPath" }
}
if ($DatabaseName -notmatch '^[a-z][a-z0-9_]{0,62}$') { throw "Unsafe database name." }
if ($ApplicationRole -notmatch '^[a-z][a-z0-9_]{0,62}$') { throw "Unsafe application role." }

$sourceText = Get-Content -LiteralPath $CredentialSource -Raw
$sourceMatch = [regex]::Match(
  $sourceText,
  '(?im)^DATABASE_URL\s*=\s*postgres(?:ql)?://(?<user>[^:@/\s]+):(?<password>[^@\s]*)@(?<host>[^:/\s]+):(?<port>\d+)/'
)
if (-not $sourceMatch.Success) { throw "Credential source has no parseable PostgreSQL URL." }
$adminUser = $sourceMatch.Groups['user'].Value
$adminPassword = [Uri]::UnescapeDataString($sourceMatch.Groups['password'].Value)
$databaseHost = $sourceMatch.Groups['host'].Value
$databasePort = [int]$sourceMatch.Groups['port'].Value

$passwordBytes = New-Object byte[] 32
$jwtBytes = New-Object byte[] 48
$encryptionBytes = New-Object byte[] 32
$random = [Security.Cryptography.RandomNumberGenerator]::Create()
try {
  $random.GetBytes($passwordBytes)
  $random.GetBytes($jwtBytes)
  $random.GetBytes($encryptionBytes)
}
finally { $random.Dispose() }
$applicationPassword = -join ($passwordBytes | ForEach-Object { $_.ToString("x2") })
$jwtSecret = [Convert]::ToBase64String($jwtBytes)
$documentEncryptionKey = [Convert]::ToBase64String($encryptionBytes)

$env:PGPASSWORD = $adminPassword
try {
  $adminCheck = & $psqlPath -w -h $databaseHost -p $databasePort -U $adminUser -d postgres -tAc "SELECT 1;"
  if ($LASTEXITCODE -ne 0 -or $adminCheck.Trim() -ne "1") { throw "Stored PostgreSQL credential is invalid." }

  $roleExists = & $psqlPath -w -h $databaseHost -p $databasePort -U $adminUser -d postgres -tAc "SELECT 1 FROM pg_roles WHERE rolname = '$ApplicationRole';"
  if (("$roleExists").Trim() -eq "1") {
    & $psqlPath -w -h $databaseHost -p $databasePort -U $adminUser -d postgres -v ON_ERROR_STOP=1 -c "ALTER ROLE $ApplicationRole WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD '$applicationPassword';"
  }
  else {
    & $psqlPath -w -h $databaseHost -p $databasePort -U $adminUser -d postgres -v ON_ERROR_STOP=1 -c "CREATE ROLE $ApplicationRole WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD '$applicationPassword';"
  }
  if ($LASTEXITCODE -ne 0) { throw "Could not configure the isolated application role." }

  $databaseExists = & $psqlPath -w -h $databaseHost -p $databasePort -U $adminUser -d postgres -tAc "SELECT 1 FROM pg_database WHERE datname = '$DatabaseName';"
  if (("$databaseExists").Trim() -ne "1") {
    & $createdbPath -w -h $databaseHost -p $databasePort -U $adminUser -O $ApplicationRole $DatabaseName
    if ($LASTEXITCODE -ne 0) { throw "Could not create the Authority Atlas database." }
  }
  else {
    & $psqlPath -w -h $databaseHost -p $databasePort -U $adminUser -d postgres -v ON_ERROR_STOP=1 -c "GRANT CONNECT, TEMPORARY ON DATABASE $DatabaseName TO $ApplicationRole;"
    & $psqlPath -w -h $databaseHost -p $databasePort -U $adminUser -d $DatabaseName -v ON_ERROR_STOP=1 -c "GRANT USAGE, CREATE ON SCHEMA public TO $ApplicationRole; GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO $ApplicationRole; GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO $ApplicationRole;"
    if ($LASTEXITCODE -ne 0) { throw "Could not grant access to the existing Authority Atlas database." }
  }

  $env:PGPASSWORD = $applicationPassword
  $appCheck = & $psqlPath -w -h $databaseHost -p $databasePort -U $ApplicationRole -d $DatabaseName -tAc "SELECT current_user;"
  if ($LASTEXITCODE -ne 0 -or $appCheck.Trim() -ne $ApplicationRole) { throw "Application-role verification failed." }

  $settings = @(
    "NODE_ENV=development",
    "HOST=127.0.0.1",
    "PORT=4400",
    "DATABASE_URL=postgresql://${ApplicationRole}:${applicationPassword}@${databaseHost}:${databasePort}/${DatabaseName}?schema=public",
    "JWT_SECRET=$jwtSecret",
    "JWT_EXPIRES_IN=1h",
    "CORS_ORIGINS=http://localhost:4400,http://127.0.0.1:4400",
    "PERSISTENCE_DRIVER=postgres",
    "UPLOAD_DIRECTORY=./uploads",
    "DOCUMENT_ENCRYPTION_KEY=$documentEncryptionKey",
    "MAX_FILE_SIZE_BYTES=10485760",
    "DOCUMENT_RETENTION_DAYS=30",
    "RETENTION_SWEEP_INTERVAL_MS=3600000",
    "RATE_LIMIT_MAX=100",
    "RATE_LIMIT_WINDOW=1 minute",
    "LOG_LEVEL=info",
    "TRUST_PROXY=false"
  )
  [IO.File]::WriteAllLines($envPath, $settings, [Text.UTF8Encoding]::new($false))
}
finally {
  $adminPassword = $null
  $applicationPassword = $null
  Remove-Item Env:PGPASSWORD -ErrorAction SilentlyContinue
}

Push-Location $projectDirectory
try {
  npm.cmd run prisma:generate
  if ($LASTEXITCODE -ne 0) { throw "Prisma client generation failed." }
  npm.cmd run prisma:deploy
  if ($LASTEXITCODE -ne 0) { throw "Prisma migration deployment failed." }
  Write-Host "Authority Atlas now has an isolated PostgreSQL database and application role." -ForegroundColor Green
}
finally { Pop-Location }
