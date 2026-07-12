param(
  [string]$TaskName = 'Scrape2Lead Daily Prepare',
  [string]$At = '10:00'
)
$ErrorActionPreference = 'Stop'
$runner = Join-Path $PSScriptRoot 'run-automation-prepare.ps1'
if (-not (Test-Path -LiteralPath $runner)) { throw "Runner not found: $runner" }
$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$runner`""
$trigger = New-ScheduledTaskTrigger -Daily -At $At
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Hours 6)
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Description 'Prepare Scrape2Lead GZ plans/lots for manual Bitrix approval' -Force | Out-Null
Get-ScheduledTask -TaskName $TaskName | Select-Object TaskName, State
