@echo off
rem Manual run: sends the streak message to every account in config.local.json "targets"
rem (same as the 6:00 task: log in logs\, Windows notification, Discord webhook).
cd /d "%~dp0"
echo Sending TikTok streak messages now...
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0run.ps1"
if %errorlevel%==0 (echo. & echo DONE: all messages sent and verified.) else (echo. & echo FAILED: see the logs folder for details.)
echo Log: %~dp0logs
pause
