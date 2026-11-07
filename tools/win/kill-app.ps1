# Stops every uni-git shell and backend process (dev binary, dist binary, node running the extension bundle).
# Use this instead of `taskkill /PID` from Git Bash: MSYS turns /PID into a path.
Get-Process neutralino-win_x64, uni-git-win_x64 -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Get-CimInstance Win32_Process | Where-Object { ($_.Name -eq 'node.exe' -or $_.Name -eq 'cmd.exe') -and $_.CommandLine -match 'backend[/\\]main\.js' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Start-Sleep -Milliseconds 800
$left = Get-CimInstance Win32_Process | Where-Object { $_.Name -match 'neutralino|uni-git' -or ($_.Name -eq 'node.exe' -and $_.CommandLine -match 'backend[/\\]main\.js') }
Write-Output ("left: " + (($left | ForEach-Object { "$($_.ProcessId) $($_.Name)" }) -join ", "))
