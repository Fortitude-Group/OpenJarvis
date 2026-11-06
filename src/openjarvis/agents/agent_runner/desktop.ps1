# Desktop control helper for the Jarvis agent runner.
#
# Long-lived: reads one JSON command per line on stdin, writes one JSON result
# per line on stdout. Kept alive by runner.mjs so the C# shim compiles once.
#
#   {"op":"screenshot","monitor":0,"max":1568} -> {"ok":true,"path":..,"x0":..,"y0":..,"w":..,"h":..,"sw":..,"sh":..,"monitors":[..]}
#     monitor = index into the monitor list; -1 = primary (default)
#   {"op":"click","x":..,"y":..,"button":"left","double":false}
#   {"op":"move","x":..,"y":..}
#   {"op":"scroll","x":..,"y":..,"amount":-3}  (negative = down)
#   {"op":"type","text":"hello"}
#   {"op":"key","keys":"ctrl+shift+esc"}
#
# Coordinates are physical screen pixels (the process is DPI aware).

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class JDesk {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern int GetSystemMetrics(int i);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, int dx, int dy, int d, UIntPtr e);
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint f, UIntPtr e);
  [StructLayout(LayoutKind.Sequential)] public struct KI { public ushort vk; public ushort scan; public uint flags; public uint time; public UIntPtr extra; }
  [StructLayout(LayoutKind.Explicit, Size=40)] public struct INPUT { [FieldOffset(0)] public uint type; [FieldOffset(8)] public KI ki; }
  [DllImport("user32.dll", SetLastError=true)] public static extern uint SendInput(uint n, INPUT[] inputs, int size);
  public static void Unicode(string s) {
    foreach (char c in s) {
      var d = new INPUT[2];
      d[0].type = 1; d[0].ki.scan = c; d[0].ki.flags = 4;          // KEYEVENTF_UNICODE
      d[1].type = 1; d[1].ki.scan = c; d[1].ki.flags = 4 | 2;      // + KEYUP
      SendInput(2, d, Marshal.SizeOf(typeof(INPUT)));
      System.Threading.Thread.Sleep(4);
    }
  }
}
"@
[JDesk]::SetProcessDPIAware() | Out-Null

$VK = @{
  ctrl=0x11; control=0x11; shift=0x10; alt=0x12; win=0x5B; windows=0x5B
  enter=0x0D; return=0x0D; tab=0x09; esc=0x1B; escape=0x1B; space=0x20; backspace=0x08
  delete=0x2E; del=0x2E; insert=0x2D; home=0x24; end=0x23; pageup=0x21; pagedown=0x22
  up=0x26; down=0x28; left=0x25; right=0x27; capslock=0x14; printscreen=0x2C
  volumeup=0xAF; volumedown=0xAE; volumemute=0xAD; mute=0xAD
  playpause=0xB3; nexttrack=0xB0; prevtrack=0xB1; stop=0xB2
}
1..24 | ForEach-Object { $VK["f$_"] = 0x6F + $_ }

function Get-Vk([string]$name) {
  $n = $name.Trim().ToLower()
  if ($VK.ContainsKey($n)) { return [byte]$VK[$n] }
  if ($n.Length -eq 1) {
    $c = [char]::ToUpper($n[0])
    if (($c -ge 'A' -and $c -le 'Z') -or ($c -ge '0' -and $c -le '9')) { return [byte][int]$c }
  }
  throw "unknown key '$name'"
}

function Send-Keys([string]$combo) {
  # "ctrl+shift+esc", or several presses separated by spaces: "volumedown volumedown"
  foreach ($press in ($combo -split '\s+' | Where-Object { $_ })) {
    $vks = @($press -split '\+' | ForEach-Object { Get-Vk $_ })
    foreach ($v in $vks) { [JDesk]::keybd_event($v, 0, 0, [UIntPtr]::Zero) }
    [array]::Reverse($vks)
    foreach ($v in $vks) { [JDesk]::keybd_event($v, 0, 2, [UIntPtr]::Zero) }
    Start-Sleep -Milliseconds 40
  }
}

