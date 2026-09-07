# Shared by the Windows installer and its regression tests (PowerShell 5.1+).
function Wait-MailServer {
  param(
    [string]$Url,
    [string]$TaskName,
    [datetime]$StartedAt,
    [double]$TimeoutSeconds = 60
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

      $scheduled = Get-ScheduledTask -TaskName $TaskName -ErrorAction Stop
      $info = Get-ScheduledTaskInfo -TaskName $TaskName -ErrorAction Stop
      $state = [string]$scheduled.State
      $result = $info.LastTaskResult
      # Queued is not dead. Ready may describe an old run, so require evidence
      # that THIS launch ran (Task Scheduler stores times at second precision).
      if ($state -eq "Disabled" -or (
        $state -eq "Ready" -and $info.LastRunTime -ge $StartedAt.AddSeconds(-1) -and
        $result -ne 267009 -and $result -ne 267011
      )) {
        $reason = "exited"
        break
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
