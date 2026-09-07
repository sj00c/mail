param(
  [Parameter(Mandatory = $true)][string]$BunPath,
  [Parameter(Mandatory = $true)][string]$LogPath
)

# This entrypoint only runs the already-built app. Never build on login.
# Use UTF-8 consistently with the installer, including on PowerShell 5.1.
$ErrorActionPreference = "Stop"
try {
  Set-Location -LiteralPath (Join-Path $PSScriptRoot "..")
  if (-not (Test-Path -LiteralPath $BunPath -PathType Leaf)) { throw "Bun executable missing: $BunPath. Run deploy/install.ps1 again." }
  if (-not (Test-Path -LiteralPath "dist/index.html")) { throw "dist/index.html missing. Run deploy/install.ps1 again." }
  $env:NODE_ENV = "production"
  $env:HOST = "127.0.0.1"
  Add-Content -LiteralPath $LogPath -Encoding UTF8 -Value "Starting Mail $(Get-Date -Format o)"
  # Native stderr includes normal Bun diagnostics on Windows PowerShell 5.1.
  $ErrorActionPreference = "Continue"
  $global:LASTEXITCODE = $null
  & $BunPath --use-system-ca server/index.ts 2>&1 |
    ForEach-Object { [string]$_ } | Out-File -LiteralPath $LogPath -Append -Encoding UTF8
  $code = $global:LASTEXITCODE
  $ErrorActionPreference = "Stop"
  if ($null -eq $code) { throw "Bun process did not start." }
  Add-Content -LiteralPath $LogPath -Encoding UTF8 -Value "Mail exited: $code ($(Get-Date -Format o))"
  exit $code
}
catch {
  Add-Content -LiteralPath $LogPath -Encoding UTF8 -Value "Mail launch failed: $($_.Exception.Message)"
  exit 1
}
