# Remove dsh-desktop-uia from a DSH profile.
#
#   powershell -ExecutionPolicy Bypass -File uninstall.ps1
#   powershell -ExecutionPolicy Bypass -File uninstall.ps1 -Profile web -Purge
#
# -Purge also deletes the plugin's stored settings and audit trail under
# <DSH_HOME>\storages\dsh-desktop-uia.
[CmdletBinding()]
param(
    [string]$Profile = 'web',
    [string]$DshHome,
    [string]$AppRoot,
    [switch]$Purge
)

$ErrorActionPreference = 'Stop'
$pluginRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$packageName = 'dsh-desktop-uia'

function Write-Step([string]$message) { Write-Host "[uninstall] $message" }

if ($DshHome) { $dshHome = $DshHome } elseif ($env:DSH_HOME) { $dshHome = $env:DSH_HOME } else { $dshHome = Join-Path $env:APPDATA 'dsh-desktop\harness' }
if (-not (Test-Path -LiteralPath $dshHome)) { throw "no DSH home at $dshHome" }

if (-not $AppRoot) {
    $process = Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.ProcessName -eq 'DSH Desktop' } | Select-Object -First 1
    $candidates = @()
    if ($process -and $process.Path) { $candidates += (Join-Path (Split-Path -Parent $process.Path) 'resources\app') }
    $candidates += (Join-Path $env:LOCALAPPDATA 'Programs\DSH Desktop\resources\app')
    $candidates += (Join-Path $env:ProgramFiles 'DSH Desktop\resources\app')
    foreach ($candidate in $candidates) {
        if ($candidate -and (Test-Path -LiteralPath (Join-Path $candidate 'node_modules\@deepseek-ai\dsh\lib\bin.js'))) { $AppRoot = $candidate; break }
    }
}
if (-not $AppRoot) { throw 'cannot find the DSH installation: pass -AppRoot "<...>\resources\app"' }

$profileDir = Join-Path $dshHome "profiles\$Profile"
$cli = Join-Path $AppRoot 'node_modules\@deepseek-ai\dsh\lib\bin.js'
$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { throw 'node is not on PATH' }

if (-not (Test-Path -LiteralPath $profileDir)) {
    Write-Step "no profile at $profileDir; nothing to remove"
} else {
    Write-Step "removing $packageName from profile $Profile"
    & $node $cli plugin --profile $Profile remove $packageName
    if ($LASTEXITCODE -ne 0) { throw "dsh plugin remove exited with $LASTEXITCODE" }

    $manifestPath = Join-Path $profileDir 'package.json'
    $manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
    $stillListed = @($manifest.dsh.profile.bundles) -contains $packageName
    Write-Step "still in the bundle list: $stillListed"
    if ($stillListed) {
        Write-Host '[uninstall] the bundle list still names the plugin; remove that entry by hand if DSH complains on boot.' -ForegroundColor Yellow
    }
}

if ($Purge) {
    $storage = Join-Path $dshHome 'storages\dsh-desktop-uia'
    if (Test-Path -LiteralPath $storage) {
        Remove-Item -LiteralPath $storage -Recurse -Force
        Write-Step "deleted $storage"
    } else {
        Write-Step 'no stored settings to delete'
    }
}

Write-Host ''
Write-Host '[uninstall] done. Restart DSH Desktop to unload the plugin.' -ForegroundColor Green
