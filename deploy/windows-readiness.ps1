# Shared by the Windows installer, manual control entrypoint, and regression
# tests (PowerShell 5.1+).

$script:MailTaskName = "MailLocal"
$script:MailTaskPath = "\"

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
    throw "작업의 Enabled 상태를 읽지 못했습니다."
  }
  if ($Task.Settings.Enabled -is [bool]) { return [bool]$Task.Settings.Enabled }
  $parsed = $false
  if ([bool]::TryParse([string]$Task.Settings.Enabled, [ref]$parsed)) { return $parsed }
  throw "작업의 Enabled 상태를 해석하지 못했습니다."
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

function Test-MailTaskOwnership {
  param(
    [Parameter(Mandatory = $true)][object]$Task,
    [Parameter(Mandatory = $true)][string]$RunPath
  )
  $expected = ConvertTo-MailFullPath $RunPath
  $actual = ConvertTo-MailFullPath (Get-MailRunPathFromTask $Task)
  return -not [string]::IsNullOrEmpty($expected) -and
    -not [string]::IsNullOrEmpty($actual) -and
    [string]::Equals($expected, $actual, [StringComparison]::OrdinalIgnoreCase)
}

function Assert-MailTaskOwnership {
  param(
    [Parameter(Mandatory = $true)][object]$Task,
    [Parameter(Mandatory = $true)][string]$RunPath
  )
  if (-not (Test-MailTaskOwnership -Task $Task -RunPath $RunPath)) {
    throw "루트 MailLocal 작업이 다른 deploy/run.ps1을 가리킵니다. 기존 설치 폴더에서 deploy\uninstall.ps1을 실행한 뒤 이 폴더에서 다시 설치하세요."
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
      throw "빈 작업 정의"
    }
  }
  catch {
    throw "기존 작업 정의를 저장하지 못해 안전하게 교체할 수 없습니다."
  }
  return [pscustomobject]$snapshot
}

function Restore-MailTaskRecovery {
  param(
    [Parameter(Mandatory = $true)][object]$Snapshot,
    [Parameter(Mandatory = $true)][string]$RunPath,
    [switch]$StateOnly
  )
  if ([string]::IsNullOrWhiteSpace([string]$Snapshot.Definition)) {
    return [pscustomobject]@{ Succeeded = $false; Message = "기존 작업 정의가 없어 복구를 시도하지 않았습니다." }
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
    $message = "기존 작업 정의와 Enabled 상태를 복구하고 이전 실행 재시작을 요청했습니다."
    if (-not $Snapshot.Active) {
      $message = "기존 작업 정의와 Enabled 상태를 복구했습니다. 이전 실행은 활성 상태로 관찰되지 않았습니다."
    }
    elseif (-not $Snapshot.Enabled) {
      $message = "기존 작업 정의와 비활성 Enabled 상태를 복구했습니다. 의도적으로 비활성화된 이전 실행은 재시작하지 않았습니다."
    }
    return [pscustomobject]@{ Succeeded = $true; Message = $message }
  }
  catch {
    return [pscustomobject]@{ Succeeded = $false; Message = "기존 작업 복구 실패: $($_.Exception.Message)" }
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
    [Parameter(Mandatory = $true)][string]$RunPath,
    [double]$WaitTimeoutSeconds = 10,
    [int]$PollMilliseconds = 250
  )
  if ([double]::IsNaN($WaitTimeoutSeconds) -or
    [double]::IsInfinity($WaitTimeoutSeconds) -or
    $WaitTimeoutSeconds -le 0) {
    throw "작업 종료 대기 시간은 0보다 큰 유한한 숫자여야 합니다."
  }
  if ($PollMilliseconds -lt 1) {
    throw "작업 상태 확인 간격은 1밀리초 이상이어야 합니다."
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
  throw "자동 실행 작업이 종료되지 않았습니다 (${WaitTimeoutSeconds}초 대기 후에도 인스턴스가 활성입니다)."
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
