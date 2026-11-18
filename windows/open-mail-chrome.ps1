param(
  [string]$DataDirectory = (Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'FSARCAN\BrowserMailController'),
  [string]$Url = 'about:blank',
  [string]$NodeExecutable = 'node',
  [string]$BrowserExecutable = '',
  [switch]$Probe
)
$ErrorActionPreference = 'Stop'
$PackageRoot = Split-Path -Parent $PSScriptRoot
$EntryFile = Join-Path $PackageRoot 'src\browser-mail\desktop-cli.mjs'
$CommandName = if ($Probe) { 'probe' } else { 'open' }
if (-not $BrowserExecutable) {
  $Candidates = @(
    (Join-Path $env:ProgramFiles 'Google\Chrome\Application\chrome.exe'),
    (Join-Path ([Environment]::GetFolderPath('ProgramFilesX86')) 'Google\Chrome\Application\chrome.exe'),
    (Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'Google\Chrome\Application\chrome.exe')
  )
  $BrowserExecutable = $Candidates | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1
}
if (-not $BrowserExecutable) { throw 'Set -BrowserExecutable to the installed chrome executable path.' }
$LaunchArguments = @($EntryFile, $CommandName, '--browser', 'chrome', '--data-directory', $DataDirectory, '--url', $Url, '--executable-path', $BrowserExecutable)
& $NodeExecutable @LaunchArguments
exit $LASTEXITCODE
