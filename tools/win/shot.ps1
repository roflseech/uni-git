# Drives the running epic-git window for UI checks without a human: optional click (physical pixels relative
# to the window rect, read them off a previous screenshot), optional typed keys, then a DPI-aware screenshot.
#   powershell -ExecutionPolicy Bypass -File tools\win\shot.ps1 -Out shot.png
#   powershell -ExecutionPolicy Bypass -File tools\win\shot.ps1 -Out shot.png -ClickX 263 -ClickY 147
#   powershell -ExecutionPolicy Bypass -File tools\win\shot.ps1 -Out "" -ClickX 1360 -ClickY 945 -Keys "commit subject"
param([string]$Out, [int]$ClickX = -1, [int]$ClickY = -1, [int]$Wait = 700, [switch]$Right, [switch]$Double, [string]$Keys = "", [int]$ProcId = 0)
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms
Add-Type @'
using System; using System.Runtime.InteropServices;
public class W {
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint x, uint y, uint d, UIntPtr e);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; } }
'@
[W]::SetProcessDPIAware() | Out-Null
# Dev shell (app/bin) first, then the dist binary; -ProcId targets one instance when several windows are open.
if ($ProcId -gt 0) { $p = Get-Process -Id $ProcId -ErrorAction SilentlyContinue }
else { $p = @(Get-Process neutralino-win_x64 -ErrorAction SilentlyContinue) + @(Get-Process epic-git-win_x64 -ErrorAction SilentlyContinue) | Select-Object -First 1 }
if (-not $p) { Write-Output "no epic-git window"; exit 1 }
$h = $p.MainWindowHandle
[W]::SetForegroundWindow($h) | Out-Null; Start-Sleep -Milliseconds 250
$r = New-Object W+RECT; [W]::GetWindowRect($h, [ref]$r) | Out-Null
if ($ClickX -ge 0) {
  [W]::SetCursorPos($r.L + $ClickX, $r.T + $ClickY) | Out-Null; Start-Sleep -Milliseconds 80
  $down = 0x0002; $up = 0x0004
  if ($Right) { $down = 0x0008; $up = 0x0010 }
  [W]::mouse_event($down, 0, 0, 0, [UIntPtr]::Zero); [W]::mouse_event($up, 0, 0, 0, [UIntPtr]::Zero)
  if ($Double) { Start-Sleep -Milliseconds 60; [W]::mouse_event($down, 0, 0, 0, [UIntPtr]::Zero); [W]::mouse_event($up, 0, 0, 0, [UIntPtr]::Zero) }
  Start-Sleep -Milliseconds $Wait
}
if ($Keys -ne "") { [System.Windows.Forms.SendKeys]::SendWait($Keys); Start-Sleep -Milliseconds $Wait }
if ($Out -ne "") {
  $w = $r.R - $r.L; $hh = $r.B - $r.T
  $bmp = New-Object System.Drawing.Bitmap $w, $hh
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.CopyFromScreen($r.L, $r.T, 0, 0, $bmp.Size)
  $bmp.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
  Write-Output "pid $($p.Id) rect $($r.L),$($r.T) $w x $hh saved $Out"
}
