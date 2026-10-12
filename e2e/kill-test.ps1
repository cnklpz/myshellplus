# Stop only E2E test instances. A test instance is a myshellplus.exe whose PID was recorded at launch,
# or whose WebView2 uses the msp-e2e data folder. The user's own window is never matched.
$ids = @()
$pidFile = "$env:TEMP\msp-e2e.pid"
if (Test-Path $pidFile) { $ids += [int](Get-Content $pidFile) }
$wv = Get-CimInstance Win32_Process -Filter "Name='msedgewebview2.exe'" | Where-Object { $_.CommandLine -like '*msp-e2e*' }
$ids += $wv | ForEach-Object { $_.ParentProcessId }
foreach ($p in ($ids | Sort-Object -Unique)) {
  $proc = Get-CimInstance Win32_Process -Filter "ProcessId=$p"
  if ($proc -and ($proc.Name -eq 'myshellplus.exe' -or $proc.Name -eq 'myshellplus-e2e.exe')) { Stop-Process -Id $p -Force }
}
$wv | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Remove-Item $pidFile -ErrorAction SilentlyContinue
