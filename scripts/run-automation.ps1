param(
  [string]$ConfigPath = 'config/automation.json',
  [string]$LogPath = 'runs/scheduler.log'
)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $root
$log = if ([System.IO.Path]::IsPathRooted($LogPath)) { $LogPath } else { Join-Path $root $LogPath }
New-Item -ItemType Directory -Path (Split-Path -Parent $log) -Force | Out-Null

# npm writes warnings to stderr even on success. Under 'Stop' PowerShell turns
# those into a NativeCommandError and the task reports failure for a run that
# actually pushed, so stderr is collected as plain text instead.
$ErrorActionPreference = 'Continue'
& npm.cmd run automation:run -- --config $ConfigPath 2>&1 |
  ForEach-Object { if ($_ -is [System.Management.Automation.ErrorRecord]) { $_.Exception.Message } else { $_ } } |
  Out-File -LiteralPath $log -Append -Encoding utf8
$code = $LASTEXITCODE
$ErrorActionPreference = 'Stop'

$stamp = (Get-Date).ToString('o')
$status = if ($code -eq 0) { 'pushed' } else { 'failed' }
Add-Content -LiteralPath $log -Value "$stamp scheduler automation:run status=$status exit=$code config=$ConfigPath" -Encoding utf8
exit $code
