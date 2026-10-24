<#
.SYNOPSIS
  Kills headless Edge browsers left behind by test and screenshot scripts.
.DESCRIPTION
  A script that starts Edge and then kills the PID it spawned often kills nothing: msedge.exe hands
  over to the real browser process and exits, so the browser (and its GPU, renderer and utility
  processes) keeps running and eats CPU. This finds every headless Edge whose profile folder is in
  %TEMP% and that is older than -MinAgeMin minutes, kills it and its children by profile, and removes
  the folder. Lumen's own browser (data\browser-profile) and an incognito session's profile
  (lumen-incognito-*) are never touched.
.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File tools\kill-stray-edge.ps1            # list and kill (older than 10 min)
  powershell -NoProfile -ExecutionPolicy Bypass -File tools\kill-stray-edge.ps1 -WhatIf    # list only
#>
param([int]$MinAgeMin = 10, [switch]$WhatIf)

$temp = [IO.Path]::GetFullPath($env:TEMP).TrimEnd('\')
$all = Get-CimInstance Win32_Process -Filter "Name='msedge.exe'"
$roots = $all | Where-Object { $_.CommandLine -match '--headless' -and $_.CommandLine -notmatch '--type=' }
$killed = 0
foreach ($p in $roots) {
  $m = [regex]::Match($p.CommandLine, '--user-data-dir="?([^"]+?)"?(\s--|\s*$)')
  if (-not $m.Success) { continue }
  $dir = [IO.Path]::GetFullPath($m.Groups[1].Value.Trim()).TrimEnd('\')
  if (-not $dir.StartsWith($temp, [StringComparison]::OrdinalIgnoreCase)) { continue }
  $name = Split-Path $dir -Leaf
  if ($name -like 'lumen-incognito*') { continue }
  $age = [int]((Get-Date) - $p.CreationDate).TotalMinutes
  if ($age -lt $MinAgeMin) { continue }
  $family = $all | Where-Object { $_.CommandLine -and $_.CommandLine.IndexOf($dir, [StringComparison]::OrdinalIgnoreCase) -ge 0 }
  "{0,-7} {1,5} min  {2,3} processes  {3}" -f $p.ProcessId, $age, ($family | Measure-Object).Count, $name
  if ($WhatIf) { continue }
  foreach ($f in $family) { Stop-Process -Id $f.ProcessId -Force -ErrorAction SilentlyContinue }
  Start-Sleep -Milliseconds 500
  Remove-Item -LiteralPath $dir -Recurse -Force -ErrorAction SilentlyContinue
  $killed += 1
}
if ($WhatIf) { 'listed only (-WhatIf)' } else { "killed $killed stray headless Edge browser(s)" }
