# Windows 원클릭 설치: .env 확인 -> Bun/의존성 설치 -> 빌드 -> 자동 실행 등록.
$ErrorActionPreference = "Stop"

if ([System.Environment]::OSVersion.Platform -ne [System.PlatformID]::Win32NT) {
  Write-Host "이 설치 파일은 Windows 전용입니다. macOS에서는 bash deploy/install.sh를 실행하세요." -ForegroundColor Red
  exit 1
}

$dir = (Resolve-Path "$PSScriptRoot\..").Path
$run = Join-Path $dir "deploy\run.cmd"
$task = "MailLocal"
$appUrl = "http://localhost:8787"
$expectedRedirect = "$appUrl/auth/callback"
$envFile = Join-Path $dir ".env"

function Stop-Install([string]$Message) {
  Write-Host ""
  Write-Host "설치를 완료하지 못했습니다: $Message" -ForegroundColor Red
  exit 1
}

if (-not (Test-Path -LiteralPath $envFile)) {
  Stop-Install ".env 파일이 없습니다. README의 안내대로 .env를 먼저 만들고 Google 연결 정보를 입력하세요."
}

$values = @{}
foreach ($rawLine in Get-Content -LiteralPath $envFile) {
  $line = $rawLine.TrimEnd("`r")
  if ([string]::IsNullOrWhiteSpace($line) -or $line.TrimStart().StartsWith("#")) {
    continue
  }
  $separator = $line.IndexOf("=")
  if ($separator -lt 1) {
    continue
  }
  $key = $line.Substring(0, $separator).Trim()
  $value = $line.Substring($separator + 1)
  $values[$key] = $value
}

$clientId = [string]$values["GOOGLE_CLIENT_ID"]
$clientSecret = [string]$values["GOOGLE_CLIENT_SECRET"]
$redirect = [string]$values["OAUTH_REDIRECT"]
$port = [string]$values["PORT"]
if ([string]::IsNullOrEmpty($redirect)) { $redirect = $expectedRedirect }
if ([string]::IsNullOrEmpty($port)) { $port = "8787" }

if ([string]::IsNullOrWhiteSpace($clientId)) {
  Stop-Install ".env의 GOOGLE_CLIENT_ID가 비어 있습니다."
}
if ([string]::IsNullOrWhiteSpace($clientSecret)) {
  Stop-Install ".env의 GOOGLE_CLIENT_SECRET이 비어 있습니다."
}
if ($clientId -match "^(your-|여기에_)|PLACEHOLDER") {
  Stop-Install ".env의 GOOGLE_CLIENT_ID를 실제 Client ID로 바꾸세요."
}
if (-not $clientId.EndsWith(".apps.googleusercontent.com")) {
  Stop-Install "GOOGLE_CLIENT_ID 형식이 올바르지 않습니다. 보통 .apps.googleusercontent.com으로 끝납니다."
}
if ($clientSecret -match "^(your-|여기에_)|PLACEHOLDER") {
  Stop-Install ".env의 GOOGLE_CLIENT_SECRET을 실제 Client Secret으로 바꾸세요."
}
if (
  $clientId -match "\s" -or $clientSecret -match "\s" -or
  $clientId.Contains('"') -or $clientId.Contains("'") -or
  $clientSecret.Contains('"') -or $clientSecret.Contains("'")
) {
  Stop-Install "Client ID와 Client Secret에는 따옴표나 공백을 넣지 마세요."
}
if ($redirect -ne $expectedRedirect) {
  Stop-Install "OAUTH_REDIRECT는 $expectedRedirect 이어야 합니다."
}
if ($port -ne "8787") {
  Stop-Install "PORT는 8787이어야 합니다."
}

Write-Host "[1/4] 실행 프로그램 확인"
$bunCommand = Get-Command bun -ErrorAction SilentlyContinue
if (-not $bunCommand) {
  Write-Host "Bun이 없어 공식 설치 프로그램으로 설치합니다."
  Invoke-RestMethod "https://bun.sh/install.ps1" | Invoke-Expression
  $bunDir = Join-Path $env:USERPROFILE ".bun\bin"
  $env:Path = "$bunDir;$env:Path"
  $bunCommand = Get-Command bun -ErrorAction SilentlyContinue
}
if (-not $bunCommand) {
  Stop-Install "Bun 설치 후에도 실행 파일을 찾지 못했습니다. PowerShell을 다시 연 뒤 재실행하세요."
}
$bun = $bunCommand.Source

Push-Location $dir
try {
  Write-Host "[2/4] 앱에 필요한 파일 설치"
  & $bun install --frozen-lockfile
  if ($LASTEXITCODE -ne 0) {
    Stop-Install "앱에 필요한 파일 설치 중 오류가 발생했습니다."
  }

  Write-Host "[3/4] 앱 빌드"
  & $bun run build
  if ($LASTEXITCODE -ne 0) {
    Stop-Install "앱 빌드 중 오류가 발생했습니다."
  }
}
finally {
  Pop-Location
}

Write-Host "[4/4] 로그인 시 자동 실행 등록"
$action = New-ScheduledTaskAction -Execute "cmd.exe" -Argument "/c `"$run`"" -WorkingDirectory $dir
$trigger = New-ScheduledTaskTrigger -AtLogOn
$settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -RestartCount 999 -RestartInterval (New-TimeSpan -Seconds 10) `
  -ExecutionTimeLimit (New-TimeSpan -Seconds 0)

Stop-ScheduledTask -TaskName $task -ErrorAction SilentlyContinue
Register-ScheduledTask -TaskName $task -Action $action -Trigger $trigger `
  -Settings $settings -Force | Out-Null
Start-ScheduledTask -TaskName $task

$ready = $false
for ($attempt = 0; $attempt -lt 30; $attempt++) {
  Start-Sleep -Seconds 1
  try {
    $response = Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 `
      -Uri "http://127.0.0.1:8787/auth/status"
    if ($response.StatusCode -eq 200) {
      $ready = $true
      break
    }
  }
  catch {
    # 서버가 시작되는 동안 다시 확인한다.
  }
}

if (-not $ready) {
  Stop-Install "서버가 30초 안에 열리지 않았습니다. Windows 작업 스케줄러의 MailLocal 기록을 확인하세요."
}

Write-Host ""
Write-Host "설치가 끝났습니다." -ForegroundColor Green
Write-Host "주소: $appUrl"
Write-Host "앞으로는 이 주소만 열면 됩니다."
Write-Host "자동 실행 해제: powershell -File deploy\uninstall.ps1"
Start-Process $appUrl
