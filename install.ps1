# Install dsh-desktop-uia into a DSH profile.
#
#   powershell -ExecutionPolicy Bypass -File install.ps1                     # web profile, auto-detected paths
#   powershell -ExecutionPolicy Bypass -File install.ps1 -Profile web
#   powershell -ExecutionPolicy Bypass -File install.ps1 -AppRoot "D:\DSH\resources\app" -DshHome "D:\dsh-home"
#
# What it does:
#   1. builds the C# sidecar with the in-box .NET Framework compiler,
#   2. runs `dsh plugin --profile <name> add link:<this folder>`, which pnpm-links
#      the plugin into the profile and adds it to the profile's bundle layer list,
#   3. verifies the profile manifest and reports what to do next.
#
# A backup of the profile manifest is written next to it before anything changes,
# and uninstall.ps1 reverses the install.
[CmdletBinding()]
param(
    [string]$Profile = 'web',
    [string]$DshHome,
    [string]$AppRoot,
    [switch]$NoBuild,
    [switch]$SkipDoctor
)

$ErrorActionPreference = 'Stop'
$pluginRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$packageJsonPath = Join-Path $pluginRoot 'package.json'
$packageName = 'dsh-desktop-uia'

function Write-Step([string]$message) { Write-Host "[install] $message" }
function Write-Problem([string]$message) { Write-Host "[install] $message" -ForegroundColor Red }

<#
    Run a native command and return its exit code.

    Tools like pnpm print progress to stderr, and with $ErrorActionPreference =
    'Stop' a redirected stderr line would abort the script even on success, so
    the preference is relaxed for the duration of the call and both streams are
    echoed.
#>
function Invoke-Native {
    param([string]$FilePath, [string[]]$Arguments, [switch]$Quiet)
    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        & $FilePath @Arguments 2>&1 | ForEach-Object {
            $line = "$_"
            # pnpm prints a long peer-dependency table for this profile; with
            # -Quiet only lines that carry an outcome are echoed.
            if ($Quiet -and $line -notmatch 'ERR_|error|Error|fail|Done in|Packages:|excluded|restored') { return }
            Write-Host "  $line"
        }
        return $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $previous
    }
}

function Test-Windows {
    return [System.Environment]::OSVersion.Platform -eq 'Win32NT'
}
if (-not (Test-Windows)) { throw 'dsh-desktop-uia drives Windows desktops only.' }
if (-not (Test-Path -LiteralPath $packageJsonPath)) { throw "not a plugin folder: $pluginRoot" }

function Resolve-DshHome {
    param([string]$Explicit)
    if ($Explicit) { return $Explicit }
    if ($env:DSH_HOME) { return $env:DSH_HOME }
    $candidate = Join-Path $env:APPDATA 'dsh-desktop\harness'
    if (Test-Path -LiteralPath $candidate) { return $candidate }
    throw 'cannot find the DSH home: pass -DshHome or set DSH_HOME'
}

function Resolve-AppRoot {
    param([string]$Explicit)
    if ($Explicit) {
        if (-not (Test-Path -LiteralPath (Join-Path $Explicit 'node_modules\@deepseek-ai\dsh\lib\bin.js'))) {
            throw "no DSH CLI under $Explicit (expected node_modules\@deepseek-ai\dsh\lib\bin.js)"
        }
        return $Explicit
    }
    # Prefer the running app: its executable sits beside resources\app.
    $process = Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.ProcessName -eq 'DSH Desktop' } | Select-Object -First 1
    if ($process -and $process.Path) {
        $candidate = Join-Path (Split-Path -Parent $process.Path) 'resources\app'
        if (Test-Path -LiteralPath (Join-Path $candidate 'node_modules\@deepseek-ai\dsh\lib\bin.js')) { return $candidate }
    }
    $roots = @(
        (Join-Path $env:LOCALAPPDATA 'Programs\DSH Desktop\resources\app'),
        (Join-Path $env:ProgramFiles 'DSH Desktop\resources\app'),
        (Join-Path ${env:ProgramFiles(x86)} 'DSH Desktop\resources\app')
    )
    foreach ($root in $roots) {
        if ($root -and (Test-Path -LiteralPath (Join-Path $root 'node_modules\@deepseek-ai\dsh\lib\bin.js'))) { return $root }
    }
    throw 'cannot find the DSH installation: pass -AppRoot "<...>\resources\app"'
}

$dshHome = Resolve-DshHome -Explicit $DshHome
$appRoot = Resolve-AppRoot -Explicit $AppRoot
$profileDir = Join-Path $dshHome "profiles\$Profile"
$cli = Join-Path $appRoot 'node_modules\@deepseek-ai\dsh\lib\bin.js'
Write-Step "plugin   : $pluginRoot"
Write-Step "dsh home : $dshHome"
Write-Step "app root : $appRoot"
Write-Step "profile  : $Profile ($profileDir)"

if (-not (Test-Path -LiteralPath $profileDir)) {
    Write-Step "profile directory does not exist yet; the dsh CLI will create it"
}

# ---------------------------------------------------------------------- build
if ($NoBuild) {
    Write-Step 'skipping the sidecar build (-NoBuild)'
} else {
    Write-Step 'building the sidecar (in-box C# compiler, no SDK required)'
    $buildCode = Invoke-Native -FilePath 'powershell.exe' -Arguments @(
        '-NoProfile', '-ExecutionPolicy', 'Bypass',
        '-File', (Join-Path $pluginRoot 'sidecar\build.ps1'), '-Force'
    )
    if ($buildCode -ne 0) { throw 'the sidecar build failed' }
    if (-not (Test-Path -LiteralPath (Join-Path $pluginRoot 'sidecar\UiaSidecar.exe'))) { throw 'the sidecar build produced no executable' }
}

