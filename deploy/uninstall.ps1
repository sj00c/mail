# Windows: 자동 시작 해제 — 작업을 멈추고 등록을 제거한다.
$task = "MailLocal"
Stop-ScheduledTask -TaskName $task -ErrorAction SilentlyContinue
Unregister-ScheduledTask -TaskName $task -Confirm:$false -ErrorAction SilentlyContinue
Write-Host "자동 시작 해제됨. 서버가 중지되었습니다."
