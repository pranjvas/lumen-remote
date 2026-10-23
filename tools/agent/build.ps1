<#
.SYNOPSIS
  Builds and signs the Lumen Agent Tizen app (companion/agent) for the TV.

.DESCRIPTION
  1. Finds this PC's LAN address the same way the server does: a UDP "connect" towards the TV
     (no packet is sent) and the local endpoint the OS picked for it.
  2. Reads data/secrets.json, creating only the secrets that are missing (never overwriting one).
  3. Writes companion/agent/agent-config.json { pcHost, pcPort, key, version }.
  4. Runs tizen build-web and tizen package (signed with the given security profile) and copies
     the result to companion/build/LumenAgent.wgt.
  The agent key is never printed. Installing is a separate step (tools/agent/install.sh).
#>
[CmdletBinding()]
param(
  [string]$TvHost,
  [int]$PcPort,
  [string]$SigningProfile = 'Q95T',
  [string]$TizenCli = 'C:\Users\pranj\Documents\Codex\Tools\TizenStudio10\tools\ide\bin\tizen.bat'
)

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$DataDir = Join-Path $Root 'data'
$AgentDir = Join-Path $Root 'companion\agent'
$BuildDir = Join-Path $Root 'companion\build'
$OutDir = Join-Path $BuildDir 'agent'
$Utf8 = New-Object System.Text.UTF8Encoding $false

function Write-JsonFile([string]$Path, $Object) {
  $tmp = "$Path.tmp"
  [System.IO.File]::WriteAllText($tmp, ($Object | ConvertTo-Json -Depth 5), $Utf8)
  Move-Item -LiteralPath $tmp -Destination $Path -Force
}

function New-Secret {
  $bytes = New-Object byte[] 32
  $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
  try { $rng.GetBytes($bytes) } finally { $rng.Dispose() }
  -join ($bytes | ForEach-Object { $_.ToString('x2') })
}

function Invoke-Tizen([string[]]$Arguments) {
  & $TizenCli @Arguments
  if ($LASTEXITCODE -ne 0) { throw "tizen $($Arguments[0]) failed with exit code $LASTEXITCODE" }
}

# ---- settings: explicit parameters, then data/config.json, then the defaults from the spec ----
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
if (-not (Test-Path -LiteralPath $TizenCli)) { throw "Tizen CLI not found at $TizenCli" }

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

# ---- 2. secrets (create only what is missing) ----
New-Item -ItemType Directory -Force -Path $DataDir | Out-Null
$secretsPath = Join-Path $DataDir 'secrets.json'
$secrets = [ordered]@{}
if (Test-Path -LiteralPath $secretsPath) {
  $existing = Get-Content -LiteralPath $secretsPath -Raw | ConvertFrom-Json
  foreach ($p in $existing.PSObject.Properties) { $secrets[$p.Name] = $p.Value }
}
$created = @()
foreach ($name in 'genaSecret', 'agentKey', 'castSecret', 'mcpToken') {
  if (-not $secrets.Contains($name) -or -not $secrets[$name]) {
    $secrets[$name] = New-Secret
    $created += $name
  }
}
if ($created.Count -gt 0) {
  Write-JsonFile $secretsPath $secrets
  Write-Host "data/secrets.json: created $($created -join ', ')"
} else {
  Write-Host 'data/secrets.json: all secrets present'
}

# ---- 3. agent-config.json ----
$version = ([xml](Get-Content -LiteralPath (Join-Path $AgentDir 'config.xml') -Raw)).widget.version
if (-not $version) { throw 'companion/agent/config.xml has no widget version' }
# The agent's CSP lets its player fetch only from the relay port; another lan.port would break playback.
$csp = [string](Select-String -LiteralPath (Join-Path $AgentDir 'config.xml') -Pattern '<tizen:content-security-policy>(.*)</tizen:content-security-policy>').Matches[0].Groups[1].Value
if ($csp -notmatch "connect-src [^;]*http://\*:$PcPort(\s|;|$)" -or $csp -notmatch "media-src [^;]*http://\*:$PcPort(\s|;|$)") {
  throw "companion/agent/config.xml CSP does not allow the relay port $PcPort (add http://*:$PcPort to connect-src and media-src)"
}
Write-JsonFile (Join-Path $AgentDir 'agent-config.json') ([ordered]@{
  pcHost = $pcHost
  pcPort = $PcPort
  key = [string]$secrets['agentKey']
  version = $version
})
Write-Host "companion/agent/agent-config.json: pcHost $pcHost, pcPort $PcPort, version $version (key hidden)"

# ---- 4. build and sign ----
if (Test-Path -LiteralPath $OutDir) { Remove-Item -LiteralPath $OutDir -Recurse -Force }
New-Item -ItemType Directory -Force -Path $BuildDir | Out-Null
Invoke-Tizen @('build-web', '-e', 'agent-config.example.json', '-out', $OutDir, '--', $AgentDir)
Invoke-Tizen @('package', '-t', 'wgt', '-s', $SigningProfile, '--', $OutDir)

$wgt = Get-ChildItem -LiteralPath $OutDir -Filter '*.wgt' | Sort-Object LastWriteTime -Descending | Select-Object -First 1
if (-not $wgt) { throw "tizen package produced no .wgt in $OutDir" }
$target = Join-Path $BuildDir 'LumenAgent.wgt'
Copy-Item -LiteralPath $wgt.FullName -Destination $target -Force

Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip = [System.IO.Compression.ZipFile]::OpenRead($target)
try { $entries = @($zip.Entries | ForEach-Object { $_.FullName }) } finally { $zip.Dispose() }
foreach ($required in 'config.xml', 'index.html', 'agent.js', 'agent-config.json', 'author-signature.xml', 'signature1.xml') {
  if ($entries -notcontains $required) { throw "LumenAgent.wgt is missing $required" }
}

$size = (Get-Item -LiteralPath $target).Length
Write-Host "Built $target ($size bytes, version $version, signed with profile $SigningProfile)"
Write-Host "Contents: $($entries -join ', ')"
