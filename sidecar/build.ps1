# Build UiaSidecar.exe with the C# compiler that ships inside Windows.
#
# No .NET SDK, no NuGet, no MSVC: the in-box .NET Framework compiler plus the
# framework's own UI Automation assemblies are all this needs. The result is a
# single self-contained exe that runs on any Windows 10/11 with .NET Framework
# 4.x present (which is every supported Windows).
#
# Usage:
#   pwsh -File sidecar/build.ps1              # build
#   pwsh -File sidecar/build.ps1 -SelfTest    # build, then run the built-in self-test
[CmdletBinding()]
param(
    [switch]$SelfTest,
    [switch]$Force,
    [string]$Configuration = 'Release'
)

$ErrorActionPreference = 'Stop'
$sidecarDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$rootDir = Split-Path -Parent $sidecarDir
$exePath = Join-Path $sidecarDir 'UiaSidecar.exe'
$manifestPath = Join-Path $sidecarDir 'UiaSidecar.manifest'
$sources = @(
    (Join-Path $sidecarDir 'Program.cs'),
    (Join-Path $sidecarDir 'UiaSidecar.cs')
)

function Write-Step([string]$message) { Write-Host "[build] $message" }
function Write-Warn2([string]$message) { Write-Warning "[build] $message" }

foreach ($source in $sources) {
    if (-not (Test-Path -LiteralPath $source)) { throw "missing source file: $source" }
}
if (-not (Test-Path -LiteralPath $manifestPath)) { throw "missing manifest: $manifestPath" }

