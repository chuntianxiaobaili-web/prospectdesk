[CmdletBinding()]
param(
    [ValidateSet('chromium', 'chrome', 'msedge')]
    [string]$Browser = 'chromium',
    [string]$DataDir = (Join-Path $env:LOCALAPPDATA 'B2BSalesHarness')
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

if ($env:OS -ne 'Windows_NT') { throw 'This launcher is for Windows only.' }
$Root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$DataDir = [IO.Path]::GetFullPath($DataDir)
$Entry = Join-Path $Root 'src\local-app.js'
$Node = Get-Command node.exe -ErrorAction SilentlyContinue
if (-not $Node) { throw 'Install Node.js 22 or later, then reopen PowerShell.' }
$NodeMajor = & $Node.Source -p 'Number(process.versions.node.split(".")[0])'
if ($LASTEXITCODE -ne 0 -or [int]$NodeMajor -lt 22) { throw 'Node.js 22 or later is required.' }
if (-not (Test-Path -LiteralPath $Entry)) { throw 'src/local-app.js is missing. Use the complete v0.2 package.' }
if (-not (Test-Path -LiteralPath (Join-Path $Root 'node_modules\playwright\package.json'))) {
    throw 'Dependencies are missing. Run windows\install.ps1 first.'
}
$Validator = Join-Path $Root 'src\validate-local-directory.js'
if (-not (Test-Path -LiteralPath $Validator)) { throw 'The read-only data-directory validator is missing. Use the complete v0.2 package.' }
& $Node.Source $Validator $DataDir
if ($LASTEXITCODE -ne 0) { throw 'Unsafe or unsupported data directory. No application files or browser downloads were written to it.' }
New-Item -ItemType Directory -Path $DataDir -Force | Out-Null
$env:PLAYWRIGHT_BROWSERS_PATH = Join-Path $DataDir 'browser-binaries'
Write-Host "Starting dedicated browser edition ($Browser). Data: $DataDir"
Write-Host 'A separate application profile is used; your normal Chrome/Edge profile is not attached.'
Write-Host 'Use the local controls to pause or take over. Ctrl+C stops this process; no global browser processes will be killed.'
Push-Location $Root
try {
    & $Node.Source $Entry --data-dir $DataDir --browser $Browser
    $Result = $LASTEXITCODE
} finally { Pop-Location }
if ($Result -ne 0) { throw "Local application exited with code $Result. Review the error above; do not delete profile/state locks while an instance is running." }
