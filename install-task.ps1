# Registers a daily Windows scheduled task "TikTok Streak" that runs run.ps1.
#   powershell -ExecutionPolicy Bypass -File install-task.ps1              # daily at 06:00
#   powershell -ExecutionPolicy Bypass -File install-task.ps1 -At 07:30   # another time
#   powershell -ExecutionPolicy Bypass -File install-task.ps1 -DryRun     # schedule a dry run (nothing sent)
# Remove it with: Unregister-ScheduledTask -TaskName "TikTok Streak" -Confirm:$false
param([string]$At = "06:00", [switch]$DryRun)

$script = Join-Path $PSScriptRoot "run.ps1"
$arg = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$script`""
if ($DryRun) { $arg += " -DryRun" }

$action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument $arg -WorkingDirectory $PSScriptRoot
$trigger = New-ScheduledTaskTrigger -Daily -At $At
# WakeToRun: wake the PC from sleep. StartWhenAvailable: run later if 06:00 was missed (PC off / signed out).
$settings = New-ScheduledTaskSettingsSet -WakeToRun -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -ExecutionTimeLimit (New-TimeSpan -Minutes 20) -MultipleInstances IgnoreNew
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited

Register-ScheduledTask -TaskName "TikTok Streak" -Action $action -Trigger $trigger -Settings $settings -Principal $principal `
  -Description "Sends TikTok streak messages (Desktop\tiktok\run.ps1)" -Force | Out-Null

$task = Get-ScheduledTask -TaskName "TikTok Streak"
$info = Get-ScheduledTaskInfo -TaskName "TikTok Streak"
Write-Host "Registered '$($task.TaskName)' ($($task.State)), next run: $($info.NextRunTime)$(if ($DryRun) { ' [dry run]' })"