function Find-Compiler {
    $candidates = @(
        (Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'),
        (Join-Path $env:WINDIR 'Microsoft.NET\Framework\v4.0.30319\csc.exe')
    )
    foreach ($candidate in $candidates) {
        if ($candidate -and (Test-Path -LiteralPath $candidate)) { return $candidate }
    }
    $onPath = Get-Command csc.exe -ErrorAction SilentlyContinue
    if ($onPath) { return $onPath.Source }
    throw 'no C# compiler found: expected the in-box .NET Framework csc.exe under %WINDIR%\Microsoft.NET\Framework64\v4.0.30319'
}

function Resolve-Assembly([string]$simpleName) {
    # Prefer reference assemblies when a targeting pack is installed, then fall
    # back to the GAC copy that is present on every .NET Framework install.
    $refRoots = @(
        (Join-Path ${env:ProgramFiles(x86)} 'Reference Assemblies\Microsoft\Framework\.NETFramework'),
        (Join-Path $env:ProgramFiles 'Reference Assemblies\Microsoft\Framework\.NETFramework')
    )
    foreach ($refRoot in $refRoots) {
        if (-not $refRoot -or -not (Test-Path -LiteralPath $refRoot)) { continue }
        $versions = Get-ChildItem -LiteralPath $refRoot -Directory -ErrorAction SilentlyContinue |
            Where-Object { $_.Name -like 'v4*' } | Sort-Object Name -Descending
        foreach ($version in $versions) {
            $candidate = Join-Path $version.FullName "$simpleName.dll"
            if (Test-Path -LiteralPath $candidate) { return $candidate }
        }
    }
    $gacRoot = Join-Path $env:WINDIR 'Microsoft.NET\assembly\GAC_MSIL'
    $gacDir = Join-Path $gacRoot $simpleName
    if (Test-Path -LiteralPath $gacDir) {
        $found = Get-ChildItem -LiteralPath $gacDir -Recurse -Filter "$simpleName.dll" -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($found) { return $found.FullName }
    }
    throw "cannot locate $simpleName.dll: the .NET Framework UI Automation assemblies are missing. Install the .NET Framework 4.x or enable the Windows 'UI Automation' feature."
}

function Get-Platform {
    if ([Environment]::Is64BitOperatingSystem) { return 'x64' }
    return 'x86'
}

function Get-SourceFingerprint {
    $builder = New-Object System.Text.StringBuilder
    foreach ($source in ($sources | Sort-Object)) {
        $info = Get-Item -LiteralPath $source
        [void]$builder.Append($info.Name).Append(':').Append($info.Length).Append(';')
    }
    return $builder.ToString()
}

$compiler = Find-Compiler
$uiaClient = Resolve-Assembly 'UIAutomationClient'
$uiaTypes = Resolve-Assembly 'UIAutomationTypes'
$windowsBase = Resolve-Assembly 'WindowsBase'
$platform = Get-Platform

Write-Step "compiler  : $compiler"
Write-Step "assemblies: UIAutomationClient / UIAutomationTypes / WindowsBase resolved"
Write-Step "platform  : $platform"

$needsBuild = $Force.IsPresent -or -not (Test-Path -LiteralPath $exePath)
$stampPath = Join-Path $sidecarDir 'build-info.json'
if (-not $needsBuild) {
    $fingerprint = Get-SourceFingerprint
    if (Test-Path -LiteralPath $stampPath) {
        try {
            $stamp = Get-Content -LiteralPath $stampPath -Raw | ConvertFrom-Json
            if ($stamp.fingerprint -ne $fingerprint -or $stamp.platform -ne $platform) { $needsBuild = $true }
        } catch { $needsBuild = $true }
    } else {
        $needsBuild = $true
    }
}

if (-not $needsBuild) {
    Write-Step "up to date : $exePath"
} else {
    $tmpExe = "$exePath.tmp"
    if (Test-Path -LiteralPath $tmpExe) { Remove-Item -LiteralPath $tmpExe -Force }

    $arguments = @(
        '/nologo',
        '/target:exe',
        "/platform:$platform",
        '/optimize+',
        '/warnaserror-',
        '/codepage:65001',
        "/win32manifest:$manifestPath",
        "/out:$tmpExe",
        "/r:$uiaClient",
        "/r:$uiaTypes",
        "/r:$windowsBase"
    )
    if ($Configuration -eq 'Debug') { $arguments += '/debug+'; $arguments += '/define:DEBUG' }
    else { $arguments += '/debug-'; $arguments += '/define:RELEASE' }
    $arguments += $sources

    Write-Step 'compiling...'
    $compilerOutput = & $compiler @arguments 2>&1
    $exitCode = $LASTEXITCODE
    if ($compilerOutput) { $compilerOutput | ForEach-Object { Write-Host "  $_" } }
    if ($exitCode -ne 0) {
        if (Test-Path -LiteralPath $tmpExe) { Remove-Item -LiteralPath $tmpExe -Force }
        throw "compilation failed with exit code $exitCode"
    }
    if (-not (Test-Path -LiteralPath $tmpExe)) { throw 'compiler reported success but produced no output' }

    if (Test-Path -LiteralPath $exePath) {
        # A running sidecar would hold the old image open; retry briefly.
        $moved = $false
        for ($attempt = 0; $attempt -lt 10 -and -not $moved; $attempt++) {
            try { Move-Item -LiteralPath $tmpExe -Destination $exePath -Force; $moved = $true }
            catch { Start-Sleep -Milliseconds 150 }
        }
        if (-not $moved) { throw "cannot replace $exePath - stop DSH (or the sidecar) and build again" }
    } else {
        Move-Item -LiteralPath $tmpExe -Destination $exePath -Force
    }

    $info = Get-Item -LiteralPath $exePath
    $stamp = [ordered]@{
        builtAt     = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
        compiler    = (& $compiler 2>&1 | Select-Object -First 1)
        platform    = $platform
        configuration = $Configuration
        bytes       = $info.Length
        fingerprint = (Get-SourceFingerprint)
    }
    $stampJson = $stamp | ConvertTo-Json
    [System.IO.File]::WriteAllText($stampPath, $stampJson, (New-Object System.Text.UTF8Encoding($false)))
    Write-Step "built      : $exePath ($($info.Length) bytes)"
}

if ($SelfTest) {
    Write-Step 'running self-test...'
    $output = & $exePath --selftest 2>&1
    $exitCode = $LASTEXITCODE
    $output | ForEach-Object { Write-Host "  $_" }
    if ($exitCode -ne 0) { throw "self-test failed with exit code $exitCode" }
    Write-Step 'self-test passed'
}

Write-Step 'done'
