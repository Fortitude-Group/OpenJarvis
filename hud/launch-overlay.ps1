# Launch the JARVIS HUD as an always-on-top, frameless desktop overlay.
# Uses Edge in --app mode (full mic/audio support) and pins it topmost via Win32.
#
#   Usage:  powershell -ExecutionPolicy Bypass -File hud\launch-overlay.ps1
#           powershell ... -File hud\launch-overlay.ps1 -Frameless -Width 960 -Height 760
#
param(
  [string]$Url = "http://localhost:5173/jarvis-hud.html",
  [int]$Width = 900,
  [int]$Height = 720,
  [switch]$Frameless
)

$edge = @(
  "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe",
  "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe"
) | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $edge) { Write-Error "Microsoft Edge not found."; exit 1 }

# Center on the primary screen
Add-Type -AssemblyName System.Windows.Forms
$wa = [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea
$x = [int]($wa.X + ($wa.Width  - $Width)  / 2)
$y = [int]($wa.Y + ($wa.Height - $Height) / 2)

$profile = Join-Path $env:LOCALAPPDATA "jarvis-hud-overlay"
$args = @(
  "--app=$Url",
  "--user-data-dir=$profile",
  "--window-size=$Width,$Height",
  "--window-position=$x,$y",
  "--new-window",
  "--disable-features=Translate,msEdgeWelcome"
)
Start-Process $edge -ArgumentList $args | Out-Null

# Find the overlay window by its page title and pin it always-on-top.
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class Win {
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x,int y,int cx,int cy, uint flags);
  [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr h, int idx);
  [DllImport("user32.dll")] public static extern int SetWindowLong(IntPtr h, int idx, int v);
  public static IntPtr TOPMOST = new IntPtr(-1);
}
"@
$SWP_NOMOVE=0x2; $SWP_NOSIZE=0x1; $SWP_FRAMECHANGED=0x20; $SWP_SHOW=0x40
$GWL_STYLE=-16; $WS_CAPTION=0x00C00000; $WS_THICKFRAME=0x00040000

$hwnd = [IntPtr]::Zero
for ($i=0; $i -lt 40 -and $hwnd -eq [IntPtr]::Zero; $i++) {
  Start-Sleep -Milliseconds 300
  $p = Get-Process msedge -ErrorAction SilentlyContinue |
       Where-Object { $_.MainWindowTitle -match 'OPENJARVIS|J\.A\.R\.V\.I\.S' } |
       Select-Object -First 1
  if ($p) { $hwnd = $p.MainWindowHandle }
}
if ($hwnd -eq [IntPtr]::Zero) { Write-Warning "Overlay launched, but couldn't pin topmost (window not found)."; exit 0 }

if ($Frameless) {
  $style = [Win]::GetWindowLong($hwnd, $GWL_STYLE)
  $style = $style -band (-bnot $WS_CAPTION) -band (-bnot $WS_THICKFRAME)
  [Win]::SetWindowLong($hwnd, $GWL_STYLE, $style) | Out-Null
}
[Win]::SetWindowPos($hwnd, [Win]::TOPMOST, $x, $y, $Width, $Height, ($SWP_FRAMECHANGED -bor $SWP_SHOW)) | Out-Null
Write-Output "JARVIS overlay pinned always-on-top (hwnd $hwnd). Alt+F4 to close."
