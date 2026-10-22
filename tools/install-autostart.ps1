<#
.SYNOPSIS
  Starts Lumen Remote when you sign in to Windows (per user, no admin rights).

.DESCRIPTION
  Creates "Lumen Remote.lnk" in your Startup folder. The shortcut runs
  `node tools/start-hidden.js` in this repository, which launches the server in the
  background with its window hidden. Use -Remove to delete the shortcut again.

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File tools/install-autostart.ps1
.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File tools/install-autostart.ps1 -Remove
#>
param([switch]$Remove)

$ErrorActionPreference = 'Stop'

$repo = Split-Path -Parent $PSScriptRoot
$startup = [Environment]::GetFolderPath('Startup')
$shortcut = Join-Path $startup 'Lumen Remote.lnk'

if ($Remove) {
  if (Test-Path -LiteralPath $shortcut) {
    Remove-Item -LiteralPath $shortcut
    Write-Host "Removed $shortcut"
  } else {
    Write-Host 'Lumen Remote is not set to start at sign-in.'
  }
  return
}

$node = (Get-Command node.exe -ErrorAction SilentlyContinue).Source
if (-not $node) { throw 'node.exe was not found on PATH. Install Node.js 22 or newer first.' }

$launcher = Join-Path $repo 'tools\start-hidden.js'
if (-not (Test-Path -LiteralPath $launcher)) { throw "Missing $launcher" }

$shell = New-Object -ComObject WScript.Shell
$link = $shell.CreateShortcut($shortcut)
$link.TargetPath = $node
$link.Arguments = '"' + $launcher + '"'
$link.WorkingDirectory = $repo
$link.WindowStyle = 7 # minimised: the launcher exits as soon as the server is spawned
$link.Description = 'Start Lumen Remote in the background'
$link.Save()

Write-Host "Lumen Remote will start when you sign in ($shortcut)."
Write-Host 'Remove it with: tools/install-autostart.ps1 -Remove'
