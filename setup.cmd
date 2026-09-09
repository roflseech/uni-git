@echo off
rem Windows one-click setup: installs Git, Node.js, WebView2 if missing, then project dependencies.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0setup.ps1"
echo.
pause
