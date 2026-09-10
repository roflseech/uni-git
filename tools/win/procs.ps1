# Lists the epic-git shell and backend processes (to check that the backend exits with the window).
Get-CimInstance Win32_Process |
  Where-Object { $_.Name -match 'neutralino|epic-git' -or (($_.Name -eq 'node.exe' -or $_.Name -eq 'cmd.exe') -and $_.CommandLine -match 'backend[/\\]main\.js') } |
  Select-Object ProcessId, ParentProcessId, Name | Format-Table -AutoSize | Out-String -Width 120
