# Runs the bot once: waits for the network, appends output to logs\YYYY-MM-DD.log,
# retries once if nothing was sent, and shows a Windows notification with the result.
# Used by the "TikTok Streak" scheduled task (see install-task.ps1).
param([switch]$DryRun)

Set-Location -LiteralPath $PSScriptRoot
New-Item -ItemType Directory -Force -Path (Join-Path $PSScriptRoot "logs") | Out-Null
$log = Join-Path $PSScriptRoot ("logs\" + (Get-Date -Format "yyyy-MM-dd") + ".log")

function Write-Log($text) { Add-Content -LiteralPath $log -Value $text -Encoding UTF8 }

function Show-Toast($title, $text) {
  try {
    [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
    [Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null
    $xml = New-Object Windows.Data.Xml.Dom.XmlDocument
    $t = [Security.SecurityElement]::Escape($title)
    $b = [Security.SecurityElement]::Escape($text)
    $xml.LoadXml("<toast><visual><binding template='ToastGeneric'><text>$t</text><text>$b</text></binding></visual></toast>")
    $appId = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\WindowsPowerShell\v1.0\powershell.exe'
    [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($appId).Show([Windows.UI.Notifications.ToastNotification]::new($xml))
  } catch {}
}


# Discord webhook from config.local.json ("discordWebhook"), kept out of git. Posts one embed per run.
function Send-Discord($embed) {
  try {
    $localCfg = Join-Path $PSScriptRoot "config.local.json"
    if (-not (Test-Path $localCfg)) { return }
    $url = ([IO.File]::ReadAllText($localCfg, [Text.Encoding]::UTF8) | ConvertFrom-Json).discordWebhook
    if (-not $url) { return }
    $json = @{ username = "TikTok Streak"; embeds = @($embed) } | ConvertTo-Json -Depth 6 -Compress
    Invoke-RestMethod -Uri $url -Method Post -ContentType "application/json; charset=utf-8" `
      -Body ([Text.Encoding]::UTF8.GetBytes($json)) -TimeoutSec 20 | Out-Null
  } catch {
    Write-Log "Discord webhook failed: $($_.Exception.Message)"
  }
}

function Escape-Md($text) { return ($text -replace '([\*_~`|>])', '\$1') }

$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { $node = "C:\Program Files\nodejs\node.exe" }
$nodeArgs = "index.js"
if ($DryRun) { $nodeArgs = "index.js --debug --dry-run" }
$started = Get-Date

# After waking from sleep the network can take a moment to come up.
for ($i = 0; $i -lt 12; $i++) {
  try { Invoke-WebRequest "https://www.tiktok.com" -Method Head -UseBasicParsing -TimeoutSec 10 | Out-Null; break }
  catch { Start-Sleep -Seconds 10 }
}

$code = 1
$report = $null
$scriptError = $null
$attempts = 0
try {
  for ($attempt = 1; $attempt -le 2; $attempt++) {
    $attempts = $attempt
    Write-Log "===== $(Get-Date -Format s) attempt $attempt ====="
    $before = @(Get-Content -LiteralPath $log -Encoding UTF8).Count
    # cmd redirection keeps node's UTF-8 output intact (nicknames with Vietnamese/emoji)
    $env:NO_COLOR = "1"
    cmd /c "`"$node`" $nodeArgs >> `"$log`" 2>&1"
    $code = $LASTEXITCODE
    $line = Get-Content -LiteralPath $log -Encoding UTF8 | Select-Object -Skip $before | Where-Object { $_ -like "REPORT *" } | Select-Object -Last 1
    $report = if ($line) { $line.Substring(7) | ConvertFrom-Json } else { $null }
    # Only retry when nothing at all was sent, so a retry never double-messages anyone.
    if ($code -eq 0 -or ($report -and $report.success -gt 0)) { break }
    Start-Sleep -Seconds 60
  }
} catch {
  $code = 1
  $scriptError = $_.Exception.Message
}

# ---- Build the notification ----
$logName = "logs\$(Get-Date -Format yyyy-MM-dd).log"
$duration = [int]((Get-Date) - $started).TotalSeconds
if ($report) {
  $total = [int]$report.total; $ok = [int]$report.success; $bad = [int]$report.failed
  $summary = if ($report.dryRun) { "$ok/$total typed (dry run)" } else { "$([int]$report.verified)/$total delivered" }
} else {
  $total = 0; $ok = 0; $bad = 0
  $summary = "Bot did not report a result"
}

if ($code -eq 0 -and $report -and $report.dryRun) { $status = "Dry run passed"; $color = 3447003 }      # blue
elseif ($code -eq 0) { $status = "Streaks sent"; $color = 3066993 }                                    # green
elseif ($ok -gt 0) { $status = "Partially sent"; $color = 15105570 }                                   # orange
else { $status = "Failed"; $color = 15158332 }                                                         # red

$rows = @()
if ($report) {
  foreach ($r in $report.results) {
    $name = Escape-Md $r.name
    switch ($r.status) {
      "verified" { $rows += ":white_check_mark: **$name**: delivered" }
      "sent"     { $rows += ":ballot_box_with_check: **$name**: sent" }
      "dry"      { $rows += ":test_tube: **$name**: typed, not sent" }
      default    { $rows += ":x: **$name**: $(Escape-Md $r.detail)" }
    }
  }
}
$description = ($rows -join "`n")
if ($report -and $report.fatal) { $description += "`n`n**Error:** $(Escape-Md $report.fatal)" }
if ($scriptError) { $description += "`n`n**run.ps1 error:** $(Escape-Md $scriptError)" }
if (-not $description) { $description = "No details. Check the log on the PC." }
if ($description.Length -gt 3900) { $description = $description.Substring(0, 3900) + "`n..." }

$message = if ($report) { $report.message } else { "-" }
$embed = @{
  title       = "TikTok Streak: $status"
  description = $description
  color       = $color
  fields      = @(
    @{ name = "Result";   value = $summary;                         inline = $true },
    @{ name = "Message";  value = "$message";                       inline = $true },
    @{ name = "Duration"; value = "${duration}s, $attempts attempt(s)"; inline = $true }
  )
  footer      = @{ text = "$env:COMPUTERNAME | $logName" }
  timestamp   = (Get-Date).ToUniversalTime().ToString("o")
}

if ($code -eq 0) { Show-Toast "TikTok Streak: $status" $summary }
else { Show-Toast "TikTok Streak: $status" "$summary - see $logName" }
Send-Discord $embed
exit $code
