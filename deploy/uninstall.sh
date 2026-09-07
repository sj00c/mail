#!/bin/bash
# 자동 시작 해제 — launchd 서비스와 등록 파일을 안전하게 제거한다.
set -uo pipefail

LABEL="com.mail.local"
UID_NUM="$(id -u)"
TARGET="gui/$UID_NUM/$LABEL"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"

service_state() {
  # 0: service is loaded, 1: genuinely absent, anything else: lifecycle error.
  local output status
  if output="$(launchctl print "$TARGET" 2>&1)"; then
    return 0
  else
    status=$?
  fi
  if [ "$status" -eq 113 ]; then
    return 1
  fi
  case "$output" in
    *"Could not find service"*|*"could not find service"*|*"No such process"*|*"no such process"*)
      return 1
      ;;
  esac
  echo "launchd 상태를 확인하지 못했습니다 (종료 코드 $status)." >&2
  [ -n "$output" ] && echo "$output" >&2
  # Keep absence distinct from every lifecycle failure. In particular,
  # launchctl can use status 1 for permission or transport errors.
  return 2
}

remove_plist() {
  # -e is false for a dangling symlink; -L still lets us remove that stale
  # launch-agent path without following or preserving it.
  if [ -e "$PLIST" ] || [ -L "$PLIST" ]; then
    if rm -f "$PLIST"; then
      :
    else
      local status=$?
      echo "등록 파일을 삭제하지 못했습니다: $PLIST" >&2
      return "$status"
    fi
  fi
}

if service_state; then
  output=""
  if output="$(launchctl bootout "$TARGET" 2>&1)"; then
    :
  else
    status=$?
    echo "launchd 서비스를 종료하지 못했습니다 (종료 코드 $status)." >&2
    [ -n "$output" ] && echo "$output" >&2
    echo "서비스가 종료되지 않아 등록 파일을 보존합니다: $PLIST" >&2
    exit "$status"
  fi

  if service_state; then
    echo "launchd 서비스가 아직 실행 중이어서 등록 파일을 보존합니다: $PLIST" >&2
    exit 1
  else
    status=$?
    if [ "$status" -ne 1 ]; then
      exit "$status"
    fi
  fi

  remove_plist || exit $?
  echo "자동 시작을 해제했습니다. launchd 서비스가 종료되었습니다."
  exit 0
else
  status=$?
  if [ "$status" -ne 1 ]; then
    exit "$status"
  fi
fi

# launchd에는 이미 없지만 설치가 중단되어 plist만 남은 경우도 정리한다.
remove_plist || exit $?
if [ -e "$PLIST" ] || [ -L "$PLIST" ]; then
  echo "launchd 서비스가 없어 등록 파일을 확인할 수 없습니다: $PLIST" >&2
  exit 1
fi
echo "자동 시작 서비스가 이미 없습니다."
