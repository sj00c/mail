#!/bin/bash
# Isolated regression checks for the macOS launcher and uninstaller.
# The fixture never runs the production installer or touches a user's launchd
# domain; full install/bootstrap coverage remains the caller's responsibility.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
FIXTURE="$(mktemp -d "${TMPDIR:-/tmp}/mail-macos-deploy.XXXXXX")"
trap 'rm -rf "$FIXTURE"' EXIT

fail() {
  printf 'FAIL: %s\n' "$1" >&2
  exit 1
}

pass() {
  printf 'PASS: %s\n' "$1"
}

assert_status() {
  [ "$1" -eq "$2" ] || fail "$3 (expected $2, got $1)"
  pass "$3"
}

assert_contains() {
  case "$1" in
    *"$2"*) pass "$3" ;;
    *) fail "$3" ;;
  esac
}

assert_not_contains() {
  case "$1" in
    *"$2"*) fail "$3" ;;
    *) pass "$3" ;;
  esac
}

assert_file() {
  [ -e "$1" ] || fail "$2"
  pass "$2"
}

assert_missing() {
  [ ! -e "$1" ] || fail "$2"
  pass "$2"
}

mkdir -p "$FIXTURE/bin" "$FIXTURE/deploy" "$FIXTURE/dist" "$FIXTURE/web" \
  "$FIXTURE/home/Library/LaunchAgents"
cp "$ROOT/deploy/run.sh" "$FIXTURE/deploy/run.sh"
cp "$ROOT/deploy/uninstall.sh" "$FIXTURE/deploy/uninstall.sh"
chmod +x "$FIXTURE/deploy/run.sh" "$FIXTURE/deploy/uninstall.sh"
printf '<html></html>\n' > "$FIXTURE/dist/index.html"
printf 'new source\n' > "$FIXTURE/web/newer.ts"

BUN="$FIXTURE/bin/fake-bun"
BUN_LOG="$FIXTURE/bun.log"
cat > "$BUN" <<'EOF'
#!/bin/bash
set -e
: > "$FAKE_BUN_LOG"
printf 'argc=%s\n' "$#" >> "$FAKE_BUN_LOG"
for argument in "$@"; do
  printf 'arg=%s\n' "$argument" >> "$FAKE_BUN_LOG"
done
printf 'NODE_ENV=%s\n' "${NODE_ENV-}" >> "$FAKE_BUN_LOG"
printf 'HOST=%s\n' "${HOST-}" >> "$FAKE_BUN_LOG"
printf 'PWD=%s\n' "$PWD" >> "$FAKE_BUN_LOG"
exit "${FAKE_BUN_EXIT:-0}"
EOF
chmod +x "$BUN"

LAUNCHCTL="$FIXTURE/bin/launchctl"
LAUNCHCTL_STATE="$FIXTURE/launchctl.state"
cat > "$LAUNCHCTL" <<'EOF'
#!/bin/bash
set -e
command_name="${1-}"
state="$(<"$FAKE_LAUNCHCTL_STATE")"
case "$command_name" in
  print)
    if [ "${FAKE_LAUNCHCTL_PRINT_ERROR:-}" = "1" ]; then
      printf 'launchctl print permission denied (fake exit %s)\n' "${FAKE_LAUNCHCTL_PRINT_STATUS:-17}" >&2
      exit "${FAKE_LAUNCHCTL_PRINT_STATUS:-17}"
    fi
    if [ "$state" = "active" ]; then
      printf 'service loaded\n'
      exit 0
    fi
    printf 'Could not find service\n' >&2
    exit 113
    ;;
  bootout)
    if [ "${FAKE_LAUNCHCTL_BOOTOUT_ERROR:-}" = "1" ]; then
      printf 'launchctl bootout failed\n' >&2
      exit 42
    fi
    if [ "$state" != "active" ]; then
      printf 'Could not find service\n' >&2
      exit 113
    fi
    if [ "${FAKE_LAUNCHCTL_STUBBORN:-}" != "1" ]; then
      printf 'absent\n' > "$FAKE_LAUNCHCTL_STATE"
    fi
    exit 0
    ;;
  *)
    printf 'unexpected launchctl command\n' >&2
    exit 64
    ;;
