#!/bin/bash
# 자동 시작 해제 — 서버를 멈추고 launchd 등록을 제거한다.
set -uo pipefail
LABEL="com.mail.local"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"

launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
rm -f "$PLIST"
echo "🛑 자동 시작 해제됨. 서버가 중지되었습니다."
