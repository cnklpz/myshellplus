#!/usr/bin/env bash
# Stop the previous test instance (never the user's window), reset its data, start again.
D="$(cygpath -w "$(dirname "$0")")"
powershell -NoProfile -ExecutionPolicy Bypass -File "$D\kill-test.ps1" >/dev/null 2>&1
sleep 2
rm -rf /d/xm/msp-e2e 2>/dev/null
powershell -NoProfile -ExecutionPolicy Bypass -File "$D\launch.ps1"
for i in $(seq 1 40); do curl -s -m 2 http://127.0.0.1:9333/json/version >/dev/null && break; sleep 1; done
sleep 3
