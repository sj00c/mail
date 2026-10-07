# One-line install and update for Windows. Nothing needs to be installed first:
#   powershell -NoProfile -ExecutionPolicy Bypass -Command "irm https://raw.githubusercontent.com/sj00c/mail/main/deploy/bootstrap.ps1 | iex"
# With setup options, e.g. migrating from a specific old folder:
#   & ([scriptblock]::Create((irm https://raw.githubusercontent.com/sj00c/mail/main/deploy/bootstrap.ps1))) --from "C:\old\mail"
# Installs Bun with its official installer when missing, then runs
# `bun x --bun @sj00c/mail@latest setup`, which does everything else.
# This text runs inside the caller's session, so it never calls exit.
$setupArgs = @($args)
& {
  $ErrorActionPreference = "Stop"
  $ProgressPreference = "SilentlyContinue"
  # Windows PowerShell 5.1 may otherwise negotiate obsolete TLS versions.
  [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
  $bunHome = if ($env:BUN_INSTALL) { $env:BUN_INSTALL } else { Join-Path $env:USERPROFILE ".bun" }
  $bunExe = Join-Path $bunHome "bin\bun.exe"
  $found = Get-Command bun -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
  $bun = if ($found) { $found.Source } elseif (Test-Path -LiteralPath $bunExe -PathType Leaf) { $bunExe } else { $null }
  try {
    if (-not $bun) {
      Write-Host "  Installing Bun with the official installer (bun.sh)..."
      # A child process keeps any exit in the installer out of this session.
      $powershell = Join-Path $env:SystemRoot "System32\WindowsPowerShell\v1.0\powershell.exe"
      & $powershell -NoProfile -ExecutionPolicy Bypass -Command "[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12; irm https://bun.sh/install.ps1 | iex"
      if (-not (Test-Path -LiteralPath $bunExe -PathType Leaf)) { throw "Bun was not installed at $bunExe. Check the internet connection to bun.sh and run this command again." }
      $bun = $bunExe
    }
    # SJ_MAIL_PACKAGE_SPEC (file:<tgz>) lets tests run an unpublished package.
    $package = if ($env:SJ_MAIL_PACKAGE_SPEC) { $env:SJ_MAIL_PACKAGE_SPEC } else { "@sj00c/mail@latest" }
    & $bun x --bun --package $package sj-mail setup @setupArgs
    if ($LASTEXITCODE -ne 0) { Write-Host "  Setup did not finish. Fix the reported problem and run the same command again." -ForegroundColor Red }
  }
  catch { Write-Host "  Mail setup could not start: $($_.Exception.Message)" -ForegroundColor Red }
}
