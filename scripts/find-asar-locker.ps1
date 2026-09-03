# find-asar-locker.ps1 - locate which process holds a handle on the target file
Add-Type @'
using System;
using System.Runtime.InteropServices;
public class Rm {
  [DllImport("rstrtmgr.dll", CharSet=CharSet.Unicode)]
  public static extern int RmStartSession(out uint pSessionHandle, int dwSessionFlags, string strSessionKey);
  [DllImport("rstrtmgr.dll")]
  public static extern int RmRegisterResources(uint pSessionHandle, uint nFiles, string[] rgsFilenames, uint nProcesses, IntPtr rgApplications, uint nServices, string[] rgsServiceNames);
  [DllImport("rstrtmgr.dll")]
  public static extern int RmGetList(uint dwSessionHandle, out uint pnProcInfoNeeded, ref uint pnProcInfo, [In, Out] RM_PROCESS_INFO[] rgAffectedApps, ref uint lpdwRebootReasons);
  [DllImport("rstrtmgr.dll")]
  public static extern int RmEndSession(uint dwSessionHandle);
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
  public struct RM_UNIQUE_PROCESS { public int dwProcessId; public System.Runtime.InteropServices.ComTypes.FILETIME ProcessStartTime; }
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
  public struct RM_PROCESS_INFO {
    public RM_UNIQUE_PROCESS Process;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst=256)] public string strAppName;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst=64)] public string strServiceShortName;
    public int ApplicationType; public uint AppStatus; public uint TSSessionId; public bool bRestartable;
  }
}
'@
$path = 'F:\xiaokong-projects\daweige-agent\release-v2\win-unpacked\resources\app.asar'
$key = [Guid]::NewGuid().ToString()
[uint32]$handle = 0
[Rm]::RmStartSession([ref]$handle, 0, $key) | Out-Null
[Rm]::RmRegisterResources($handle, 1, @($path), 0, [IntPtr]::Zero, 0, $null) | Out-Null
$needed = [uint32]0; $count = [uint32]10; $reasons = [uint32]0
$info = New-Object Rm+RM_PROCESS_INFO[] 10
[Rm]::RmGetList($handle, [ref]$needed, [ref]$count, $info, [ref]$reasons) | Out-Null
if ($count -eq 0) { Write-Output 'NO_LOCKER_FOUND' }
for ($i=0; $i -lt $count; $i++) {
  Write-Output ('LOCKER pid=' + $info[$i].Process.dwProcessId + ' name=' + $info[$i].strAppName)
}
[Rm]::RmEndSession($handle) | Out-Null
