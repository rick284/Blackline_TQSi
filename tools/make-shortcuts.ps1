# Puts two shortcuts on your desktop: "Blackline" (starts everything and opens the app) and "Stop Blackline".
# Run once; run again if you move the Blackline_TQSi folder.
Add-Type -AssemblyName System.Drawing
$root = Split-Path $PSScriptRoot -Parent
$desktop = [Environment]::GetFolderPath("Desktop")
$icon = Join-Path $PSScriptRoot "blackline.ico"

# The app's own icon, as a Windows icon file (a PNG inside an ICO)
$png = [System.IO.File]::ReadAllBytes((Join-Path $root "packages\web\public\icon-192.png"))
$ms = New-Object System.IO.MemoryStream
$w = New-Object System.IO.BinaryWriter($ms)
$w.Write([uint16]0); $w.Write([uint16]1); $w.Write([uint16]1)
$w.Write([byte]192); $w.Write([byte]192); $w.Write([byte]0); $w.Write([byte]0)
$w.Write([uint16]1); $w.Write([uint16]32); $w.Write([uint32]$png.Length); $w.Write([uint32]22)
$w.Write($png); $w.Flush()
[System.IO.File]::WriteAllBytes($icon, $ms.ToArray())

$shell = New-Object -ComObject WScript.Shell
function New-Shortcut($name, $script, $style) {
  $s = $shell.CreateShortcut((Join-Path $desktop "$name.lnk"))
  $s.TargetPath = "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe"
  $s.Arguments = "-NoProfile -ExecutionPolicy Bypass -File `"$(Join-Path $PSScriptRoot $script)`""
  $s.WorkingDirectory = $root
  $s.IconLocation = $icon
  $s.WindowStyle = $style
  $s.Save()
}
New-Shortcut "Blackline" "start-blackline.ps1" 1
New-Shortcut "Stop Blackline" "stop-blackline.ps1" 7
Write-Host "Done: Blackline and Stop Blackline are on your desktop ($desktop)."
