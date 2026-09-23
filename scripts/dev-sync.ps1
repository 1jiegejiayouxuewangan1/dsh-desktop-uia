<#
.SYNOPSIS
  Copy this checkout into the DSH profile that actually loads it.

.DESCRIPTION
  DSH loads the plugin from <DSH_HOME>\profiles\<profile>\node_modules\dsh-desktop-uia,
  not from this working copy. After editing lib\ or rebuilding the sidecar, that
  installed copy is stale until this script runs - and node_modules is a pnpm
  store hard link, so a plain copy is the honest way to update it.

  The script reports every file it changes, and refuses to invent a target: if no
  installed copy exists, install the plugin first (install.cmd).

.PARAMETER Profile
  Profile directory under <DSH_HOME>\profiles. Default: web (the GUI profile).

.PARAMETER WhatIf
  Report what would change without writing anything.

.PARAMETER Force
  Sync even when a DSH process currently holds the installed files.

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\dev-sync.ps1
#>
[CmdletBinding()]
param(
  [string]$Profile = 'web',
  [switch]$WhatIf,
  [switch]$Force
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)

$home_ = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:APPDATA 'dsh-desktop\harness' }
$profilesDir = Join-Path $home_ 'profiles'
$target = Join-Path $profilesDir (Join-Path $Profile 'node_modules\dsh-desktop-uia')

Write-Host "checkout : $root"
Write-Host "installed: $target"

if (-not (Test-Path $target)) {
  Write-Host "FAIL: no installed copy at $target" -ForegroundColor Red
  Write-Host "      install the plugin first: install.cmd"
  exit 1
}

$running = Get-Process -Name 'DSH Desktop', 'DSH', 'dsh' -ErrorAction SilentlyContinue
if ($running -and -not $Force) {
  Write-Host "note: DSH is running; changed files are only picked up after a restart." -ForegroundColor Yellow
}

$items = @(
  @{ From = Join-Path $root 'lib'; To = Join-Path $target 'lib'; Filter = '*.js' },
  @{ From = Join-Path $root 'sidecar'; To = Join-Path $target 'sidecar'; Filter = 'UiaSidecar.exe' },
  @{ From = Join-Path $root 'sidecar'; To = Join-Path $target 'sidecar'; Filter = 'UiaSidecar.manifest' },
  @{ From = Join-Path $root 'sidecar'; To = Join-Path $target 'sidecar'; Filter = 'build-info.json' },
  @{ From = $root; To = $target; Filter = '*.md' },
  @{ From = $root; To = $target; Filter = 'package.json' }
)

$changed = 0
$missing = 0
foreach ($item in $items) {
  if (-not (Test-Path $item.From)) { continue }
  $files = Get-ChildItem -Path $item.From -Filter $item.Filter -File -ErrorAction SilentlyContinue
  foreach ($file in $files) {
    $destination = Join-Path $item.To $file.Name
    $same = $false
    if (Test-Path $destination) {
      $sourceHash = (Get-FileHash $file.FullName -Algorithm SHA256).Hash
      $targetHash = (Get-FileHash $destination -Algorithm SHA256).Hash
      $same = $sourceHash -eq $targetHash
    }
    if ($same) { continue }
    $relative = $file.FullName.Replace($root, '').TrimStart('\')
    if ($WhatIf) {
      Write-Host "would update  $relative"
      $changed++
      continue
    }
    if (-not (Test-Path $item.To)) { New-Item -ItemType Directory -Path $item.To -Force | Out-Null }
    try {
      Copy-Item $file.FullName $destination -Force
      Write-Host "updated  $relative"
      $changed++
    } catch {
      Write-Host "FAILED  $relative - $($_.Exception.Message)" -ForegroundColor Red
      Write-Host "        close DSH (the file is loaded) and run again, or pass -Force." -ForegroundColor Yellow
      $missing++
    }
  }
}

Write-Host ''
if ($changed -eq 0 -and $missing -eq 0) {
  Write-Host 'RESULT: the installed copy already matches this checkout.' -ForegroundColor Green
  exit 0
}
if ($missing -gt 0) {
  Write-Host "RESULT: $changed file(s) updated, $missing failed." -ForegroundColor Red
  exit 1
}
if ($WhatIf) {
  Write-Host "RESULT: $changed file(s) would be updated (-WhatIf, nothing written)." -ForegroundColor Yellow
  exit 0
}
Write-Host "RESULT: $changed file(s) updated. Restart DSH to load them." -ForegroundColor Green
exit 0
