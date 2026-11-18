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
    (Join-Path $env:ProgramFiles 'Yandex\YandexBrowser\Application\browser.exe'),
    (Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'Yandex\YandexBrowser\Application\browser.exe')
  )
  $BrowserExecutable = $Candidates | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1
}
if (-not $BrowserExecutable) { throw 'Set -BrowserExecutable to the installed yandex executable path.' }
$LaunchArguments = @($EntryFile, $CommandName, '--browser', 'yandex', '--data-directory', $DataDirectory, '--url', $Url, '--executable-path', $BrowserExecutable)
& $NodeExecutable @LaunchArguments
exit $LASTEXITCODE
