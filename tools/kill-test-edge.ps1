<#
.SYNOPSIS
  Closes the headless Edge instances the test suite started (profile folders named lumen-test-*), with
  everything under them.

.DESCRIPTION
  Edge's launcher hands over to the real browser process and exits, so killing a test's process tree
  never reaches its browser: a test killed or timed out mid-run leaves its Edge running. tools/test-batches.sh
  calls this after every batch and when it is stopped. -Since limits it to instances started at or after
  that time; Lumen's own Edge never matches (its profile is not a lumen-test-* folder). Two test runs at
  once would close each other's: run one at a time. -WhatIf lists them only.
#>
[CmdletBinding(SupportsShouldProcess)]
param([datetime]$Since = [datetime]::MinValue)

$roots = Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" | Where-Object {
  $_.CommandLine -notmatch '--type=' -and $_.CommandLine -match '--user-data-dir="?[^" ]*\\lumen-test-[^\\" ]+\\' -and $_.CreationDate -ge $Since
}
foreach ($r in $roots) {
  $dir = if ($r.CommandLine -match '--user-data-dir="?([^" ]+)') { $Matches[1] } else { '?' }
  if ($PSCmdlet.ShouldProcess("$($r.ProcessId) ($dir)", 'close test Edge')) {
    & taskkill.exe /PID $r.ProcessId /T /F *> $null
    "closed test Edge $($r.ProcessId)"
  } else { "would close test Edge $($r.ProcessId) ($dir)" }
}
