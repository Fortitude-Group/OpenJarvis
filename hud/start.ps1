# Start everything the JARVIS HUD (arc-reactor page) needs, check it works, then open it.
#   Backend API  :8000   (jarvis serve - chat + local speech-to-text)
#   Vite         :5173   (serves the HUD page)
#   TTS sidecar  :8731   (Kokoro bm_george voice)
#
#   Usage:  powershell -ExecutionPolicy Bypass -File E:\jarvis\OpenJarvis\hud\start.ps1
#           ... -Overlay    open as an always-on-top overlay instead of a browser tab
#           ... -Restart    restart this repo's servers too (after editing or pulling code)
#
# Server output is logged to %LOCALAPPDATA%\jarvis-hud\logs (backend, tts, frontend).
# The backend and voice sidecar run under hud\keep-running.ps1, which restarts them
# if they exit and logs the exit code to <name>.err.log.
#
# If a port is held by anything other than this repo (another OpenJarvis install,
# say), that process is stopped and replaced: the HUD only works against this repo.
#
# Keep this file ASCII-only. Windows PowerShell 5.1 reads BOM-less UTF-8 as ANSI,
# and a single em dash is enough to break parsing.

param([switch]$Overlay, [switch]$Restart)

$ErrorActionPreference = 'Stop'
$repo   = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$api    = 'http://127.0.0.1:8000'
$hudUrl = 'http://localhost:5173/jarvis-hud.html'
$failed = $false

function Say([string]$tag, [string]$msg, [string]$colour) {
  Write-Host ('[{0,-4}] {1}' -f $tag, $msg) -ForegroundColor $colour
}

function Get-PortOwner([int]$port) {
  $c = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $c) { return $null }
  Get-CimInstance Win32_Process -Filter "ProcessId=$($c.OwningProcess)"
}

function Test-FromRepo($proc) {
  $proc.CommandLine -and $proc.CommandLine.IndexOf($repo, [StringComparison]::OrdinalIgnoreCase) -ge 0
}

function Wait-Until([scriptblock]$cond, [int]$secs) {
  $deadline = (Get-Date).AddSeconds($secs)
  while ((Get-Date) -lt $deadline) { if (& $cond) { return $true }; Start-Sleep -Milliseconds 500 }
  return [bool](& $cond)
}

function Test-Answers([string]$url) {
  if (-not $url) { return $true }
  try { Invoke-WebRequest $url -UseBasicParsing -TimeoutSec 10 | Out-Null; return $true } catch { return $false }
}

function Show-LogTail([string]$log) {
  foreach ($f in @("$log.err.log", "$log.log")) {
    if ((Test-Path $f) -and (Get-Item $f).Length -gt 0) {
      Write-Host "       last lines of ${f}:" -ForegroundColor DarkGray
      Get-Content $f -Tail 15 | ForEach-Object { Write-Host "         $_" -ForegroundColor DarkGray }
      return
    }
  }
  Write-Host "       (nothing in $log.log / .err.log)" -ForegroundColor DarkGray
}

$keepRunning = Join-Path $PSScriptRoot 'keep-running.ps1'

# The keep-running.ps1 supervisors for a server (empty if it isn't supervised).
function Get-Supervisors([string]$logName) {
  @(Get-CimInstance Win32_Process | Where-Object {
      $_.CommandLine -and $_.CommandLine -like "*keep-running.ps1*-Name $logName *" })
}

# Start a server. With -Command it runs under keep-running.ps1, launched through
# WMI so it has no parent: closing the terminal (or Claude session) that ran this
# script can't take it down, and if the server exits it is restarted and the exit
# code logged. Without -Command it is a plain hidden process ($exe + $argList).
function Start-HudServer([string]$name, [string]$logName, [int]$port, [string]$healthUrl, [string]$dir,
                         [int]$secs, [string]$command = '', [string]$exe = '', [string[]]$argList = @()) {
  $log = Join-Path $logDir $logName
  $supervised = [bool]$command
  $owner = Get-PortOwner $port
  if ($owner) {
    if (-not (Test-FromRepo $owner)) {
      Say 'stop' ("{0}: port {1} is held by something else, stopping it: {2}" -f $name, $port, $owner.CommandLine) Yellow
    } elseif ($Restart) {
      Say 'stop' ("{0}: restarting" -f $name) Yellow
    } elseif (-not (Test-Answers $healthUrl)) {
      Say 'stop' ("{0}: holds :{1} but is not answering, restarting it" -f $name, $port) Yellow
    } elseif ($supervised -and (Get-Supervisors $logName).Count -eq 0) {
      Say 'stop' ("{0}: running without its supervisor, restarting it under one" -f $name) Yellow
    } else {
      Say 'ok' ("{0} already running on :{1}" -f $name, $port) Green
      return $true
    }
    # Stop the supervisor first, or it would start a second copy.
    Get-Supervisors $logName | ForEach-Object { & taskkill.exe /PID $_.ProcessId /T /F 2>&1 | Out-Null }
    & taskkill.exe /PID $owner.ProcessId /T /F 2>&1 | Out-Null
    if (-not (Wait-Until { -not (Get-PortOwner $port) } 15)) {
      Say 'FAIL' ("{0}: could not free port {1}" -f $name, $port) Red
      return $false
    }
  }
  # A supervisor left behind by a server that died goes before a fresh start.
  Get-Supervisors $logName | ForEach-Object { & taskkill.exe /PID $_.ProcessId /T /F 2>&1 | Out-Null }
  Say '..' ("starting {0} on :{1}" -f $name, $port) Yellow
  if ($supervised) {
    $line = '"{0}" -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "{1}" -Name {2} -Command "{3}"' -f `
              $psExe, $keepRunning, $logName, $command
    $startup = New-CimInstance -ClassName Win32_ProcessStartup -ClientOnly -Property @{ ShowWindow = [uint16]0 }
    $r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{
           CommandLine = $line; CurrentDirectory = $dir; ProcessStartupInformation = $startup }
    $procId = $r.ProcessId
    $exited = { -not (Get-Process -Id $procId -ErrorAction SilentlyContinue) }
  } else {
    # Output goes to a log so a crash leaves a trace (the window is hidden).
    $proc = Start-Process -PassThru -WindowStyle Hidden -WorkingDirectory $dir -FilePath $exe -ArgumentList $argList `
              -RedirectStandardOutput "$log.log" -RedirectStandardError "$log.err.log"
    $exited = { $proc.HasExited }
  }
  if (Wait-Until { [bool](Get-PortOwner $port) -or (& $exited) } $secs) {
    if (-not (& $exited)) {
      Say 'ok' ("{0} up on :{1}" -f $name, $port) Green
      return $true
    }
    Say 'FAIL' ("{0} exited before listening on :{1}" -f $name, $port) Red
  } else {
    Say 'FAIL' ("{0} did not come up on :{1} within {2}s" -f $name, $port, $secs) Red
  }
  Show-LogTail $log
  return $false
}

