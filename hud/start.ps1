# Start (or re-start) everything the JARVIS HUD needs, then open it.
#   Backend API  :8000   (OpenJarvis serve — chat + local STT)
#   Vite         :5173   (serves the HUD + proxies /v1 -> :8000)
#   TTS sidecar  :8731   (Kokoro bm_george voice)
#
#   Usage:  powershell -ExecutionPolicy Bypass -File hud\start.ps1
#           ... -Overlay      # open as always-on-top overlay instead of a tab
#
param([switch]$Overlay)

$ErrorActionPreference = "SilentlyContinue"
$clone = Split-Path $PSScriptRoot -Parent          # repo root (…\OpenJarvis)
function Listening($port){ [bool](Get-NetTCPConnection -LocalPort $port -State Listen -EA SilentlyContinue) }
function WaitPort($port,$secs=40){ for($i=0;$i -lt $secs*2 -and -not (Listening $port);$i++){Start-Sleep -Milliseconds 500}; Listening $port }

# 1) Backend API on :8000
if (Listening 8000) { Write-Host "[ok]   backend already on :8000" -ForegroundColor Green }
else {
  Write-Host "[..]   starting backend on :8000" -ForegroundColor Yellow
  Start-Process -WindowStyle Hidden -WorkingDirectory $clone `
    -FilePath "uv" -ArgumentList @("run","jarvis","serve","--port","8000")
  if (WaitPort 8000 60) { Write-Host "[ok]   backend up" -ForegroundColor Green }
  else { Write-Host "[warn] backend did not come up — chat/STT will be offline" -ForegroundColor Red }
}

# 2) Kokoro TTS sidecar on :8731
if (Listening 8731) { Write-Host "[ok]   tts sidecar already on :8731" -ForegroundColor Green }
else {
  Write-Host "[..]   starting Kokoro bm_george sidecar on :8731" -ForegroundColor Yellow
  Start-Process -WindowStyle Hidden -WorkingDirectory $clone `
    -FilePath "uv" -ArgumentList @("run","python","hud/tts_sidecar.py")
  WaitPort 8731 60 | Out-Null
  Write-Host "[ok]   tts sidecar warming (bm_george)" -ForegroundColor Green
}

# 3) Vite dev server on :5173
if (Listening 5173) { Write-Host "[ok]   frontend already on :5173" -ForegroundColor Green }
else {
  Write-Host "[..]   starting frontend on :5173" -ForegroundColor Yellow
  Start-Process -WindowStyle Hidden -WorkingDirectory (Join-Path $clone "frontend") `
    -FilePath "npm.cmd" -ArgumentList @("run","dev")
  WaitPort 5173 60 | Out-Null
}

# 4) Open the HUD
Start-Sleep 1
if ($Overlay) { & (Join-Path $PSScriptRoot "launch-overlay.ps1") }
else { Start-Process "http://localhost:5173/jarvis-hud.html" }
Write-Host "`nJARVIS HUD ready -> http://localhost:5173/jarvis-hud.html" -ForegroundColor Cyan
