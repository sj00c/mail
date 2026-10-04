param(
  [double]$WaitTimeoutSeconds = 10,
  [int]$PollMilliseconds = 250
)
$ErrorActionPreference = "Stop"

# Windows: stop scheduled instances and unregister automatic startup.
$task = "MailLocal"
$taskPath = "\"
$root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$run = Join-Path $root "deploy\run.ps1"

. (Join-Path $PSScriptRoot "windows-readiness.ps1")

if ([double]::IsNaN($WaitTimeoutSeconds) -or [double]::IsInfinity($WaitTimeoutSeconds) -or $WaitTimeoutSeconds -le 0) {
  throw "WaitTimeoutSeconds must be a finite number greater than zero."
}
if ($PollMilliseconds -lt 1) {
  throw "PollMilliseconds must be at least one."
}

$installed = Get-MailTask
if ($null -ne $installed) {
  Assert-MailTaskOwnership -Task $installed -RunPath $run
  Stop-MailTask -RunPath $run -WaitTimeoutSeconds $WaitTimeoutSeconds -PollMilliseconds $PollMilliseconds | Out-Null

  # Re-check immediately before unregistering in case an existing run
  # changed state while it was being stopped. Ownership is checked again
  # before unregistering so a race cannot remove another task.
  $installed = Get-MailTask
  if ($null -ne $installed) {
    Assert-MailTaskOwnership -Task $installed -RunPath $run
    Unregister-ScheduledTask -TaskName $task -TaskPath $taskPath -Confirm:$false -ErrorAction Stop
  }
}

# A successful unregister must be observable, not inferred from its exit.
$remaining = Get-MailTask
if ($null -ne $remaining) {
  throw "Could not remove the scheduled task."
}

Write-Host "  OK    Automatic startup removed; scheduled instances stopped. Manually started servers are not affected." -ForegroundColor Green
