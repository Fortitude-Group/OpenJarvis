# Keep one HUD server running: start it, and if it ever exits, log the exit code
# and start it again. start.ps1 launches this detached (via WMI), so it doesn't die
# with whatever terminal or session ran start.ps1.
#
#   keep-running.ps1 -Name backend -Command "uv run jarvis serve --port 8000"
#
# Output goes to %LOCALAPPDATA%\jarvis-hud\logs\<Name>.log and <Name>.err.log.
# Keep this file ASCII-only so Windows PowerShell 5.1 can parse it.

param(
  [Parameter(Mandatory = $true)][string]$Name,
  [Parameter(Mandatory = $true)][string]$Command
)

$logDir = Join-Path $env:LOCALAPPDATA 'jarvis-hud\logs'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$out = Join-Path $logDir "$Name.log"
$err = Join-Path $logDir "$Name.err.log"
Set-Content -Path $out -Value $null
Set-Content -Path $err -Value $null

function Note([string]$msg) {
  Add-Content -Path $err -Value ("[keep-running] {0} {1}" -f (Get-Date -Format s), $msg)
}

Set-Location (Join-Path $PSScriptRoot '..')
Note "supervisor started (pid $PID): $Command"
while ($true) {
  $started = Get-Date
  & cmd.exe /d /c "$Command >> `"$out`" 2>> `"$err`""
  $code = $LASTEXITCODE
  $ran = [int]((Get-Date) - $started).TotalSeconds
  Note "$Name exited with code $code after ${ran}s, restarting"
  # Back off if it is dying straight away, so a broken setup doesn't spin.
  if ($ran -lt 30) { Start-Sleep 15 } else { Start-Sleep 2 }
}
