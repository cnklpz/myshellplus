#!/usr/bin/env bash
# Stop the previous test instance (never the user's window), reset its data, start again.
D="$(cygpath -w "$(dirname "$0")")"
powershell -NoProfile -ExecutionPolicy Bypass -File "$D\kill-test.ps1" >/dev/null 2>&1
sleep 2
SFX=""; [ -n "$MSP_E2E_SLOT" ] && [ "$MSP_E2E_SLOT" != 0 ] && SFX="-$MSP_E2E_SLOT"
rm -rf "/d/xm/msp-e2e$SFX" 2>/dev/null
powershell -NoProfile -ExecutionPolicy Bypass -File "$D\launch.ps1"
for i in $(seq 1 40); do curl -s -m 2 "http://127.0.0.1:$((9333 + ${MSP_E2E_SLOT:-0}))/json/version" >/dev/null && break; sleep 1; done
sleep 3
