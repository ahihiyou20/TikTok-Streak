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
for ($attempt = 1; $attempt -le 2; $attempt++) {
  Write-Log "===== $(Get-Date -Format s) attempt $attempt ====="
  $before = @(Get-Content -LiteralPath $log -Encoding UTF8).Count
  # cmd redirection keeps node's UTF-8 output intact (nicknames with Vietnamese/emoji)
  $env:NO_COLOR = "1"
  cmd /c "`"$node`" $nodeArgs >> `"$log`" 2>&1"
  $code = $LASTEXITCODE
  $result = Get-Content -LiteralPath $log -Encoding UTF8 | Select-Object -Skip $before | Where-Object { $_ -like "RESULT *" } | Select-Object -Last 1
  if (-not $result) { $result = "RESULT sent=0 (bot crashed, no result line)" }
  # Only retry when nothing at all was sent, so a retry never double-messages anyone.
  if ($code -eq 0 -or $result -notmatch "sent=0 ") { break }
  Start-Sleep -Seconds 60
}

if ($code -eq 0) {
  Show-Toast "TikTok Streak: OK" ($result -replace "^RESULT ", "")
} else {
  Show-Toast "TikTok Streak: FAILED" "$($result -replace '^RESULT ', '') - see logs\$(Get-Date -Format yyyy-MM-dd).log"
}
exit $code
