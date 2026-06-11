#!/bin/bash
# macOS: 로그인 시 자동 시작 + 죽으면 자동 재시작되도록 launchd에 등록한다.
# 한 번만 실행하면 된다. 이후 재부팅/로그인/크래시에도 알아서 켜진다.
set -euo pipefail

DIR="$(cd "$(dirname "$0")/.." && pwd)"      # 프로젝트 루트
LABEL="com.mail.local"
RUN="$DIR/deploy/run.sh"
LOG="$HOME/Library/Logs/mail.local.log"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
UID_NUM="$(id -u)"

if [ ! -f "$DIR/.env" ]; then
  echo "⚠️  .env 가 없습니다. 먼저 'cp .env.example .env' 후 값을 채우세요 (README 참고)." >&2
  exit 1
fi

chmod +x "$DIR/deploy/run.sh"
mkdir -p "$HOME/Library/LaunchAgents" "$(dirname "$LOG")"

# 경로를 plist에 주입
sed -e "s|__RUN__|$RUN|g" -e "s|__DIR__|$DIR|g" -e "s|__LOG__|$LOG|g" \
  "$DIR/deploy/$LABEL.plist" > "$PLIST"

# 이미 떠 있으면 내리고 다시 올린다 (재설치 안전)
launchctl bootout "gui/$UID_NUM/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$UID_NUM" "$PLIST"
launchctl enable "gui/$UID_NUM/$LABEL"
launchctl kickstart -k "gui/$UID_NUM/$LABEL"

echo "✅ 등록 완료. 로그인할 때마다 자동으로 켜집니다."
echo "   주소:  http://localhost:8787"
echo "   로그:  $LOG"
echo "   끄기:  bash deploy/uninstall.sh"
