#!/bin/bash
# macOS 원클릭 설치: .env 확인 → Bun/의존성 설치 → 빌드 → 자동 실행 등록.
set -euo pipefail

DIR="$(cd "$(dirname "$0")/.." && pwd)"
LABEL="com.mail.local"
RUN="$DIR/deploy/run.sh"
LOG="$HOME/Library/Logs/mail.local.log"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
UID_NUM="$(id -u)"
APP_URL="http://localhost:8787"
EXPECTED_REDIRECT="$APP_URL/auth/callback"

fail() {
  echo
  echo "설치를 완료하지 못했습니다: $1" >&2
  exit 1
}

env_value() {
  local wanted="$1"
  local line key
  while IFS= read -r line || [ -n "$line" ]; do
    line="${line%$'\r'}"
    case "$line" in
      ""|\#*) continue ;;
    esac
    key="${line%%=*}"
    if [ "$key" = "$wanted" ]; then
      printf "%s" "${line#*=}"
      return
    fi
  done < "$DIR/.env"
}

[ "$(uname -s)" = "Darwin" ] || fail "이 파일은 macOS용입니다. Windows에서는 deploy\\install.ps1을 실행하세요."
[ -f "$DIR/.env" ] || fail ".env 파일이 없습니다. README의 안내대로 .env를 먼저 만들고 Google 연결 정보를 입력하세요."
chmod 600 "$DIR/.env"

CLIENT_ID="$(env_value GOOGLE_CLIENT_ID)"
CLIENT_SECRET="$(env_value GOOGLE_CLIENT_SECRET)"
REDIRECT="$(env_value OAUTH_REDIRECT)"
PORT_VALUE="$(env_value PORT)"
REDIRECT="${REDIRECT:-$EXPECTED_REDIRECT}"
PORT_VALUE="${PORT_VALUE:-8787}"

[ -n "$CLIENT_ID" ] || fail ".env의 GOOGLE_CLIENT_ID가 비어 있습니다."
[ -n "$CLIENT_SECRET" ] || fail ".env의 GOOGLE_CLIENT_SECRET이 비어 있습니다."
case "$CLIENT_ID" in
  your-*|여기에_*|*PLACEHOLDER*) fail ".env의 GOOGLE_CLIENT_ID를 실제 Client ID로 바꾸세요." ;;
  *.apps.googleusercontent.com) ;;
  *) fail "GOOGLE_CLIENT_ID 형식이 올바르지 않습니다. 보통 .apps.googleusercontent.com으로 끝납니다." ;;
esac
case "$CLIENT_SECRET" in
  your-*|여기에_*|*PLACEHOLDER*) fail ".env의 GOOGLE_CLIENT_SECRET을 실제 Client Secret으로 바꾸세요." ;;
esac
case "$CLIENT_ID$CLIENT_SECRET" in
  *\"*|*\'*|*" "*) fail "Client ID와 Client Secret에는 따옴표나 공백을 넣지 마세요." ;;
esac
[ "$REDIRECT" = "$EXPECTED_REDIRECT" ] || fail "OAUTH_REDIRECT는 $EXPECTED_REDIRECT 이어야 합니다."
[ "$PORT_VALUE" = "8787" ] || fail "PORT는 8787이어야 합니다."

export PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.bun/bin:/usr/bin:/bin:$PATH"

echo "[1/4] 실행 프로그램 확인"
if ! command -v bun >/dev/null 2>&1; then
  echo "Bun이 없어 공식 설치 프로그램으로 설치합니다."
  command -v curl >/dev/null 2>&1 || fail "Bun 설치에 필요한 curl을 찾을 수 없습니다."
  curl -fsSL https://bun.com/install | bash
  export PATH="$HOME/.bun/bin:$PATH"
fi
command -v bun >/dev/null 2>&1 || fail "Bun 설치 후에도 실행 파일을 찾지 못했습니다. 터미널을 다시 연 뒤 재실행하세요."

echo "[2/4] 앱에 필요한 파일 설치"
(
  cd "$DIR"
  bun install --frozen-lockfile
)

echo "[3/4] 앱 빌드"
(
  cd "$DIR"
  bun run build
)

echo "[4/4] 로그인 시 자동 실행 등록"
chmod +x "$RUN"
mkdir -p "$HOME/Library/LaunchAgents" "$(dirname "$LOG")"
cp "$DIR/deploy/$LABEL.plist" "$PLIST"
/usr/libexec/PlistBuddy -c "Set :ProgramArguments:0 $RUN" "$PLIST"
/usr/bin/plutil -replace WorkingDirectory -string "$DIR" "$PLIST"
/usr/bin/plutil -replace StandardOutPath -string "$LOG" "$PLIST"
/usr/bin/plutil -replace StandardErrorPath -string "$LOG" "$PLIST"

launchctl bootout "gui/$UID_NUM/$LABEL" >/dev/null 2>&1 || true
for _ in {1..10}; do
  if ! launchctl print "gui/$UID_NUM/$LABEL" >/dev/null 2>&1; then
    break
  fi
  sleep 1
done
sleep 1
if launchctl print "gui/$UID_NUM/$LABEL" >/dev/null 2>&1; then
  fail "기존 자동 실행을 종료하지 못했습니다. 잠시 후 설치 스크립트를 다시 실행하세요."
fi
launchctl bootstrap "gui/$UID_NUM" "$PLIST"
launchctl enable "gui/$UID_NUM/$LABEL"
launchctl kickstart -k "gui/$UID_NUM/$LABEL"

READY=0
for _ in {1..30}; do
  if /usr/bin/curl -fsS --max-time 2 "http://127.0.0.1:8787/auth/status" >/dev/null 2>&1; then
    READY=1
    break
  fi
  sleep 1
done

if [ "$READY" -ne 1 ]; then
  fail "서버가 30초 안에 열리지 않았습니다. 로그를 확인하세요: $LOG"
fi

echo
echo "설치가 끝났습니다."
echo "주소: $APP_URL"
echo "앞으로는 이 주소만 열면 됩니다."
echo "자동 실행 해제: bash deploy/uninstall.sh"
/usr/bin/open "$APP_URL"
