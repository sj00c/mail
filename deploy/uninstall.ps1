param(
  [double]$WaitTimeoutSeconds = 10,
  [int]$PollMilliseconds = 250
)
$ErrorActionPreference = "Stop"

# Windows: 자동 시작 해제 — 작업을 멈추고 등록을 제거한다.
$task = "MailLocal"
$taskPath = "\"

if ([double]::IsNaN($WaitTimeoutSeconds) -or [double]::IsInfinity($WaitTimeoutSeconds) -or $WaitTimeoutSeconds -le 0) {
  throw "작업 종료 대기 시간은 0보다 큰 유한한 숫자여야 합니다."
}
if ($PollMilliseconds -lt 1) {
  throw "작업 상태 확인 간격은 1밀리초 이상이어야 합니다."
}

function Get-MailTask {
  # Enumerate the root path so a same-name task in another folder is never
  # mistaken for the task created by install.ps1. Query errors propagate.
  $found = @(Get-ScheduledTask -TaskPath $taskPath -ErrorAction Stop |
    Where-Object { $_.TaskName -eq $task -and $_.TaskPath -eq $taskPath })
  if ($found.Count -eq 0) { return $null }
  return $found[0]
}

function Wait-MailTaskInactive {
  $clock = [System.Diagnostics.Stopwatch]::StartNew()
  try {
    while ($clock.Elapsed.TotalSeconds -lt $WaitTimeoutSeconds) {
      $current = Get-MailTask
      if ($null -eq $current) { return }
      $state = [string]$current.State
      if ($state -ne "Running" -and $state -ne "Queued") { return }
      $remainingMilliseconds = [Math]::Ceiling(($WaitTimeoutSeconds - $clock.Elapsed.TotalSeconds) * 1000)
      if ($remainingMilliseconds -le 0) { break }
      Start-Sleep -Milliseconds ([int][Math]::Min($PollMilliseconds, $remainingMilliseconds))
    }
  }
  finally { $clock.Stop() }
  throw "자동 실행 작업이 종료되지 않았습니다 (${WaitTimeoutSeconds}초 대기 후에도 상태가 활성입니다)."
}

$installed = Get-MailTask
if ($null -ne $installed) {
  # Capture activity before disabling; a running task may report Disabled
  # immediately after the command even though its current instance remains.
  $state = [string]$installed.State
  Disable-ScheduledTask -TaskName $task -TaskPath $taskPath -ErrorAction Stop | Out-Null
  if ($state -eq "Running" -or $state -eq "Queued") {
    Stop-ScheduledTask -TaskName $task -TaskPath $taskPath -ErrorAction Stop
    Wait-MailTaskInactive
  }

  # Re-check immediately before unregistering in case an existing run
  # changed state while it was being stopped.
  $installed = Get-MailTask
  if ($null -ne $installed) {
    $state = [string]$installed.State
    if ($state -eq "Running" -or $state -eq "Queued") {
      Stop-ScheduledTask -TaskName $task -TaskPath $taskPath -ErrorAction Stop
      Wait-MailTaskInactive
    }
    Unregister-ScheduledTask -TaskName $task -TaskPath $taskPath -Confirm:$false -ErrorAction Stop
  }
}

# A successful unregister must be observable, not inferred from its exit.
$remaining = Get-MailTask
if ($null -ne $remaining) {
  throw "자동 실행 작업을 제거하지 못했습니다."
}

Write-Host "자동 시작 해제됨. 서버가 중지되었습니다."
