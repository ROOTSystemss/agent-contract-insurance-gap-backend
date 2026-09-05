param(
  [string]$Database = "authority_atlas",
  [string]$DatabaseUser = "postgres",
  [int]$Port = 54329
)

$ErrorActionPreference = "Stop"
$projectDirectory = Split-Path -Parent $PSScriptRoot
$envPath = Join-Path $projectDirectory ".env"
$psqlPath = "C:\Program Files\PostgreSQL\17\bin\psql.exe"

if (-not (Test-Path -LiteralPath $psqlPath)) {
  throw "PostgreSQL 17 psql.exe was not found at the expected location."
}

$securePassword = Read-Host "Enter the PostgreSQL password for $DatabaseUser" -AsSecureString
$passwordPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($securePassword)
$plainPassword = $null

try {
  $plainPassword = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($passwordPointer)
  $encodedPassword = [Uri]::EscapeDataString($plainPassword)
  $databaseUrl = "postgresql://${DatabaseUser}:${encodedPassword}@127.0.0.1:${Port}/${Database}?schema=public"

  $jwtBytes = New-Object byte[] 48
  [Security.Cryptography.RandomNumberGenerator]::Fill($jwtBytes)
  $jwtSecret = [Convert]::ToBase64String($jwtBytes)

  $settings = @(
    "NODE_ENV=development",
    "HOST=127.0.0.1",
    "PORT=4400",
    "DATABASE_URL=$databaseUrl",
    "JWT_SECRET=$jwtSecret",
    "JWT_EXPIRES_IN=1h",
    "CORS_ORIGINS=http://localhost:4400,http://127.0.0.1:4400",
    "PERSISTENCE_DRIVER=postgres",
    "UPLOAD_DIRECTORY=./uploads",
    "MAX_FILE_SIZE_BYTES=10485760",
    "DOCUMENT_RETENTION_DAYS=30",
    "RATE_LIMIT_MAX=100",
    "RATE_LIMIT_WINDOW=1 minute",
    "LOG_LEVEL=info",
    "TRUST_PROXY=false"
  )

  [IO.File]::WriteAllLines($envPath, $settings, [Text.UTF8Encoding]::new($false))
  $env:PGPASSWORD = $plainPassword

  & $psqlPath -w -h 127.0.0.1 -p $Port -U $DatabaseUser -d $Database -tAc "SELECT 1;" | Out-Null
  if ($LASTEXITCODE -ne 0) {
    throw "PostgreSQL authentication failed. The .env file was created, but migrations were not applied."
  }

  Push-Location $projectDirectory
  try {
    & npm.cmd run prisma:generate
    if ($LASTEXITCODE -ne 0) { throw "Prisma client generation failed." }
    & npm.cmd run prisma:deploy
    if ($LASTEXITCODE -ne 0) { throw "Database migration failed." }
  }
  finally {
    Pop-Location
  }

  Write-Host "PostgreSQL connection verified and migrations applied successfully." -ForegroundColor Green
  Write-Host "The application is configured for persistent storage."
}
finally {
  if ($passwordPointer -ne [IntPtr]::Zero) {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($passwordPointer)
  }
  $plainPassword = $null
  Remove-Item Env:PGPASSWORD -ErrorAction SilentlyContinue
}
