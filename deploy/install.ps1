# Windows 원클릭 설치: 설정 확인 -> Bun/의존성 설치 -> 빌드 -> 자동 실행 등록.
$ErrorActionPreference = "Stop"

if ([System.Environment]::OSVersion.Platform -ne [System.PlatformID]::Win32NT) {
  Write-Host "이 설치 파일은 Windows 전용입니다. macOS에서는 bash deploy/install.sh를 실행하세요." -ForegroundColor Red
  exit 1
}

$dir = (Resolve-Path "$PSScriptRoot\..").Path
$run = Join-Path $dir "deploy\run.ps1"
$task = "MailLocal"
$envFile = Join-Path $dir ".env"
$logDir = Join-Path $env:LOCALAPPDATA "MailLocal"
$log = Join-Path $logDir "mail.local.log"
$installLog = Join-Path $logDir "install.log"
$readyTimeout = 60
$stage = "설정 확인"
$clock = [System.Diagnostics.Stopwatch]::StartNew()
$stageStarted = 0.0
$secrets = @()
$serverStarted = $false

function Write-InstallLog([string]$Message) {
  foreach ($secret in $script:secrets) {
    if (-not [string]::IsNullOrEmpty($secret)) { $Message = $Message.Replace($secret, "[REDACTED]") }
  }
  $line = "[{0:yyyy-MM-dd HH:mm:ss zzz}] [+{1:N1}s] {2}" -f (Get-Date), $clock.Elapsed.TotalSeconds, $Message
  Write-Host $line
  Add-Content -LiteralPath $installLog -Value $line -Encoding UTF8 -ErrorAction Stop
}

function Set-InstallStage([string]$Name) {
  Write-InstallLog ("완료: {0} ({1:N1}초)" -f $script:stage, ($clock.Elapsed.TotalSeconds - $script:stageStarted))
  $script:stage = $Name
  $script:stageStarted = $clock.Elapsed.TotalSeconds
  Write-InstallLog "시작: $Name"
}

function Stop-Install([string]$Message) { throw $Message }

