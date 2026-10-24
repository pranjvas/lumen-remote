<#
.SYNOPSIS
  Restarts the Lumen server (hidden, like the Startup shortcut) and waits until it answers.

.DESCRIPTION
  Stops the node process running server/index.js, starts it again with tools/start-hidden.js, and
  polls /api/health. With -KeepTvPage, the page Lumen's browser showed on the TV (or on its own) is
  opened again afterwards, since a restart closes the browser and the TV screen. An incognito page is
  never reopened: the restart ends incognito and deletes its session. -WhatIf says what would be
  reopened and changes nothing.
#>
[CmdletBinding(SupportsShouldProcess)]
param(
  [switch]$KeepTvPage,
  [int]$Port = 8790,
  [int]$TimeoutSec = 45
)

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot

function Send-Hub([string]$Cmd, [hashtable]$CmdArgs = @{}) {
  # One command over the /live WebSocket (the same protocol as the web UI); returns the ack's value.
  $script = @"
const ws = new WebSocket('ws://127.0.0.1:$Port/live', { headers: { Origin: 'http://127.0.0.1:$Port' } });
const args = JSON.parse(process.env.LUMEN_CMD_ARGS || '{}');
ws.addEventListener('open', () => ws.send(JSON.stringify({ t: 'cmd', id: 'r1', cmd: '$Cmd', ...args })));
ws.addEventListener('message', (ev) => { const m = JSON.parse(ev.data); if (m.t === 'ack' && m.id === 'r1') { console.log(JSON.stringify(m)); ws.close(); setTimeout(() => process.exit(0), 100); } });
setTimeout(() => process.exit(0), 60000);
"@
  # Through the environment: Windows PowerShell mangles the quotes of JSON passed as an argument.
  $env:LUMEN_CMD_ARGS = ($CmdArgs | ConvertTo-Json -Compress)
  try { node -e $script } finally { Remove-Item Env:LUMEN_CMD_ARGS -ErrorAction SilentlyContinue -WhatIf:$false }
}

function Get-State([string[]]$Keys) {
  # The values of these state keys from the hello message, as one JSON object.
  $env:LUMEN_STATE_KEYS = ($Keys -join ',')
  $script = @"
const keys = process.env.LUMEN_STATE_KEYS.split(',');
const ws = new WebSocket('ws://127.0.0.1:$Port/live', { headers: { Origin: 'http://127.0.0.1:$Port' } });
ws.addEventListener('message', (ev) => { const m = JSON.parse(ev.data); if (m.t === 'hello') { console.log(JSON.stringify(Object.fromEntries(keys.map((k) => [k, m.state[k]?.v ?? null])))); ws.close(); } });
ws.addEventListener('error', () => process.exit(1));
setTimeout(() => process.exit(0), 10000);
"@
  try { node -e $script } finally { Remove-Item Env:LUMEN_STATE_KEYS -ErrorAction SilentlyContinue -WhatIf:$false }
}

$restore = $null
if ($KeepTvPage) {
  try {
    $state = Get-State @('browser.url', 'tvscreen.on', 'browser.incognito') | ConvertFrom-Json
    if (-not $state) { throw 'no answer' }
    if ($state.'browser.incognito') { Write-Host 'The browser is incognito: its page is not reopened (the restart ends incognito).' }
    elseif ($state.'browser.url') { $restore = @{ url = $state.'browser.url'; tv = [bool]$state.'tvscreen.on' } }
  } catch { Write-Host 'Lumen was not answering; nothing to restore.' }
} else {
  # Without -KeepTvPage the TV leaves Lumen's browser cleanly now, instead of being left on a screen
  # whose server has gone.
  try {
    $onTv = Get-State 'tvscreen.on' | ConvertFrom-Json
    if ($onTv -eq $true) {
      $null = Send-Hub 'tvscreen.close'
      Write-Host 'Closed the browser on the TV.'
    }
  } catch { }
}

if (-not $PSCmdlet.ShouldProcess("Lumen on port $Port", 'Restart')) {
  if ($restore) { Write-Host ('Would reopen the page{0} after the restart.' -f $(if ($restore.tv) { ' on the TV' } else { '' })) }
  elseif ($KeepTvPage) { Write-Host 'No page would be reopened after the restart.' }
  return
}

$procs = Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -match 'lumen-remote\\server\\index.js' }
foreach ($p in $procs) { Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue }
if ($procs) { Write-Host "Stopped Lumen (pid $(@($procs.ProcessId) -join ', '))." }
Start-Sleep -Seconds 1

node (Join-Path $Root 'tools\start-hidden.js')

$deadline = (Get-Date).AddSeconds($TimeoutSec)
$health = $null
while ((Get-Date) -lt $deadline -and -not $health) {
  Start-Sleep -Seconds 1
  try { $health = (Invoke-WebRequest -UseBasicParsing "http://127.0.0.1:$Port/api/health" -TimeoutSec 3).Content } catch { }
}
if (-not $health) { throw "Lumen did not answer on port $Port within $TimeoutSec s; see data/logs/stdout.log" }
Write-Host "Healthy: $health"

if ($restore) {
  $cmd = if ($restore.tv) { 'browser.openOnTv' } else { 'browser.open' }
  # restore: Lumen putting the page back is nobody's click, so a video it starts by itself stays on the page.
  $ack = Send-Hub $cmd @{ url = $restore.url; restore = $true } | ConvertFrom-Json
  Write-Host ("Reopened the page{0}: {1}" -f ($(if ($restore.tv) { ' on the TV' } else { '' })), $(if ($ack.ok) { 'ok' } else { $ack.error.message }))
}