# ---------------------------------------------------------------------- pnpm
$pnpm = Get-Command pnpm -ErrorAction SilentlyContinue
if (-not $pnpm) {
    $desktopBin = Join-Path $dshHome '.desktop-bin'
    if (Test-Path -LiteralPath (Join-Path $desktopBin 'pnpm.cmd')) {
        $env:PATH = "$desktopBin;$env:PATH"
        $pnpm = Get-Command pnpm -ErrorAction SilentlyContinue
    }
}
if (-not $pnpm) { throw 'pnpm is not on PATH; install pnpm or run the DSH desktop app once so it provisions .desktop-bin' }

$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) { throw 'node is not on PATH; install Node.js 20+ (the DSH app also ships one under node_modules\node)' }

# -------------------------------------------------------------------- manifest
$manifestPath = Join-Path $profileDir 'package.json'
if (Test-Path -LiteralPath $manifestPath) {
    $backup = "$manifestPath.before-dsh-desktop-uia"
    Copy-Item -LiteralPath $manifestPath -Destination $backup -Force
    Write-Step "backed up: $backup"
}

# ---------------------------------------------------------------------- install
# `file:` rather than `link:` on purpose. pnpm copies the package into the
# profile's own node_modules, so Node resolves this plugin's imports of harness
# packages (`@deepseek-ai/dsh-tools`) through the profile chain
# (profiles/web/node_modules -> profiles/node_modules -> @deepseek-ai/*).
# A `link:` install would leave the module at its original path, where none of
# those packages exist, and DSH would fail to boot with ERR_MODULE_NOT_FOUND.
#
# `dsh plugin --profile <name> add <path>` also works when the plugin folder path
# contains no spaces; it is skipped here because it forwards arguments through a
# shell, which would split a path like "ds harness".
$spec = "file:$($pluginRoot -replace '\\', '/')"
Push-Location -LiteralPath $profileDir
try {
    # Remove first: `pnpm add` on an already-listed local dependency can decide
    # nothing needs to happen and leave a missing or stale entry behind, so every
    # install starts from a clean slate. A missing package is not an error.
    Write-Step "pnpm remove $packageName (ignored when not installed)"
    $null = Invoke-Native -FilePath $pnpm.Source -Arguments @('remove', $packageName, '--silent') -Quiet
    Write-Step "pnpm add $spec"
    $exitCode = Invoke-Native -FilePath $pnpm.Source -Arguments @('add', $spec) -Quiet
} finally {
    Pop-Location
}
if ($exitCode -ne 0) {
    Write-Problem "pnpm add failed with exit code $exitCode"
    throw 'installation failed; the profile manifest backup above is untouched'
}
if (-not (Test-Path -LiteralPath (Join-Path $profileDir "node_modules\$packageName\package.json"))) {
    Write-Step 'the package entry is missing; running pnpm install to repair the profile tree'
    Push-Location -LiteralPath $profileDir
    try {
        $null = Invoke-Native -FilePath $pnpm.Source -Arguments @('install') -Quiet
    } finally {
        Pop-Location
    }
}

if (Test-Path -LiteralPath $manifestPath) {
    $manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
    $bundles = @($manifest.dsh.profile.bundles)
    if ($bundles -notcontains $packageName) {
        Write-Step 'adding the plugin to the profile bundle layer list'
        $manifest.dsh.profile.bundles = @($bundles) + $packageName
        # Written without a BOM on purpose: the harness parses this manifest with
        # JSON.parse, which rejects a leading BOM, and Set-Content -Encoding UTF8
        # adds exactly that.
        $json = $manifest | ConvertTo-Json -Depth 20
        [System.IO.File]::WriteAllText($manifestPath, $json, (New-Object System.Text.UTF8Encoding($false)))
    } else {
        Write-Step 'the profile bundle layer list already names the plugin'
    }
    # The harness reads this file with JSON.parse, so verify it stayed clean.
    try {
        $null = (Get-Content -LiteralPath $manifestPath -Raw) | ConvertFrom-Json
    } catch {
        throw "the profile manifest is no longer valid JSON: $($_.Exception.Message)"
    }
}

# ---------------------------------------------------------------------- verify
$manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
$dependencies = $manifest.dependencies.PSObject.Properties.Name
$bundles = @($manifest.dsh.profile.bundles)
$linked = Test-Path -LiteralPath (Join-Path $profileDir "node_modules\$packageName\package.json")
Write-Step "dependency recorded : $($dependencies -contains $packageName)"
Write-Step "bundle layer recorded: $($bundles -contains $packageName)"
Write-Step "linked into profile  : $linked"
if (-not ($dependencies -contains $packageName) -or -not ($bundles -contains $packageName) -or -not $linked) {
    Write-Problem 'the profile manifest does not look right; inspect it before restarting DSH'
    throw 'post-install verification failed'
}

if (-not $SkipDoctor) {
    Write-Step 'running the plugin doctor (no DSH required)'
    $doctorCode = Invoke-Native -FilePath $node.Source -Arguments @((Join-Path $pluginRoot 'scripts\doctor.mjs'))
    if ($doctorCode -ne 0) { Write-Host '[install] the doctor reported problems; see the output above' -ForegroundColor Yellow }
}

Write-Host ''
Write-Host '[install] done.' -ForegroundColor Green
Write-Host 'Restart DSH Desktop (or reload the profile) so the host half mounts and the desktop_* tools appear.'
Write-Host 'The panel lives at Settings -> Desktop control.'
