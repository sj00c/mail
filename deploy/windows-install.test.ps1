param([switch]$Integration)
$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "windows-readiness.ps1")

function Assert($Condition, [string]$Message) {
  if (-not $Condition) { throw "FAIL: $Message" }
  Write-Host "PASS: $Message"
}

# Parse all deployment scripts, including the real entrypoints, on PS 5.1/7.
foreach ($file in Get-ChildItem -LiteralPath $PSScriptRoot -Filter *.ps1) {
  $tokens = $null
  $errors = $null
  $null = [System.Management.Automation.Language.Parser]::ParseFile($file.FullName, [ref]$tokens, [ref]$errors)
  Assert ($errors.Count -eq 0) "PowerShell syntax: $($file.Name) ($errors)"
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
}
finally {
  Remove-Item -LiteralPath $temp -Recurse -Force
  # Restore the actual Windows cmdlets before integration testing.
  foreach ($name in @("Get-ScheduledTask", "Get-ScheduledTaskInfo", "Get-NetTCPConnection")) {
    Remove-Item "Function:\$name" -ErrorAction SilentlyContinue
  }
}

if ($Integration) {
  if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) { throw "Integration requires Windows" }
  $root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
  if (Test-Path -LiteralPath (Join-Path $root ".env")) { throw "Refusing to overwrite existing .env" }
  if (Get-ScheduledTask -TaskName MailLocal -ErrorAction SilentlyContinue) { throw "Refusing to replace existing MailLocal task" }
  $powershell = Join-Path $env:SystemRoot "System32\WindowsPowerShell\v1.0\powershell.exe"
  $bunPath = (Get-Command bun -CommandType Application).Source
  $log = Join-Path $env:LOCALAPPDATA "MailLocal\mail.local.log"
  try {
    # Dummy OAuth values only. Readiness must work without Google connectivity.
    @("GOOGLE_CLIENT_ID=ci.apps.googleusercontent.com", "GOOGLE_CLIENT_SECRET=ci-dummy-secret", "PORT=18787", "OAUTH_REDIRECT=http://localhost:18787/auth/callback") |
      Set-Content -LiteralPath (Join-Path $root ".env") -Encoding ASCII
    & $powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot "install.ps1")
    Assert ($LASTEXITCODE -eq 0) "Real Windows installer and scheduled server start successfully"
    $response = Invoke-RestMethod -Uri "http://127.0.0.1:18787/auth/status"
    Assert ($response.authed -eq $false) "Scheduled server answers without real credentials"
    $installedTask = Get-ScheduledTask -TaskName MailLocal
    Assert ($installedTask.Settings.RestartInterval -eq "PT1M") "Scheduler accepts one-minute restart interval"
    Assert ($installedTask.Actions.Arguments.Contains($bunPath)) "Scheduled launch uses the exact installed Bun executable"
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
