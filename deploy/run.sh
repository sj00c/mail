#!/bin/bash
# launchd가 실행하는 진입점. 설치 때 등록한 Bun으로 이미 빌드된 서버만 띄운다.
# exec로 Bun을 launchd가 직접 감시하게 하여 종료 코드를 그대로 전달한다.
set -euo pipefail

fail() {
  echo "서버를 시작하지 못했습니다: $1" >&2
  exit 1
}

[ "$#" -eq 1 ] || fail "설치 때 등록한 절대 경로 Bun 실행 파일이 필요합니다. deploy/install.sh를 다시 실행하세요."
BUN="$1"
case "$BUN" in
  /*) ;;
  *) fail "Bun 실행 파일 경로가 절대 경로가 아닙니다: $BUN" ;;
esac
[ -f "$BUN" ] || fail "Bun 실행 파일이 없습니다: $BUN. deploy/install.sh를 다시 실행하세요."
[ -x "$BUN" ] || fail "Bun 실행 파일을 실행할 수 없습니다: $BUN. deploy/install.sh를 다시 실행하세요."

# 스크립트 위치 기준 프로젝트 루트로 이동 (deploy/ 의 부모)
DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$DIR"

[ -f "dist/index.html" ] || fail "빌드 결과 dist/index.html이 없습니다. deploy/install.sh를 다시 실행하세요."

export NODE_ENV=production
export HOST=127.0.0.1
exec "$BUN" --use-system-ca server/index.ts
