# uni-git — developer setup on Windows. Run setup.cmd (double-click) or:  powershell -ExecutionPolicy Bypass -File setup.ps1
# Installs what is missing (Git for Windows incl. Git Credential Manager, Node.js LTS, WebView2 runtime) through
# install.ps1 -DepsOnly, then the npm workspaces and the Neutralino binaries. To just use the app, run install.ps1.
$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

Write-Host "uni-git setup (Windows)" -ForegroundColor Green
& "$PSScriptRoot\install.ps1" -DepsOnly

Write-Host "Installing npm workspaces and Neutralino binaries ..." -ForegroundColor Cyan
npm run setup
if ($LASTEXITCODE -ne 0) { throw "npm run setup failed" }

Write-Host ""
Write-Host "Done. Next:  npm run dev   (or npm run dist for a distributable build)" -ForegroundColor Green
