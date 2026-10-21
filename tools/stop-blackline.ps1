# Stops what start-blackline.ps1 started (the API and the web app), and anything else listening on their two ports.
$home_ = Join-Path $env:LOCALAPPDATA "Blackline"
$pids = Join-Path $home_ "pids.txt"
if (Test-Path $pids) {
  foreach ($id in (Get-Content $pids | Where-Object { $_ })) { & taskkill.exe /PID $id /T /F 2>$null | Out-Null }
  Remove-Item $pids -Force
}
foreach ($port in 3000, 5173) {
  Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue | ForEach-Object { & taskkill.exe /PID $_.OwningProcess /T /F 2>$null | Out-Null }
}
Write-Host "Blackline stopped."
Start-Sleep -Seconds 1
