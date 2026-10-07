param([switch]$Integration, [switch]$LoggingOnly)
$ErrorActionPreference = "Stop"
if ($Integration -and $LoggingOnly) { throw "Integration and LoggingOnly cannot be combined." }
. (Join-Path $PSScriptRoot "windows-readiness.ps1")

function Assert($Condition, [string]$Message) {
  if (-not $Condition) { throw "FAIL: $Message" }
  Write-Host "PASS: $Message"
}

# Parse all deployment scripts, including the real entrypoints, on PS 5.1/7.
foreach ($file in Get-ChildItem -LiteralPath $PSScriptRoot -Filter *.ps1) {
  $bytes = [IO.File]::ReadAllBytes($file.FullName)
  $text = [Text.Encoding]::UTF8.GetString($bytes)
  Assert ($text -notmatch '[^\x00-\x7F]') "Deployment script stays codepage-independent: $($file.Name)"
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
  $multipleInstancesIndexes = @(
    for ($index = 0; $index -lt $commandElements.Count; $index++) {
      if ($commandElements[$index] -is [System.Management.Automation.Language.CommandParameterAst] -and
        $commandElements[$index].ParameterName -eq "MultipleInstances") { $index }
    }
  )
  $startWhenAvailableIndexes = @(
    for ($index = 0; $index -lt $commandElements.Count; $index++) {
      if ($commandElements[$index] -is [System.Management.Automation.Language.CommandParameterAst] -and
        $commandElements[$index].ParameterName -eq "StartWhenAvailable") { $index }
    }
  )
  Assert ($multipleInstancesIndexes.Count -eq 1) "Production settings has one MultipleInstances parameter"
  Assert ($startWhenAvailableIndexes.Count -eq 1) "Production settings has one StartWhenAvailable parameter"
  if ($multipleInstancesIndexes.Count -eq 1) {
    $multipleParameter = $commandElements[$multipleInstancesIndexes[0]]
    $multipleArgument = $multipleParameter.Argument
    if ($null -eq $multipleArgument -and $multipleInstancesIndexes[0] + 1 -lt $commandElements.Count) {
      $multipleArgument = $commandElements[$multipleInstancesIndexes[0] + 1]
    }
    Assert ($null -ne $multipleArgument -and $multipleArgument.Extent.Text -eq "IgnoreNew") "Production task ignores duplicate instances"
  }
  $triggerCommands = @($installerAst.FindAll({
      param($node)
      $node -is [System.Management.Automation.Language.CommandAst] -and
        $node.GetCommandName() -eq "New-ScheduledTaskTrigger"
    }, $true))
  Assert ($triggerCommands.Count -eq 2) "Production installer has logon and periodic triggers"
  $periodicTriggers = @($triggerCommands | Where-Object {
      @($_.CommandElements | Where-Object {
          $_ -is [System.Management.Automation.Language.CommandParameterAst] -and $_.ParameterName -eq "Once"
        }).Count -eq 1
    })
  Assert ($periodicTriggers.Count -eq 1) "Production installer has one once trigger"
  if ($periodicTriggers.Count -eq 1) {
    $periodicElements = @($periodicTriggers[0].CommandElements)
    Assert (@($periodicElements | Where-Object {
          $_ -is [System.Management.Automation.Language.CommandParameterAst] -and $_.ParameterName -eq "RepetitionInterval"
        }).Count -eq 1) "Periodic trigger repeats explicitly"
    Assert (-not $periodicTriggers[0].Extent.Text.Contains("RepetitionDuration")) "Periodic trigger duration is indefinite"
  }
  Assert ((Get-Content -LiteralPath (Join-Path $PSScriptRoot "install.ps1") -Raw).Contains("-WindowStyle Hidden")) "Scheduled PowerShell launch is hidden"
  $controlText = Get-Content -LiteralPath (Join-Path $PSScriptRoot "windows-control.ps1") -Raw
  Assert ($controlText.Contains("Stop-MailTask -RunPath")) "Control stop uses the shared instance barrier"
  Assert ($controlText.Contains("-ProbeDisabled")) "Status probes HTTP even when the scheduler is disabled"
  Assert ($controlText.Contains("Get-MailTaskEnabled")) "Control uses Settings.Enabled for desired state"
}
$actionCommands = @($installerAst.FindAll({
    param($node)
    $node -is [System.Management.Automation.Language.CommandAst] -and
      $node.GetCommandName() -eq "New-ScheduledTaskAction"
  }, $true))
Assert ($actionCommands.Count -eq 1) "Production installer has one scheduler action command"
if ($actionCommands.Count -eq 1) {
  Assert ($actionCommands[0].Extent.Text -match '-WindowStyle\s+Hidden') "Scheduled login action hides the PowerShell window"
}
$atLogOn = @($triggerCommands | Where-Object {
    @($_.CommandElements | Where-Object {
        $_ -is [System.Management.Automation.Language.CommandParameterAst] -and $_.ParameterName -eq "AtLogOn"
      }).Count -eq 1
  })
Assert ($atLogOn.Count -eq 1) "Scheduled login action triggers at user logon"
$principalCommands = @($installerAst.FindAll({
    param($node)
    $node -is [System.Management.Automation.Language.CommandAst] -and
      $node.GetCommandName() -eq "New-ScheduledTaskPrincipal"
  }, $true))
Assert ($principalCommands.Count -eq 1) "Production installer has one scheduler principal command"
if ($principalCommands.Count -eq 1) {
  $principalText = $principalCommands[0].Extent.Text
  Assert ($principalText -match '-LogonType\s+Interactive') "Scheduled login action uses the interactive user session"
  Assert ($principalText -match '-RunLevel\s+Limited') "Scheduled login action retains least privilege"
}

