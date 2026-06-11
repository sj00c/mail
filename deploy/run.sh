#!/bin/bash
# launchd가 실행하는 진입점. 프로젝트 루트에서 (재)빌드 후 프로덕션 서버를 띄운다.
# exec로 bun을 PID 1로 넘겨 launchd의 KeepAlive가 서버 자체를 감시하게 한다.
set -e

# 스크립트 위치 기준 프로젝트 루트로 이동 (deploy/ 의 부모)
cd "$(cd "$(dirname "$0")/.." && pwd)"

# launchd는 최소 PATH로 실행하므로 bun(과 git)을 찾을 수 있게 보강
export PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.bun/bin:/usr/bin:/bin:$PATH"
export NODE_ENV=production

# 부팅 직후엔 시스템 부하로 vite 빌드가 수십 초씩 걸려 그동안 포트가 안 열린다.
# 소스가 dist보다 새로울 때만 재빌드해 평소 재시작/재부팅은 즉시 뜨게 한다.
if [ ! -f dist/index.html ] || \
   [ -n "$(find web vite.config.ts package.json -newer dist/index.html -print -quit 2>/dev/null)" ]; then
  bun run build
fi
exec bun server/index.ts
