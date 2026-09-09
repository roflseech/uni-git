# epic-git — Windows setup. Run setup.cmd (double-click) or:  powershell -ExecutionPolicy Bypass -File setup.ps1
# Installs what is missing (Git for Windows incl. Git Credential Manager, Node.js LTS, WebView2 runtime)
# via winget, then installs npm workspaces and downloads the Neutralino binaries.
$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

function Has($cmd) { return [bool](Get-Command $cmd -ErrorAction SilentlyContinue) }
function Refresh-Path {
  $env:Path = [Environment]::GetEnvironmentVariable("Path", "Machine") + ";" + [Environment]::GetEnvironmentVariable("Path", "User")
}
function Winget-Install($id, $label) {
  if (-not (Has "winget")) { throw "winget is not available. Install '$label' manually, then run setup again." }
  Write-Host "Installing $label ..." -ForegroundColor Cyan
  winget install --id $id -e --accept-package-agreements --accept-source-agreements --silent
  Refresh-Path
}

Write-Host "epic-git setup (Windows)" -ForegroundColor Green

# 1. Git (Git for Windows bundles Git Credential Manager)
if (-not (Has "git")) { Winget-Install "Git.Git" "Git for Windows" }
$gitVersion = (git --version) -replace "git version ", ""
Write-Host "  git $gitVersion"

# 2. Node.js LTS (needed at runtime for the backend and for the build)
$nodeOk = $false
if (Has "node") { $major = [int]((node --version).TrimStart("v").Split(".")[0]); $nodeOk = $major -ge 20 }
if (-not $nodeOk) { Winget-Install "OpenJS.NodeJS.LTS" "Node.js LTS" }
Write-Host "  node $(node --version), npm $(npm --version)"

# 3. WebView2 runtime (Neutralino renders in it; present on Windows 10/11, absent on some clean images)
$wv2 = "HKLM:\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}"
if (-not (Test-Path $wv2)) { $wv2 = "HKCU:\SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}" }
if (Test-Path $wv2) { Write-Host "  WebView2 $((Get-ItemProperty $wv2).pv)" }
else { Winget-Install "Microsoft.EdgeWebView2Runtime" "WebView2 runtime" }

# 4. Project dependencies + Neutralino binaries
Write-Host "Installing npm workspaces and Neutralino binaries ..." -ForegroundColor Cyan
npm run setup
if ($LASTEXITCODE -ne 0) { throw "npm run setup failed" }

Write-Host ""
Write-Host "Done. Next:  npm run dev   (or npm run dist for a distributable build)" -ForegroundColor Green
