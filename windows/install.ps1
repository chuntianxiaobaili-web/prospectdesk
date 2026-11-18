[CmdletBinding()]
param(
    [ValidateSet('chromium', 'chrome', 'msedge')]
    [string]$Browser = 'chromium',
    [string]$DataDir = (Join-Path $env:LOCALAPPDATA 'B2BSalesHarness')
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

if ($env:OS -ne 'Windows_NT') { throw 'This installer is for Windows only.' }
$Root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$DataDir = [IO.Path]::GetFullPath($DataDir)
$Node = Get-Command node.exe -ErrorAction SilentlyContinue
$Npm = Get-Command npm.cmd -ErrorAction SilentlyContinue
if (-not $Node -or -not $Npm) { throw 'Install Node.js 22 or later (including npm), then reopen PowerShell.' }
$NodeMajor = & $Node.Source -p 'Number(process.versions.node.split(".")[0])'
if ($LASTEXITCODE -ne 0 -or [int]$NodeMajor -lt 22) { throw 'Node.js 22 or later is required.' }
if (-not (Test-Path -LiteralPath (Join-Path $Root 'package-lock.json'))) {
    throw 'package-lock.json is missing. Use the complete v0.2 package; no unpinned dependency installation was attempted.'
}
$Validator = Join-Path $Root 'src\validate-local-directory.js'
if (-not (Test-Path -LiteralPath $Validator)) { throw 'The read-only data-directory validator is missing. Use the complete v0.2 package.' }
& $Node.Source $Validator $DataDir
if ($LASTEXITCODE -ne 0) { throw 'Unsafe or unsupported data directory. No application files or browser downloads were written to it.' }
New-Item -ItemType Directory -Path $DataDir -Force | Out-Null
$env:PLAYWRIGHT_BROWSERS_PATH = Join-Path $DataDir 'browser-binaries'

Push-Location $Root
try {
    Write-Host 'Installing the exact dependency lock. No administrator privileges or execution-policy changes are used.'
    & $Npm.Source ci --ignore-scripts --no-audit --no-fund
    if ($LASTEXITCODE -ne 0) { throw "npm ci failed with exit code $LASTEXITCODE." }
    if ($Browser -eq 'chromium') {
        $Playwright = Join-Path $Root 'node_modules\.bin\playwright.cmd'
        if (-not (Test-Path -LiteralPath $Playwright)) { throw 'The locked Playwright dependency was not installed.' }
        Write-Host 'Downloading the matching Chromium build into this application data directory only.'
        & $Playwright install chromium
        if ($LASTEXITCODE -ne 0) { throw "Chromium installation failed with exit code $LASTEXITCODE. No alternate download or policy bypass was attempted." }
    } else {
        Write-Host "Selected installed browser channel: $Browser. This installer does not install, replace, or update your regular browser."
    }
} finally { Pop-Location }

$Python = Get-Command python.exe -ErrorAction SilentlyContinue
if ($Python -and $Python.Source -notmatch '[\\/]WindowsApps[\\/]') {
    & $Python.Source -c 'import openpyxl; print("Optional Excel support available: openpyxl " + openpyxl.__version__)'
    if ($LASTEXITCODE -ne 0) { Write-Warning 'Optional XLSX support is unavailable. Install Python/openpyxl separately if needed. CSV and browser operation do not require it.' }
} else {
    Write-Warning 'Python was not found. XLSX operations require Python/openpyxl; CSV and browser operation do not require it.'
}
Write-Host 'Installed. Start with windows\start.ps1, using the same -DataDir and -Browser values.'
Write-Host 'This package includes only a synthetic mock webmail adapter. Installing it does not send mail or connect an account.'
