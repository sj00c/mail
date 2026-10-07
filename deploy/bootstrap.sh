#!/bin/bash
# One-line install and update for macOS. Nothing needs to be installed first:
#   curl -fsSL https://raw.githubusercontent.com/sj00c/mail/main/deploy/bootstrap.sh | bash
# With setup options, e.g. migrating from a specific old folder:
#   curl -fsSL https://raw.githubusercontent.com/sj00c/mail/main/deploy/bootstrap.sh | bash -s -- --from ~/old/mail
# Installs Bun with its official installer when missing, then runs
# `bun x --bun @sj00c/mail@latest setup`, which does everything else.
set -euo pipefail

BUN_BIN="${BUN_INSTALL:-$HOME/.bun}/bin/bun"
if command -v bun >/dev/null 2>&1; then
  BUN_BIN="$(command -v bun)"
elif [ ! -x "$BUN_BIN" ]; then
  echo "  Installing Bun with the official installer (bun.sh)..."
  curl -fsSL https://bun.sh/install | bash
fi
if [ ! -x "$BUN_BIN" ]; then
  echo "  Bun was not installed at $BUN_BIN. Check the internet connection to bun.sh and run this command again." >&2
  exit 1
fi

# SJ_MAIL_PACKAGE_SPEC (file:<tgz>) lets tests run an unpublished package.
PACKAGE="${SJ_MAIL_PACKAGE_SPEC:-@sj00c/mail@latest}"
# Under `curl ... | bash` stdin is the script pipe, not the keyboard. Hand
# setup the terminal so it can wait while the user fills in .env.
if { : </dev/tty; } 2>/dev/null; then
  exec "$BUN_BIN" x --bun --package "$PACKAGE" sj-mail setup "$@" </dev/tty
fi
exec "$BUN_BIN" x --bun --package "$PACKAGE" sj-mail setup "$@"
