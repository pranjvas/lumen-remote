<#
.SYNOPSIS
  Builds, signs and installs a Lumen TV app (the agent or Eyes) on the TV through sdb. Used by the updater
  (server/update/tvapps.js) after an update carried a newer TV app; also usable by hand.
.DESCRIPTION
  1. Builds and signs with the app's own script (tools/agent/build.ps1 or tools/eyes/build.ps1), the given
     Tizen CLI and signing profile (or takes -Package, already built and signed).
  2. Connects sdb to the TV, pushes the package and installs it with vd_appinstall.
  The agent is left stopped (Lumen starts it again); Eyes starts when Lumen next needs it.
.EXAMPLE
  powershell -File tools/tvapp-install.ps1 -App agent -TizenCli C:\tizen-studio\tools\ide\bin\tizen.bat -Sdb C:\tizen-studio\tools\sdb.exe -TvHost 192.168.1.2 -SigningProfile MyTV
#>
param(
  [Parameter(Mandatory)][ValidateSet('agent', 'eyes')][string]$App,
  [Parameter(Mandatory)][string]$TizenCli,
  [Parameter(Mandatory)][string]$Sdb,
  [Parameter(Mandatory)][string]$TvHost,
  [string]$SigningProfile = '',
  [string]$Package = ''
)
$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
$target = "${TvHost}:26101"

# sdb, with its output (stderr too) as text. Windows PowerShell 5.1 turns a native program's redirected stderr
# into errors, which 'Stop' would make fatal (sdb reports starting its server on stderr).
function Invoke-Sdb {
  $previous = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    $text = & $Sdb @args 2>&1 | ForEach-Object { "$_" } | Out-String
    return [pscustomobject]@{ Text = $text; Code = $LASTEXITCODE }
  } finally {
    $ErrorActionPreference = $previous
  }
}

if ($App -eq 'agent') {
  $built = Join-Path $Root 'companion\build\LumenAgent.wgt'
  $appId = 'lumenrmt01.LumenAgent'
  $remote = '/home/owner/share/tmp/sdk_tools/tmp/LumenAgent.wgt'
} else {
  $built = Join-Path $Root 'companion\build\LumenEyes.tpk'
  $appId = 'org.lumen.eyes'
  $remote = '/home/owner/share/tmp/sdk_tools/tmp/LumenEyes.tpk'
}
if ($Package) {
  $built = $Package
} else {
  $buildArgs = @('-TizenCli', $TizenCli)
  if ($SigningProfile) { $buildArgs += @('-SigningProfile', $SigningProfile) }
  & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $Root "tools\$App\build.ps1") @buildArgs | Out-Host
  if ($LASTEXITCODE -ne 0) { throw "the $App build failed" }
}
if (-not (Test-Path -LiteralPath $built)) { throw "the build left no $built" }

if ((Invoke-Sdb devices).Text -notmatch [regex]::Escape($target)) {
  for ($i = 0; $i -lt 3 -and ((Invoke-Sdb connect $target).Text -notmatch 'connected to'); $i++) { Start-Sleep -Seconds 5 }
}
$push = Invoke-Sdb -s $target push $built $remote
Write-Host $push.Text
if ($push.Code -ne 0) { throw 'sdb push failed (is Developer mode on with this PC as its host?)' }
$out = (Invoke-Sdb -s $target shell 0 vd_appinstall $appId $remote).Text
Write-Host $out
if ($out -notmatch [regex]::Escape("app_id[$appId] install completed")) { throw "the install did not complete" }
Write-Host "$App installed"