$temp = Join-Path ([IO.Path]::GetTempPath()) ("mail-installer-test-" + [guid]::NewGuid())
New-Item -ItemType Directory -Path $temp | Out-Null
try {
  # Load only the installer's logging/native-command functions, never its body.
  $tokens = $null
  $errors = $null
  $ast = [System.Management.Automation.Language.Parser]::ParseFile((Join-Path $PSScriptRoot "install.ps1"), [ref]$tokens, [ref]$errors)
  foreach ($name in @("Write-InstallLog", "Set-InstallStage", "Stop-Install", "Invoke-InstallCommand", "Get-PortOccupant")) {
    $definition = $ast.Find({ param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name }, $true)
    . ([scriptblock]::Create($definition.Extent.Text))
  }
  $script:installLog = Join-Path $temp "install.log"
  $script:clock = [Diagnostics.Stopwatch]::StartNew()
  $script:secrets = @("test-client-secret")
  $script:bun = (Get-Process -Id $PID).Path
  $consoleOutput = @(Invoke-InstallCommand -Executable $bun -CommandArgs @("-NoProfile", "-Command", "[Console]::Error.WriteLine('normal progress test-client-secret'); exit 0") 6>&1)
  Assert ($consoleOutput.Count -eq 0) "Verbose native output stays in the log, not the console"
  $logged = Get-Content -LiteralPath $installLog -Raw
  Assert ($logged.Contains("normal progress [REDACTED]")) "Native stderr is logged and credentials are redacted"
  Assert (-not $logged.Contains("test-client-secret")) "Secret is absent from install log"
  $failureOutput = @(Write-InstallLog "Failed test-client-secret" -Level FAIL 6>&1)
  Assert (($failureOutput -join "`n") -match 'FAIL\s+Failed \[REDACTED\]') "Console failures have a level and redact credentials"
  $escape = [char]27
  Write-InstallLog "${escape}[31mNative warning${escape}[0m" -Level DETAIL
  $logged = Get-Content -LiteralPath $installLog -Raw
  Assert (-not $logged.Contains([string]$escape) -and $logged.Contains("Native warning")) "File logs remove ANSI controls without dropping warnings"
  $script:stage = "[1/4] Configuration"
  $script:stageStarted = 0.0
  $stageOutput = @(Set-InstallStage "[2/4] Runtime" 6>&1)
  Assert (($stageOutput -join "`n") -match 'OK\s+\[1/4\] Configuration \([\d.,]+s\)') "Completed stages report duration"
  Assert (($stageOutput -join "`n") -match 'RUN\s+\[2/4\] Runtime') "The current stage is visible before work starts"
  Assert ($script:stage -eq "[2/4] Runtime") "Failure context tracks the current stage"
  # Exercise the actual placeholder regex constants, including the Korean
  # prefix represented by ASCII regex escapes in the production script.
  $patterns = @($ast.FindAll({
      param($node)
      $node -is [System.Management.Automation.Language.StringConstantExpressionAst] -and
        $node.Value.StartsWith("^(your-")
    }, $true))
  Assert ($patterns.Count -eq 2) "Both OAuth values are checked for placeholders"
  $localizedPlaceholder = ([string][char]0xC5EC) + [char]0xAE30 + [char]0xC5D0 + "_value"
  foreach ($pattern in $patterns) {
    Assert ("your-client" -match $pattern.Value) "English placeholders are rejected"
    Assert ($localizedPlaceholder -match $pattern.Value) "Localized placeholders are rejected without codepage dependence"
    Assert ("PLACEHOLDER" -match $pattern.Value) "Explicit placeholders are rejected"
    Assert ("real-client.apps.googleusercontent.com" -notmatch $pattern.Value) "Non-placeholder credentials pass this check"
  }
  $failed = $false
  try { Invoke-InstallCommand -Executable $bun -CommandArgs @("-NoProfile", "-Command", "exit 7") } catch { $failed = $_.Exception.Message.Contains("7") }
  Assert $failed "Nonzero native exit fails the installation"
  $script:bun = Join-Path $temp "missing-bun.exe"
  $failed = $false
  try { Invoke-InstallCommand -Executable $bun -CommandArgs @("--version") } catch { $failed = $true }
  Assert $failed "Missing executable cannot reuse a previous successful exit code"

  # Exercise early failure reporting with the real installer body. Only the
  # OS entry guard is removed in this temporary fixture; invalid configuration
  # must exit before any Windows scheduler/runtime operation can be reached.
  $configRoot = Join-Path $temp "configuration-fixture"
  $configDeploy = Join-Path $configRoot "deploy"
  $configLogs = Join-Path $configRoot "local"
  New-Item -ItemType Directory -Force -Path $configDeploy, (Join-Path $configLogs "MailLocal") | Out-Null
  $installerSource = Get-Content -LiteralPath (Join-Path $PSScriptRoot "install.ps1") -Raw
  $guard = @($ast.EndBlock.Statements | Where-Object {
      $_ -is [System.Management.Automation.Language.IfStatementAst] -and
      $_.Extent.Text -match 'OSVersion.Platform'
    })
  Assert ($guard.Count -eq 1) "Configuration fixture bypasses only the OS entry guard"
  $installerSource.Replace($guard[0].Extent.Text, "") |
    Set-Content -LiteralPath (Join-Path $configDeploy "install.ps1") -Encoding UTF8
  Copy-Item -LiteralPath (Join-Path $PSScriptRoot "windows-readiness.ps1") -Destination $configDeploy
  $staleLog = Join-Path $configLogs "MailLocal/mail.local.log"
  Set-Content -LiteralPath $staleLog -Value "OLD SERVER 403 -- unrelated to this install" -Encoding UTF8
  $oldLocalAppData = $env:LOCALAPPDATA
  try {
    $env:LOCALAPPDATA = $configLogs
    $hostExecutable = (Get-Process -Id $PID).Path
    $configWorkspace = Join-Path $configRoot "workspace"
    New-Item -ItemType Directory -Force -Path $configWorkspace | Out-Null
    $configOutput = @(& $hostExecutable -NoProfile -File (Join-Path $configDeploy "install.ps1") -Workspace $configWorkspace)
    Assert ($LASTEXITCODE -eq 1) "Missing configuration fails the real installer"
    $configText = $configOutput -join "`n"
    Assert ($configText -match 'FAIL\s+\[1/4\] Configuration') "Failure summary names the actual stage"
    Assert ($configText -match '\.env is missing') "Failure includes actionable configuration guidance"
    $configLog = Get-Content -LiteralPath (Join-Path $configLogs "MailLocal/install.log") -Raw
    Assert ($configText -notmatch 'OLD SERVER|403|Server log:' -and $configLog -notmatch 'OLD SERVER|403') "Early failures do not surface stale server errors"
    Assert ((Get-Content -LiteralPath $staleLog -Raw) -match 'OLD SERVER') "Early failures leave the previous server log intact"
  }
  finally {
    if ($null -eq $oldLocalAppData) { Remove-Item Env:LOCALAPPDATA -ErrorAction SilentlyContinue }
    else { $env:LOCALAPPDATA = $oldLocalAppData }
  }

  # Focused portable coverage; the default suite still executes all Windows
  # job-object and scheduler tests unchanged.
  if ($LoggingOnly) {
    Write-Host "PASS: Portable installer logging checks complete (Windows lifecycle not exercised)"
    exit 0
  }

  $hostExecutable = (Get-Process -Id $PID).Path
  $launchLog = Join-Path $temp "server.log"
  $launchWorkspace = Join-Path $temp "launch-workspace"
  New-Item -ItemType Directory -Path $launchWorkspace | Out-Null
  Set-Content -LiteralPath (Join-Path $launchWorkspace ".env") -Value "PORT=8787" -Encoding ASCII
  & $hostExecutable -NoProfile -File (Join-Path $PSScriptRoot "run.ps1") -BunPath $bun -LogPath $launchLog -Workspace $launchWorkspace
  Assert ($LASTEXITCODE -ne 0) "Launcher reports missing executable with nonzero exit"
  Assert ((Get-Content -LiteralPath $launchLog -Raw -Encoding UTF8).Contains("Bun executable missing")) "Launcher persists missing executable error"
  $fixtureDeploy = Join-Path $temp "deploy"
  New-Item -ItemType Directory -Path $fixtureDeploy | Out-Null
  Copy-Item -LiteralPath (Join-Path $PSScriptRoot "run.ps1") -Destination $fixtureDeploy
  & $hostExecutable -NoProfile -File (Join-Path $fixtureDeploy "run.ps1") -BunPath $hostExecutable -LogPath $launchLog -Workspace $launchWorkspace
  Assert ($LASTEXITCODE -ne 0) "Missing build fails without rebuilding at startup"
  Assert ((Get-Content -LiteralPath $launchLog -Raw -Encoding UTF8).Contains("dist/index.html missing")) "Launcher explains missing build in log"

  # A scheduler stop terminates the launcher before Bun can exit gracefully.
  # Run a real Bun fixture, kill only the launcher PID, and require both the
  # child PID and its listening port to disappear.
  $bunCommand = Get-Command bun -CommandType Application -ErrorAction SilentlyContinue
  Assert ($null -ne $bunCommand) "Bun executable is available for job lifetime regression"
  $jobRoot = Join-Path $temp "job-lifetime-fixture"
  $jobDeploy = Join-Path $jobRoot "deploy"
  $jobDist = Join-Path $jobRoot "dist"
  $jobServer = Join-Path $jobRoot "server"
  New-Item -ItemType Directory -Force -Path $jobDeploy, $jobDist, $jobServer | Out-Null
  Copy-Item -LiteralPath (Join-Path $PSScriptRoot "run.ps1") -Destination $jobDeploy
  Set-Content -LiteralPath (Join-Path $jobRoot ".env") -Value "# job fixture" -Encoding ASCII
  Set-Content -LiteralPath (Join-Path $jobDist "index.html") -Value "<!doctype html><title>job fixture</title>" -Encoding UTF8
  @'
const marker = process.env.MAIL_JOB_TEST_PID_FILE;
const port = Number(process.env.PORT);
if (!marker || !Number.isInteger(port)) {
  throw new Error("Job lifetime fixture environment is incomplete.");
}
Bun.serve({
  hostname: "127.0.0.1",
  port,
  fetch() {
    return new Response("job fixture");
  },
});
await Bun.write(marker, String(process.pid));
await new Promise(() => {});
'@ | Set-Content -LiteralPath (Join-Path $jobServer "index.ts") -Encoding UTF8
  $jobPortListener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0)
  $jobPortListener.Start()
  $jobPort = ([Net.IPEndPoint]$jobPortListener.LocalEndpoint).Port
  $jobPortListener.Stop()
  $jobPidFile = Join-Path $jobRoot "bun.pid"
  $jobLog = Join-Path $jobRoot "server.log"
  $jobLauncher = $null
  $jobBunPid = 0
  $jobBunProcess = $null
  $oldPort = $env:PORT
  $oldJobPidFile = $env:MAIL_JOB_TEST_PID_FILE
  try {
    $env:PORT = [string]$jobPort
    $env:MAIL_JOB_TEST_PID_FILE = $jobPidFile
    $quote = { param([string]$value) '"' + $value + '"' }
    $jobArguments = @(
      "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
      "-File", (& $quote (Join-Path $jobDeploy "run.ps1")),
      "-BunPath", (& $quote $bunCommand.Source),
      "-LogPath", (& $quote $jobLog),
      "-Workspace", (& $quote $jobRoot)
    )
    $jobLauncher = Start-Process -FilePath $hostExecutable -ArgumentList $jobArguments -WorkingDirectory $jobRoot -PassThru
    $startDeadline = [DateTime]::UtcNow.AddSeconds(15)
    while ([DateTime]::UtcNow -lt $startDeadline -and $jobBunPid -eq 0) {
      if (Test-Path -LiteralPath $jobPidFile) {
        $pidText = (Get-Content -LiteralPath $jobPidFile -Raw -Encoding UTF8).Trim()
        if ($pidText -match '^\d+$') { $jobBunPid = [int]$pidText }
      }
      if ($jobBunPid -eq 0 -and $jobLauncher.HasExited) { throw "Job lifetime launcher exited before Bun started." }
      if ($jobBunPid -eq 0) { Start-Sleep -Milliseconds 100 }
    }
    Assert ($jobBunPid -gt 0) "Launcher starts the Bun lifetime fixture"
    $jobBunProcess = Get-Process -Id $jobBunPid -ErrorAction SilentlyContinue
    Assert ($null -ne $jobBunProcess) "Bun lifetime fixture process is running"
    $portReady = $false
    $readyDeadline = [DateTime]::UtcNow.AddSeconds(5)
    while ([DateTime]::UtcNow -lt $readyDeadline -and -not $portReady) {
      $client = $null
      try {
        $client = [Net.Sockets.TcpClient]::new()
        $client.Connect("127.0.0.1", $jobPort)
        $portReady = $true
      }
      catch {}
      finally { if ($null -ne $client) { $client.Dispose() } }
      if (-not $portReady) { Start-Sleep -Milliseconds 100 }
    }
    Assert $portReady "Bun lifetime fixture binds its port"
    $jobLauncher.Kill()
    $jobLauncher.WaitForExit(10000)
    Assert $jobLauncher.HasExited "Forced launcher termination completes"
    $childGone = $false
    $portFree = $false
    $stopDeadline = [DateTime]::UtcNow.AddSeconds(10)
    while ([DateTime]::UtcNow -lt $stopDeadline -and (-not $childGone -or -not $portFree)) {
      $childGone = $jobBunProcess.HasExited
      $probeListener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, $jobPort)
      try {
        $probeListener.Start()
        $portFree = $true
      }
      catch { $portFree = $false }
      finally { $probeListener.Stop() }
      if (-not $childGone -or -not $portFree) { Start-Sleep -Milliseconds 100 }
    }
    Assert $childGone "Forced launcher termination reaps the Bun child"
    Assert $portFree "Forced launcher termination frees the Bun port"
  }
  finally {
    if ($null -ne $jobLauncher -and -not $jobLauncher.HasExited) {
      $jobLauncher.Kill()
      $jobLauncher.WaitForExit(10000)
    }
    if ($null -ne $jobBunProcess -and -not $jobBunProcess.HasExited) {
      $jobBunProcess.Kill()
      $jobBunProcess.WaitForExit(10000)
    }
    if ($null -eq $oldPort) { Remove-Item Env:PORT -ErrorAction SilentlyContinue } else { $env:PORT = $oldPort }
    if ($null -eq $oldJobPidFile) { Remove-Item Env:MAIL_JOB_TEST_PID_FILE -ErrorAction SilentlyContinue } else { $env:MAIL_JOB_TEST_PID_FILE = $oldJobPidFile }
  }

  # Scheduler commands do not exist on Linux; use controlled task observations.
  function Get-ScheduledTask {
    [CmdletBinding()]
    param($TaskName, $TaskPath)
    [pscustomobject]@{ TaskName = $TaskName; TaskPath = if ($TaskPath) { $TaskPath } else { "\" }; State = $script:taskState }
  }
  function Get-ScheduledTaskInfo {
    [CmdletBinding()]
    param($TaskName, $TaskPath)
    [pscustomobject]@{ LastRunTime = $script:lastRun; LastTaskResult = $script:taskResult }
  }
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

  # Recovery snapshots fail closed before a replacement can disable or stop
  # the existing task, and Enabled comes from Settings rather than State.
  $snapshotTask = [pscustomobject]@{
    State = "Running"
    Settings = [pscustomobject]@{ Enabled = $false }
  }
  function Export-ScheduledTask {
    [CmdletBinding()]
    param($TaskName, $TaskPath)
    if ($script:exportRecoveryFailure) { throw "export failed" }
    return "<Task />"
  }
  $script:exportRecoveryFailure = $false
  $snapshot = Export-MailTaskRecovery -Task $snapshotTask
  Assert (-not $snapshot.Enabled -and $snapshot.Active) "Recovery snapshot preserves Settings.Enabled and observed active state"
  $missingSettingsFailed = $false
  try { Export-MailTaskRecovery -Task ([pscustomobject]@{ State = "Ready"; Settings = [pscustomobject]@{} }) } catch { $missingSettingsFailed = $true }
  Assert $missingSettingsFailed "Missing Enabled state blocks recovery snapshot"
  $script:exportRecoveryFailure = $true
  $snapshotFailed = $false
  try { Export-MailTaskRecovery -Task $snapshotTask } catch { $snapshotFailed = $true }
  Assert $snapshotFailed "Recovery export failure blocks replacement"
  $script:exportRecoveryFailure = $false

  # Exercise the real uninstaller with isolated scheduler mocks. These cases
  # never touch the user's MailLocal task or files.
  # Mock the shared Schedule.Service instance query rather than adding a
  # production-only non-Windows fallback.
  function New-Object {
    [CmdletBinding(DefaultParameterSetName = "TypeName")]
    param(
      [Parameter(Position = 0, ParameterSetName = "TypeName")][string]$TypeName,
      [Parameter(ParameterSetName = "ComObject")][string]$ComObject,
      [Parameter(ParameterSetName = "TypeName")][object[]]$ArgumentList
    )
    if ($ComObject -eq "Schedule.Service") {
      $service = [pscustomobject]@{}
      $folder = [pscustomobject]@{}
      $registered = [pscustomobject]@{}
      $script:mockScheduleFolder = $folder
      $script:mockScheduleTask = $registered
      Add-Member -InputObject $service -MemberType ScriptMethod -Name Connect -Value { }
      Add-Member -InputObject $service -MemberType ScriptMethod -Name GetFolder -Value { param($Path) $script:mockScheduleFolder }
      Add-Member -InputObject $folder -MemberType ScriptMethod -Name GetTask -Value { param($Name) $script:mockScheduleTask }
      # Mirror IRunningTaskCollection: an object with Count. A bare one-item
      # array would be unrolled, and PowerShell 5.1 objects have no Count.
      Add-Member -InputObject $registered -MemberType ScriptMethod -Name GetInstances -Value {
        param($Flags)
        $active = $script:lingeringInstance -or $script:uninstallState -eq "Running" -or $script:uninstallState -eq "Queued"
        return [pscustomobject]@{ Count = $(if ($active) { 1 } else { 0 }) }
      }
      return $service
    }
    & Microsoft.PowerShell.Utility\New-Object @PSBoundParameters
  }

  # Dot-source inside a child scope so scheduler mocks share this test's
  # script-scoped state without leaking the entrypoint's local variables.
  $uninstallScript = {
    param([double]$WaitTimeoutSeconds, [int]$PollMilliseconds = 250)
    . (Join-Path $PSScriptRoot "uninstall.ps1") @PSBoundParameters
  }
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
  $script:uninstallRunPath = Join-Path $PSScriptRoot "run.ps1"
  function Get-ScheduledTask {
    [CmdletBinding()]
    param([string]$TaskPath)
    $script:uninstallDiscoveryCalls++
    if ($null -ne $script:uninstallDiscoveryFailure) { throw $script:uninstallDiscoveryFailure }
    if ($TaskPath -ne "\") { throw "unexpected task path: $TaskPath" }
    if ($script:uninstallTaskPresent) {
      [pscustomobject]@{
        TaskName = "MailLocal"
        TaskPath = "\"
        State = $script:uninstallState
        Settings = [pscustomobject]@{ Enabled = ($script:uninstallState -ne "Disabled" -and -not $script:controlDisabled) }
        Actions = @([pscustomobject]@{ Arguments = "-NoProfile -File `"$($script:uninstallRunPath)`"" })
      }
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
    $script:controlDisabled = $true
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
  function Register-ScheduledTask {
    [CmdletBinding()]
    param([string]$TaskName, [string]$TaskPath, [string]$Xml, [switch]$Force)
    if ($TaskPath -ne "\") { throw "unexpected task path: $TaskPath" }
    $script:restoreRegisterCalls++
    $script:restoreObservedStopped = ($script:uninstallState -ne "Running" -and $script:uninstallState -ne "Queued")
  }
  function Enable-ScheduledTask {
    [CmdletBinding()]
    param([string]$TaskName, [string]$TaskPath)
    if ($TaskPath -ne "\") { throw "unexpected task path: $TaskPath" }
    $script:restoreEnableCalls++
    $script:controlDisabled = $false
    if ($script:uninstallState -eq "Disabled") { $script:uninstallState = "Ready" }
  }
  function Start-ScheduledTask {
    [CmdletBinding()]
    param([string]$TaskName, [string]$TaskPath)
    if ($TaskPath -ne "\") { throw "unexpected task path: $TaskPath" }
    $script:restoreStartCalls++
  }
  $script:restoreRegisterCalls = 0
  $script:restoreEnableCalls = 0
  $script:restoreStartCalls = 0
  $script:restoreObservedStopped = $false
  $script:uninstallTaskPresent = $true
  $script:uninstallState = "Running"
  $script:uninstallStopTransitions = $true
  $script:uninstallStopCalls = 0
  $script:uninstallDisableCalls = 0
  $restoreResult = Restore-MailTaskRecovery -Snapshot ([pscustomobject]@{
      Definition = "<Task />"
      Enabled = $false
      Active = $true
    }) -RunPath $script:uninstallRunPath
  Assert ($restoreResult.Succeeded -and $script:restoreRegisterCalls -eq 1 -and $script:restoreObservedStopped) "Rollback stops the owned replacement before restoring XML"
  Assert ($script:restoreStartCalls -eq 0 -and $restoreResult.Message -match "disabled") "Rollback preserves an intentionally disabled task"

  # A failed stop before replacement must restore Enabled, not retry the
  # same failing stop and leave the original task permanently disabled.
  $script:uninstallStopFailure = $true
  $script:uninstallState = "Running"
  $registerBefore = $script:restoreRegisterCalls
  $stopBefore = $script:uninstallStopCalls
  $restoreResult = Restore-MailTaskRecovery -Snapshot ([pscustomobject]@{
      Definition = "<Task />"; Enabled = $true; Active = $true
    }) -RunPath $script:uninstallRunPath -StateOnly
  Assert ($restoreResult.Succeeded -and -not $script:controlDisabled) "Failed pre-replacement stop restores automatic recovery"
  Assert ($script:restoreRegisterCalls -eq $registerBefore -and $script:uninstallStopCalls -eq $stopBefore) "State-only rollback does not replace XML or repeat failed stop"
  $script:uninstallStopFailure = $false

  # Load controller functions without its Windows-only main or real .env.
  $controlAst = [System.Management.Automation.Language.Parser]::ParseFile((Join-Path $PSScriptRoot "windows-control.ps1"), [ref]$tokens, [ref]$errors)
  foreach ($definition in $controlAst.FindAll({
      param($node)
      $node -is [System.Management.Automation.Language.FunctionDefinitionAst]
    }, $true)) {
    . ([scriptblock]::Create($definition.Extent.Text))
  }
  $envFile = Join-Path $temp "control.env"
  $run = $script:uninstallRunPath
  $task = "MailLocal"
  $taskPath = "\"
  $logPath = Join-Path $temp "control.log"
  $WaitTimeoutSeconds = 0.1
  $PollMilliseconds = 1
  foreach ($case in @(
      @{ Text = "PORT=8788`nPORT=8789"; Port = 8789 },
      @{ Text = "PORT="; Port = 8787 },
      @{ Text = "# PORT=9999"; Port = 8787 }
    )) {
    Set-Content -LiteralPath $envFile -Value $case.Text -Encoding UTF8
    Assert ((Get-ControlPort) -eq $case.Port) "Control reads last PORT assignment and installer-compatible empty values"
  }
  foreach ($invalidPort in @(" 8787", "8787 ", "1023", "65536", "oops")) {
    Set-Content -LiteralPath $envFile -Value "PORT=$invalidPort" -Encoding UTF8
    $failed = $false
    try { Get-ControlPort | Out-Null } catch { $failed = $true }
    Assert $failed "Control rejects invalid PORT without normalizing it: '$invalidPort'"
  }
  function Wait-MailServer {
    param($Url, $TaskName, $StartedAt, $TimeoutSeconds, [switch]$ProbeDisabled)
    $script:controlProbeDisabled = [bool]$ProbeDisabled
    return [pscustomobject]@{ Reason = $script:controlReadyReason }
  }
  $script:controlReadyReason = "ready"
  $script:uninstallState = "Running"
  $script:restoreStartCalls = 0
  Start-ControlTask -Port 8787
  Assert ($script:restoreStartCalls -eq 0) "Start does not duplicate a healthy running task"
  $script:uninstallState = "Queued"
  Start-ControlTask -Port 8787
  Assert ($script:restoreStartCalls -eq 0) "Start waits for queued work without submitting another start"
  $script:controlReadyReason = "timeout"
  $stopBefore = $script:uninstallStopCalls
  $failed = $false
  try { Start-ControlTask -Port 8787 } catch { $failed = $_.Exception.Message -match "queued" }
  Assert ($failed -and $script:restoreStartCalls -eq 0) "Queued timeout reports failure without duplicate submission"
  $script:uninstallState = "Running"
  $failed = $false
  try { Start-ControlTask -Port 8787 } catch { $failed = $_.Exception.Message -match "unresponsive" }
  Assert ($failed -and $script:uninstallStopCalls -eq $stopBefore) "Start does not kill an unresponsive running server"
  $script:uninstallState = "Disabled"
  $script:controlDisabled = $true
  $script:controlReadyReason = "ready"
  Start-ControlTask -Port 8787
  Assert (-not $script:controlDisabled -and $script:restoreStartCalls -eq 1) "Start re-enables an intentionally stopped task and requests launch"
  Stop-ControlTask
  Assert $script:controlDisabled "Stop disables future automatic recovery"
  $script:uninstallState = "Disabled"
  $script:lingeringInstance = $true
  $failed = $false
  try { Restart-ControlTask -Port 8787 } catch { $failed = $_.Exception.Message -match "did not stop" }
  Assert ($failed -and $script:controlDisabled -and $script:restoreStartCalls -eq 1) "Restart refuses to overlap an instance hidden by Disabled state"
  $script:lingeringInstance = $false
  Restart-ControlTask -Port 8787
  Assert (-not $script:controlDisabled -and $script:restoreStartCalls -eq 2) "Restart enables and starts only after owned instances are gone"
  $script:uninstallState = "Disabled"
  $script:controlDisabled = $true
  Show-ControlStatus -Port 8787
  Assert $script:controlProbeDisabled "Status probes HTTP even while scheduler is disabled"
  $script:controlReadyReason = "timeout"
  $failed = $false
  try { Show-ControlStatus -Port 8787 } catch { $failed = $_.Exception.Message -match "not responding" }
  Assert $failed "Unhealthy status returns failure rather than silent success"
  $script:uninstallTaskPresent = $false
  $failed = $false
  try { Start-ControlTask -Port 8787 } catch { $failed = $_.Exception.Message -match "not installed" }
  Assert $failed "Start reports missing installation"
  # Restore the real readiness function before subsequent entrypoint tests.
  . (Join-Path $PSScriptRoot "windows-readiness.ps1")
  $script:controlDisabled = $false

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
    Assert ($errorText -match "finite number") "Invalid uninstall timeout is rejected"
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

  # A same-name task in the exact root with another run.ps1 is not ours.
  $script:uninstallTaskPresent = $true
  $script:uninstallState = "Ready"
  $script:uninstallRunPath = Join-Path $temp "other-run.ps1"
  $script:uninstallDisableCalls = 0
  $script:uninstallStopCalls = 0
  $script:uninstallUnregisterCalls = 0
  $errorText = ""
  try { & $uninstallScript -WaitTimeoutSeconds 0.1 -PollMilliseconds 1 } catch { $errorText = $_.Exception.Message }
  Assert ($errorText -match "another deploy/run\.ps1") "Uninstaller rejects unrelated root task ownership"
  Assert ($script:uninstallDisableCalls -eq 0 -and $script:uninstallStopCalls -eq 0 -and $script:uninstallUnregisterCalls -eq 0) "Unrelated root task is not mutated"
  $script:uninstallRunPath = Join-Path $PSScriptRoot "run.ps1"

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

  # Disabled does not bypass the owned-instance stop barrier.
  $script:uninstallTaskPresent = $true
  $script:uninstallState = "Disabled"
  $script:uninstallStopCalls = 0
  $script:uninstallDisableCalls = 0
  $script:uninstallUnregisterCalls = 0
  $script:uninstallUnregisterRemovesTask = $true
  $disabledOutput = @(& $uninstallScript -WaitTimeoutSeconds 0.1 -PollMilliseconds 1 6>&1)
  Assert (-not $script:uninstallTaskPresent -and $script:uninstallStopCalls -eq 1) "Disabled task still receives an explicit stop request"
  Assert (($disabledOutput -join "`n") -match "Manually started servers") "Uninstall distinguishes managed instances from foreground servers"

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
  Assert ($errorText -match "did not stop") "Active task wait has a bounded timeout"
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
  Assert ($errorText -match "Could not remove") "Surviving task fails removal verification"
  Assert $script:uninstallTaskPresent "Removal verification observes a surviving task"
  foreach ($sentinel in $sentinels) {
    Assert (Test-Path -LiteralPath $sentinel) "Uninstaller preserves $([IO.Path]::GetFileName($sentinel))"
  }
}
finally {
  Remove-Item -LiteralPath $temp -Recurse -Force
  Remove-Variable -Name mockScheduleFolder, mockScheduleTask -Scope Script -ErrorAction SilentlyContinue
  # Restore the actual Windows cmdlets before integration testing.
  foreach ($name in @("Get-ScheduledTask", "Get-ScheduledTaskInfo", "Get-NetTCPConnection", "Export-ScheduledTask", "Disable-ScheduledTask", "Stop-ScheduledTask", "Unregister-ScheduledTask", "Register-ScheduledTask", "Enable-ScheduledTask", "Start-ScheduledTask", "New-Object")) {
    Remove-Item "Function:\$name" -ErrorAction SilentlyContinue
  }
}

if ($Integration) {
  if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) { throw "Integration requires Windows" }
  # The checkout acts as the installed package (dist must already be built);
  # a separate workspace with a non-ASCII name holds .env like sj-mail setup.
  $root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
  if (-not (Test-Path -LiteralPath (Join-Path $root "dist\index.html"))) { throw "Build dist before the integration test" }
  $workspace = Join-Path ([IO.Path]::GetTempPath()) ("mail-workspace-" + ([string][char]0xBA54) + [char]0xC77C + "-" + [guid]::NewGuid().ToString("N"))
  $envPath = Join-Path $workspace ".env"
  $mailLogDir = Join-Path $env:LOCALAPPDATA "MailLocal"
  if (Get-ScheduledTask -TaskName MailLocal -TaskPath "\" -ErrorAction SilentlyContinue) { throw "Refusing to replace existing MailLocal task" }
  if (Test-Path -LiteralPath $mailLogDir) { throw "Refusing to overwrite existing MailLocal user files" }
  $powershell = Join-Path $env:SystemRoot "System32\WindowsPowerShell\v1.0\powershell.exe"
  $bunPath = (Get-Command bun -CommandType Application).Source
  $log = Join-Path $mailLogDir "mail.local.log"
  try {
    New-Item -ItemType Directory -Path $workspace | Out-Null
    # Dummy OAuth values only. Readiness must work without Google connectivity.
    @("GOOGLE_CLIENT_ID=ci.apps.googleusercontent.com", "GOOGLE_CLIENT_SECRET=ci-dummy-secret", "PORT=18787", "OAUTH_REDIRECT=http://localhost:18787/auth/callback") |
      Set-Content -LiteralPath $envPath -Encoding ASCII

    # A previous (ZIP/source) installation owns MailLocal. Without an explicit
    # replacement the installer must leave it alone; setup can find it.
    $legacyRun = Join-Path ([IO.Path]::GetTempPath()) ("mail-legacy-" + [guid]::NewGuid().ToString("N") + "\deploy\run.ps1")
    $legacyAction = New-ScheduledTaskAction -Execute $powershell -Argument "-WindowStyle Hidden -NoProfile -File `"$legacyRun`" -BunPath `"$bunPath`""
    $legacyPrincipal = New-ScheduledTaskPrincipal -UserId ([System.Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType Interactive -RunLevel Limited
    Register-ScheduledTask -TaskName MailLocal -TaskPath "\" -Action $legacyAction -Principal $legacyPrincipal -Force | Out-Null
    Assert ((Get-MailTaskRunPath) -eq $legacyRun) "Setup detection reads the previous installation's launcher"
    & $powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot "install.ps1") -Workspace $workspace -BunPath $bunPath
    Assert ($LASTEXITCODE -ne 0) "Installer refuses a task owned by another installation"
    Assert ((Get-MailTaskRunPath) -eq $legacyRun) "Refused installation leaves the previous task intact"

    & $powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot "install.ps1") -Workspace $workspace -BunPath $bunPath -ReplaceRunPath $legacyRun
    Assert ($LASTEXITCODE -eq 0) "Real Windows installer takes over the previous task and starts the server"
    Assert (Test-MailTaskOwnership -Task (Get-MailTask) -RunPath (Join-Path $PSScriptRoot "run.ps1")) "MailLocal now launches this package"
    $response = Invoke-RestMethod -Uri "http://127.0.0.1:18787/auth/status"
    Assert ($response.authed -eq $false) "Scheduled server answers without real credentials"
    $installedTask = Get-ScheduledTask -TaskName MailLocal -TaskPath "\"
    Assert ($installedTask.Settings.MultipleInstances -eq "IgnoreNew") "Scheduler ignores duplicate instances"
    Assert ($installedTask.Settings.StartWhenAvailable) "Scheduler starts when available"
    $installedTriggers = @($installedTask.Triggers)
    Assert ($installedTriggers.Count -eq 2) "Scheduler keeps logon and periodic triggers"
    $periodicInstalled = @($installedTriggers | Where-Object { $_.Repetition.Interval -eq "PT1M" })
    $repetitions = ($installedTriggers | ForEach-Object { "interval=$($_.Repetition.Interval) duration=$($_.Repetition.Duration) stopAtEnd=$($_.Repetition.StopAtDurationEnd)" }) -join "; "
    Assert ($periodicInstalled.Count -eq 1 -and -not $periodicInstalled[0].Repetition.StopAtDurationEnd) "Scheduler periodic trigger is indefinite at one minute ($repetitions)"
    Assert ($installedTask.Actions.Arguments.Contains($bunPath)) "Scheduled launch uses the exact installed Bun executable"
    Assert ($installedTask.Actions.Arguments.Contains("-Workspace `"$workspace`"")) "Scheduled launch passes the non-ASCII workspace intact"
    Assert ($installedTask.Actions.Arguments.Contains("-WindowStyle Hidden")) "Scheduled launch keeps the PowerShell window hidden"

    # Register a uniquely named, deliberately failing task and observe one
    # periodic trigger restart.
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
      $failureTrigger = New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Minutes 1)
      $failurePrincipal = New-ScheduledTaskPrincipal -UserId ([System.Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType Interactive -RunLevel Limited
      $failureSettings = New-ScheduledTaskSettingsSet `
        -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
        -MultipleInstances IgnoreNew -StartWhenAvailable `
        -ExecutionTimeLimit (New-TimeSpan -Seconds 0)
      Register-ScheduledTask -TaskName $temporaryTaskName -Action $failureAction -Trigger $failureTrigger -Principal $failurePrincipal -Settings $failureSettings -Force | Out-Null
      $registeredFailureTask = Get-ScheduledTask -TaskName $temporaryTaskName -TaskPath "\"
      Assert ($registeredFailureTask.Settings.MultipleInstances -eq "IgnoreNew") "Temporary failure task ignores duplicate instances"
      Assert ($registeredFailureTask.Triggers.Repetition.Interval -eq "PT1M") "Temporary failure task repeats every minute"
      Start-ScheduledTask -TaskName $temporaryTaskName -TaskPath "\"
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
        Disable-ScheduledTask -TaskName $temporaryTaskName -TaskPath "\" -ErrorAction SilentlyContinue
        Stop-ScheduledTask -TaskName $temporaryTaskName -TaskPath "\" -ErrorAction SilentlyContinue
        $stopClock = [Diagnostics.Stopwatch]::StartNew()
        while ($stopClock.Elapsed.TotalSeconds -lt 10) {
          $remainingTask = Get-ScheduledTask -TaskName $temporaryTaskName -TaskPath "\" -ErrorAction SilentlyContinue
          if (-not $remainingTask -or $remainingTask.State -ne "Running") { break }
          Start-Sleep -Milliseconds 250
        }
        Unregister-ScheduledTask -TaskName $temporaryTaskName -TaskPath "\" -Confirm:$false -ErrorAction SilentlyContinue
      }
      finally {
        Remove-Item -LiteralPath $failureScript, $failureMarker -Force -ErrorAction SilentlyContinue
      }
    }

    Disable-ScheduledTask -TaskName MailLocal -TaskPath "\"
    Stop-ScheduledTask -TaskName MailLocal -TaskPath "\"
    Unregister-ScheduledTask -TaskName MailLocal -TaskPath "\" -Confirm:$false
    # Actual native launcher failure must propagate to Task Scheduler.
    & $powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot "run.ps1") -BunPath (Join-Path $root "missing-bun.exe") -LogPath $log -Workspace $workspace
    Assert ($LASTEXITCODE -ne 0) "Missing Bun produces a nonzero launcher exit"
    Assert ((Get-Content -LiteralPath $log -Raw -Encoding UTF8).Contains("Bun executable missing")) "Launcher error is persisted"
  }
  finally {
    Disable-ScheduledTask -TaskName MailLocal -TaskPath "\" -ErrorAction SilentlyContinue
    Stop-ScheduledTask -TaskName MailLocal -TaskPath "\" -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName MailLocal -TaskPath "\" -Confirm:$false -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $workspace -Recurse -Force -ErrorAction SilentlyContinue
  }
}

# Expected native failure tests leave LASTEXITCODE nonzero. Signal suite success
# explicitly so the GitHub Actions PowerShell wrapper does not report failure.
exit 0
