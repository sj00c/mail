param(
  [double]$WaitTimeoutSeconds = 10,
  [int]$PollMilliseconds = 250
)
$ErrorActionPreference = "Stop"

# Windows: 자동 시작 해제 — 작업을 멈추고 등록을 제거한다.
$task = "MailLocal"
$taskPath = "\"
$root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$run = Join-Path $root "deploy\run.ps1"

. (Join-Path $PSScriptRoot "windows-readiness.ps1")

if ([double]::IsNaN($WaitTimeoutSeconds) -or [double]::IsInfinity($WaitTimeoutSeconds) -or $WaitTimeoutSeconds -le 0) {
  throw "작업 종료 대기 시간은 0보다 큰 유한한 숫자여야 합니다."
}
if ($PollMilliseconds -lt 1) {
  throw "작업 상태 확인 간격은 1밀리초 이상이어야 합니다."
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
  throw "자동 실행 작업을 제거하지 못했습니다."
}

Write-Host "자동 시작 해제됨. 예약 작업의 실행 인스턴스가 중지되었습니다. 수동으로 따로 실행한 서버는 대상이 아닙니다."
