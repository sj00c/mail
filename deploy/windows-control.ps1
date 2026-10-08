param(
  [ValidateSet("Start", "Stop", "Restart", "Status")]
  [string]$Action = "Start",
  # Folder with .env (the workspace); Stop does not need it.
  [string]$Workspace,
  [double]$WaitTimeoutSeconds = 60,
  [int]$PollMilliseconds = 250
)

$ErrorActionPreference = "Stop"

if ([Environment]::OSVersion.Platform -ne [System.PlatformID]::Win32NT) {
  Write-Host "windows-control.ps1 is Windows-only." -ForegroundColor Red
  exit 1
}
if ([Console]::IsOutputRedirected) { [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false) }

$root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$run = Join-Path $root "deploy\run.ps1"
$envFile = if ([string]::IsNullOrWhiteSpace($Workspace)) { $null } else { Join-Path $Workspace ".env" }
$task = "MailLocal"
$taskPath = "\"
$logPath = Join-Path $env:LOCALAPPDATA "MailLocal\mail.local.log"

. (Join-Path $PSScriptRoot "windows-readiness.ps1")

function Assert-ControlBounds {
  if ([double]::IsNaN($WaitTimeoutSeconds) -or
    [double]::IsInfinity($WaitTimeoutSeconds) -or
    $WaitTimeoutSeconds -le 0) {
    throw "WaitTimeoutSeconds must be a finite number greater than zero."
  }
  if ($PollMilliseconds -lt 1) {
    throw "PollMilliseconds must be at least one."
  }
}

function Get-ControlPort {
  if ($null -eq $envFile -or -not (Test-Path -LiteralPath $envFile -PathType Leaf)) {
    throw ".env is missing. Run the Mail installer first."
  }
  $portText = $null
  foreach ($rawLine in Get-Content -LiteralPath $envFile -Encoding UTF8) {
    $line = $rawLine.TrimEnd("`r")
    if ([string]::IsNullOrWhiteSpace($line) -or $line.TrimStart().StartsWith("#")) { continue }
    $separator = $line.IndexOf("=")
    if ($separator -lt 1) { continue }
    if ($line.Substring(0, $separator).Trim() -eq "PORT") {
      # Match install.ps1: the last PORT assignment wins and its value is
      # validated as-is, so whitespace is rejected rather than normalized.
      $portText = $line.Substring($separator + 1)
    }
  }
  if ([string]::IsNullOrEmpty($portText)) { $portText = "8787" }
  $port = 0
  if ($portText -notmatch '^\d+$' -or
    -not [int]::TryParse($portText, [ref]$port) -or
    $port -lt 1024 -or $port -gt 65535) {
    throw "PORT in .env must be a number from 1024 through 65535."
  }
  return $port
}

function Get-ControlTask {
  $found = Get-MailTask
  if ($null -eq $found) {
    throw "MailLocal is not installed at the root task path. Run the Mail installer first."
  }
  Assert-MailTaskOwnership -Task $found -RunPath $run
  return $found
}

