# Start an isolated MyShell+ test instance (CDP on :9333), record its PID.
# Runs a private copy of the exe so `pnpm tauri dev` can still rebuild target\debug\myshellplus.exe.
# MSP_E2E_SLOT=N runs a parallel instance (CDP :9333+N, own data dir / exe / pid file) so two sessions don't collide.
$slot = if ($env:MSP_E2E_SLOT) { [int]$env:MSP_E2E_SLOT } else { 0 }
$sfx = if ($slot) { "-$slot" } else { '' }
$data = "D:\xm\msp-e2e$sfx"
$bin = 'D:\xm\msp-e2e-bin'
New-Item -ItemType Directory -Force $data, $bin | Out-Null
Copy-Item 'D:\xm\myshellplus\src-tauri\target\debug\myshellplus.exe' "$bin\myshellplus-e2e$sfx.exe" -Force
$env:MYSHELL_TEST_INSTANCE = '1'
$env:MYSHELL_DATA_DIR = $data
$env:WEBVIEW2_USER_DATA_FOLDER = "$data\webview2"
$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = "--remote-debugging-port=$(9333 + $slot)"
$p = Start-Process -FilePath "$bin\myshellplus-e2e$sfx.exe" -PassThru -WindowStyle Normal `
  -RedirectStandardOutput "$env:TEMP\e2e-app$sfx.log" -RedirectStandardError "$env:TEMP\e2e-app$sfx.err"
$p.Id | Set-Content "$env:TEMP\msp-e2e$sfx.pid"
