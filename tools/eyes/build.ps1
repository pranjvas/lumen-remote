<#
  Builds Lumen Eyes (companion/eyes, Tizen .NET) and signs it for the TV:
    1. dotnet build -c Release (Tizen.NET.Sdk from NuGet; the .NET 8 SDK is enough)
    2. copies the .tpk to companion/build/LumenEyes.tpk
    3. re-signs it with the Tizen CLI security profile (the same one as the agent)
  Install with: wsl bash /mnt/c/Users/pranj/source/lumen-remote/tools/eyes/install.sh
#>
param(
  [string]$SigningProfile = 'Q95T',
  [string]$TizenCli = 'C:\Users\pranj\Documents\Codex\Tools\TizenStudio10\tools\ide\bin\tizen.bat'
)
$ErrorActionPreference = 'Stop'
$root = Resolve-Path (Join-Path $PSScriptRoot '..\..')
$project = Join-Path $root 'companion\eyes'
$manifest = [xml](Get-Content (Join-Path $project 'tizen-manifest.xml'))
$version = $manifest.manifest.version
$package = $manifest.manifest.package

dotnet build $project -c Release | Out-Host
if ($LASTEXITCODE -ne 0) { throw 'dotnet build failed' }
$built = Join-Path $project "bin\Release\tizen50\$package-$version.tpk"
if (-not (Test-Path $built)) { throw "missing $built" }

$outDir = Join-Path $root 'companion\build'
New-Item -ItemType Directory -Force $outDir | Out-Null
$target = Join-Path $outDir 'LumenEyes.tpk'
Copy-Item $built $target -Force
& $TizenCli package -t tpk -s $SigningProfile -- $target | Out-Host
if ($LASTEXITCODE -ne 0) { throw 'tizen package (signing) failed' }
Write-Host "Built $target (version $version, signed with profile $SigningProfile)"
