# Shared by the Windows installer, manual control entrypoint, and regression
# tests (PowerShell 5.1+).

$script:MailTaskName = "MailLocal"
$script:MailTaskPath = "\"

# `stop` pauses the server only until the user signs in again. The flag is a
# volatile HKCU key: Windows discards it when the user's registry hive
# unloads (sign-out, restart, shutdown), so a stop can never outlive the
# session and automatic startup cannot stay off by accident. The task itself
# stays enabled; deploy/run.ps1 exits immediately while the key exists.
# Keep in sync with the -PauseKey default in deploy/run.ps1.
$script:MailPauseKey = "Software\MailLocalPaused"

function Test-MailPaused {
  return Test-Path -LiteralPath "HKCU:\$script:MailPauseKey"
}

function Set-MailPaused {
  $key = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey(
    $script:MailPauseKey,
    [Microsoft.Win32.RegistryKeyPermissionCheck]::Default,
    [Microsoft.Win32.RegistryOptions]::Volatile)
  if ($null -eq $key) { throw "Could not record the stop request in HKCU\$script:MailPauseKey." }
  $key.Close()
}

function Clear-MailPaused {
  [Microsoft.Win32.Registry]::CurrentUser.DeleteSubKey($script:MailPauseKey, $false)
}

function Get-MailLastEvent([string]$LogPath) {
  # deploy/run.ps1 records every launch and exit; the scheduler's
  # LastTaskResult is overwritten each minute by ignored duplicate triggers.
  if (-not (Test-Path -LiteralPath $LogPath -PathType Leaf)) { return $null }
  $events = @(Get-Content -LiteralPath $LogPath -Encoding UTF8 -Tail 500 |
    Where-Object { $_ -match '^(Starting Mail|Mail exited|Mail launch failed)' })
  if ($events.Count -eq 0) { return $null }
  return $events[-1]
}

function Get-MailTask {
  # Always query the root path explicitly. A same-name task in another folder
  # belongs to somebody else and must not be controlled by this application.
  $tasks = @(Get-ScheduledTask -TaskPath $script:MailTaskPath -ErrorAction Stop |
    Where-Object { $_.TaskName -eq $script:MailTaskName -and $_.TaskPath -eq $script:MailTaskPath })
  if ($tasks.Count -eq 0) { return $null }
  return $tasks[0]
}

function Get-MailTaskInfo {
  return Get-ScheduledTaskInfo -TaskName $script:MailTaskName -TaskPath $script:MailTaskPath -ErrorAction Stop
}

function Get-MailTaskEnabled([object]$Task) {
  if ($null -eq $Task -or $null -eq $Task.Settings -or
    $null -eq $Task.Settings.PSObject.Properties["Enabled"]) {
    throw "Could not read the task's Enabled state."
  }
  if ($Task.Settings.Enabled -is [bool]) { return [bool]$Task.Settings.Enabled }
  $parsed = $false
  if ([bool]::TryParse([string]$Task.Settings.Enabled, [ref]$parsed)) { return $parsed }
  throw "Could not parse the task's Enabled state."
}

