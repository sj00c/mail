# Claude Code installation guide

This repository is a local-only Gmail, Google Calendar, Google Drive, and Google Contacts web app. Help a non-developer install it on macOS or Windows without exposing credentials.

## Required behavior

1. Detect the operating system before running commands.
2. Read `README.md` and `cli/mail.mjs` (`setup`, `doctor`) before changing or running anything. Distribution is npm-only. The README one-liners (`deploy/bootstrap.ps1` / `deploy/bootstrap.sh`) need nothing preinstalled: they install Bun with the official installer when missing and run `bun x --bun @sj00c/mail@latest setup`. With Node.js 22+ or Bun already present, `npx @sj00c/mail@latest setup` / `bunx @sj00c/mail@latest setup` are equivalent. Setup installs or updates into the workspace `~/sj-mail` (`--dir` to override); the platform scripts it runs live in the package's `deploy/` (`install.ps1`/`install.sh`).
3. Explain Google Cloud steps in plain Korean, one human action at a time.
4. Never ask the user to paste a Client Secret into chat or a command argument.
5. Have the user enter credentials directly into the workspace `.env` file. Never print, inspect, commit, or transmit its values.
6. Do not invent API keys. This app uses a Web application OAuth Client ID and Client Secret.
7. Keep the default port 8787 unless setup reports that another program owns it. Then set `PORT` and `OAUTH_REDIRECT` in `.env` to the same free port and have the user add that redirect URI in Google Cloud Console before re-running. Never expose the server to the LAN.
8. In a terminal, setup opens `.env` in the editor and waits for Enter, re-checking it each time. Without a TTY (agents, scripts) the first `setup` creates the `.env` template and stops; run it again only after the user confirms they saved both credential values. Only Gmail, Calendar and Drive APIs are required; the People API is optional (contact suggestions stay empty without it).
9. Diagnose with `npm run doctor` in the workspace (also printed at the end of setup): it checks Bun, the installed app, `.env`, automatic startup, the server and per-API Google access, prints a fix for each problem, never prints secrets, and exits nonzero on failures. Verify `http://127.0.0.1:<PORT>/auth/status` (default 8787). Report the exact failing step when setup does not complete. The setup screen is mirrored to `setup.log` (Windows `%LOCALAPPDATA%\MailLocal\`, macOS `~/Library/Logs/sj-mail/`); on Windows `install.log` in the same directory has stage timings, Bun path/version, task result and the server log tail; server output is `mail.local.log`. Do not infer slow hardware, Defender, or invalid credentials from a timeout alone. A `bun` port owner is not necessarily this app.
10. Login starts the packaged, already-built app via `deploy/run.sh` (macOS) or `deploy/run.ps1` (Windows) with the absolute Bun path and workspace registered by setup. Do not reintroduce builds at login or rely on the scheduler's PATH.
11. ZIP/git installations migrate with the same `setup`: it finds the old folder from the registered autostart entry (or `--from <folder>`), copies `.env` and `server/.data` without overwriting, and takes over `MailLocal`/`com.mail.local`. The old folder is left untouched. Until then, a checkout's `deploy/run.sh`/`run.ps1` keeps serving with its own `.env` when called without a workspace.
12. Lifecycle commands run in the workspace: `npm run status|start|stop|restart|uninstall` (Windows delegates to `deploy\windows-control.ps1`). Always-on contract: sign-in (including after restart) starts the server; a server that exits is relaunched by the task's one-minute repeating trigger (overlapping runs ignored) or launchd KeepAlive. `stop` lasts only until the next sign-in: on Windows it sets a volatile `HKCU\Software\MailLocalPaused` flag that `run.ps1` honors and keeps the task enabled; `start`, `restart` and `setup` clear it. Only `uninstall` turns automatic startup off. The Windows server log appends every `Starting Mail`/`Mail exited` across setups. Do not kill arbitrary port owners or promise automatic recovery of a running-but-unresponsive process. Use status (it shows the last launcher event) and the server log to diagnose, then restart when appropriate.

## Installation source of truth

- Use `README.md` for Google Cloud links, API/scopes, credential setup, and platform commands. Do not maintain a second copy here.
- Never overwrite an existing `.env`; setup only creates or migrates it when absent (or still the untouched template).
- Installation validates credential format, not Google's acceptance of the credentials. Keep readiness, OAuth success, and API access as separate checks.

## Safety boundaries

- `.env` and OAuth tokens are secrets and must remain untracked.
- The server must bind to `127.0.0.1`; never set `HOST=0.0.0.0`.
- Do not replace `setup` with ad-hoc startup commands. It checks Bun, installs the exact package version, migrates previous installations, registers automatic startup, and verifies readiness.
- Do not run macOS commands on Windows or Windows commands on macOS.