function Invoke-Click($x, $y, [string]$button, [bool]$double) {
  [JDesk]::SetCursorPos([int]$x, [int]$y) | Out-Null
  Start-Sleep -Milliseconds 30
  $down, $up = switch ($button) { 'right' { 0x08, 0x10 } 'middle' { 0x20, 0x40 } default { 0x02, 0x04 } }
  $times = if ($double) { 2 } else { 1 }
  for ($i = 0; $i -lt $times; $i++) {
    [JDesk]::mouse_event($down, 0, 0, 0, [UIntPtr]::Zero)
    [JDesk]::mouse_event($up, 0, 0, 0, [UIntPtr]::Zero)
    Start-Sleep -Milliseconds 60
  }
}

function Get-Monitors {
  $i = 0
  foreach ($m in [System.Windows.Forms.Screen]::AllScreens) {
    $b = $m.Bounds
    @{ index = $i; primary = $m.Primary; x = $b.X; y = $b.Y; w = $b.Width; h = $b.Height }
    $i++
  }
}

function Save-Screenshot([int]$monitor, [int]$max) {
  $mons = @(Get-Monitors)
  $m = if ($monitor -ge 0 -and $monitor -lt $mons.Count) { $mons[$monitor] } else { $mons | Where-Object { $_.primary } | Select-Object -First 1 }
  $vx = $m.x; $vy = $m.y; $w = $m.w; $h = $m.h
  $bmp = New-Object System.Drawing.Bitmap $w, $h
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.CopyFromScreen($vx, $vy, 0, 0, $bmp.Size)
  $scale = [Math]::Min(1.0, $max / [double]$w)
  $sw = [int]($w * $scale); $sh = [int]($h * $scale)
  $out = New-Object System.Drawing.Bitmap $sw, $sh
  $g2 = [System.Drawing.Graphics]::FromImage($out)
  $g2.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g2.DrawImage($bmp, 0, 0, $sw, $sh)
  $path = Join-Path ([IO.Path]::GetTempPath()) "jarvis-screen.png"
  $out.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
  $g.Dispose(); $g2.Dispose(); $bmp.Dispose(); $out.Dispose()
  return @{ ok = $true; path = $path; monitor = $m.index; x0 = $vx; y0 = $vy; w = $w; h = $h; sw = $sw; sh = $sh; monitors = $mons }
}

while ($null -ne ($line = [Console]::In.ReadLine())) {
  try {
    $c = $line | ConvertFrom-Json
    $r = switch ($c.op) {
      'screenshot' { Save-Screenshot ([int]$(if ($null -ne $c.monitor) { $c.monitor } else { -1 })) ([int]$(if ($c.max) { $c.max } else { 1568 })) }
      'click'      { Invoke-Click $c.x $c.y ([string]$c.button) ([bool]$c.double); @{ ok = $true } }
      'move'       { [JDesk]::SetCursorPos([int]$c.x, [int]$c.y) | Out-Null; @{ ok = $true } }
      'scroll'     { [JDesk]::SetCursorPos([int]$c.x, [int]$c.y) | Out-Null
                     [JDesk]::mouse_event(0x0800, 0, 0, [int](120 * $c.amount), [UIntPtr]::Zero); @{ ok = $true } }
      'type'       { [JDesk]::Unicode([string]$c.text); @{ ok = $true } }
      'key'        { Send-Keys ([string]$c.keys); @{ ok = $true } }
      default      { @{ ok = $false; error = "unknown op '$($c.op)'" } }
    }
  } catch {
    $r = @{ ok = $false; error = $_.Exception.Message }
  }
  [Console]::Out.WriteLine(($r | ConvertTo-Json -Compress))
  [Console]::Out.Flush()
}
