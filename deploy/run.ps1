param(
  [Parameter(Mandatory = $true)][string]$BunPath,
  [Parameter(Mandatory = $true)][string]$LogPath
)

# This entrypoint only runs the already-built app. Never build on login.
# Use UTF-8 consistently with the installer, including on PowerShell 5.1.
$ErrorActionPreference = "Stop"

function New-MailJobObject {
  # A scheduled-task stop terminates this PowerShell process. On Windows,
  # associating the launcher with a kill-on-close job makes Bun a member too,
  # so the OS closes the job handle with the launcher and reaps Bun.
  if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) {
    return [IntPtr]::Zero
  }
  try {
    if ($null -eq ("MailWindowsJobObject" -as [type])) {
      Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;

public static class MailWindowsJobObject
{
    private const int JobObjectExtendedLimitInformationClass = 9;
    private const uint JobObjectLimitKillOnJobClose = 0x00002000;
    private const uint HandleFlagInherit = 0x00000001;

    [StructLayout(LayoutKind.Sequential)]
    private struct JobObjectBasicLimitInformation
    {
        public long PerProcessUserTimeLimit;
        public long PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize;
        public UIntPtr MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass;
        public uint SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct IoCounters
    {
        public ulong ReadOperationCount;
        public ulong WriteOperationCount;
        public ulong OtherOperationCount;
        public ulong ReadTransferCount;
        public ulong WriteTransferCount;
        public ulong OtherTransferCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JobObjectExtendedLimitInformation
    {
        public JobObjectBasicLimitInformation BasicLimitInformation;
        public IoCounters IoInfo;
        public UIntPtr ProcessMemoryLimit;
        public UIntPtr JobMemoryLimit;
        public UIntPtr PeakProcessMemoryUsed;
        public UIntPtr PeakJobMemoryUsed;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr CreateJobObject(IntPtr jobAttributes, string name);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetInformationJobObject(
        IntPtr job,
        int informationClass,
        IntPtr information,
        uint informationLength);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetHandleInformation(
        IntPtr handle,
        uint mask,
        uint flags);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CloseHandle(IntPtr handle);

    [DllImport("kernel32.dll")]
    private static extern IntPtr GetCurrentProcess();

    private static void ThrowLastError(string operation)
    {
        throw new Win32Exception(Marshal.GetLastWin32Error(), operation + " failed.");
    }

    public static IntPtr CreateForCurrentProcess()
    {
        IntPtr job = CreateJobObject(IntPtr.Zero, null);
        if (job == IntPtr.Zero)
        {
            ThrowLastError("CreateJobObject");
        }
        try
        {
            JobObjectExtendedLimitInformation information =
                new JobObjectExtendedLimitInformation();
            information.BasicLimitInformation.LimitFlags =
                JobObjectLimitKillOnJobClose;
            int informationSize = Marshal.SizeOf(typeof(JobObjectExtendedLimitInformation));
            IntPtr informationBuffer = Marshal.AllocHGlobal(informationSize);
            try
            {
                Marshal.StructureToPtr(information, informationBuffer, false);
                if (!SetInformationJobObject(
                    job,
                    JobObjectExtendedLimitInformationClass,
                    informationBuffer,
                    (uint)informationSize))
                {
                    ThrowLastError("SetInformationJobObject");
                }
            }
            finally
            {
                Marshal.FreeHGlobal(informationBuffer);
            }

            // The child inherits job membership, not this handle. Keeping the
            // handle non-inheritable prevents Bun from retaining the job after
            // the launcher exits.
            if (!SetHandleInformation(job, HandleFlagInherit, 0))
            {
                ThrowLastError("SetHandleInformation");
            }
            if (!AssignProcessToJobObject(job, GetCurrentProcess()))
            {
                ThrowLastError("AssignProcessToJobObject");
            }
            return job;
        }
        catch
        {
            CloseHandle(job);
            throw;
        }
    }
}
'@ -ErrorAction Stop
    }
    return [MailWindowsJobObject]::CreateForCurrentProcess()
  }
  catch {
    throw "Windows Job Object setup failed: $($_.Exception.Message)"
  }
}

try {
  Set-Location -LiteralPath (Join-Path $PSScriptRoot "..")
  if (-not (Test-Path -LiteralPath $BunPath -PathType Leaf)) { throw "Bun executable missing: $BunPath. Run deploy/install.ps1 again." }
  if (-not (Test-Path -LiteralPath "dist/index.html")) { throw "dist/index.html missing. Run deploy/install.ps1 again." }
  # Keep the native job handle open until this launcher exits. Closing it
  # explicitly would also terminate the launcher, which would skip the exit
  # record below; process teardown closes it and kills any remaining Bun child.
  $jobHandle = New-MailJobObject
  $env:NODE_ENV = "production"
  $env:HOST = "127.0.0.1"
  Add-Content -LiteralPath $LogPath -Encoding UTF8 -Value "Starting Mail $(Get-Date -Format o)"
  # Native stderr includes normal Bun diagnostics on Windows PowerShell 5.1.
  $ErrorActionPreference = "Continue"
  $global:LASTEXITCODE = $null
  & $BunPath --use-system-ca server/index.ts 2>&1 |
    ForEach-Object { [string]$_ } | Out-File -LiteralPath $LogPath -Append -Encoding UTF8
  $code = $global:LASTEXITCODE
  $ErrorActionPreference = "Stop"
  if ($null -eq $code) { throw "Bun process did not start." }
  Add-Content -LiteralPath $LogPath -Encoding UTF8 -Value "Mail exited: $code ($(Get-Date -Format o))"
  exit $code
}
catch {
  Add-Content -LiteralPath $LogPath -Encoding UTF8 -Value "Mail launch failed: $($_.Exception.Message)"
  exit 1
}
