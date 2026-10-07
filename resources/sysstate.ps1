# Vesper system-state host (07 D3 game mode, spike S8 in 07 §F). READ-ONLY: it only queries Windows, never changes
# anything. One persistent hidden process; JSON lines on stdout:
#   {"t":"ready","pid":n}                                       once, after the P/Invoke type is compiled
#   {"t":"state","quns":5,"fg":true,"covers":false,"caption":true,"shell":false,"pid":1234,"cls":"…"}
#     printed at start and then ONLY when something changed (polled every -IntervalMs, default 5000)
#   quns    = SHQueryUserNotificationState (2 busy, 3 D3D full screen, 5 accepts notifications, …)
#   fg      = a foreground window exists
#   covers  = the foreground window's rect covers its whole monitor (a maximized window does not: the taskbar)
#   caption = the foreground window has WS_CAPTION (borderless games and fullscreen video players don't)
#   shell   = the foreground window is the desktop or the taskbar (Progman, WorkerW, Shell_*TrayWnd)
#   pid     = process id owning the foreground window (Vesper excludes itself)
# stdin: a line {"op":"probe"} prints the current state now, even if unchanged; stdin EOF (parent closed the pipe or
# died) exits, so no powershell.exe is ever orphaned. Same hygiene as wintts.ps1.
param([int]$IntervalMs = 5000)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8

$sig = @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class VesperSysState {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
  [StructLayout(LayoutKind.Sequential)] public struct MONITORINFO { public int cbSize; public RECT rcMonitor; public RECT rcWork; public int dwFlags; }
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] static extern IntPtr MonitorFromWindow(IntPtr h, int flags);
  [DllImport("user32.dll")] static extern bool GetMonitorInfo(IntPtr m, ref MONITORINFO mi);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder sb, int n);
  [DllImport("user32.dll")] static extern int GetWindowThreadProcessId(IntPtr h, out int pid);
  [DllImport("user32.dll")] static extern int GetWindowLong(IntPtr h, int index);
  [DllImport("shell32.dll")] static extern int SHQueryUserNotificationState(out int state);
  const int GWL_STYLE = -16;
  const int WS_CAPTION = 0x00C00000;
  static string Esc(string s) { return s.Replace("\\", "\\\\").Replace("\"", "\\\""); }
  public static string Probe() {
    int quns = 0;
    try { SHQueryUserNotificationState(out quns); } catch { quns = 0; }
    IntPtr h = GetForegroundWindow();
    if (h == IntPtr.Zero) return "{\"t\":\"state\",\"quns\":" + quns + ",\"fg\":false,\"covers\":false,\"caption\":false,\"shell\":false,\"pid\":0,\"cls\":\"\"}";
    RECT r; GetWindowRect(h, out r);
    MONITORINFO mi = new MONITORINFO(); mi.cbSize = Marshal.SizeOf(typeof(MONITORINFO));
    bool covers = false;
    if (GetMonitorInfo(MonitorFromWindow(h, 2), ref mi))
      covers = r.L <= mi.rcMonitor.L && r.T <= mi.rcMonitor.T && r.R >= mi.rcMonitor.R && r.B >= mi.rcMonitor.B;
    var sb = new StringBuilder(256); GetClassName(h, sb, 256);
    string cls = sb.ToString();
    int pid; GetWindowThreadProcessId(h, out pid);
    bool caption = (GetWindowLong(h, GWL_STYLE) & WS_CAPTION) == WS_CAPTION;
    bool shell = cls == "Progman" || cls == "WorkerW" || cls == "Shell_TrayWnd" || cls == "Shell_SecondaryTrayWnd";
    return "{\"t\":\"state\",\"quns\":" + quns + ",\"fg\":true,\"covers\":" + (covers ? "true" : "false") + ",\"caption\":" + (caption ? "true" : "false") +
      ",\"shell\":" + (shell ? "true" : "false") + ",\"pid\":" + pid + ",\"cls\":\"" + Esc(cls) + "\"}";
  }
}
'@
Add-Type -TypeDefinition $sig

function Emit([string]$line) { [Console]::Out.WriteLine($line); [Console]::Out.Flush() }

# A StreamReader of our own: [Console]::In.ReadLineAsync() blocks on .NET Framework (SyncTextReader), this one doesn't.
$stdin = New-Object IO.StreamReader([Console]::OpenStandardInput())
Emit ('{"t":"ready","pid":' + $PID + '}')
$last = ''
$read = $stdin.ReadLineAsync()
while ($true) {
  $state = [VesperSysState]::Probe()
  if ($state -ne $last) { Emit $state; $last = $state }
  if ($read.Wait([Math]::Max(250, $IntervalMs))) {
    $line = $read.Result
    if ($null -eq $line) { break }            # stdin EOF → exit
    if ($line -match '"op"\s*:\s*"probe"') { $last = [VesperSysState]::Probe(); Emit $last }
    $read = $stdin.ReadLineAsync()
  }
}
