# Starts Blackline (the API with the demo company, and the web app) hidden in the background, waits until both answer,
# then opens the app in its own window. Safe to run again: anything already running is left alone.
# The demo database is kept on disk in %LOCALAPPDATA%\Blackline\data, so your work is still there next time.
param([switch]$NoOpen, [int]$ApiPort = 3000, [int]$WebPort = 5173)

$ErrorActionPreference = "Stop"
$root = Split-Path $PSScriptRoot -Parent
$home_ = Join-Path $env:LOCALAPPDATA "Blackline"
$logs = Join-Path $home_ "logs"
$data = Join-Path $home_ "data"
New-Item -ItemType Directory -Force $logs, $data | Out-Null

if (-not (Get-Command npm.cmd -ErrorAction SilentlyContinue)) { $env:Path = "C:\Program Files\nodejs;" + $env:Path }
if (-not (Get-Command npm.cmd -ErrorAction SilentlyContinue)) {
  Write-Host "Node.js was not found, so Blackline cannot start. Install Node.js from nodejs.org and try again."
  Read-Host "Press Enter to close"; exit 1
}

function Test-Up($url) { try { return (Invoke-WebRequest $url -UseBasicParsing -TimeoutSec 2).StatusCode -lt 500 } catch { return $false } }
$api = "http://127.0.0.1:$ApiPort/health"
$web = "http://localhost:$WebPort/"
$pids = Join-Path $home_ "pids.txt"
$started = @()

Write-Host "Starting Blackline..."
if (-not (Test-Up $api)) {
  $env:PORT = "$ApiPort"; $env:DATA_DIR = $data
  $p = Start-Process npm.cmd -ArgumentList "run", "demo", "-w", "@blackline/server" -WorkingDirectory $root -WindowStyle Hidden -PassThru `
    -RedirectStandardOutput (Join-Path $logs "api.log") -RedirectStandardError (Join-Path $logs "api.err.log")
  $started += $p.Id
}
if (-not (Test-Up $web)) {
  $env:API_URL = "http://127.0.0.1:$ApiPort"
  $p = Start-Process npm.cmd -ArgumentList "run", "dev", "-w", "@blackline/web", "--", "--port", "$WebPort", "--strictPort" -WorkingDirectory $root -WindowStyle Hidden -PassThru `
    -RedirectStandardOutput (Join-Path $logs "web.log") -RedirectStandardError (Join-Path $logs "web.err.log")
  $started += $p.Id
}
if ($started.Count) { Add-Content $pids ($started -join "`n") }

$deadline = (Get-Date).AddSeconds(150)
while (-not ((Test-Up $api) -and (Test-Up $web))) {
  if ((Get-Date) -gt $deadline) {
    Write-Host "Blackline did not start in time. The logs are in $logs"
    Read-Host "Press Enter to close"; exit 1
  }
  Start-Sleep -Seconds 2
}

if (-not $NoOpen) {
  $url = "http://localhost:$WebPort/"
  $browsers = @("$env:ProgramFiles\Google\Chrome\Application\chrome.exe", "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe", "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe")
  $b = $browsers | Where-Object { Test-Path $_ } | Select-Object -First 1
  # --app opens it in its own window, without tabs or an address bar, like an installed program
  if ($b) { Start-Process $b -ArgumentList "--app=$url" } else { Start-Process $url }
}
Write-Host "Blackline is running."
