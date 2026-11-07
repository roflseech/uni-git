# Drives the running epic-git window for UI checks without a human: optional click (physical pixels relative
# to the window rect, read them off a previous screenshot), optional typed keys, then a DPI-aware screenshot.
#   powershell -ExecutionPolicy Bypass -File tools\win\shot.ps1 -Out shot.png
#   powershell -ExecutionPolicy Bypass -File tools\win\shot.ps1 -Out shot.png -ClickX 263 -ClickY 147
#   powershell -ExecutionPolicy Bypass -File tools\win\shot.ps1 -Out "" -ClickX 1360 -ClickY 945 -Keys "commit subject"
#   powershell -ExecutionPolicy Bypass -File tools\win\shot.ps1 -Out shot.png -ClickX 975 -ClickY 600 -DragX 700   (drag a splitter)
param([string]$Out, [int]$ClickX = -1, [int]$ClickY = -1, [int]$Wait = 700, [switch]$Right, [switch]$Double, [switch]$Hover, [switch]$Shift, [switch]$Ctrl, [string]$Keys = "", [int]$ProcId = 0, [int]$DragX = -1, [int]$DragY = -1)
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms
Add-Type @'
using System; using System.Runtime.InteropServices;
public class W {
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint x, uint y, uint d, UIntPtr e);
  [DllImport("user32.dll")] public static extern void keybd_event(byte k, byte s, uint f, UIntPtr e);
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
# Never click or type into somebody else's window: if the app could not be brought to the front
# (the user is working in another program), skip the input and only take the screenshot.
$front = [W]::GetForegroundWindow() -eq $h
if (-not $front -and ($ClickX -ge 0 -or $Keys -ne "")) {
  Write-Output "SKIPPED input: the epic-git window is not in the foreground"
  $ClickX = -1; $Keys = ""
}
if ($ClickX -ge 0 -and $Hover) {
  # move the pointer only (menus with hover previews)
  [W]::SetCursorPos($r.L + $ClickX, $r.T + $ClickY) | Out-Null; Start-Sleep -Milliseconds $Wait
  $ClickX = -1
}
if ($ClickX -ge 0 -and ($DragX -ge 0 -or $DragY -ge 0)) {
  # drag: press at ClickX/ClickY, move to DragX/DragY in steps (mouse_event MOVE so the page gets mousemove), release
  if ($DragX -lt 0) { $DragX = $ClickX }
  if ($DragY -lt 0) { $DragY = $ClickY }
  [W]::SetCursorPos($r.L + $ClickX, $r.T + $ClickY) | Out-Null; Start-Sleep -Milliseconds 80
  [W]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero); Start-Sleep -Milliseconds 60
  $steps = 12
  for ($i = 1; $i -le $steps; $i++) {
    $x = $ClickX + [int](($DragX - $ClickX) * $i / $steps)
    $y = $ClickY + [int](($DragY - $ClickY) * $i / $steps)
    [W]::SetCursorPos($r.L + $x, $r.T + $y) | Out-Null
    [W]::mouse_event(0x0001, 0, 0, 0, [UIntPtr]::Zero); Start-Sleep -Milliseconds 20
  }
  [W]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero); Start-Sleep -Milliseconds $Wait
  $ClickX = -1
}
if ($ClickX -ge 0) {
  [W]::SetCursorPos($r.L + $ClickX, $r.T + $ClickY) | Out-Null; Start-Sleep -Milliseconds 80
  if ($Shift) { [W]::keybd_event(0x10, 0, 0, [UIntPtr]::Zero) }
  if ($Ctrl) { [W]::keybd_event(0x11, 0, 0, [UIntPtr]::Zero) }
  $down = 0x0002; $up = 0x0004
  if ($Right) { $down = 0x0008; $up = 0x0010 }
  [W]::mouse_event($down, 0, 0, 0, [UIntPtr]::Zero); [W]::mouse_event($up, 0, 0, 0, [UIntPtr]::Zero)
  if ($Double) { Start-Sleep -Milliseconds 60; [W]::mouse_event($down, 0, 0, 0, [UIntPtr]::Zero); [W]::mouse_event($up, 0, 0, 0, [UIntPtr]::Zero) }
  if ($Shift) { [W]::keybd_event(0x10, 0, 2, [UIntPtr]::Zero) }
  if ($Ctrl) { [W]::keybd_event(0x11, 0, 2, [UIntPtr]::Zero) }
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