esac
EOF
chmod +x "$LAUNCHCTL"

# Newer source must not trigger a login-time build. The fake Bun records the
# exact native invocation and exits nonzero so the launcher's status is tested.
touch "$FIXTURE/web/newer.ts"
set +e
LAUNCH_STATUS=0
LAUNCH_OUTPUT="$(FAKE_BUN_LOG="$BUN_LOG" FAKE_BUN_EXIT=23 bash "$FIXTURE/deploy/run.sh" "$BUN" 2>&1)"
LAUNCH_STATUS=$?
set -e
assert_status "$LAUNCH_STATUS" 23 "launcher propagates Bun exit code"
LAUNCH_LOG="$(<"$BUN_LOG")"
assert_contains "$LAUNCH_LOG" "argc=2" "launcher passes exactly two Bun arguments"
assert_contains "$LAUNCH_LOG" "arg=--use-system-ca" "launcher enables the system CA store"
assert_contains "$LAUNCH_LOG" "arg=server/index.ts" "launcher starts the production server entrypoint"
assert_contains "$LAUNCH_LOG" "NODE_ENV=production" "launcher sets production environment"
assert_contains "$LAUNCH_LOG" "HOST=127.0.0.1" "launcher forces loopback binding"
assert_not_contains "$LAUNCH_LOG" "arg=run" "launcher does not invoke a build command"
assert_not_contains "$LAUNCH_LOG" "arg=build" "launcher does not build when source is newer"

BEFORE_MISSING_BUILD="$LAUNCH_LOG"
rm -f "$FIXTURE/dist/index.html"
set +e
LAUNCH_OUTPUT="$(FAKE_BUN_LOG="$BUN_LOG" FAKE_BUN_EXIT=0 bash "$FIXTURE/deploy/run.sh" "$BUN" 2>&1)"
LAUNCH_STATUS=$?
set -e
assert_status "$LAUNCH_STATUS" 1 "launcher rejects a missing build"
assert_contains "$LAUNCH_OUTPUT" "dist/index.html" "missing-build error names the required artifact"
BUN_AFTER_MISSING="$(<"$BUN_LOG")"
if [ "$BUN_AFTER_MISSING" = "$BEFORE_MISSING_BUILD" ]; then
  BUN_INVOKED=0
else
  BUN_INVOKED=1
fi
assert_status "$BUN_INVOKED" 0 "missing build does not invoke Bun"
printf '<html></html>\n' > "$FIXTURE/dist/index.html"

MISSING_BUN="$FIXTURE/bin/missing-bun"
set +e
LAUNCH_OUTPUT="$(bash "$FIXTURE/deploy/run.sh" "$MISSING_BUN" 2>&1)"
LAUNCH_STATUS=$?
set -e
assert_status "$LAUNCH_STATUS" 1 "launcher rejects a missing Bun executable"
assert_contains "$LAUNCH_OUTPUT" "Bun 실행 파일이 없습니다" "missing Bun error is actionable"

set +e
LAUNCH_OUTPUT="$(bash "$FIXTURE/deploy/run.sh" "relative-bun" 2>&1)"
LAUNCH_STATUS=$?
set -e
assert_status "$LAUNCH_STATUS" 1 "launcher rejects a relative Bun path"
assert_contains "$LAUNCH_OUTPUT" "절대 경로" "relative Bun error requires an absolute path"

PLIST_SOURCE="$(<"$ROOT/deploy/com.mail.local.plist")"
INSTALL_SOURCE="$(<"$ROOT/deploy/install.sh")"
assert_contains "$PLIST_SOURCE" '<string>__BUN__</string>' "launchd template reserves an absolute Bun argument"
assert_contains "$INSTALL_SOURCE" 'Set :ProgramArguments:1 $BUN' "installer registers the resolved Bun path"
assert_contains "$INSTALL_SOURCE" '"$BUN" run build' "installer performs the build before registration"
assert_contains "$INSTALL_SOURCE" 'dist/index.html' "installer validates the build artifact"

