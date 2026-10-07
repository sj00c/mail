# Claude Code installation guide

This repository is a local-only Gmail, Google Calendar, Google Drive, and Google Contacts web app. Help a non-developer install it on macOS or Windows without exposing credentials.

## Required behavior

1. Detect the operating system before running commands.
2. Read `README.md` and `cli/mail.mjs` (`setup`) before changing or running anything. Distribution is npm-only: `bunx @sj00c/mail@latest setup` installs or updates into the workspace `~/sj-mail` (`--dir` to override). The platform scripts it runs live in the package's `deploy/` (`install.ps1`/`install.sh`).
3. Explain Google Cloud steps in plain Korean, one human action at a time.
4. Never ask the user to paste a Client Secret into chat or a command argument.
5. Have the user enter credentials directly into the workspace `.env` file. Never print, inspect, commit, or transmit its values.
6. Do not invent API keys. This app uses a Web application OAuth Client ID and Client Secret.
7. Keep the default port 8787 unless setup reports that another program owns it. Then set `PORT` and `OAUTH_REDIRECT` in `.env` to the same free port and have the user add that redirect URI in Google Cloud Console before re-running. Never expose the server to the LAN.
8. The first `setup` creates the `.env` template and stops; run it again only after the user confirms they saved both credential values.
9. Verify `http://127.0.0.1:<PORT>/auth/status` (default 8787). Report the exact failing step when setup does not complete. The setup screen is mirrored to `setup.log` (Windows `%LOCALAPPDATA%\MailLocal\`, macOS `~/Library/Logs/sj-mail/`); on Windows `install.log` in the same directory has stage timings, Bun path/version, task result and the server log tail; server output is `mail.local.log`. Do not infer slow hardware, Defender, or invalid credentials from a timeout alone. A `bun` port owner is not necessarily this app.
10. Login starts the packaged, already-built app via `deploy/run.sh` (macOS) or `deploy/run.ps1` (Windows) with the absolute Bun path and workspace registered by setup. Do not reintroduce builds at login or rely on the scheduler's PATH.
11. ZIP/git installations migrate with the same `setup`: it finds the old folder from the registered autostart entry (or `--from <folder>`), copies `.env` and `server/.data` without overwriting, and takes over `MailLocal`/`com.mail.local`. The old folder is left untouched. Until then, a checkout's `deploy/run.sh`/`run.ps1` keeps serving with its own `.env` when called without a workspace.
12. Lifecycle commands run in the workspace: `bun run status|start|stop|restart|uninstall` (Windows delegates to `deploy\windows-control.ps1`, which re-enables on Start and disables on Stop; the task has a one-minute repeating trigger with overlapping runs ignored). Do not kill arbitrary port owners or promise automatic recovery of a running-but-unresponsive process. Use status and the server log to diagnose, then restart when appropriate.

## Installation source of truth

- Use `README.md` for Google Cloud links, API/scopes, credential setup, and platform commands. Do not maintain a second copy here.
- Never overwrite an existing `.env`; setup only creates or migrates it when absent (or still the untouched template).
- Installation validates credential format, not Google's acceptance of the credentials. Keep readiness, OAuth success, and API access as separate checks.

## Safety boundaries

- `.env` and OAuth tokens are secrets and must remain untracked.
- The server must bind to `127.0.0.1`; never set `HOST=0.0.0.0`.
- Do not replace `setup` with ad-hoc startup commands. It checks Bun, installs the exact package version, migrates previous installations, registers automatic startup, and verifies readiness.
- Do not run macOS commands on Windows or Windows commands on macOS.
