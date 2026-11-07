# uni-git installer for Windows. In PowerShell:
#   irm https://github.com/roflseech/uni-git/releases/latest/download/install.ps1 | iex
# Installs what is missing (Git for Windows with Git Credential Manager, Node.js LTS, the WebView2 runtime) via winget,
# then the latest uni-git into %LOCALAPPDATA%\Programs\uni-git with a Start menu shortcut, and starts it.
# Run it again to repair an installation; afterwards the app updates itself. Settings in <app>\data stay as they are.
# setup.ps1 (developer setup) runs it with -DepsOnly: a new prerequisite goes here and into install.sh.
# Test overrides: UNI_GIT_RELEASES (URL of a folder with latest.json), UNI_GIT_INSTALL_DIR, UNI_GIT_NO_SHORTCUT=1.
param([switch]$DepsOnly)

# A function keeps variables and $ErrorActionPreference out of the caller's session when run through iex.
function Install-UniGit([switch]$DepsOnly) {
  $ErrorActionPreference = "Stop"
  $ProgressPreference = "SilentlyContinue" # Invoke-WebRequest crawls with the progress bar in Windows PowerShell 5.1
  [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
  $repo = "roflseech/uni-git"

  function Has($cmd) { return [bool](Get-Command $cmd -ErrorAction SilentlyContinue) }
  function Refresh-Path {
    $env:Path = [Environment]::GetEnvironmentVariable("Path", "Machine") + ";" + [Environment]::GetEnvironmentVariable("Path", "User")
  }
  function Winget-Install($id, $label) {
    if (-not (Has "winget")) { throw "winget is not available. Install $label manually, then run this again." }
    Write-Host "Installing $label ..." -ForegroundColor Cyan
    winget install --id $id -e --accept-package-agreements --accept-source-agreements --silent
    Refresh-Path
  }

  Write-Host "uni-git: checking Git, Node.js and WebView2" -ForegroundColor Green

  # 1. Git (Git for Windows bundles Git Credential Manager)
  if (-not (Has "git")) { Winget-Install "Git.Git" "Git for Windows" }
  Write-Host "  git $((git --version) -replace 'git version ', '')"

  # 2. Node.js LTS: the backend runs on it (and the build, for developers)
  $nodeOk = $false
  if (Has "node") { $nodeOk = [int]((node --version).TrimStart("v").Split(".")[0]) -ge 20 }
  if (-not $nodeOk) { Winget-Install "OpenJS.NodeJS.LTS" "Node.js LTS" }
  Write-Host "  node $(node --version)"

  # 3. WebView2 runtime (the window renders in it; present on Windows 10/11, absent on some clean images)
  $wv2 = "HKLM:\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}"
  if (-not (Test-Path $wv2)) { $wv2 = "HKCU:\SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}" }
  if (Test-Path $wv2) { Write-Host "  WebView2 $((Get-ItemProperty $wv2).pv)" }
  else { Winget-Install "Microsoft.EdgeWebView2Runtime" "WebView2 runtime" }

  if ($DepsOnly) { return }

  # 4. The app: every file of latest.json for Windows, checked against its sha256
  $releases = if ($env:UNI_GIT_RELEASES) { $env:UNI_GIT_RELEASES.TrimEnd("/") } else { "https://github.com/$repo/releases/latest/download" }
  $dir = if ($env:UNI_GIT_INSTALL_DIR) { $env:UNI_GIT_INSTALL_DIR } else { Join-Path $env:LOCALAPPDATA "Programs\uni-git" }
  $exe = Join-Path $dir "uni-git-win_x64.exe"
  if (Get-Process "uni-git-win_x64" -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $exe }) {
    throw "uni-git is running from $dir. Close it, then run this again."
  }
  New-Item -ItemType Directory -Force $dir | Out-Null
  Write-Host "Downloading uni-git ..." -ForegroundColor Cyan
  # release assets are served as application/octet-stream: save, then read as UTF-8 text
  $tmpJson = Join-Path ([IO.Path]::GetTempPath()) "uni-git-latest.json"
  Invoke-WebRequest -UseBasicParsing "$releases/latest.json" -OutFile $tmpJson
  $m = (Get-Content -Raw -Encoding UTF8 $tmpJson | ConvertFrom-Json).manifest | ConvertFrom-Json
  Remove-Item $tmpJson -ErrorAction SilentlyContinue
  foreach ($f in $m.files) {
    if ($f.platforms -and -not ($f.platforms -contains "win_x64")) { continue }
    $target = Join-Path $dir ($f.path -replace "/", "\")
    if ((Test-Path $target) -and (Get-FileHash $target -Algorithm SHA256).Hash -eq $f.sha256) { continue }
    New-Item -ItemType Directory -Force (Split-Path $target) | Out-Null
    $tmp = "$target.download"
    Invoke-WebRequest -UseBasicParsing "$($m.baseUrl)$($f.asset)" -OutFile $tmp
    if ((Get-FileHash $tmp -Algorithm SHA256).Hash -ne $f.sha256) {
      Remove-Item $tmp -ErrorAction SilentlyContinue
      throw "$($f.asset) arrived damaged (checksum mismatch). Run this again."
    }
    Move-Item -Force $tmp $target
    Write-Host "  $($f.path)"
  }

  # 5. Start menu shortcut
  $lnk = Join-Path ([Environment]::GetFolderPath("Programs")) "uni-git.lnk"
  if (-not $env:UNI_GIT_NO_SHORTCUT) {
    $s = (New-Object -ComObject WScript.Shell).CreateShortcut($lnk)
    $s.TargetPath = $exe
    $s.WorkingDirectory = $dir
    $s.IconLocation = "$exe,0"
    $s.Description = "Easy Git client with Unity integrations"
    $s.Save()
  }

  Write-Host "uni-git $($m.version) is installed in $dir (Start menu: uni-git). It updates itself from now on." -ForegroundColor Green
  # Start it the way the Start menu does, through Explorer: started from here it would attach to this console (its
  # backend log lines would show up in this window) and, in an Administrator PowerShell, it would run as administrator.
  if (-not $env:UNI_GIT_NO_SHORTCUT -and (Test-Path $lnk) -and (Get-Process explorer -ErrorAction SilentlyContinue)) {
    Start-Process explorer.exe -ArgumentList "`"$lnk`""
  } else {
    Start-Process -FilePath $exe -WorkingDirectory $dir
  }
}

Install-UniGit -DepsOnly:$DepsOnly