run_uninstall() {
  local state="$1"
  local bootout_error="$2"
  local stubborn="$3"
  local print_error="$4"
  local print_status="${5:-17}"
  printf '%s\n' "$state" > "$LAUNCHCTL_STATE"
  set +e
  UNINSTALL_OUTPUT="$(
    PATH="$FIXTURE/bin:$PATH" \
      FAKE_LAUNCHCTL_STATE="$LAUNCHCTL_STATE" \
      FAKE_LAUNCHCTL_BOOTOUT_ERROR="$bootout_error" \
      FAKE_LAUNCHCTL_STUBBORN="$stubborn" \
      FAKE_LAUNCHCTL_PRINT_ERROR="$print_error" \
      FAKE_LAUNCHCTL_PRINT_STATUS="$print_status" \
      HOME="$FIXTURE/home" \
      bash "$FIXTURE/deploy/uninstall.sh" 2>&1
  )"
  UNINSTALL_STATUS=$?
  set -e
}

PLIST="$FIXTURE/home/Library/LaunchAgents/com.mail.local.plist"

rm -f "$PLIST"
run_uninstall absent 0 0 0
assert_status "$UNINSTALL_STATUS" 0 "uninstall is idempotent when service and plist are absent"
assert_not_contains "$UNINSTALL_OUTPUT" "종료되었습니다" "absent uninstall does not claim a service was stopped"

printf 'stale plist\n' > "$PLIST"
run_uninstall absent 0 0 0
assert_status "$UNINSTALL_STATUS" 0 "uninstall cleans a stale plist when service is absent"
assert_missing "$PLIST" "stale plist is removed after a genuinely absent service"
assert_not_contains "$UNINSTALL_OUTPUT" "서비스가 종료되었습니다" "stale-plist cleanup does not claim a service was stopped"

rm -f "$PLIST"
ln -s "$FIXTURE/missing-plist-target" "$PLIST"
run_uninstall absent 0 0 0
assert_status "$UNINSTALL_STATUS" 0 "uninstall removes a dangling plist symlink"
assert_missing "$PLIST" "dangling plist symlink is removed after an absent service"

printf 'active\n' > "$LAUNCHCTL_STATE"
printf 'registered plist\n' > "$PLIST"
run_uninstall active 0 0 0
assert_status "$UNINSTALL_STATUS" 0 "uninstall succeeds after launchd bootout"
assert_missing "$PLIST" "successful bootout removes the plist"
assert_contains "$UNINSTALL_OUTPUT" "서비스가 종료되었습니다" "successful uninstall reports a verified stop"

printf 'active\n' > "$LAUNCHCTL_STATE"
printf 'registered plist\n' > "$PLIST"
run_uninstall active 1 0 0
assert_status "$UNINSTALL_STATUS" 42 "uninstall propagates launchd bootout failure"
assert_file "$PLIST" "bootout failure preserves the plist"

printf 'active\n' > "$LAUNCHCTL_STATE"
printf 'registered plist\n' > "$PLIST"
run_uninstall active 0 1 0
assert_status "$UNINSTALL_STATUS" 1 "uninstall rejects a service that remains loaded"
assert_file "$PLIST" "a still-loaded service preserves the plist"

printf 'active\n' > "$LAUNCHCTL_STATE"
printf 'registered plist\n' > "$PLIST"
run_uninstall active 0 0 1 1
assert_status "$UNINSTALL_STATUS" 2 "uninstall normalizes launchd status-one errors"
assert_file "$PLIST" "status-one launchd errors preserve the plist"
assert_contains "$UNINSTALL_OUTPUT" "종료 코드 1" "status-one launchd errors retain the original code in diagnostics"
assert_not_contains "$UNINSTALL_OUTPUT" "서비스가 종료되었습니다" "status-one launchd errors do not claim a stop"

printf 'active\n' > "$LAUNCHCTL_STATE"
printf 'registered plist\n' > "$PLIST"
run_uninstall active 0 0 1 17
assert_status "$UNINSTALL_STATUS" 2 "uninstall normalizes launchd status-seventeen errors"
assert_file "$PLIST" "status-seventeen launchd errors preserve the plist"
assert_contains "$UNINSTALL_OUTPUT" "종료 코드 17" "status-seventeen launchd errors retain the original code in diagnostics"
assert_not_contains "$UNINSTALL_OUTPUT" "서비스가 종료되었습니다" "status-seventeen launchd errors do not claim a stop"

printf 'macOS deployment regression checks passed.\n'
