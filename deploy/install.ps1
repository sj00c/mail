# Windows automatic startup for the packaged app, called by `sj-mail setup`:
# configuration check, runtime check, scheduled startup, health check.
param(
  [string]$Workspace,
  [string]$BunPath,
  # Run.ps1 of a previous (ZIP/source or other workspace) installation whose
  # MailLocal task this installation takes over.
  [string]$ReplaceRunPath
)
$ErrorActionPreference = "Stop"

if ([System.Environment]::OSVersion.Platform -ne [System.PlatformID]::Win32NT) {
  Write-Host "Windows only." -ForegroundColor Red
  exit 1
}
# Keep non-ASCII paths intact when sj-mail captures this output.
if ([Console]::IsOutputRedirected) { [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false) }

$app = (Resolve-Path "$PSScriptRoot\..").Path
$run = Join-Path $app "deploy\run.ps1"
$owners = @($run)
if (-not [string]::IsNullOrWhiteSpace($ReplaceRunPath)) { $owners += $ReplaceRunPath }
$task = "MailLocal"
$taskPath = "\"
$envFile = if ([string]::IsNullOrWhiteSpace($Workspace)) { $null } else { Join-Path $Workspace ".env" }
$logDir = Join-Path $env:LOCALAPPDATA "MailLocal"
$log = Join-Path $logDir "mail.local.log"
$installLog = Join-Path $logDir "install.log"
$readyTimeout = 60
$stage = "[1/4] Configuration"
$clock = [System.Diagnostics.Stopwatch]::StartNew()
$stageStarted = 0.0
$secrets = @()
$taskMutationStarted = $false
$taskReplacementAttempted = $false
$recoverySnapshot = $null
$serverLaunchAttempted = $false

function Write-InstallLog(
  [string]$Message,
  [ValidateSet("INFO", "RUN", "OK", "WARN", "FAIL", "DETAIL")][string]$Level = "INFO"
) {
  foreach ($secret in $script:secrets) {
    if (-not [string]::IsNullOrEmpty($secret)) { $Message = $Message.Replace($secret, "[REDACTED]") }
  }
  # Strip terminal controls from native output before storing or displaying it.
  $Message = $Message -replace '\x1B\[[0-?]*[ -/]*[@-~]', ''
  $Message = $Message -replace '[\x00-\x08\x0B-\x1F\x7F]', ''
  $line = "[{0:yyyy-MM-dd HH:mm:ss zzz}] [+{1:N1}s] [{2}] {3}" -f (Get-Date), $clock.Elapsed.TotalSeconds, $Level, $Message
  Add-Content -LiteralPath $installLog -Value $line -Encoding UTF8 -ErrorAction Stop
  if ($Level -ne "DETAIL") {
    $color = switch ($Level) {
      "RUN" { "Cyan" }
      "OK" { "Green" }
      "WARN" { "Yellow" }
      "FAIL" { "Red" }
      default { "Gray" }
    }
    Write-Host ("  {0,-5} {1}" -f $Level, $Message) -ForegroundColor $color
  }
}

function Set-InstallStage([string]$Name) {
  Write-InstallLog ("{0} ({1:N1}s)" -f $script:stage, ($clock.Elapsed.TotalSeconds - $script:stageStarted)) -Level OK
  $script:stage = $Name
  $script:stageStarted = $clock.Elapsed.TotalSeconds
  Write-InstallLog $Name -Level RUN
}

function Stop-Install([string]$Message) { throw $Message }

function Invoke-InstallCommand([string]$Executable, [string[]]$CommandArgs) {
  # Windows PowerShell 5.1 turns redirected native stderr into ErrorRecords.
  # Bun writes ordinary progress to stderr; only its exit code denotes failure.
  $previousPreference = $ErrorActionPreference
  try {
    $ErrorActionPreference = "Continue"
    $global:LASTEXITCODE = $null
    & $Executable @CommandArgs 2>&1 | ForEach-Object { Write-InstallLog ([string]$_) -Level DETAIL }
    $code = $global:LASTEXITCODE
  }
  finally { $ErrorActionPreference = $previousPreference }
  if ($null -eq $code) { Stop-Install "Could not launch $Executable. Check the executable path and install log." }
  if ($code -ne 0) { Stop-Install "Command failed (exit $code): $Executable $($CommandArgs -join ' '). See the install log for command output." }
}

