<#
.SYNOPSIS
  Packages the Lumen TV agent (companion/agent) as an UNSIGNED .wgt for Apps2Samsung
  (https://github.com/Apps2Samsung/Apps2Samsung) to sign and install.

.DESCRIPTION
  Apps2Samsung installs any .wgt through "Custom WGT / TPK": it strips whatever signatures the
  package carries and re-signs it with its own certificate (on Tizen 4.x-6.x TVs such as the
  Q95T's 5.5, a bundled Tizen developer certificate; on Tizen 7+, a Samsung certificate it mints
  after a Samsung-account sign-in). So this script needs no Tizen Studio and no certificate
  profile: it only stages the agent's files and zips them.

  1. Finds this PC's LAN address towards the TV (UDP "connect", no packet is sent), like build.ps1.
  2. Reads the agent key from data/secrets.json. READ ONLY: it never creates or rewrites a secret,
     because a fresh key would not match the one the running server checks.
  3. Writes agent-config.json { pcHost, pcPort, key, version } into a staging folder (never into
     companion/agent/, so it does not disturb build.ps1's output).
  4. Zips the staged files uncompressed (NoCompression) with '/' separators, the way
     Apps2Samsung builds its own unsigned debug-agent package, and checks the result.

  The output carries the agent key and this PC's address: it is a personal build for your own TV.
  Do not publish it. The key is never printed.

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File tools/agent/package-apps2samsung.ps1
#>
[CmdletBinding()]
param(
  [string]$TvHost,
  [int]$PcPort,
  # The folder holding config.json and secrets.json. Defaults to this checkout's data/.
  [string]$DataDir,
  # Defaults to companion/build/LumenAgent-<version>-apps2samsung.wgt.
  [string]$OutFile
)

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
if (-not $DataDir) { $DataDir = Join-Path $Root 'data' }
$AgentDir = Join-Path $Root 'companion\agent'
$BuildDir = Join-Path $Root 'companion\build'
$StageDir = Join-Path $BuildDir 'agent-apps2samsung'
$Utf8 = New-Object System.Text.UTF8Encoding $false

# Files of companion/agent that never go into the package: the example config (the real one is
# generated below), a stale generated config, and any signature a previous Tizen Studio run left.
$Excluded = @('agent-config.example.json', 'agent-config.json', 'author-signature.xml')

# ---- settings: explicit parameters, then data/config.json, then the defaults ----
$settings = $null
$configPath = Join-Path $DataDir 'config.json'
if (Test-Path -LiteralPath $configPath) { $settings = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json }
if (-not $TvHost) {
  $TvHost = '192.168.1.2'
  if ($settings -and $settings.tv -and $settings.tv.host) { $TvHost = [string]$settings.tv.host }
}
if (-not $PcPort) {
  $PcPort = 8791
  if ($settings -and $settings.lan -and $settings.lan.port) { $PcPort = [int]$settings.lan.port }
}

# ---- config.xml: what Apps2Samsung reads from it ----
$configXmlPath = Join-Path $AgentDir 'config.xml'
$configXmlText = Get-Content -LiteralPath $configXmlPath -Raw
$widget = ([xml]$configXmlText).widget
$version = [string]$widget.version
if (-not $version) { throw 'companion/agent/config.xml has no widget version' }
$app = $widget.application
if (-not $app -or [string]$app.package -ne 'lumenrmt01' -or [string]$app.id -ne 'lumenrmt01.LumenAgent') {
  throw 'companion/agent/config.xml: expected <tizen:application id="lumenrmt01.LumenAgent" package="lumenrmt01">'
}
# Apps2Samsung switches to a Partner certificate (Samsung sign-in, Partner tier) when a package
# declares a Partner privilege or on-boot/auto-restart. The agent needs none; keep it that way.
$noComments = [regex]::Replace($configXmlText, '<!--.*?-->', '', 'Singleline')
foreach ($m in [regex]::Matches($noComments, '<tizen:privilege\b[^>]*\bname\s*=\s*"([^"]+)"')) {
  $p = $m.Groups[1].Value
  if ($p -match '(vpnservice|drminfo|\.partner)$') { throw "config.xml declares the Partner-level privilege $p; Apps2Samsung would need a Partner certificate" }
}
if ($noComments -match '\b(on-boot|auto-restart)\s*=\s*"\s*true\s*"') { throw "config.xml sets $($Matches[1])=""true"", which needs Partner signing" }

# The agent's CSP lets its player fetch only from the relay port; another lan.port would break playback.
$csp = [string](Select-String -LiteralPath $configXmlPath -Pattern '<tizen:content-security-policy>(.*)</tizen:content-security-policy>').Matches[0].Groups[1].Value
if ($csp -notmatch "connect-src [^;]*http://\*:$PcPort(\s|;|$)" -or $csp -notmatch "media-src [^;]*http://\*:$PcPort(\s|;|$)") {
  throw "companion/agent/config.xml CSP does not allow the relay port $PcPort (add http://*:$PcPort to connect-src and media-src)"
}

# ---- 1. this PC's LAN address towards the TV ----
$udp = New-Object System.Net.Sockets.UdpClient
try {
  $udp.Connect($TvHost, 9)
  $pcHost = $udp.Client.LocalEndPoint.Address.ToString()
} finally {
  $udp.Dispose()
}
if (-not $pcHost -or $pcHost -eq '0.0.0.0') { throw "Could not find a local address that routes to $TvHost" }
Write-Host "PC address towards the TV ($TvHost): ${pcHost}:$PcPort"

# ---- 2. the agent key (read only) ----
$secretsPath = Join-Path $DataDir 'secrets.json'
if (-not (Test-Path -LiteralPath $secretsPath)) {
  throw "$secretsPath not found: start the Lumen server once (or run npm run agent:build), or pass -DataDir"
}
$key = [string](Get-Content -LiteralPath $secretsPath -Raw | ConvertFrom-Json).agentKey
if (-not $key) { throw "$secretsPath has no agentKey: start the Lumen server once (or run npm run agent:build)" }

# ---- 3. stage the files ----
if (Test-Path -LiteralPath $StageDir) { Remove-Item -LiteralPath $StageDir -Recurse -Force }
New-Item -ItemType Directory -Force -Path $StageDir | Out-Null
$sources = @(Get-ChildItem -LiteralPath $AgentDir -File | Where-Object {
  $Excluded -notcontains $_.Name -and $_.Name -notmatch '^signature\d*\.xml$' -and
  $_.Name -notmatch '^\.' -and $_.Extension -ne '.wgt'
})
foreach ($f in $sources) { Copy-Item -LiteralPath $f.FullName -Destination (Join-Path $StageDir $f.Name) }
if (@(Get-ChildItem -LiteralPath $AgentDir -Directory).Count -gt 0) {
  throw 'companion/agent has subfolders; this script only packages top-level files, extend it first'
}
[System.IO.File]::WriteAllText((Join-Path $StageDir 'agent-config.json'), ([ordered]@{
  pcHost = $pcHost
  pcPort = $PcPort
  key = $key
  version = $version
} | ConvertTo-Json -Depth 5), $Utf8)
Write-Host "agent-config.json: pcHost $pcHost, pcPort $PcPort, version $version (key hidden)"

# ---- 4. zip (uncompressed, '/' entry names; CreateFromDirectory on .NET Framework can write backslashes) ----
if (-not $OutFile) { $OutFile = Join-Path $BuildDir "LumenAgent-$version-apps2samsung.wgt" }
# Apps2Samsung picks install-time patchers by file name; keep the name clear of theirs.
if ([System.IO.Path]::GetFileName($OutFile) -match '(?i)jellyfin|camera-?pip|tvapp') {
  throw "Output name $OutFile would trigger one of Apps2Samsung's app-specific patchers; choose another"
}
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $OutFile) | Out-Null
if (Test-Path -LiteralPath $OutFile) { Remove-Item -LiteralPath $OutFile -Force }

Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
$stream = [System.IO.File]::Open($OutFile, [System.IO.FileMode]::CreateNew)
try {
  $zip = New-Object System.IO.Compression.ZipArchive($stream, [System.IO.Compression.ZipArchiveMode]::Create)
  try {
    foreach ($f in (Get-ChildItem -LiteralPath $StageDir -File | Sort-Object Name)) {
      $entry = $zip.CreateEntry($f.Name, [System.IO.Compression.CompressionLevel]::NoCompression)
      $out = $entry.Open()
      try {
        $bytes = [System.IO.File]::ReadAllBytes($f.FullName)
        $out.Write($bytes, 0, $bytes.Length)
      } finally { $out.Dispose() }
    }
  } finally { $zip.Dispose() }
} finally { $stream.Dispose() }
Remove-Item -LiteralPath $StageDir -Recurse -Force

# ---- check the package ----
$zip = [System.IO.Compression.ZipFile]::OpenRead($OutFile)
try { $entries = @($zip.Entries | ForEach-Object { $_.FullName }) } finally { $zip.Dispose() }
foreach ($required in 'config.xml', 'index.html', 'icon.png', 'agent.js', 'agent-config.json') {
  if ($entries -notcontains $required) { throw "$OutFile is missing $required" }
}
foreach ($e in $entries) {
  if ($e -match '\\' -or $e -match '(^|/)(author-)?signature\d*\.xml$' -or $e -eq 'agent-config.example.json') {
    throw "$OutFile has an entry that must not ship: $e"
  }
}

$size = (Get-Item -LiteralPath $OutFile).Length
Write-Host "Built $OutFile ($size bytes, version $version, unsigned: Apps2Samsung signs it at install)"
Write-Host "Contents: $($entries -join ', ')"
Write-Host 'It carries the agent key and this PC''s address: install it on your own TV only, do not publish it.'
