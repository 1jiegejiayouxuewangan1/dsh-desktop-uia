<#
.SYNOPSIS
  Publish this package to npm, with the preflight checks that make it safe.

.DESCRIPTION
  Everything npm needs lives in package.json; this script is the guard rail
  around the publish itself:

    1. finds an npm CLI -- a real one on PATH, or a scratch copy it installs
       itself with pnpm, because the DSH desktop runtime ships no npm at all;
    2. refuses to publish from a dirty or unpushed working tree;
    3. refuses to publish a version that is already on the registry;
    4. runs the test suite unless -SkipTests;
    5. packs and verifies the tarball still carries the compiled sidecar,
       cordis.patch.yml and the host half;
    6. checks the npm login and prints exactly what to do when there is none;
    7. publishes, then reads the version back from the registry.

  No token is ever read, printed or stored here: the script relies on the npm
  login already present in %USERPROFILE%\.npmrc.

.PARAMETER DryRun
  Run every check and the pack, but stop before publishing.

.PARAMETER SkipTests
  Skip the test suite (the slowest step).

.PARAMETER OTP
  One-time password, when the account publishes with 2FA enabled.

.PARAMETER Tag
  npm dist-tag to publish under. Default: latest.

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\publish-npm.ps1 -DryRun
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\publish-npm.ps1
#>
[CmdletBinding()]
param(
  [switch]$DryRun,
  [switch]$SkipTests,
  [string]$OTP,
  [string]$Tag = 'latest'
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
Set-Location $root

function Say([string]$message, [string]$colour = 'Gray') {
  Write-Host $message -ForegroundColor $colour
}
function Fail([string]$message) {
  Say "FAIL: $message" 'Red'
  exit 1
}

# Native tools write warnings to stderr; that must not abort the script.
function Invoke-Native([string]$command, [string[]]$arguments) {
  $previous = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    $output = & $command @arguments 2>&1
    $script:nativeExit = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $previous
  }
  return @($output | Where-Object { $_ -notmatch 'Unknown env config' })
}

# ------------------------------------------------------------------ npm CLI
$scratch = Join-Path $env:TEMP 'npmcli'
$scratchCli = Join-Path $scratch 'node_modules\npm\bin\npm-cli.js'
$npmCommand = $null
$npmPrefix = @()

$onPath = Get-Command npm -ErrorAction SilentlyContinue
if ($onPath) {
  $npmCommand = 'npm'
  Say "npm: $($onPath.Source)"
} elseif (Test-Path $scratchCli) {
  $npmCommand = 'node'
  $npmPrefix = @($scratchCli)
  Say "npm: scratch copy at $scratchCli"
} else {
  Say 'no npm CLI found; installing a scratch copy with pnpm (nothing system-wide changes)' 'Yellow'
  New-Item -ItemType Directory -Force $scratch | Out-Null
  Set-Content -Path (Join-Path $scratch 'package.json') -Value '{"name":"npmcli-scratch","private":true,"version":"0.0.0"}' -Encoding ASCII
  $install = Invoke-Native 'pnpm' @('--dir', $scratch, 'add', 'npm')
  if (-not (Test-Path $scratchCli)) { Fail "could not install an npm CLI: $($install -join ' | ')" }
  $npmCommand = 'node'
  $npmPrefix = @($scratchCli)
  Say "npm: scratch copy installed at $scratchCli"
}

function Invoke-Npm([string[]]$arguments) {
  return Invoke-Native $npmCommand (@($npmPrefix) + $arguments)
}

Say "npm version: $((Invoke-Npm @('--version') | Select-Object -First 1))"

function Invoke-Git([string[]]$arguments) {
  if (-not $script:gitCommand) { return @() }
  return Invoke-Native $script:gitCommand $arguments
}

# Git is not always on PATH (GitHub Desktop ships its own copy), and the
# working-tree guard is worth having, so look in the usual places too.
$script:gitCommand = $null
$gitOnPath = Get-Command git -ErrorAction SilentlyContinue
if ($gitOnPath) {
  $script:gitCommand = $gitOnPath.Source
} else {
  $candidates = @()
  foreach ($glob in @(
    (Join-Path $env:LOCALAPPDATA 'GitHubDesktop\app-*\resources\app\git\cmd\git.exe'),
    (Join-Path $env:ProgramFiles 'Git\cmd\git.exe'),
    (Join-Path ${env:ProgramFiles(x86)} 'Git\cmd\git.exe')
  )) {
    if ($glob) { $candidates += @(Get-ChildItem $glob -ErrorAction SilentlyContinue) }
  }
  $best = $candidates | Sort-Object LastWriteTime -Descending | Select-Object -First 1
  if ($best) { $script:gitCommand = $best.FullName }
}

