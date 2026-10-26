<#
.SYNOPSIS
  Builds, signs and installs a Lumen TV app (the agent or Eyes) on the TV through sdb. Used by the updater
  (server/update/tvapps.js) after an update carried a newer TV app; also usable by hand.
.DESCRIPTION
  1. Builds and signs with the app's own script (tools/agent/build.ps1 or tools/eyes/build.ps1) and the
     given Tizen CLI.
  2. Connects sdb to the TV, pushes the package and installs it with vd_appinstall.
  The agent is left stopped (Lumen starts it again); Eyes starts when Lumen next needs it.
.EXAMPLE
  powershell -File tools/tvapp-install.ps1 -App agent -TizenCli C:\tizen-studio\tools\ide\bin\tizen.bat -Sdb C:\tizen-studio\tools\sdb.exe -TvHost 192.168.1.2
#>
param(
  [Parameter(Mandatory)][ValidateSet('agent', 'eyes')][string]$App,
  [Parameter(Mandatory)][string]$TizenCli,
  [Parameter(Mandatory)][string]$Sdb,
  [Parameter(Mandatory)][string]$TvHost
)
$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
$target = "${TvHost}:26101"

if ($App -eq 'agent') {
  & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $Root 'tools\agent\build.ps1') -TizenCli $TizenCli | Out-Host
  if ($LASTEXITCODE -ne 0) { throw 'the agent build failed' }
  $package = Join-Path $Root 'companion\build\LumenAgent.wgt'
  $appId = 'lumenrmt01.LumenAgent'
  $remote = '/home/owner/share/tmp/sdk_tools/tmp/LumenAgent.wgt'
} else {
  & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $Root 'tools\eyes\build.ps1') -TizenCli $TizenCli | Out-Host
  if ($LASTEXITCODE -ne 0) { throw 'the Eyes build failed' }
  $package = Join-Path $Root 'companion\build\LumenEyes.tpk'
  $appId = 'org.lumen.eyes'
  $remote = '/home/owner/share/tmp/sdk_tools/tmp/LumenEyes.tpk'
}
if (-not (Test-Path -LiteralPath $package)) { throw "the build left no $package" }

$devices = & $Sdb devices 2>&1 | Out-String
if ($devices -notmatch [regex]::Escape($target)) {
  for ($i = 0; $i -lt 3 -and ((& $Sdb connect $target 2>&1 | Out-String) -notmatch 'connected to'); $i++) { Start-Sleep -Seconds 5 }
}
& $Sdb -s $target push $package $remote | Out-Host
if ($LASTEXITCODE -ne 0) { throw 'sdb push failed (is Developer mode on with this PC as its host?)' }
$out = & $Sdb -s $target shell 0 vd_appinstall $appId $remote 2>&1 | Out-String
Write-Host $out
if ($out -notmatch [regex]::Escape("app_id[$appId] install completed")) { throw "the install did not complete" }
Write-Host "$App installed"
