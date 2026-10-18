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

# Discord webhook from config.local.json ("discordWebhook"), kept out of git.
function Send-Discord($title, $lines) {
  try {
    $localCfg = Join-Path $PSScriptRoot "config.local.json"
    if (-not (Test-Path $localCfg)) { return }
    $url = ([IO.File]::ReadAllText($localCfg, [Text.Encoding]::UTF8) | ConvertFrom-Json).discordWebhook
    if (-not $url) { return }
    $body = "$title`n" + (($lines | Select-Object -First 40) -join "`n")
    if ($body.Length -gt 1900) { $body = $body.Substring(0, 1900) + "`n..." }
    $json = @{ username = "TikTok Streak"; content = $body } | ConvertTo-Json -Compress
    Invoke-RestMethod -Uri $url -Method Post -ContentType "application/json; charset=utf-8" `
      -Body ([Text.Encoding]::UTF8.GetBytes($json)) -TimeoutSec 20 | Out-Null
  } catch {
    Write-Log "Discord webhook failed: $($_.Exception.Message)"
  }
}

$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { $node = "C:\Program Files\nodejs\node.exe" }
$nodeArgs = "index.js"
if ($DryRun) { $nodeArgs = "index.js --debug --dry-run" }

# After waking from sleep the network can take a moment to come up.
for ($i = 0; $i -lt 12; $i++) {
  try { Invoke-WebRequest "https://www.tiktok.com" -Method Head -UseBasicParsing -TimeoutSec 10 | Out-Null; break }
  catch { Start-Sleep -Seconds 10 }
}

$result = $null
$code = 1
$details = @()
try {
  for ($attempt = 1; $attempt -le 2; $attempt++) {
    Write-Log "===== $(Get-Date -Format s) attempt $attempt ====="
    $before = @(Get-Content -LiteralPath $log -Encoding UTF8).Count
    # cmd redirection keeps node's UTF-8 output intact (nicknames with Vietnamese/emoji)
    $env:NO_COLOR = "1"
    cmd /c "`"$node`" $nodeArgs >> `"$log`" 2>&1"
    $code = $LASTEXITCODE
    $lines = @(Get-Content -LiteralPath $log -Encoding UTF8 | Select-Object -Skip $before)
    $result = $lines | Where-Object { $_ -like "RESULT *" } | Select-Object -Last 1
    if (-not $result) { $result = "RESULT sent=0 (bot crashed, no result line)" }
    $details += "**Attempt $attempt** (exit $code)"
    $details += $lines | Where-Object { $_ -match "Mengirim pesan|Terkirim|Dry run:|Verified|Not found|Error|Fatal|Not logged" } | ForEach-Object { $_.Trim() }
    # Only retry when nothing at all was sent, so a retry never double-messages anyone.
    if ($code -eq 0 -or $result -notmatch "sent=0 ") { break }
    Start-Sleep -Seconds 60
  }
} catch {
  $code = 1
  $result = "RESULT run.ps1 error: $($_.Exception.Message)"
  $details += "run.ps1 error: $($_.Exception.Message)"
}

$summary = $result -replace "^RESULT ", ""
$mode = if ($DryRun) { " (dry run)" } else { "" }
if ($code -eq 0) {
  Show-Toast "TikTok Streak: OK" $summary
  Send-Discord ":white_check_mark: **TikTok Streak OK**$mode`n$summary" $details
} else {
  Show-Toast "TikTok Streak: FAILED" "$summary - see logs\$(Get-Date -Format yyyy-MM-dd).log"
  Send-Discord ":x: **TikTok Streak FAILED**$mode`n$summary`nLog: logs\$(Get-Date -Format yyyy-MM-dd).log" $details
}
exit $code