function Get-ControlReadiness([int]$Port, [datetime]$StartedAt, [double]$TimeoutSeconds, [switch]$ProbeDisabled) {
  return Wait-MailServer -Url "http://127.0.0.1:$Port/auth/status" `
    -TaskName $task -StartedAt $StartedAt -TimeoutSeconds $TimeoutSeconds -ProbeDisabled:$ProbeDisabled
}

function Enable-ControlTask {
  $current = Get-ControlTask
  if (-not (Get-MailTaskEnabled $current)) {
    Enable-ScheduledTask -TaskName $task -TaskPath $taskPath -ErrorAction Stop | Out-Null
  }
}

function Start-ControlTask([int]$Port) {
  # Start also resumes a stop and re-enables a task disabled by older versions.
  Clear-MailPaused
  Enable-ControlTask
  $current = Get-ControlTask
  $state = [string]$current.State
  if ($state -eq "Running" -or $state -eq "Queued") {
    $startedAt = Get-Date
    $ready = Get-ControlReadiness -Port $Port -StartedAt $startedAt -TimeoutSeconds $WaitTimeoutSeconds
    if ($ready.Reason -eq "ready") {
      Write-Host "MailLocal is already running and ready."
      return
    }
    if ($state -eq "Queued") {
      throw "MailLocal is queued and no duplicate start was submitted. Readiness timed out; run: bunx @sj00c/mail restart"
    }
    throw "MailLocal is running but unresponsive. No process was killed; run: bunx @sj00c/mail restart"
  }

  $startedAt = Get-Date
  Start-ScheduledTask -TaskName $task -TaskPath $taskPath -ErrorAction Stop
  $ready = Get-ControlReadiness -Port $Port -StartedAt $startedAt -TimeoutSeconds $WaitTimeoutSeconds
  if ($ready.Reason -ne "ready") {
    throw "MailLocal did not become ready ($($ready.Reason)); run: bunx @sj00c/mail restart"
  }
  Write-Host "MailLocal started and is ready."
}

function Stop-ControlTask {
  Get-ControlTask | Out-Null
  # Record the stop first so the watchdog trigger cannot relaunch meanwhile.
  Set-MailPaused
  try {
    # Stop-MailTask disables first, sends a stop request even from Ready, and
    # verifies owned scheduler instances instead of inferring from Disabled.
    Stop-MailTask -RunPath $run -WaitTimeoutSeconds $WaitTimeoutSeconds -PollMilliseconds $PollMilliseconds | Out-Null
  }
  finally {
    # The task stays armed: the pause flag ends at sign-out or restart, and
    # the logon trigger then starts the server again.
    Enable-ControlTask
  }
  Write-Host "MailLocal stopped until you sign out or restart Windows. Resume now with: bunx @sj00c/mail start"
}

function Restart-ControlTask([int]$Port) {
  Get-ControlTask | Out-Null
  try {
    Stop-MailTask -RunPath $run -WaitTimeoutSeconds $WaitTimeoutSeconds -PollMilliseconds $PollMilliseconds | Out-Null
  }
  finally {
    # Whatever happens, leave automatic startup and recovery armed.
    Clear-MailPaused
    Enable-ControlTask
  }
  $startedAt = Get-Date
  Start-ScheduledTask -TaskName $task -TaskPath $taskPath -ErrorAction Stop
  $ready = Get-ControlReadiness -Port $Port -StartedAt $startedAt -TimeoutSeconds $WaitTimeoutSeconds
  if ($ready.Reason -ne "ready") {
    throw "MailLocal restart did not become ready ($($ready.Reason))."
  }
  Write-Host "MailLocal restarted and is ready."
}

function Show-ControlStatus([int]$Port) {
  $current = Get-ControlTask
  $enabled = Get-MailTaskEnabled $current
  $paused = Test-MailPaused
  $last = Get-MailLastEvent $logPath
  $lastText = if ($last) { $last } else { "no launch recorded" }
  $ready = Get-ControlReadiness -Port $Port -StartedAt (Get-Date) `
    -TimeoutSeconds ([Math]::Min($WaitTimeoutSeconds, 5)) -ProbeDisabled
  $startup = if (-not $enabled) { "disabled" } elseif ($paused) { "paused until sign-out or restart" } else { "at sign-in, restarted within a minute if it exits" }
  if ($ready.Reason -eq "ready") {
    Write-Host "MailLocal: running at http://localhost:$Port. Automatic startup: $startup. Last event: $lastText"
    return
  }
  if ($paused) {
    Write-Host "MailLocal: stopped until you sign out or restart Windows. Resume now with: bunx @sj00c/mail start" -ForegroundColor Yellow
  }
  elseif (-not $enabled) {
    Write-Host "MailLocal: automatic startup is disabled. Turn it back on with: bunx @sj00c/mail start" -ForegroundColor Yellow
  }
  else {
    Write-Host "MailLocal: not responding (task $([string]$current.State)). Last event: $lastText. Log: $logPath. Try: bunx @sj00c/mail restart" -ForegroundColor Yellow
  }
  # The explanation above is the whole report; the nonzero exit is the signal.
  $script:statusReported = $true
  throw "MailLocal is not responding."
}

try {
  Assert-ControlBounds
  if ($Action -eq "Stop") {
    Stop-ControlTask
    exit 0
  }
  Get-ControlTask | Out-Null
  $port = Get-ControlPort
  switch ($Action) {
    "Start" { Start-ControlTask -Port $port }
    "Restart" { Restart-ControlTask -Port $port }
    "Status" { Show-ControlStatus -Port $port }
  }
}
catch {
  if (-not $script:statusReported) {
    Write-Host "MailLocal control failed: $($_.Exception.Message) Log: $logPath" -ForegroundColor Red
  }
  exit 1
}

exit 0
