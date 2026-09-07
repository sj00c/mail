#!/bin/bash
# macOS 원클릭 설치: .env 확인 → Bun/의존성 설치 → 빌드 → 자동 실행 등록.
set -euo pipefail

DIR="$(cd "$(dirname "$0")/.." && pwd)"
LABEL="com.mail.local"
RUN="$DIR/deploy/run.sh"
LOG="$HOME/Library/Logs/mail.local.log"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
UID_NUM="$(id -u)"
# 서버가 열릴 때까지 기다리는 시간(초). 처음 켜는 PC는 느린 디스크·보안 검사 때문에
# 시작이 수십 초 걸릴 수 있다. 도중에 서버가 죽으면 기다리지 않고 바로 끝낸다.
READY_TIMEOUT=60

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
PORT_VALUE="${PORT_VALUE:-8787}"

# 포트는 기본 8787이지만 바꿀 수 있다 — 단, 리디렉션 URI도 같은 포트여야 하고
# 그 URI가 Google Cloud 콘솔에 등록돼 있어야 한다(아래에서 안내).
case "$PORT_VALUE" in
  ''|*[!0-9]*) fail "PORT는 숫자여야 합니다 (기본 8787)." ;;
esac
if [ "$PORT_VALUE" -lt 1024 ] || [ "$PORT_VALUE" -gt 65535 ]; then
  fail "PORT는 1024~65535 사이여야 합니다 (기본 8787)."
fi
APP_URL="http://localhost:$PORT_VALUE"
EXPECTED_REDIRECT="$APP_URL/auth/callback"
REDIRECT="${REDIRECT:-$EXPECTED_REDIRECT}"

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
[ "$REDIRECT" = "$EXPECTED_REDIRECT" ] || fail "OAUTH_REDIRECT는 $EXPECTED_REDIRECT 이어야 합니다 (PORT=$PORT_VALUE 기준)."
if [ "$PORT_VALUE" != "8787" ]; then
  echo "참고: PORT=$PORT_VALUE — Google Cloud 콘솔의 승인된 리디렉션 URI에 $EXPECTED_REDIRECT 가 등록돼 있어야 로그인이 됩니다."
fi

# 포트를 누가 쓰고 있는지. 우리 자동 실행 항목은 아래에서 종료하므로, 그 뒤에도 남아 있으면
# 다른 프로그램이 사용하는 것이다. 그 상태로 등록하면 서버가 계속 죽었다 살아나므로
# 여기서 점유 프로세스를 알려 주되, 프로세스 이름만으로 앱을 추측하거나 종료하지 않는다.
port_listener() {
  local listeners status
  if listeners="$(/usr/sbin/lsof -nP -iTCP:"$PORT_VALUE" -sTCP:LISTEN -Fpc 2>&1)"; then
    printf '%s\n' "$listeners" | awk '
    /^p/ { pid = substr($0, 2) }
    /^c/ { print substr($0, 2) " (PID " pid ")"; exit }'
  else
    status=$?
    # lsof returns 1 with no output for a free port; that is not an install error.
    if [ "$status" -eq 1 ] && [ -z "$listeners" ]; then return 0; fi
    fail "포트 점유 상태를 확인하지 못했습니다 (종료 코드 $status): $listeners"
  fi
}

export PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.bun/bin:/usr/bin:/bin:$PATH"

echo "[1/4] 실행 프로그램 확인"
if ! command -v bun >/dev/null 2>&1; then
  PACKAGE_MANAGER="$(/usr/bin/plutil -extract packageManager raw -o - "$DIR/package.json")" ||
    fail "package.json의 packageManager를 읽지 못했습니다."
  [[ "$PACKAGE_MANAGER" =~ ^bun@([0-9]+\.[0-9]+\.[0-9]+)$ ]] ||
    fail "packageManager에는 bun@버전 형식의 고정 버전이 필요합니다."
  BUN_VERSION="${BASH_REMATCH[1]}"
  echo "Bun $BUN_VERSION을 공식 설치 프로그램으로 설치합니다."
  command -v curl >/dev/null 2>&1 || fail "Bun 설치에 필요한 curl을 찾을 수 없습니다."
  curl -fsSL https://bun.com/install | bash -s -- "bun-v$BUN_VERSION"
  export PATH="$HOME/.bun/bin:$PATH"