$logDir = Join-Path $env:LOCALAPPDATA 'jarvis-hud\logs'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$psExe  = (Get-Process -Id $PID).Path

# 1) Start the three servers. The backend and voice run supervised (see Start-HudServer).
$okApi  = Start-HudServer 'backend'     'backend'  8000 "$api/v1/models" $repo 180 `
            -command 'uv run jarvis serve --port 8000'
$okTts  = Start-HudServer 'tts sidecar' 'tts'      8731 ''               $repo 90 `
            -command 'uv run python hud/tts_sidecar.py'
$okVite = Start-HudServer 'frontend'    'frontend' 5173 ''               (Join-Path $repo 'frontend') 60 `
            -exe 'npm.cmd' -argList @('run','dev')
if (-not ($okApi -and $okTts -and $okVite)) { $failed = $true }

# 2) The page must be the HUD itself. A different frontend on :5173 serves a
#    blank React shell for this URL instead of a 404.
#    Retry for a while: Vite can be slow to answer while the backend is still
#    loading and the machine is busy.
$pageOk = Wait-Until {
  try { (Invoke-WebRequest $hudUrl -UseBasicParsing -TimeoutSec 30).Content -match 'OPENJARVIS // HUD' } catch { $false }
} 120
if ($pageOk) { Say 'ok' 'HUD page is served' Green }
else { Say 'FAIL' "HUD page not served at $hudUrl" Red; $failed = $true }

# 3) Warm up speech-to-text so the first thing you say isn't slow while the model
#    loads. Sends half a second of silence; an error here means STT is broken.
if ($okApi) {
  $wav = Join-Path ([IO.Path]::GetTempPath()) 'jarvis-hud-warmup.wav'
  $rate = 16000; $n = $rate / 2
  $ms = New-Object IO.MemoryStream; $bw = New-Object IO.BinaryWriter($ms)
  $bw.Write([Text.Encoding]::ASCII.GetBytes('RIFF')); $bw.Write([int](36 + $n * 2))
  $bw.Write([Text.Encoding]::ASCII.GetBytes('WAVEfmt ')); $bw.Write([int]16)
  $bw.Write([int16]1); $bw.Write([int16]1); $bw.Write([int]$rate); $bw.Write([int]($rate * 2))
  $bw.Write([int16]2); $bw.Write([int16]16)
  $bw.Write([Text.Encoding]::ASCII.GetBytes('data')); $bw.Write([int]($n * 2))
  $bw.Write((New-Object byte[] ($n * 2)))
  [IO.File]::WriteAllBytes($wav, $ms.ToArray())
  try {
    $code = & curl.exe -s -o NUL -w '%{http_code}' -m 120 -F "file=@$wav;type=audio/wav" "$api/v1/speech/transcribe"
    if ($code -eq '200') { Say 'ok' 'speech-to-text warmed up' Green }
    else {
      Say 'FAIL' "speech-to-text returned HTTP $code - speaking to the HUD will not work" Red
      Show-LogTail (Join-Path $logDir 'backend')
      $failed = $true
    }
  } finally { Remove-Item $wav -ErrorAction SilentlyContinue }
}

# 4) Open it
if ($Overlay) { & (Join-Path $PSScriptRoot 'launch-overlay.ps1') }
else { Start-Process $hudUrl }

if ($failed) { Write-Host "`nJARVIS HUD opened, but something above failed." -ForegroundColor Red; exit 1 }
Write-Host "`nJARVIS HUD ready -> $hudUrl" -ForegroundColor Cyan
