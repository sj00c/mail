param([switch]$Integration)
$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "windows-readiness.ps1")

function Assert($Condition, [string]$Message) {
  if (-not $Condition) { throw "FAIL: $Message" }
  Write-Host "PASS: $Message"
}

# Parse all deployment scripts, including the real entrypoints, on PS 5.1/7.
foreach ($file in Get-ChildItem -LiteralPath $PSScriptRoot -Filter *.ps1) {
  $bytes = [IO.File]::ReadAllBytes($file.FullName)
  if ([Text.Encoding]::UTF8.GetString($bytes) -match '[^\x00-\x7F]') {
    # PowerShell 5.1 otherwise reads UTF-8 Korean strings as the ANSI codepage.
    Assert ($bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF) "Non-ASCII PowerShell script has a UTF-8 BOM: $($file.Name)"
  }
  $tokens = $null
  $errors = $null
  $null = [System.Management.Automation.Language.Parser]::ParseFile($file.FullName, [ref]$tokens, [ref]$errors)
  Assert ($errors.Count -eq 0) "PowerShell syntax: $($file.Name) ($errors)"
}

# Inspect the production settings command directly from its AST. This keeps the
# scheduler bounds regression independent from installer side effects.
$installerTokens = $null
$installerErrors = $null
$installerAst = [System.Management.Automation.Language.Parser]::ParseFile((Join-Path $PSScriptRoot "install.ps1"), [ref]$installerTokens, [ref]$installerErrors)
Assert ($installerErrors.Count -eq 0) "Installer AST has no parse errors"
$settingsCommands = @($installerAst.FindAll({
    param($node)
    $node -is [System.Management.Automation.Language.CommandAst] -and
      $node.GetCommandName() -eq "New-ScheduledTaskSettingsSet"
  }, $true))
Assert ($settingsCommands.Count -eq 1) "Production installer has one scheduler settings command"
if ($settingsCommands.Count -eq 1) {
  $settingsCommand = $settingsCommands[0]
  $commandElements = @($settingsCommand.CommandElements)
  $restartCountIndexes = @(
    for ($index = 0; $index -lt $commandElements.Count; $index++) {
      if ($commandElements[$index] -is [System.Management.Automation.Language.CommandParameterAst] -and
        $commandElements[$index].ParameterName -eq "RestartCount") { $index }
    }
  )
  $restartIntervalIndexes = @(
    for ($index = 0; $index -lt $commandElements.Count; $index++) {
      if ($commandElements[$index] -is [System.Management.Automation.Language.CommandParameterAst] -and
        $commandElements[$index].ParameterName -eq "RestartInterval") { $index }
    }
  )
  Assert ($restartCountIndexes.Count -eq 1) "Production settings has one RestartCount parameter"
  Assert ($restartIntervalIndexes.Count -eq 1) "Production settings has one RestartInterval parameter"
  $countArgument = $null
  if ($restartCountIndexes.Count -eq 1) {
    $countParameter = $commandElements[$restartCountIndexes[0]]
    if ($null -ne $countParameter.Argument) {
      $countArgument = $countParameter.Argument
    } elseif ($restartCountIndexes[0] + 1 -lt $commandElements.Count) {
      $countArgument = $commandElements[$restartCountIndexes[0] + 1]
    }
  }
  $literalCount = $null
  $countLiteralAst = $countArgument
  if ($countArgument -is [System.Management.Automation.Language.CommandExpressionAst]) {
    $countLiteralAst = $countArgument.Expression
  }
  if ($countLiteralAst -is [System.Management.Automation.Language.ConstantExpressionAst]) {
    $literalCount = $countLiteralAst.SafeGetValue()
  }
  Assert ($literalCount -eq 3) "Production restart count is 3"
  $intervalArgument = $null
  if ($restartIntervalIndexes.Count -eq 1) {
    $intervalParameter = $commandElements[$restartIntervalIndexes[0]]
    if ($null -ne $intervalParameter.Argument) {
      $intervalArgument = $intervalParameter.Argument
    } elseif ($restartIntervalIndexes[0] + 1 -lt $commandElements.Count) {
      $intervalArgument = $commandElements[$restartIntervalIndexes[0] + 1]
    }
  }
  $intervalText = if ($null -ne $intervalArgument) { $intervalArgument.Extent.Text } else { "" }
  Assert ($intervalText -match '^\(?\s*New-TimeSpan\s+-Minutes\s+1\s*\)?$') "Production restart interval is one minute"
}