fi
BUN="$(command -v bun)" || fail "Bun 설치 후에도 실행 파일을 찾지 못했습니다. 터미널을 다시 연 뒤 재실행하세요."
BUN_DIR="$(cd "$(dirname "$BUN")" && pwd -P)" || fail "Bun 실행 파일 경로를 확인하지 못했습니다: $BUN"
BUN="$BUN_DIR/$(basename "$BUN")"
[ -x "$BUN" ] || fail "Bun 실행 파일을 찾을 수 없거나 실행할 수 없습니다: $BUN"
echo "Bun 실행 파일: $BUN"

echo "[2/4] 앱에 필요한 파일 설치"
(
  cd "$DIR"
  "$BUN" install --frozen-lockfile
)

echo "[3/4] 앱 빌드"
(
  cd "$DIR"
  "$BUN" run build
)
[ -f "$DIR/dist/index.html" ] || fail "빌드 결과 dist/index.html이 없습니다."

echo "[4/4] 로그인 시 자동 실행 등록"
chmod +x "$RUN"
mkdir -p "$HOME/Library/LaunchAgents" "$(dirname "$LOG")"
cp "$DIR/deploy/$LABEL.plist" "$PLIST"
/usr/libexec/PlistBuddy -c "Set :ProgramArguments:0 $RUN" "$PLIST"
/usr/libexec/PlistBuddy -c "Set :ProgramArguments:1 $BUN" "$PLIST"
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
OCCUPANT="$(port_listener)"
if [ -n "$OCCUPANT" ]; then
  fail "$PORT_VALUE 포트를 다른 프로그램이 쓰고 있습니다: $OCCUPANT
  - 해당 프로그램을 확인하거나 종료한 뒤 다시 실행하세요. 프로세스 이름만으로 Mail이라고 판단하지 않습니다.
  - 종료할 수 없는 다른 프로그램이라면 .env의 PORT를 비어 있는 번호(예: 8788)로 바꾸고, OAUTH_REDIRECT도
    http://localhost:그번호/auth/callback 으로 바꾼 뒤 같은 주소를 Google Cloud 콘솔의
    승인된 리디렉션 URI에 추가하고 다시 실행하세요."
fi
launchctl bootstrap "gui/$UID_NUM" "$PLIST"
launchctl enable "gui/$UID_NUM/$LABEL"
launchctl kickstart -k "gui/$UID_NUM/$LABEL"

# 서버가 살아 있는지(launchd가 PID를 보고 있는지). 처음 죽고 나면 KeepAlive가 10초 뒤 다시 켜보므로
# "죽었다"가 한 번이라도 보이면 설정 문제다 — 기다리지 말고 로그를 보여준다.
server_alive() {
  launchctl print "gui/$UID_NUM/$LABEL" 2>/dev/null | grep -qE '^\s*pid = [0-9]+'
}

show_log_tail() {
  if [ -s "$LOG" ]; then
    echo
    echo "---- 로그 마지막 부분 ($LOG) ----" >&2
    tail -n 25 "$LOG" >&2
    echo "-------------------------------------------" >&2
  fi
}

READY=0
DIED=0
sleep 1
for i in $(seq 1 "$READY_TIMEOUT"); do
  if /usr/bin/curl -fsS --max-time 2 "http://127.0.0.1:$PORT_VALUE/auth/status" >/dev/null 2>&1; then
    READY=1
    break
  fi
  # 철 직후 몇 초는 launchd가 PID를 아직 안 준 수 있어 3초부터 본다
  if [ "$i" -ge 3 ] && ! server_alive; then
    DIED=1
    break
  fi
  sleep 1
done

if [ "$DIED" -eq 1 ]; then
  show_log_tail
  fail "서버가 시작 직후 종료됐습니다. 위 로그의 마지막 오류를 확인하세요: $LOG"
fi
if [ "$READY" -ne 1 ]; then
  show_log_tail
  fail "서버가 ${READY_TIMEOUT}초 안에 열리지 않았습니다. PC가 느리면 잠시 후 $APP_URL 을 열어 보고, 그래도 안 열리면 로그를 확인하세요: $LOG"
fi

echo
echo "설치가 끝났습니다."
echo "주소: $APP_URL"
echo "앞으로는 이 주소만 열면 됩니다."
echo "자동 실행 해제: bash deploy/uninstall.sh"
/usr/bin/open "$APP_URL"
