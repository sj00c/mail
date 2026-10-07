#!/bin/bash
# launchd가 실행하는 진입점. 설치 때 등록한 Bun으로 이미 빌드된 서버만 띄운다.
# exec로 Bun을 launchd가 직접 감시하게 하여 종료 코드를 그대로 전달한다.
#   run.sh <Bun> <작업 폴더>  — sj-mail 패키지: 설정(.env)·로그인 정보(.data)는 작업 폴더
#   run.sh <Bun>              — git 체크아웃: 설정은 저장소 루트, 로그인 정보는 server/.data
#                               (sj-mail setup으로 옮기기 전까지 기존 자동 실행을 유지)
set -euo pipefail

fail() {
  echo "서버를 시작하지 못했습니다: $1" >&2
  exit 1
}

[ "$#" -eq 1 ] || [ "$#" -eq 2 ] || fail "Bun 절대 경로(와 작업 폴더)가 필요합니다. setup을 다시 실행하세요."
BUN="$1"
case "$BUN" in
  /*) ;;
  *) fail "Bun 실행 파일 경로가 절대 경로가 아닙니다: $BUN" ;;
esac
[ -f "$BUN" ] || fail "Bun 실행 파일이 없습니다: $BUN. setup을 다시 실행하세요."
[ -x "$BUN" ] || fail "Bun 실행 파일을 실행할 수 없습니다: $BUN. setup을 다시 실행하세요."

# 스크립트 위치 기준 앱 루트 (deploy/ 의 부모)
APP="$(cd "$(dirname "$0")/.." && pwd)"
[ -f "$APP/dist/index.html" ] || fail "빌드 결과 dist/index.html이 없습니다. setup을 다시 실행하세요."

export NODE_ENV=production
export HOST=127.0.0.1
if [ "$#" -eq 2 ]; then
  WORKSPACE="$2"
  [ -d "$WORKSPACE" ] || fail "작업 폴더가 없습니다: $WORKSPACE. setup을 다시 실행하세요."
  export MAIL_DATA_DIR="$WORKSPACE/.data"
else
  WORKSPACE="$APP"
fi
[ -f "$WORKSPACE/.env" ] || fail ".env가 없습니다: $WORKSPACE/.env. setup을 다시 실행하세요."

cd "$WORKSPACE"
exec "$BUN" --use-system-ca "--env-file=$WORKSPACE/.env" "$APP/server/index.ts"