function Get-PortOccupant([int]$Port) {
  # Query failures must not silently masquerade as a free port.
  $conn = Get-NetTCPConnection -State Listen -ErrorAction Stop |
    Where-Object { $_.LocalPort -eq $Port } | Select-Object -First 1
  if (-not $conn) { return $null }
  $proc = Get-Process -Id $conn.OwningProcess -ErrorAction SilentlyContinue
  if ($proc) { return "$($proc.ProcessName) (PID $($proc.Id))" }
  return "PID $($conn.OwningProcess)"
}

try {
  New-Item -ItemType Directory -Force -Path $logDir | Out-Null
  # Keep one complete latest attempt; the server log is separate.
  Set-Content -LiteralPath $installLog -Value "Mail Windows installation" -Encoding UTF8
  Write-Host "`n  MAIL / LOCAL DEPLOY" -ForegroundColor White
  Write-Host "  ----------------------------------------------" -ForegroundColor DarkGray
  Write-InstallLog "App: $app"
  Write-InstallLog "Workspace: $Workspace"
  Write-InstallLog "Install log: $installLog"
  Write-InstallLog $stage -Level RUN
  Write-InstallLog "Windows: $([Environment]::OSVersion.VersionString); PowerShell: $($PSVersionTable.PSVersion); CPU: $env:PROCESSOR_ARCHITECTURE" -Level DETAIL
  . (Join-Path $PSScriptRoot "windows-readiness.ps1")

  if ($null -eq $envFile) { Stop-Install "Workspace is required. Run: bunx @sj00c/mail@latest setup" }
  if (-not (Test-Path -LiteralPath $envFile)) {
    Stop-Install ".env is missing in $Workspace. Run sj-mail setup and enter your Google OAuth credentials."
  }
  $values = @{}
  foreach ($rawLine in Get-Content -LiteralPath $envFile -Encoding UTF8) {
    $line = $rawLine.TrimEnd("`r")
    if ([string]::IsNullOrWhiteSpace($line) -or $line.TrimStart().StartsWith("#")) { continue }
    $separator = $line.IndexOf("=")
    if ($separator -lt 1) { continue }
    $values[$line.Substring(0, $separator).Trim()] = $line.Substring($separator + 1)
  }
  $clientId = [string]$values["GOOGLE_CLIENT_ID"]
  $clientSecret = [string]$values["GOOGLE_CLIENT_SECRET"]
  $secrets = @($clientId, $clientSecret)
  $redirect = [string]$values["OAUTH_REDIRECT"]
  $portText = [string]$values["PORT"]
  if ([string]::IsNullOrEmpty($portText)) { $portText = "8787" }
  $port = 0
  if ($portText -notmatch '^\d+$' -or -not [int]::TryParse($portText, [ref]$port) -or $port -lt 1024 -or $port -gt 65535) {
    Stop-Install "PORT must be an integer from 1024 through 65535 (default: 8787)."
  }
  $appUrl = "http://localhost:$port"
  $expectedRedirect = "$appUrl/auth/callback"
  if ([string]::IsNullOrEmpty($redirect)) { $redirect = $expectedRedirect }
  if ([string]::IsNullOrWhiteSpace($clientId)) { Stop-Install "GOOGLE_CLIENT_ID is empty in .env." }
  if ([string]::IsNullOrWhiteSpace($clientSecret)) { Stop-Install "GOOGLE_CLIENT_SECRET is empty in .env." }
  if ($clientId -match '^(your-|\uC5EC\uAE30\uC5D0_)|PLACEHOLDER') { Stop-Install "Replace GOOGLE_CLIENT_ID in .env with your actual Google Client ID." }
  if (-not $clientId.EndsWith(".apps.googleusercontent.com")) { Stop-Install "GOOGLE_CLIENT_ID must end with .apps.googleusercontent.com." }
  if ($clientSecret -match '^(your-|\uC5EC\uAE30\uC5D0_)|PLACEHOLDER') { Stop-Install "Replace GOOGLE_CLIENT_SECRET in .env with your actual Google Client Secret." }
  if ($clientId -match "\s|[`"']" -or $clientSecret -match "\s|[`"']") {
    Stop-Install "Remove quotes and whitespace from the Client ID and Client Secret in .env."
  }
  if ($redirect -ne $expectedRedirect) { Stop-Install "Set OAUTH_REDIRECT=$expectedRedirect in .env to match PORT=$port." }
  if ($port -ne 8787) { Write-InstallLog "Add $expectedRedirect to the authorized redirect URIs in Google Cloud Console." -Level WARN }

  Set-InstallStage "[2/4] Runtime"
  $powershell = Join-Path $env:SystemRoot "System32\WindowsPowerShell\v1.0\powershell.exe"
  # sj-mail setup resolves and version-checks Bun; the task uses this exact
  # absolute path, never the scheduler's PATH.
  if ([string]::IsNullOrWhiteSpace($BunPath) -or -not (Test-Path -LiteralPath $BunPath -PathType Leaf)) {
    Stop-Install "Bun executable not found: $BunPath. Run: bunx @sj00c/mail@latest setup"
  }
  $bun = (Resolve-Path -LiteralPath $BunPath).Path
  Write-InstallLog "Bun: $bun"
  Invoke-InstallCommand -Executable $bun -CommandArgs @("--version")
  if (-not (Test-Path -LiteralPath (Join-Path $app "dist\index.html"))) { Stop-Install "The package has no dist/index.html. Rerun sj-mail setup." }

  Set-InstallStage "[3/4] Automatic startup"
  if (-not (Test-Path -LiteralPath $run -PathType Leaf)) { Stop-Install "deploy/run.ps1 is missing. Rerun sj-mail setup." }
  $action = New-ScheduledTaskAction -Execute $powershell -Argument "-WindowStyle Hidden -NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$run`" -BunPath `"$bun`" -LogPath `"$log`" -Workspace `"$Workspace`"" -WorkingDirectory $Workspace
  $user = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
  $atLogonTrigger = New-ScheduledTaskTrigger -AtLogOn -User $user
  # Omitting RepetitionDuration is the Task Scheduler representation of an
  # indefinite repetition. The first trigger is intentionally immediate; the
  # explicit Start-ScheduledTask below remains idempotent via IgnoreNew.
  $periodicTrigger = New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Minutes 1)
  # New-ScheduledTaskTrigger sets StopAtDurationEnd even without a duration;
  # clear it so a running server is never stopped by the repetition pattern.
  $periodicTrigger.Repetition.StopAtDurationEnd = $false
  $triggers = @($atLogonTrigger, $periodicTrigger)
  $principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
  $settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -MultipleInstances IgnoreNew -StartWhenAvailable `
    -ExecutionTimeLimit (New-TimeSpan -Seconds 0)

  # Validate the exact root task and save its definition before any mutation.
  # A task belonging to another installation is replaced only when setup
  # named it explicitly (migration); otherwise it is never overwritten.
  $existing = Get-MailTask
  if ($existing) {
    Assert-MailTaskOwnership -Task $existing -RunPath $owners
    $recoverySnapshot = Export-MailTaskRecovery -Task $existing
    $taskMutationStarted = $true
    Stop-MailTask -RunPath $owners -WaitTimeoutSeconds 10 -PollMilliseconds 250 | Out-Null
  }
  $occupant = Get-PortOccupant $port
  if ($occupant) {
    Stop-Install "Port $port is occupied by $occupant. Identify the process before stopping it. To use another port, update PORT and OAUTH_REDIRECT in .env and Google Cloud Console."
  }
  $taskMutationStarted = $true
  $taskReplacementAttempted = $true
  Register-ScheduledTask -TaskName $task -TaskPath $taskPath -Action $action -Trigger $triggers -Principal $principal -Settings $settings -Force -ErrorAction Stop | Out-Null
  # A fresh server log avoids showing errors from a previous installation.
  Set-Content -LiteralPath $log -Value "Mail server launch $(Get-Date -Format o)" -Encoding UTF8
  $startedAt = Get-Date
  $serverLaunchAttempted = $true
  Start-ScheduledTask -TaskName $task -TaskPath $taskPath -ErrorAction Stop

  Set-InstallStage "[4/4] Health check"
  $ready = Wait-MailServer -Url "http://127.0.0.1:$port/auth/status" -TaskName $task -StartedAt $startedAt -TimeoutSeconds $readyTimeout
  Write-InstallLog "Health: $($ready.Reason); elapsed=$($ready.ElapsedSeconds)s; task=$($ready.TaskState); result=$($ready.TaskResult); $($ready.LastProbe)" -Level DETAIL
  if ($ready.Reason -eq "missing" -or $ready.Reason -eq "exited") { Stop-Install "The server task exited or was disabled. See the server log." }
  if ($ready.Reason -ne "ready") { Stop-Install "Health check timed out after ${readyTimeout}s. See task diagnostics in the install log and server log." }
  Write-InstallLog ("{0} ({1:N1}s)" -f $stage, ($clock.Elapsed.TotalSeconds - $stageStarted)) -Level OK
  Write-Host ""
  Write-InstallLog ("Ready in {0:N1}s | {1}" -f $clock.Elapsed.TotalSeconds, $appUrl) -Level OK
  # A missing browser association must not turn a healthy installation into failure.
  try { Start-Process $appUrl } catch { Write-InstallLog "Could not open the browser. Open $appUrl manually." -Level WARN }
}
catch {
  $failure = $_.Exception.Message
  try {
    if ($taskMutationStarted) {
      if ($null -ne $recoverySnapshot) {
        $restored = Restore-MailTaskRecovery -Snapshot $recoverySnapshot -RunPath $owners -StateOnly:(-not $taskReplacementAttempted)
        Write-InstallLog $restored.Message
      }
      else {
        # There was no prior task to restore. Remove only an owned task that
        # may have been partially registered, never an unrelated task.
        try {
          $fresh = Get-MailTask
          if ($fresh -and (Test-MailTaskOwnership -Task $fresh -RunPath $run)) {
            Stop-MailTask -RunPath $run -WaitTimeoutSeconds 10 -PollMilliseconds 250 | Out-Null
            Unregister-ScheduledTask -TaskName $task -TaskPath $taskPath -Confirm:$false -ErrorAction Stop
          }
        }
        catch { Write-InstallLog "Task cleanup failed: $($_.Exception.Message)" -Level WARN }
      }
    }
    Write-InstallLog ("{0} ({1:N1}s)" -f $stage, ($clock.Elapsed.TotalSeconds - $stageStarted)) -Level FAIL
    Write-InstallLog $failure -Level FAIL
    if ($serverLaunchAttempted) {
      # Configuration/build errors must not be confused with a previous run.
      if (Test-Path -LiteralPath $log) {
        Write-InstallLog "Current launch: last 25 server log lines" -Level DETAIL
        Get-Content -LiteralPath $log -Encoding UTF8 -Tail 25 | ForEach-Object { Write-InstallLog $_ -Level DETAIL }
      }
    }
  }
  catch { Write-Host "  FAIL  Could not write diagnostics. Check log folder permissions." -ForegroundColor Red }
  Write-Host "  FAIL  Installation stopped at $stage." -ForegroundColor Red
  Write-Host "  INFO  Install log: $installLog"
  if ($serverLaunchAttempted) { Write-Host "  INFO  Server log: $log" }
  exit 1
}