function Invoke-InstallCommand([string]$Executable, [string[]]$CommandArgs) {
  # Windows PowerShell 5.1 turns redirected native stderr into ErrorRecords.
  # Bun writes ordinary progress to stderr; only its exit code denotes failure.
  $previousPreference = $ErrorActionPreference
  try {
    $ErrorActionPreference = "Continue"
    $global:LASTEXITCODE = $null
    & $Executable @CommandArgs 2>&1 | ForEach-Object { Write-InstallLog ([string]$_) }
    $code = $global:LASTEXITCODE
  }
  finally { $ErrorActionPreference = $previousPreference }
  if ($null -eq $code) { Stop-Install "프로세스를 실행하지 못했습니다." }
  if ($code -ne 0) { Stop-Install "명령 실패 (종료 코드 $code). 위 출력과 설치 로그를 확인하세요." }
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
  Write-InstallLog "시작: $stage"
  Write-InstallLog "Windows: $([Environment]::OSVersion.VersionString); PowerShell: $($PSVersionTable.PSVersion); CPU: $env:PROCESSOR_ARCHITECTURE"
  . (Join-Path $PSScriptRoot "windows-readiness.ps1")

  if (-not (Test-Path -LiteralPath $envFile)) {
    Stop-Install ".env 파일이 없습니다. README의 안내대로 먼저 만들고 Google 연결 정보를 입력하세요."
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
    Stop-Install "PORT는 1024~65535 사이의 숫자여야 합니다 (기본 8787)."
  }
  $appUrl = "http://localhost:$port"
  $expectedRedirect = "$appUrl/auth/callback"
  if ([string]::IsNullOrEmpty($redirect)) { $redirect = $expectedRedirect }
  if ([string]::IsNullOrWhiteSpace($clientId)) { Stop-Install ".env의 GOOGLE_CLIENT_ID가 비어 있습니다." }
  if ([string]::IsNullOrWhiteSpace($clientSecret)) { Stop-Install ".env의 GOOGLE_CLIENT_SECRET이 비어 있습니다." }
  if ($clientId -match "^(your-|여기에_)|PLACEHOLDER") { Stop-Install "GOOGLE_CLIENT_ID를 실제 Client ID로 바꾸세요." }
  if (-not $clientId.EndsWith(".apps.googleusercontent.com")) { Stop-Install "GOOGLE_CLIENT_ID는 .apps.googleusercontent.com으로 끝나야 합니다." }
  if ($clientSecret -match "^(your-|여기에_)|PLACEHOLDER") { Stop-Install "GOOGLE_CLIENT_SECRET을 실제 Client Secret으로 바꾸세요." }
  if ($clientId -match "\s|[`"']" -or $clientSecret -match "\s|[`"']") {
    Stop-Install "Client ID와 Client Secret에는 따옴표나 공백을 넣지 마세요."
  }
  if ($redirect -ne $expectedRedirect) { Stop-Install "OAUTH_REDIRECT는 $expectedRedirect 이어야 합니다 (PORT=$port 기준)." }
  if ($port -ne 8787) { Write-InstallLog "Google Cloud 콘솔의 승인된 리디렉션 URI에 $expectedRedirect 를 등록해야 로그인됩니다." }

  Set-InstallStage "[1/5] 실행 프로그램 확인"
  $powershell = Join-Path $env:SystemRoot "System32\WindowsPowerShell\v1.0\powershell.exe"
  $bunCommand = Get-Command bun -CommandType Application -ErrorAction SilentlyContinue
  if (-not $bunCommand) {
    $bunDir = Join-Path $env:USERPROFILE ".bun\bin"
    $env:Path = "$bunDir;$env:Path"
    $bunCommand = Get-Command bun -CommandType Application -ErrorAction SilentlyContinue
  }
  if (-not $bunCommand) {
    $package = Get-Content -LiteralPath (Join-Path $dir "package.json") -Raw | ConvertFrom-Json
    $bunVersion = $package.packageManager -replace '^bun@', ''
    Write-InstallLog "Bun $bunVersion 설치 (공식 설치 프로그램)"
    # Windows PowerShell 5.1 may otherwise negotiate obsolete TLS versions.
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
    $bootstrap = Join-Path ([IO.Path]::GetTempPath()) ("mail-bun-" + [guid]::NewGuid() + ".ps1")
    try {
      Invoke-RestMethod "https://bun.sh/install.ps1" -OutFile $bootstrap
      Invoke-InstallCommand -Executable $powershell -CommandArgs @("-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", $bootstrap, "-Version", $bunVersion)
    }
    finally { Remove-Item -LiteralPath $bootstrap -ErrorAction SilentlyContinue }
    $bunRoot = if ($env:BUN_INSTALL) { $env:BUN_INSTALL } else { Join-Path $env:USERPROFILE ".bun" }
    $env:Path = "$(Join-Path $bunRoot 'bin');$env:Path"
    $bunCommand = Get-Command bun -CommandType Application -ErrorAction SilentlyContinue
  }
  if (-not $bunCommand) { Stop-Install "Bun 설치 후에도 실행 파일을 찾지 못했습니다. PowerShell을 다시 열어 재실행하세요." }
  $bun = $bunCommand.Source
  Write-InstallLog "Bun 실행 파일: $bun"
  Invoke-InstallCommand -Executable $bun -CommandArgs @("--version")

  Push-Location $dir
  try {
    Set-InstallStage "[2/5] 앱에 필요한 파일 설치"
    Invoke-InstallCommand -Executable $bun -CommandArgs @("install", "--frozen-lockfile")
    Set-InstallStage "[3/5] 앱 빌드"
    Invoke-InstallCommand -Executable $bun -CommandArgs @("run", "build")
    if (-not (Test-Path -LiteralPath (Join-Path $dir "dist\index.html"))) { Stop-Install "빌드 결과 dist/index.html이 없습니다." }
  }
  finally { Pop-Location }

  Set-InstallStage "[4/5] 로그인 시 자동 실행 등록"
  # Use the same absolute Bun path as installation, not the scheduler's PATH.
  $action = New-ScheduledTaskAction -Execute $powershell -Argument "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$run`" -BunPath `"$bun`" -LogPath `"$log`"" -WorkingDirectory $dir
  $user = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
  $trigger = New-ScheduledTaskTrigger -AtLogOn -User $user
  $principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
  # Windows Task Scheduler requires a restart interval of at least one minute.
  $settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) `
    -ExecutionTimeLimit (New-TimeSpan -Seconds 0)

  $existing = Get-ScheduledTask -TaskName $task -ErrorAction SilentlyContinue
  if ($existing) {
    Stop-ScheduledTask -TaskName $task
    $stopClock = [System.Diagnostics.Stopwatch]::StartNew()
    while ((Get-ScheduledTask -TaskName $task).State -eq "Running") {
      if ($stopClock.Elapsed.TotalSeconds -ge 10) { Stop-Install "기존 자동 실행을 종료하지 못했습니다." }
      Start-Sleep -Milliseconds 250
    }
  }
  $occupant = Get-PortOccupant $port
  if ($occupant) {
    Stop-Install "$port 포트 점유: $occupant. 해당 프로그램을 확인하세요 (bun이라는 이름만으로 Mail이라고 단정할 수 없습니다). 다른 프로그램이라면 .env의 PORT와 OAUTH_REDIRECT를 함께 바꾸고 같은 주소를 Google Cloud 콘솔에 등록하세요."
  }
  Register-ScheduledTask -TaskName $task -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null
  # A fresh server log avoids showing errors from a previous installation.
  Set-Content -LiteralPath $log -Value "Mail server launch $(Get-Date -Format o)" -Encoding UTF8
  $startedAt = Get-Date
  Start-ScheduledTask -TaskName $task
  $serverStarted = $true

  Set-InstallStage "[5/5] 서버 응답 확인"
  $ready = Wait-MailServer -Url "http://127.0.0.1:$port/auth/status" -TaskName $task -StartedAt $startedAt -TimeoutSeconds $readyTimeout
  Write-InstallLog "응답 확인: $($ready.Reason), $($ready.ElapsedSeconds)초; 작업 상태=$($ready.TaskState); 결과=$($ready.TaskResult); $($ready.LastProbe)"
  if ($ready.Reason -eq "exited") { Stop-Install "서버 작업이 종료됐거나 비활성화됐습니다. 아래 서버 로그를 확인하세요." }
  if ($ready.Reason -ne "ready") { Stop-Install "서버 응답 확인 시간 초과 (${readyTimeout}초). 자동 실행이 늦은 것인지, 서버 오류인지 아래 작업 상태와 로그로 확인해야 합니다." }
  Set-InstallStage "설치 완료"
  Write-InstallLog "설치가 끝났습니다. 주소: $appUrl"
  Write-InstallLog "설치 로그: $installLog"
  Write-InstallLog "자동 실행 해제: powershell -File deploy\uninstall.ps1"
  # A missing browser association must not turn a healthy installation into failure.
  try { Start-Process $appUrl } catch { Write-InstallLog "브라우저를 열지 못했습니다. $appUrl 을 직접 여세요." }
}
catch {
  $failure = $_.Exception.Message
  try {
    Write-InstallLog "설치 실패 단계: $stage"
    Write-InstallLog $failure
    if ($serverStarted) {
      $info = Get-ScheduledTaskInfo -TaskName $task -ErrorAction SilentlyContinue
      if ($info) { Write-InstallLog ("작업 종료 코드: {0} (0x{0:X8}); 마지막 실행: {1:o}" -f [long]$info.LastTaskResult, $info.LastRunTime) }
      if (Test-Path -LiteralPath $log) {
        Write-InstallLog "---- 서버 로그 마지막 25줄 ----"
        Get-Content -LiteralPath $log -Encoding UTF8 -Tail 25 | ForEach-Object { Write-InstallLog $_ }
      }
    }
  }
  catch { Write-Host "진단 로그 기록에도 실패했습니다. 설치 폴더와 로그 폴더 권한을 확인하세요." -ForegroundColor Red }
  Write-Host "설치를 완료하지 못했습니다. 실패 단계: $stage" -ForegroundColor Red
  Write-Host "설치 로그: $installLog"
  Write-Host "서버 로그: $log"
  exit 1
}
