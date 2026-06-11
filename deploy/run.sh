#!/bin/bash
# launchd가 실행하는 진입점. 프로젝트 루트에서 (재)빌드 후 프로덕션 서버를 띄운다.
# exec로 bun을 PID 1로 넘겨 launchd의 KeepAlive가 서버 자체를 감시하게 한다.
set -e

# 스크립트 위치 기준 프로젝트 루트로 이동 (deploy/ 의 부모)
cd "$(cd "$(dirname "$0")/.." && pwd)"

# launchd는 최소 PATH로 실행하므로 bun(과 git)을 찾을 수 있게 보강
export PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.bun/bin:/usr/bin:/bin:$PATH"
export NODE_ENV=production

bun run build
exec bun server/index.ts