# ---------------------------------------------------------------- the package
$pkg = [System.IO.File]::ReadAllText((Join-Path $root 'package.json'), [System.Text.Encoding]::UTF8) | ConvertFrom-Json
$name = $pkg.name
$version = $pkg.version
# The publish target comes from package.json, so a mirror configured in the
# user's .npmrc can neither redirect a publish nor make the auth check ask the
# wrong server (a mirror answers "not logged in" for a perfectly good token).
$registry = if ($pkg.publishConfig.registry) { $pkg.publishConfig.registry } else { 'https://registry.npmjs.org/' }
$registry = $registry.TrimEnd('/')
Say ''
Say "package: $name@$version" 'Cyan'
Say "registry: $registry"
if (-not $pkg.dsh.bundle.patch) { Fail 'package.json must declare dsh.bundle.patch; a dsh.client-only manifest is not installable' }
if (-not $pkg.os -or ($pkg.os -notcontains 'win32')) { Say 'note: package.json does not restrict this package to win32' 'Yellow' }

# ------------------------------------------------------------- working tree
if ($script:gitCommand) {
  Say "git: $($script:gitCommand)"
  $dirty = Invoke-Git @('status', '--porcelain')
  if ($dirty.Count -gt 0) { Fail "the working tree has uncommitted changes; commit them so the published tarball matches a commit:`n$($dirty -join "`n")" }
  $head = (Invoke-Git @('rev-parse', 'HEAD') | Select-Object -First 1)
  $branch = (Invoke-Git @('rev-parse', '--abbrev-ref', 'HEAD') | Select-Object -First 1)
  $remote = (Invoke-Git @('rev-parse', "origin/$branch") | Select-Object -First 1)
  if ($head -and $remote -and $head -ne $remote) { Fail "HEAD ($($head.Substring(0, 7))) is not pushed; the npm page links back to the repository, so push first" }
  Say "git: clean at $($head.Substring(0, 7)) on $branch"
} else {
  Say 'note: no git found; skipping the dirty-tree and pushed-HEAD checks' 'Yellow'
}

# -------------------------------------------------------- registry preflight
$published = $null
try {
  $published = (Invoke-RestMethod -Uri "$registry/$name" -TimeoutSec 30 -ErrorAction Stop).'dist-tags'.latest
} catch {
  if ($_.Exception.Response.StatusCode.value__ -ne 404) { Say "note: could not read the registry: $($_.Exception.Message)" 'Yellow' }
}
if ($published -eq $version) { Fail "$name@$version is already published; bump the version first" }
Say "registry: latest is $(if ($published) { $published } else { '(nothing published yet)' }); this run would publish $version"

# ------------------------------------------------------------------- tests
if (-not $SkipTests) {
  Say ''
  Say 'running the test suite...'
  $test = Invoke-Native 'node' @('--import', './test/helpers/register.mjs', '--test', 'test/*.test.mjs')
  $test | Where-Object { $_ -match '(tests|pass|fail|skipped)\s+\d+' } | Select-Object -Last 4 | ForEach-Object { Say "  $($_.ToString().Trim())" }
  if ($script:nativeExit -ne 0) { Fail 'the test suite is red; publishing a red build is not worth it' }
}

# -------------------------------------------------------------------- pack
Say ''
Say 'packing...'
Remove-Item (Join-Path $root '*.tgz') -Force -ErrorAction SilentlyContinue
$packOutput = Invoke-Npm @('pack', '--silent')
$tgz = Get-ChildItem (Join-Path $root '*.tgz') | Sort-Object LastWriteTime | Select-Object -Last 1
if (-not $tgz) { Fail "pack failed: $($packOutput -join ' | ')" }
Say "packed: $($tgz.Name) ($([math]::Round($tgz.Length / 1KB, 1)) KB)"
$entries = Invoke-Native 'tar' @('-tzf', $tgz.FullName)
foreach ($required in @('package/lib/index.js', 'package/lib/client.js', 'package/sidecar/UiaSidecar.exe', 'package/cordis.patch.yml', 'package/LICENSE')) {
  if ($entries -notcontains $required) { Fail "the tarball is missing $required" }
}
Say "contents verified: $($entries.Count) entries, compiled sidecar present"

# -------------------------------------------------------------------- auth
Say ''
$who = Invoke-Npm @('whoami', '--registry', $registry)
if (($who -join ' ') -match 'ENEEDAUTH|need auth|E401') {
  Say 'Not logged in to npm. Do this once, then run this script again:' 'Yellow'
  Say '  1. create a free account at https://www.npmjs.com/signup and verify the email' 'Yellow'
  Say '  2. create an Automation token at https://www.npmjs.com/settings/~/tokens' 'Yellow'
  Say '  3. add one line to %USERPROFILE%\.npmrc (no quotes):' 'Yellow'
  Say '     //registry.npmjs.org/:_authToken=npm_xxxxxxxxxxxx' 'Yellow'
  Say '  or log in through the browser instead of handling a token:' 'Yellow'
  Say "     node `"$scratchCli`" login --auth-type=web --registry=https://registry.npmjs.org/" 'Yellow'
  if ($DryRun) { Say ''; Say 'DRY RUN: every other check passed.' 'Green'; exit 0 }
  Fail 'npm login is required'
}
Say "npm user: $($who | Select-Object -First 1)"

# ----------------------------------------------------------------- publish
if ($DryRun) {
  Say ''
  Say "DRY RUN: would run npm publish --access public --tag $Tag"
  Say 'DRY RUN: every preflight check passed.' 'Green'
  exit 0
}

Say ''
Say "publishing $name@$version ..." 'Cyan'
$publishArgs = @('publish', '--access', 'public', '--tag', $Tag, '--registry', $registry)
if ($OTP) { $publishArgs += @('--otp', $OTP) }
$result = Invoke-Npm $publishArgs
$result | Where-Object { $_ -match 'npm notice|npm error|^\+ ' } | ForEach-Object { Say "  $($_.ToString().Trim())" }
if ($script:nativeExit -ne 0) {
  $text = $result -join ' '
  if ($text -match 'Two-factor authentication or granular access token with bypass 2fa') {
    Say ''
    Say 'npm refused because a granular access token may only publish when it is allowed to bypass 2FA.' 'Yellow'
    Say 'This is npm policy even for an account without 2FA enabled. Three ways out, easiest first:' 'Yellow'
    Say ''
    Say '  A. log in through the browser (an interactive session may publish; no token settings to change):' 'Yellow'
    Say "     node `"$scratchCli`" login --auth-type=web --registry=$registry" 'Yellow'
    Say '     ...then run this script again.' 'Yellow'
    Say ''
    Say '  B. recreate the token with the bypass flag:' 'Yellow'
    Say '     npmjs.com -> Access Tokens -> Generate New Token -> Granular Access Token' 'Yellow'
    Say '     -> Packages and scopes: Read and write' 'Yellow'
    Say '     -> CHECK "Bypass two-factor authentication"' 'Yellow'
    Say '     ...then paste the new token into %USERPROFILE%\.npmrc as before.' 'Yellow'
    Say ''
    Say '  C. enable 2FA (Authorization and writes), then publish with a fresh code each time:' 'Yellow'
    Say '     powershell -ExecutionPolicy Bypass -File scripts\publish-npm.ps1 -OTP 123456' 'Yellow'
    Fail 'the token is not allowed to publish'
  }
  if ($text -match 'E403|403 Forbidden') {
    Say ''
    Say 'The registry refused the publish (403). Check that the token is not read-only and that the name is free:' 'Yellow'
    Say "  https://www.npmjs.com/package/$name" 'Yellow'
  }
  Fail "publish failed: $text"
}

$check = $null
try { $check = (Invoke-RestMethod -Uri "$registry/$name" -TimeoutSec 30).'dist-tags'.latest } catch { $check = $null }
Say ''
if ($check -eq $version) {
  Say "published: https://www.npmjs.com/package/$name/v/$version" 'Green'
  Say 'The marketplace links the package to the entry by itself; the download figure appears on its own.' 'Green'
  Say 'Keep the release tarball as the source of truth for dsh plugin add.' 'Gray'
} else {
  Say "published, but the registry still reports latest=$check; check https://www.npmjs.com/package/$name" 'Yellow'
}
