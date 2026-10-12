# Start an isolated MyShell+ test instance (CDP on :9333), record its PID.
# Runs a private copy of the exe so `pnpm tauri dev` can still rebuild target\debug\myshellplus.exe.
$data = 'D:\xm\msp-e2e'
$bin = 'D:\xm\msp-e2e-bin'
New-Item -ItemType Directory -Force $data, $bin | Out-Null
Copy-Item 'D:\xm\myshellplus\src-tauri\target\debug\myshellplus.exe' "$bin\myshellplus-e2e.exe" -Force
$env:MYSHELL_TEST_INSTANCE = '1'
$env:MYSHELL_DATA_DIR = $data
$env:WEBVIEW2_USER_DATA_FOLDER = "$data\webview2"
$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = '--remote-debugging-port=9333'
$p = Start-Process -FilePath "$bin\myshellplus-e2e.exe" -PassThru -WindowStyle Normal `
  -RedirectStandardOutput "$env:TEMP\e2e-app.log" -RedirectStandardError "$env:TEMP\e2e-app.err"
$p.Id | Set-Content "$env:TEMP\msp-e2e.pid"