$temp = Join-Path ([IO.Path]::GetTempPath()) ("mail-installer-test-" + [guid]::NewGuid())
New-Item -ItemType Directory -Path $temp | Out-Null
try {
  # Load only the installer's logging/native-command functions, never its body.
  $tokens = $null
  $errors = $null
  $ast = [System.Management.Automation.Language.Parser]::ParseFile((Join-Path $PSScriptRoot "install.ps1"), [ref]$tokens, [ref]$errors)
  foreach ($name in @("Write-InstallLog", "Stop-Install", "Invoke-InstallCommand", "Get-PortOccupant")) {
    $definition = $ast.Find({ param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name }, $true)
    . ([scriptblock]::Create($definition.Extent.Text))
  }
  $script:installLog = Join-Path $temp "install.log"
  $script:clock = [Diagnostics.Stopwatch]::StartNew()
  $script:secrets = @("test-client-secret")
  $script:bun = (Get-Process -Id $PID).Path
  Invoke-InstallCommand -Executable $bun -CommandArgs @("-NoProfile", "-Command", "[Console]::Error.WriteLine('normal progress test-client-secret'); exit 0")
  $logged = Get-Content -LiteralPath $installLog -Raw
  Assert ($logged.Contains("normal progress [REDACTED]")) "Native stderr is logged and credentials are redacted"
  Assert (-not $logged.Contains("test-client-secret")) "Secret is absent from install log"
  $failed = $false
  try { Invoke-InstallCommand -Executable $bun -CommandArgs @("-NoProfile", "-Command", "exit 7") } catch { $failed = $_.Exception.Message.Contains("7") }
  Assert $failed "Nonzero native exit fails the installation"
  $script:bun = Join-Path $temp "missing-bun.exe"
  $failed = $false
  try { Invoke-InstallCommand -Executable $bun -CommandArgs @("--version") } catch { $failed = $true }
  Assert $failed "Missing executable cannot reuse a previous successful exit code"

  $hostExecutable = (Get-Process -Id $PID).Path
  $launchLog = Join-Path $temp "server.log"
  & $hostExecutable -NoProfile -File (Join-Path $PSScriptRoot "run.ps1") -BunPath $bun -LogPath $launchLog
  Assert ($LASTEXITCODE -ne 0) "Launcher reports missing executable with nonzero exit"
  Assert ((Get-Content -LiteralPath $launchLog -Raw -Encoding UTF8).Contains("Bun executable missing")) "Launcher persists missing executable error"
  $fixtureDeploy = Join-Path $temp "deploy"
  New-Item -ItemType Directory -Path $fixtureDeploy | Out-Null
  Copy-Item -LiteralPath (Join-Path $PSScriptRoot "run.ps1") -Destination $fixtureDeploy
  & $hostExecutable -NoProfile -File (Join-Path $fixtureDeploy "run.ps1") -BunPath $hostExecutable -LogPath $launchLog
  Assert ($LASTEXITCODE -ne 0) "Missing build fails without rebuilding at startup"
  Assert ((Get-Content -LiteralPath $launchLog -Raw -Encoding UTF8).Contains("dist/index.html missing")) "Launcher explains missing build in log"

  # Scheduler commands do not exist on Linux; use controlled task observations.
  function Get-ScheduledTask { [CmdletBinding()]param($TaskName) [pscustomobject]@{ State = $script:taskState } }
  function Get-ScheduledTaskInfo { [CmdletBinding()]param($TaskName) [pscustomobject]@{ LastRunTime = $script:lastRun; LastTaskResult = $script:taskResult } }
  $script:taskState = "Running"
  $script:lastRun = Get-Date
  $script:taskResult = 267009
  $listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0)
  $listener.Start()
  $port = $listener.LocalEndpoint.Port
  $listener.Stop()
  $url = "http://127.0.0.1:$port/auth/status"
  $started = Get-Date
  $r = Wait-MailServer -Url $url -TaskName Test -StartedAt $started -TimeoutSeconds 0.4
  Assert ($r.Reason -eq "timeout" -and $r.ElapsedSeconds -lt 1.5) "Closed port obeys elapsed-time deadline"
  $script:taskState = "Queued"
  $r = Wait-MailServer -Url $url -TaskName Test -StartedAt $started -TimeoutSeconds 0.4
  Assert ($r.Reason -eq "timeout") "Queued task is not misdiagnosed as exited"
  $script:taskState = "Ready"
  $script:lastRun = $started.AddDays(-1)
  $script:taskResult = 1
  $r = Wait-MailServer -Url $url -TaskName Test -StartedAt $started -TimeoutSeconds 0.4
  Assert ($r.Reason -eq "timeout") "Old task failure is not attributed to new launch"
  $script:lastRun = $started
  $r = Wait-MailServer -Url $url -TaskName Test -StartedAt $started -TimeoutSeconds 5
  Assert ($r.Reason -eq "exited" -and $r.TaskResult -eq 1 -and $r.ElapsedSeconds -lt 2) "Current task failure returns early with its exit code"
  $script:taskResult = 0
  $r = Wait-MailServer -Url $url -TaskName Test -StartedAt $started -TimeoutSeconds 5
  Assert ($r.Reason -eq "exited") "A server that exited cleanly is still not ready"
  $script:taskState = "Disabled"
  $r = Wait-MailServer -Url $url -TaskName Test -StartedAt $started -TimeoutSeconds 5
  Assert ($r.Reason -eq "exited") "Disabled task fails early"
  $script:taskState = "Running"
  $script:taskResult = 267009

  foreach ($mode in @("ready", "invalid", "malformed", "error", "hang")) {
    # A real local HTTP server, not a mocked HTTP client: also checks cancellation.
    $job = Start-Job -ArgumentList $mode -ScriptBlock {
      param($mode)
      $listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0)
      $listener.Start()
      Write-Output $listener.LocalEndpoint.Port
      try {
        while ($true) {
          $accept = $listener.AcceptTcpClientAsync()
          while (-not $accept.IsCompleted) { Start-Sleep -Milliseconds 10 }
          $connection = $accept.GetAwaiter().GetResult()
          try {
            $stream = $connection.GetStream()
            $buffer = New-Object byte[] 4096
            $null = $stream.Read($buffer, 0, $buffer.Length)
            if ($mode -eq "hang") { Start-Sleep -Seconds 10; continue }
            $body = if ($mode -eq "ready") { '{"authed":false}' } else { '{"other":true}' }
            if ($mode -eq "malformed") { $body = "not json" }
            $status = if ($mode -eq "error") { "503 Unavailable" } else { "200 OK" }
            $bytes = [Text.Encoding]::ASCII.GetBytes("HTTP/1.1 $status`r`nContent-Type: application/json`r`nContent-Length: $($body.Length)`r`nConnection: close`r`n`r`n$body")
            $stream.Write($bytes, 0, $bytes.Length)
          }
          finally { $connection.Dispose() }
        }
      }
      finally { $listener.Stop() }
    }
    try {
      $wait = [Diagnostics.Stopwatch]::StartNew()
      do {
        $output = @(Receive-Job $job -Keep)
        if ($output.Count -gt 0) { break }
        if ($wait.Elapsed.TotalSeconds -gt 15) { throw "HTTP test server did not start" }
        Start-Sleep -Milliseconds 50
      } while ($true)
      $r = Wait-MailServer -Url "http://127.0.0.1:$($output[0])/auth/status" -TaskName Test -StartedAt (Get-Date) -TimeoutSeconds 0.5
      if ($mode -eq "ready") { Assert ($r.Reason -eq "ready") "Unauthenticated Mail response is ready" }
      else { Assert ($r.Reason -eq "timeout" -and $r.ElapsedSeconds -lt 1.5) "HTTP $mode does not succeed or overrun the deadline" }
    }
    finally { Stop-Job $job; Remove-Job $job }
  }

  function Get-NetTCPConnection { [CmdletBinding()]param($State) throw "Access denied" }
  $failed = $false
  try { Get-PortOccupant 8787 } catch { $failed = $true }
  Assert $failed "Port inspection failure is not reported as a free port"
  function Get-NetTCPConnection { [CmdletBinding()]param($State) [pscustomobject]@{ LocalPort = 8787; OwningProcess = $PID } }
  Assert ((Get-PortOccupant 8787) -match "PID $PID") "Port occupant includes owning PID"
  Assert ($null -eq (Get-PortOccupant 8788)) "Unoccupied port returns no occupant"

  # Exercise the real uninstaller with isolated scheduler mocks. These cases
  # never touch the user's MailLocal task or files.
  $uninstallScript = Join-Path $PSScriptRoot "uninstall.ps1"
  $script:uninstallTaskPresent = $true
  $script:uninstallOtherTaskPresent = $true
  $script:uninstallState = "Ready"
  $script:uninstallDiscoveryFailure = $null
  $script:uninstallDisableFailure = $false
  $script:uninstallStopFailure = $false
  $script:uninstallStopTransitions = $true
  $script:uninstallDisableCalls = 0
  $script:uninstallUnregisterFailure = $false
  $script:uninstallUnregisterRemovesTask = $true
  $script:uninstallStopCalls = 0
  $script:uninstallUnregisterCalls = 0
  $script:uninstallDiscoveryCalls = 0
  function Get-ScheduledTask {
    [CmdletBinding()]
    param([string]$TaskPath)
    $script:uninstallDiscoveryCalls++
    if ($null -ne $script:uninstallDiscoveryFailure) { throw $script:uninstallDiscoveryFailure }
    if ($TaskPath -ne "\") { throw "unexpected task path: $TaskPath" }
    if ($script:uninstallTaskPresent) {
      [pscustomobject]@{ TaskName = "MailLocal"; TaskPath = "\"; State = $script:uninstallState }
    }
    if ($script:uninstallOtherTaskPresent) {
      [pscustomobject]@{ TaskName = "MailLocal"; TaskPath = "\Other\"; State = "Running" }
    }
  }
  function Disable-ScheduledTask {
    [CmdletBinding()]
    param([string]$TaskName, [string]$TaskPath)
    if ($TaskPath -ne "\") { throw "unexpected task path: $TaskPath" }
    $script:uninstallDisableCalls++
    if ($script:uninstallDisableFailure) { throw "disable failed" }
  }
  function Stop-ScheduledTask {
    [CmdletBinding()]
    param([string]$TaskName, [string]$TaskPath)
    if ($TaskPath -ne "\") { throw "unexpected task path: $TaskPath" }
    $script:uninstallStopCalls++
    if ($script:uninstallStopFailure) { throw "stop failed" }
    if ($script:uninstallStopTransitions) { $script:uninstallState = "Ready" }
  }
  function Unregister-ScheduledTask {
    [CmdletBinding()]
    param([string]$TaskName, [string]$TaskPath, [switch]$Confirm)
    if ($TaskPath -ne "\") { throw "unexpected task path: $TaskPath" }
    $script:uninstallUnregisterCalls++
    if ($script:uninstallUnregisterFailure) { throw "unregister failed" }
    if ($script:uninstallUnregisterRemovesTask) { $script:uninstallTaskPresent = $false }
  }
  $sentinels = @(
    (Join-Path $temp ".env"),
    (Join-Path $temp "token.json"),
    (Join-Path $temp "mail.local.log")
  )
  foreach ($sentinel in $sentinels) { Set-Content -LiteralPath $sentinel -Value "must remain" -Encoding UTF8 }

  foreach ($timeout in @([double]::NaN, [double]::PositiveInfinity, 0, -1)) {
    $discoveryBefore = $script:uninstallDiscoveryCalls
    $errorText = ""
    try { & $uninstallScript -WaitTimeoutSeconds $timeout } catch { $errorText = $_.Exception.Message }
    Assert ($errorText -match "유한한 숫자") "Invalid uninstall timeout is rejected"
    Assert ($script:uninstallDiscoveryCalls -eq $discoveryBefore) "Invalid timeout cannot mutate or inspect scheduled tasks"
  }

  # An absent task is a successful no-op and is safe to rerun.
  $script:uninstallTaskPresent = $false
  $script:uninstallOtherTaskPresent = $true
  $script:uninstallStopCalls = 0
  $script:uninstallDisableCalls = 0
  $script:uninstallUnregisterCalls = 0
  $uninstallSucceeded = $true
  try { & $uninstallScript -WaitTimeoutSeconds 0.1 -PollMilliseconds 1 } catch { $uninstallSucceeded = $false }
  Assert $uninstallSucceeded "Uninstaller accepts an absent task"
  Assert ($script:uninstallStopCalls -eq 0 -and $script:uninstallUnregisterCalls -eq 0) "Absent task does not invoke stop or unregister"
  $uninstallSucceeded = $true
  try { & $uninstallScript -WaitTimeoutSeconds 0.1 -PollMilliseconds 1 } catch { $uninstallSucceeded = $false }
  Assert $uninstallSucceeded "Uninstaller can be rerun when the task is absent"

  # A running task is stopped, observed inactive, unregistered, and verified gone.
  $script:uninstallTaskPresent = $true
  $script:uninstallState = "Running"
  $script:uninstallDisableFailure = $false
  $script:uninstallStopFailure = $false
  $script:uninstallStopTransitions = $true
  $script:uninstallUnregisterFailure = $false
  $script:uninstallUnregisterRemovesTask = $true
  $script:uninstallStopCalls = 0
  $script:uninstallDisableCalls = 0
  $script:uninstallUnregisterCalls = 0
  $uninstallSucceeded = $true
  try { & $uninstallScript -WaitTimeoutSeconds 0.1 -PollMilliseconds 1 } catch { $uninstallSucceeded = $false }
  Assert $uninstallSucceeded "Uninstaller removes an active task after it becomes inactive"
  Assert ($script:uninstallDisableCalls -eq 1 -and $script:uninstallStopCalls -eq 1 -and $script:uninstallUnregisterCalls -eq 1 -and -not $script:uninstallTaskPresent) "Active task is disabled, stopped, unregistered, and verified removed"
  Assert $script:uninstallOtherTaskPresent "Same-name task outside the root path is preserved"

  # Queued work is active too and must be stopped before unregistering.
  $script:uninstallTaskPresent = $true
  $script:uninstallState = "Queued"
  $script:uninstallStopCalls = 0
  $script:uninstallDisableCalls = 0
  $script:uninstallUnregisterCalls = 0
  $uninstallSucceeded = $true
  try { & $uninstallScript -WaitTimeoutSeconds 0.1 -PollMilliseconds 1 } catch { $uninstallSucceeded = $false }
  Assert ($uninstallSucceeded -and $script:uninstallDisableCalls -eq 1 -and $script:uninstallStopCalls -eq 1 -and $script:uninstallUnregisterCalls -eq 1) "Queued task is disabled and stopped before unregistering"

  # Discovery errors must not be mistaken for an absent task.
  $script:uninstallTaskPresent = $true
  $script:uninstallDiscoveryFailure = "scheduler discovery failed"
  $script:uninstallStopCalls = 0
  $script:uninstallUnregisterCalls = 0
  $errorText = ""
  try { & $uninstallScript -WaitTimeoutSeconds 0.1 -PollMilliseconds 1 } catch { $errorText = $_.Exception.Message }
  Assert ($errorText -match "scheduler discovery failed") "Task discovery failure propagates"
  Assert ($script:uninstallStopCalls -eq 0 -and $script:uninstallUnregisterCalls -eq 0) "Discovery failure does not mutate the task"
  $script:uninstallDiscoveryFailure = $null

  # Disabling is part of the stop barrier and its failures must propagate.
  $script:uninstallState = "Ready"
  $script:uninstallDisableFailure = $true
  $script:uninstallStopCalls = 0
  $script:uninstallUnregisterCalls = 0
  $errorText = ""
  try { & $uninstallScript -WaitTimeoutSeconds 0.1 -PollMilliseconds 1 } catch { $errorText = $_.Exception.Message }
  Assert ($errorText -match "disable failed") "Disable failure propagates"
  Assert ($script:uninstallStopCalls -eq 0 -and $script:uninstallUnregisterCalls -eq 0 -and $script:uninstallTaskPresent) "Disable failure leaves the task registered"

  # Stop failures and bounded waits must prevent unregister and success.
  $script:uninstallTaskPresent = $true
  $script:uninstallState = "Running"
  $script:uninstallDisableFailure = $false
  $script:uninstallStopFailure = $true
  $script:uninstallStopTransitions = $true
  $script:uninstallStopCalls = 0
  $script:uninstallUnregisterCalls = 0
  $errorText = ""
  try { & $uninstallScript -WaitTimeoutSeconds 0.1 -PollMilliseconds 1 } catch { $errorText = $_.Exception.Message }
  Assert ($errorText -match "stop failed") "Stop failure propagates"
  Assert ($script:uninstallUnregisterCalls -eq 0 -and $script:uninstallTaskPresent) "Stop failure leaves the task registered"

  $script:uninstallStopFailure = $false
  $script:uninstallStopTransitions = $false
  $script:uninstallStopCalls = 0
  $script:uninstallUnregisterCalls = 0
  $errorText = ""
  try { & $uninstallScript -WaitTimeoutSeconds 0.05 -PollMilliseconds 5 } catch { $errorText = $_.Exception.Message }
  Assert ($errorText -match "종료되지 않았습니다") "Active task wait has a bounded timeout"
  Assert ($script:uninstallStopCalls -eq 1 -and $script:uninstallUnregisterCalls -eq 0 -and $script:uninstallTaskPresent) "Wait timeout leaves the active task registered"

  # Unregister failures and a no-op unregister cannot report success.
  $script:uninstallState = "Ready"
  $script:uninstallDisableFailure = $false
  $script:uninstallUnregisterFailure = $true
  $script:uninstallUnregisterRemovesTask = $true
  $script:uninstallUnregisterCalls = 0
  $errorText = ""
  try { & $uninstallScript -WaitTimeoutSeconds 0.1 -PollMilliseconds 1 } catch { $errorText = $_.Exception.Message }
  Assert ($errorText -match "unregister failed") "Unregister failure propagates"
  Assert ($script:uninstallUnregisterCalls -eq 1 -and $script:uninstallTaskPresent) "Unregister failure leaves the task registered"

  $script:uninstallUnregisterFailure = $false
  $script:uninstallUnregisterRemovesTask = $false
  $errorText = ""
  try { & $uninstallScript -WaitTimeoutSeconds 0.1 -PollMilliseconds 1 } catch { $errorText = $_.Exception.Message }
  Assert ($errorText -match "제거하지 못했습니다") "Surviving task fails removal verification"
  Assert $script:uninstallTaskPresent "Removal verification observes a surviving task"
  foreach ($sentinel in $sentinels) {
    Assert (Test-Path -LiteralPath $sentinel) "Uninstaller preserves $([IO.Path]::GetFileName($sentinel))"
  }
}
finally {
  Remove-Item -LiteralPath $temp -Recurse -Force
  # Restore the actual Windows cmdlets before integration testing.
  foreach ($name in @("Get-ScheduledTask", "Get-ScheduledTaskInfo", "Get-NetTCPConnection", "Disable-ScheduledTask", "Stop-ScheduledTask", "Unregister-ScheduledTask")) {
    Remove-Item "Function:\$name" -ErrorAction SilentlyContinue
  }
}

if ($Integration) {
  if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) { throw "Integration requires Windows" }
  $root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
  $envPath = Join-Path $root ".env"
  $mailLogDir = Join-Path $env:LOCALAPPDATA "MailLocal"
  if (Test-Path -LiteralPath $envPath) { throw "Refusing to overwrite existing .env" }
  if (Get-ScheduledTask -TaskName MailLocal -ErrorAction SilentlyContinue) { throw "Refusing to replace existing MailLocal task" }
  if (Test-Path -LiteralPath $mailLogDir) { throw "Refusing to overwrite existing MailLocal user files" }
  $powershell = Join-Path $env:SystemRoot "System32\WindowsPowerShell\v1.0\powershell.exe"
  $bunPath = (Get-Command bun -CommandType Application).Source
  $log = Join-Path $mailLogDir "mail.local.log"
  try {
    # Dummy OAuth values only. Readiness must work without Google connectivity.
    @("GOOGLE_CLIENT_ID=ci.apps.googleusercontent.com", "GOOGLE_CLIENT_SECRET=ci-dummy-secret", "PORT=18787", "OAUTH_REDIRECT=http://localhost:18787/auth/callback") |
      Set-Content -LiteralPath $envPath -Encoding ASCII
    & $powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot "install.ps1")
    Assert ($LASTEXITCODE -eq 0) "Real Windows installer and scheduled server start successfully"
    $response = Invoke-RestMethod -Uri "http://127.0.0.1:18787/auth/status"
    Assert ($response.authed -eq $false) "Scheduled server answers without real credentials"
    $installedTask = Get-ScheduledTask -TaskName MailLocal
    Assert ([int]$installedTask.Settings.RestartCount -eq 3) "Scheduler registers three restart attempts"
    Assert ($installedTask.Settings.RestartInterval -eq "PT1M") "Scheduler accepts one-minute restart interval"
    Assert ($installedTask.Actions.Arguments.Contains($bunPath)) "Scheduled launch uses the exact installed Bun executable"

    # Register a uniquely named, deliberately failing task and observe one
    # scheduler restart. The future trigger prevents a second independent
    # trigger from making this assertion pass before the one-minute retry.
    $temporaryTaskName = "MailLocal-Test-" + [guid]::NewGuid().ToString("N")
    $failureScript = Join-Path ([IO.Path]::GetTempPath()) ("mail-scheduler-failure-" + [guid]::NewGuid().ToString("N") + ".ps1")
    $failureMarker = Join-Path ([IO.Path]::GetTempPath()) ("mail-scheduler-failure-" + [guid]::NewGuid().ToString("N") + ".txt")
    try {
      $markerLiteral = $failureMarker.Replace("'", "''")
      $failureBody = @'
Add-Content -LiteralPath '__MARKER__' -Value ([DateTime]::UtcNow.ToString('o')) -Encoding UTF8
exit 1
'@
      $failureBody = $failureBody.Replace("__MARKER__", $markerLiteral)
      Set-Content -LiteralPath $failureScript -Value $failureBody -Encoding UTF8
      $failureAction = New-ScheduledTaskAction -Execute $powershell -Argument "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$failureScript`""
      $failureTrigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(10)
      $failurePrincipal = New-ScheduledTaskPrincipal -UserId ([System.Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType Interactive -RunLevel Limited
      $failureSettings = New-ScheduledTaskSettingsSet `
        -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
        -RestartCount 1 -RestartInterval (New-TimeSpan -Minutes 1) `
        -ExecutionTimeLimit (New-TimeSpan -Seconds 0)
      Register-ScheduledTask -TaskName $temporaryTaskName -Action $failureAction -Trigger $failureTrigger -Principal $failurePrincipal -Settings $failureSettings -Force | Out-Null
      $registeredFailureTask = Get-ScheduledTask -TaskName $temporaryTaskName
      Assert ([int]$registeredFailureTask.Settings.RestartCount -eq 1) "Temporary failure task accepts a bounded retry count"
      Start-ScheduledTask -TaskName $temporaryTaskName
      $restartDeadline = [DateTime]::UtcNow.AddSeconds(90)
      $observedRuns = 0
      while ([DateTime]::UtcNow -lt $restartDeadline -and $observedRuns -lt 2) {
        if (Test-Path -LiteralPath $failureMarker) {
          $observedRuns = @(Get-Content -LiteralPath $failureMarker -Encoding UTF8).Count
        }
        if ($observedRuns -lt 2) { Start-Sleep -Seconds 1 }
      }
      Assert ($observedRuns -ge 2) "A failing temporary task is restarted within the bounded window"
    }
    finally {
      try {
        Stop-ScheduledTask -TaskName $temporaryTaskName -ErrorAction SilentlyContinue
        $stopClock = [Diagnostics.Stopwatch]::StartNew()
        while ($stopClock.Elapsed.TotalSeconds -lt 10) {
          $remainingTask = Get-ScheduledTask -TaskName $temporaryTaskName -ErrorAction SilentlyContinue
          if (-not $remainingTask -or $remainingTask.State -ne "Running") { break }
          Start-Sleep -Milliseconds 250
        }
        Unregister-ScheduledTask -TaskName $temporaryTaskName -Confirm:$false -ErrorAction SilentlyContinue
      }
      finally {
        Remove-Item -LiteralPath $failureScript, $failureMarker -Force -ErrorAction SilentlyContinue
      }
    }

    Stop-ScheduledTask -TaskName MailLocal
    Unregister-ScheduledTask -TaskName MailLocal -Confirm:$false
    # Actual native launcher failure must propagate to Task Scheduler.
    & $powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot "run.ps1") -BunPath (Join-Path $root "missing-bun.exe") -LogPath $log
    Assert ($LASTEXITCODE -ne 0) "Missing Bun produces a nonzero launcher exit"
    Assert ((Get-Content -LiteralPath $log -Raw -Encoding UTF8).Contains("Bun executable missing")) "Launcher error is persisted"
  }
  finally {
    Stop-ScheduledTask -TaskName MailLocal -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName MailLocal -Confirm:$false -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath (Join-Path $root ".env") -ErrorAction SilentlyContinue
  }
}

# Expected native failure tests leave LASTEXITCODE nonzero. Signal suite success
# explicitly so the GitHub Actions PowerShell wrapper does not report failure.
exit 0
