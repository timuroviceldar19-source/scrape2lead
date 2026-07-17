param(
  [string]$TaskName = 'Scrape2Lead Daily Prepare',
  [string]$At = '10:00',
  [string]$ConfigPath = 'config/automation.json',
  [string]$LogPath = 'runs/scheduler.log',
  [string]$Description = 'Prepare and push Scrape2Lead GZ plans/lots to Bitrix (AI analysis stays manual)'
)
$ErrorActionPreference = 'Stop'
$runner = Join-Path $PSScriptRoot 'run-automation.ps1'
if (-not (Test-Path -LiteralPath $runner)) { throw "Runner not found: $runner" }
$arguments = "-NoProfile -ExecutionPolicy Bypass -File `"$runner`" -ConfigPath `"$ConfigPath`" -LogPath `"$LogPath`""
$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument $arguments
$trigger = New-ScheduledTaskTrigger -Daily -At $At
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Hours 6)
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Description $Description -Force | Out-Null
Get-ScheduledTask -TaskName $TaskName | Select-Object TaskName, State
