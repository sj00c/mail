# Windows 원클릭 설치: .env 확인 -> Bun/의존성 설치 -> 빌드 -> 자동 실행 등록.
$ErrorActionPreference = "Stop"

if ([System.Environment]::OSVersion.Platform -ne [System.PlatformID]::Win32NT) {
  Write-Host "이 설치 파일은 Windows 전용입니다. macOS에서는 bash deploy/install.sh를 실행하세요." -ForegroundColor Red
  exit 1
}

$dir = (Resolve-Path "$PSScriptRoot\..").Path
$run = Join-Path $dir "deploy\run.cmd"
$task = "MailLocal"
$envFile = Join-Path $dir ".env"
$logDir = Join-Path $env:LOCALAPPDATA "MailLocal"
$log = Join-Path $logDir "mail.local.log"
# 서버가 열릴 때까지 기다리는 시간(초). 처음 켜는 PC는 Defender 검사·느린 디스크 때문에
# 시작이 수십 초 걸릴 수 있다. 도중에 작업이 죽으면 기다리지 않고 바로 끝낸다.
$readyTimeout = 60

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
if ([string]::IsNullOrEmpty($port)) { $port = "8787" }
# 포트는 기본 8787이지만 바꿀 수 있다 — 단, 리디렉션 URI도 같은 포트여야 하고
# 그 URI가 Google Cloud 콘솔에 등록돼 있어야 한다.
if ($port -notmatch '^\d+$' -or [int]$port -lt 1024 -or [int]$port -gt 65535) {
  Stop-Install "PORT는 1024~65535 사이의 숫자여야 합니다 (기본 8787)."
}
$appUrl = "http://localhost:$port"
$expectedRedirect = "$appUrl/auth/callback"
if ([string]::IsNullOrEmpty($redirect)) { $redirect = $expectedRedirect }

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
  Stop-Install "OAUTH_REDIRECT는 $expectedRedirect 이어야 합니다 (PORT=$port 기준)."
}
if ($port -ne "8787") {
  Write-Host "참고: PORT=$port — Google Cloud 콘솔의 승인된 리디렉션 URI에 $expectedRedirect 가 등록돼 있어야 로그인이 됩니다." -ForegroundColor Yellow
}

# 포트를 이미 쓰고 있는 프로그램 이름(우리 예약 작업을 멈춘 뒤에도 남아 있으면 다른 프로그램이다)
function Get-PortOccupant([int]$Port) {
  try {
    $conn = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction Stop | Select-Object -First 1
  }
  catch {
    return $null
  }
  if (-not $conn) { return $null }
  $proc = Get-Process -Id $conn.OwningProcess -ErrorAction SilentlyContinue
  if ($proc) { return "$($proc.ProcessName) (PID $($proc.Id))" }
  return "PID $($conn.OwningProcess)"
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
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
# 서버 출력을 로그 파일로 모은다 — 안 열릴 때 이유를 볼 수 있는 유일한 곳이다.
$action = New-ScheduledTaskAction -Execute "cmd.exe" -Argument "/c `"`"$run`" >> `"$log`" 2>&1`"" -WorkingDirectory $dir
$trigger = New-ScheduledTaskTrigger -AtLogOn
$settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -RestartCount 999 -RestartInterval (New-TimeSpan -Seconds 10) `
  -ExecutionTimeLimit (New-TimeSpan -Seconds 0)

Stop-ScheduledTask -TaskName $task -ErrorAction SilentlyContinue
Start-Sleep -Seconds 1
$occupant = Get-PortOccupant ([int]$port)
if ($occupant) {
  Stop-Install ("$port 포트를 다른 프로그램이 쓰고 있습니다: $occupant`n" +
    "  - 이름이 bun이면 이전에 직접 켠 Mail 서버입니다. 그 창을 닫거나 작업 관리자에서 해당 PID를 끝내고 다시 실행하세요.`n" +
    "  - 다른 프로그램이라면 .env의 PORT를 비어 있는 번호(예: 8788)로 바꾸고, OAUTH_REDIRECT도`n" +
    "    http://localhost:그번호/auth/callback 으로 바꾼 뒤 같은 주소를 Google Cloud 콘솔의`n" +
    "    승인된 리디렉션 URI에 추가하고 다시 실행하세요.")
}
Register-ScheduledTask -TaskName $task -Action $action -Trigger $trigger `
  -Settings $settings -Force | Out-Null
Start-ScheduledTask -TaskName $task

function Show-LogTail {
  if (Test-Path -LiteralPath $log) {
    Write-Host ""
    Write-Host "---- 로그 마지막 부분 ($log) ----" -ForegroundColor Yellow
    Get-Content -LiteralPath $log -Tail 25 | Write-Host
    Write-Host "-------------------------------------------" -ForegroundColor Yellow
  }
}

$ready = $false
$died = $false
for ($attempt = 1; $attempt -le $readyTimeout; $attempt++) {
  Start-Sleep -Seconds 1
  try {
    $response = Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 `
      -Uri "http://127.0.0.1:$port/auth/status"
    if ($response.StatusCode -eq 200) {
      $ready = $true
      break
    }
  }
  catch {
    # 서버가 시작되는 동안 다시 확인한다.
  }
  # 작업이 이미 끝났다면(서버가 시작 직후 죽음) 더 기다려봐야 소용없다 — 재시도 간격 10초 안에 잡힌다
  if ($attempt -ge 3) {
    $state = (Get-ScheduledTask -TaskName $task -ErrorAction SilentlyContinue).State
    if ($state -and $state -ne "Running") {
      $died = $true
      break
    }
  }
}

if ($died) {
  Show-LogTail
  Stop-Install "서버가 시작 직후 종료됐습니다. 위 로그의 마지막 오류를 확인하세요: $log"
}
if (-not $ready) {
  Show-LogTail
  Stop-Install "서버가 ${readyTimeout}초 안에 열리지 않았습니다. PC가 느리면 잠시 후 $appUrl 을 열어 보고, 그래도 안 열리면 로그를 확인하세요: $log"
}

Write-Host ""
Write-Host "설치가 끝났습니다." -ForegroundColor Green
Write-Host "주소: $appUrl"
Write-Host "앞으로는 이 주소만 열면 됩니다."
Write-Host "자동 실행 해제: powershell -File deploy\uninstall.ps1"
Start-Process $appUrl
