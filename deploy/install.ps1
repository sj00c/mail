# Windows: 로그인 시 자동 시작되도록 작업 스케줄러에 등록한다.
# PowerShell에서 한 번만 실행:  powershell -ExecutionPolicy Bypass -File deploy\install.ps1
# (작업 스케줄러는 launchd의 KeepAlive 같은 자동 재시작을 위해 RestartCount/Interval 설정)
$ErrorActionPreference = "Stop"
$dir  = (Resolve-Path "$PSScriptRoot\..").Path
$run  = Join-Path $dir "deploy\run.cmd"
$task = "MailLocal"

if (-not (Test-Path (Join-Path $dir ".env"))) {
  Write-Error ".env 가 없습니다. 먼저 'copy .env.example .env' 후 값을 채우세요 (README 참고)."
  exit 1
}

$action  = New-ScheduledTaskAction -Execute "cmd.exe" -Argument "/c `"$run`"" -WorkingDirectory $dir
$trigger = New-ScheduledTaskTrigger -AtLogOn
$settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -RestartCount 999 -RestartInterval (New-TimeSpan -Seconds 10) `
  -ExecutionTimeLimit (New-TimeSpan -Seconds 0)

Register-ScheduledTask -TaskName $task -Action $action -Trigger $trigger `
  -Settings $settings -Force | Out-Null
Start-ScheduledTask -TaskName $task

Write-Host "OK 등록 완료. 로그인할 때마다 자동으로 켜집니다."
Write-Host "   주소: http://localhost:8787"
Write-Host "   끄기: powershell -File deploy\uninstall.ps1"