function ConvertTo-MailFullPath([string]$Path) {
  if ([string]::IsNullOrWhiteSpace($Path)) { return "" }
  $value = [Environment]::ExpandEnvironmentVariables($Path.Trim().Trim('"').Trim("'"))
  return [IO.Path]::GetFullPath($value).TrimEnd("\", "/")
}

function Get-MailRunPathFromTask([object]$Task) {
  if ($null -eq $Task) { return $null }
  $actions = @($Task.Actions)
  if ($actions.Count -ne 1) { return $null }
  $arguments = [string]$actions[0].Arguments
  $match = [regex]::Match($arguments, '(?i)(?:^|\s)-File\s+(?:"([^"]+)"|''([^'']+)''|(\S+))')
  if (-not $match.Success) { return $null }
  foreach ($index in 1..3) {
    if ($match.Groups[$index].Success) { return $match.Groups[$index].Value }
  }
  return $null
}

function Get-MailTaskRunPath {
  # Used by setup to find (and migrate) the installation that
  # currently owns automatic startup.
  return Get-MailRunPathFromTask (Get-MailTask)
}

function Test-MailTaskOwnership {
  # RunPath lists every launcher this caller may manage: its own run.ps1 and,
  # while migrating, the previous installation's run.ps1.
  param(
    [Parameter(Mandatory = $true)][object]$Task,
    [Parameter(Mandatory = $true)][string[]]$RunPath
  )
  $actual = ConvertTo-MailFullPath (Get-MailRunPathFromTask $Task)
  if ([string]::IsNullOrEmpty($actual)) { return $false }
  foreach ($candidate in $RunPath) {
    $expected = ConvertTo-MailFullPath $candidate
    if (-not [string]::IsNullOrEmpty($expected) -and
      [string]::Equals($expected, $actual, [StringComparison]::OrdinalIgnoreCase)) { return $true }
  }
  return $false
}

function Assert-MailTaskOwnership {
  param(
    [Parameter(Mandatory = $true)][object]$Task,
    [Parameter(Mandatory = $true)][string[]]$RunPath
  )
  if (-not (Test-MailTaskOwnership -Task $Task -RunPath $RunPath)) {
    throw "MailLocal points to another deploy/run.ps1. Run the Mail installer so it can migrate that installation, or remove it first."
  }
}

function Export-MailTaskRecovery {
  param([Parameter(Mandatory = $true)][object]$Task)
  $enabled = Get-MailTaskEnabled $Task
  $snapshot = [ordered]@{
    Definition = $null
    Enabled = $enabled
    Active = ([string]$Task.State -eq "Running" -or [string]$Task.State -eq "Queued")
  }
  try {
    $snapshot.Definition = [string](Export-ScheduledTask -TaskName $script:MailTaskName -TaskPath $script:MailTaskPath -ErrorAction Stop)
    if ([string]::IsNullOrWhiteSpace($snapshot.Definition)) {
      throw "Empty task definition."
    }
  }
  catch {
    throw "Could not save the existing task definition. Replacement stopped to protect the existing installation."
  }
  return [pscustomobject]$snapshot
}

function Restore-MailTaskRecovery {
  param(
    [Parameter(Mandatory = $true)][object]$Snapshot,
    [Parameter(Mandatory = $true)][string[]]$RunPath,
    [switch]$StateOnly
  )
  if ([string]::IsNullOrWhiteSpace([string]$Snapshot.Definition)) {
    return [pscustomobject]@{ Succeeded = $false; Message = "Recovery skipped: no previous task definition is available." }
  }
  try {
    $current = Get-MailTask
    if ($null -ne $current) {
      Assert-MailTaskOwnership -Task $current -RunPath $RunPath
    }
    if (-not $StateOnly) {
      if ($null -ne $current) {
        Stop-MailTask -RunPath $RunPath -WaitTimeoutSeconds 10 -PollMilliseconds 250 | Out-Null
      }
      Register-ScheduledTask -TaskName $script:MailTaskName -TaskPath $script:MailTaskPath -Xml $Snapshot.Definition -Force -ErrorAction Stop | Out-Null
    }
    # A failure before registration left the original definition intact.
    # Restore its enabled state even if the initial stop timed out.
    if ($Snapshot.Enabled) {
      Enable-ScheduledTask -TaskName $script:MailTaskName -TaskPath $script:MailTaskPath -ErrorAction Stop | Out-Null
    }
    else {
      Disable-ScheduledTask -TaskName $script:MailTaskName -TaskPath $script:MailTaskPath -ErrorAction Stop | Out-Null
    }
    if ($Snapshot.Active -and $Snapshot.Enabled) {
      $restored = Get-MailTask
      if ($null -ne $restored -and [string]$restored.State -ne "Running" -and [string]$restored.State -ne "Queued") {
        Start-ScheduledTask -TaskName $script:MailTaskName -TaskPath $script:MailTaskPath -ErrorAction Stop
      }
    }
    $message = "Restored the previous task definition and Enabled state; restart requested."
    if (-not $Snapshot.Active) {
      $message = "Restored the previous task definition and Enabled state. The previous task was not active."
    }
    elseif (-not $Snapshot.Enabled) {
      $message = "Restored the previous task definition and disabled state. The intentionally disabled task was not restarted."
    }
    return [pscustomobject]@{ Succeeded = $true; Message = $message }
  }
  catch {
    return [pscustomobject]@{ Succeeded = $false; Message = "Previous task recovery failed: $($_.Exception.Message)" }
  }
}


function Get-MailTaskInstanceCount {
  $observed = Get-MailTask
  if ($null -eq $observed) { return 0 }
  # PowerShell's State becomes Disabled as soon as Disable-ScheduledTask
  # succeeds, even while an existing process is still draining. Query the
  # scheduler's owned instance collection instead of inferring from that
  # state.
  $service = $null
  $folder = $null
  $registered = $null
  $instances = $null
  try {
    $service = New-Object -ComObject "Schedule.Service"
    $service.Connect()
    $folder = $service.GetFolder($script:MailTaskPath)
    $registered = $folder.GetTask($script:MailTaskName)
    $instances = $registered.GetInstances(0)
    return [int]$instances.Count
  }
  finally {
    foreach ($comObject in @($instances, $registered, $folder, $service)) {
      if ($null -ne $comObject -and [Runtime.InteropServices.Marshal]::IsComObject($comObject)) {
        [Runtime.InteropServices.Marshal]::ReleaseComObject($comObject) | Out-Null
      }
    }
  }
}

function Stop-MailTask {
  param(
    [Parameter(Mandatory = $true)][string[]]$RunPath,
    [double]$WaitTimeoutSeconds = 10,
    [int]$PollMilliseconds = 250
  )
  if ([double]::IsNaN($WaitTimeoutSeconds) -or
    [double]::IsInfinity($WaitTimeoutSeconds) -or
    $WaitTimeoutSeconds -le 0) {
    throw "WaitTimeoutSeconds must be a finite number greater than zero."
  }
  if ($PollMilliseconds -lt 1) {
    throw "PollMilliseconds must be at least one."
  }
  $current = Get-MailTask
  if ($null -eq $current) {
    return [pscustomobject]@{ Present = $false; StopRequested = $false }
  }
  Assert-MailTaskOwnership -Task $current -RunPath $RunPath

  # Disable first so logon and periodic triggers cannot queue a replacement
  # between this observation and the stop request.
  Disable-ScheduledTask -TaskName $script:MailTaskName -TaskPath $script:MailTaskPath -ErrorAction Stop | Out-Null
  # Stop even when the pre-disable state was Ready: a periodic trigger may
  # have started an instance after that snapshot. Errors propagate.
  Stop-ScheduledTask -TaskName $script:MailTaskName -TaskPath $script:MailTaskPath -ErrorAction Stop

  $clock = [Diagnostics.Stopwatch]::StartNew()
  try {
    while ($clock.Elapsed.TotalSeconds -lt $WaitTimeoutSeconds) {
      $instanceCount = Get-MailTaskInstanceCount
      $latest = Get-MailTask
      $latestState = if ($null -eq $latest) { "Missing" } else { [string]$latest.State }
      if ($instanceCount -eq 0 -and $latestState -ne "Running" -and $latestState -ne "Queued") {
        return [pscustomobject]@{ Present = $true; StopRequested = $true }
      }
      $remaining = [Math]::Ceiling(($WaitTimeoutSeconds - $clock.Elapsed.TotalSeconds) * 1000)
      if ($remaining -le 0) { break }
      Start-Sleep -Milliseconds ([int][Math]::Min($PollMilliseconds, $remaining))
    }
  }
  finally { $clock.Stop() }
  throw "Scheduled task did not stop: instances remain active after ${WaitTimeoutSeconds}s."
}

function Wait-MailServer {
  param(
    [string]$Url,
    [string]$TaskName,
    [datetime]$StartedAt,
    [double]$TimeoutSeconds = 60,
    [switch]$ProbeDisabled
  )

  Add-Type -AssemblyName System.Net.Http
  $handler = New-Object System.Net.Http.HttpClientHandler
  # Local readiness must not depend on a corporate/system proxy.
  $handler.UseProxy = $false
  $client = New-Object System.Net.Http.HttpClient($handler)
  $clock = [System.Diagnostics.Stopwatch]::StartNew()
  $lastProbe = "No HTTP response"
  $state = "Unknown"
  $result = $null
  $reason = "timeout"
  try {
    while ($clock.Elapsed.TotalSeconds -lt $TimeoutSeconds) {
      # Inspect the task before HTTP: Windows can spend the full probe timeout
      # connecting to a closed port even when the process has already exited.
      $scheduled = if ($TaskName -eq $script:MailTaskName) {
        Get-MailTask
      }
      else {
        Get-ScheduledTask -TaskName $TaskName -TaskPath $script:MailTaskPath -ErrorAction Stop
      }
      if ($null -eq $scheduled) {
        $state = "Missing"
        $reason = "missing"
        break
      }
      $info = if ($TaskName -eq $script:MailTaskName) {
        Get-MailTaskInfo
      }
      else {
        Get-ScheduledTaskInfo -TaskName $TaskName -TaskPath $script:MailTaskPath -ErrorAction Stop
      }
      $state = [string]$scheduled.State
      $result = $info.LastTaskResult
      # Queued is not dead. Ready may describe an old run, so require evidence
      # that THIS launch ran (Task Scheduler stores times at second precision).
      $taskExited = $state -eq "Disabled" -or (
        $state -eq "Ready" -and $info.LastRunTime -ge $StartedAt.AddSeconds(-1) -and
        $result -ne 267009 -and $result -ne 267011
      )
      if (-not $ProbeDisabled -and $taskExited) {
        $reason = "exited"
        break
      }
      if ($clock.Elapsed.TotalSeconds -ge $TimeoutSeconds) { break }
      $remainingMs = [Math]::Max(1, [Math]::Ceiling(($TimeoutSeconds - $clock.Elapsed.TotalSeconds) * 1000))
      $cancel = New-Object System.Threading.CancellationTokenSource
      $cancel.CancelAfter([int][Math]::Min(2000, $remainingMs))
      $response = $null
      try {
        $response = $client.GetAsync($Url, $cancel.Token).GetAwaiter().GetResult()
        $lastProbe = "HTTP $([int]$response.StatusCode)"
        if ([int]$response.StatusCode -eq 200) {
          $body = $response.Content.ReadAsStringAsync().GetAwaiter().GetResult() | ConvertFrom-Json
          if ($null -ne $body -and $body.authed -is [bool]) {
            $reason = "ready"
            break
          }
          $lastProbe = "HTTP 200 without Mail auth status"
        }
      }
      catch {
        # Do not include response bodies, URLs with credentials, or token contents.
        $lastProbe = "HTTP probe failed: $($_.Exception.GetType().Name)"
      }
      finally {
        if ($response) { $response.Dispose() }
        $cancel.Dispose()
      }

      $remainingMs = [Math]::Floor(($TimeoutSeconds - $clock.Elapsed.TotalSeconds) * 1000)
      if ($remainingMs -gt 0) { Start-Sleep -Milliseconds ([int][Math]::Min(250, $remainingMs)) }
    }
  }
  finally {
    $clock.Stop()
    $client.Dispose()
  }
  [pscustomobject]@{
    Reason = $reason
    ElapsedSeconds = [Math]::Round($clock.Elapsed.TotalSeconds, 2)
    TaskState = $state
    TaskResult = $result
    LastProbe = $lastProbe
  }
}
