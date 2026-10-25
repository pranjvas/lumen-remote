<#
.SYNOPSIS
  Closes the headless Edge instances the test suite started (temp profile folders named lumen-*), with
  everything under them.

.DESCRIPTION
  Edge's launcher hands over to the real browser process and exits, so killing a test's process tree
  never reaches its browser: a test killed or timed out mid-run leaves its Edge running. The tests keep
  their profiles in the temp folder under lumen-* names (lumen-test-, lumen-click-ui-, lumen-recover-,
  ...). Lumen's own Edge is never closed: its profile is data\browser-profile, and its incognito
  profile (also in the temp folder) starts with lumen-incognito-<hash of that path>-, worked out here as
  server/features/browser.js does. tools/test-batches.sh calls this after every batch and when it is
  stopped. -Since limits it to instances started at or after that time. Two test runs at once would
  close each other's: run one at a time. -WhatIf lists them only.
#>
[CmdletBinding(SupportsShouldProcess)]
param([datetime]$Since = [datetime]::MinValue)

$repo = Split-Path -Parent $PSScriptRoot
$profileDir = [IO.Path]::GetFullPath((Join-Path $repo 'data\browser-profile')).ToLowerInvariant()
$sha = [Security.Cryptography.SHA256]::Create()
$hash = -join ($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($profileDir)) | ForEach-Object { $_.ToString('x2') })
$ownIncognito = "lumen-incognito-$($hash.Substring(0, 8))-"
$temp = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\')

$roots = Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" | Where-Object { $_.CommandLine -notmatch '--type=' -and $_.CreationDate -ge $Since } | ForEach-Object {
  $dir = if ($_.CommandLine -match '--user-data-dir="?([^"]+?)"?(\s--|\s*$)') { $Matches[1].Trim() } else { $null }
  if (-not $dir) { return }
  $parent = Split-Path -Parent $dir
  $leaf = Split-Path -Leaf $dir
  # The temp folder's lumen-* profile folders (a test's folder may hold the profile one level down).
  $top = if ($parent -and $parent.TrimEnd('\') -ieq $temp) { $leaf } elseif ($parent -and (Split-Path -Parent $parent).TrimEnd('\') -ieq $temp) { Split-Path -Leaf $parent } else { $null }
  if ($top -and $top -like 'lumen-*' -and -not $top.StartsWith($ownIncognito, [StringComparison]::OrdinalIgnoreCase)) { [pscustomobject]@{ Pid = $_.ProcessId; Dir = $dir } }
}
foreach ($r in $roots) {
  if ($PSCmdlet.ShouldProcess("$($r.Pid) ($($r.Dir))", 'close test Edge')) {
    & taskkill.exe /PID $r.Pid /T /F *> $null
    "closed test Edge $($r.Pid)"
  } else { "would close test Edge $($r.Pid) ($($r.Dir))" }
}
