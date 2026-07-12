param()
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $root
$runs = Join-Path $root 'runs'
New-Item -ItemType Directory -Path $runs -Force | Out-Null
$log = Join-Path $runs 'scheduler.log'
& npm.cmd run automation:prepare *>> $log
exit $LASTEXITCODE
