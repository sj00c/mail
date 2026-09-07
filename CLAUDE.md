# Claude Code installation guide

This repository is a local-only Gmail, Google Calendar, Google Drive, and Google Contacts web app. Help a non-developer install it on macOS or Windows without exposing credentials.

## Required behavior

1. Detect the operating system before running commands.
2. Read `README.md`, `.env.example`, and the matching installer before changing or running anything:
   - macOS: `deploy/install.sh`
   - Windows: `deploy/install.ps1`
3. Explain Google Cloud steps in plain Korean, one human action at a time.
4. Never ask the user to paste a Client Secret into chat or a command argument.
5. Have the user enter credentials directly into the local `.env` file. Never print, inspect, commit, or transmit its values.
6. Do not invent API keys. This app uses a Web application OAuth Client ID and Client Secret.
7. Keep the default port 8787 unless the installer reports that another program owns it. Then set `PORT` and `OAUTH_REDIRECT` in `.env` to the same free port and have the user add that redirect URI in Google Cloud Console before re-running. Never expose the server to the LAN.
8. Run the installer only after `.env` exists and the user confirms they saved both credential values.
9. Verify the build and `http://127.0.0.1:<PORT>/auth/status` (default 8787). Report the exact failing step when installation does not complete. On Windows, inspect `%LOCALAPPDATA%\MailLocal\install.log` for stage timings, Bun path/version, task result and the server log tail; server output is in `mail.local.log` in the same directory. Do not infer slow hardware, Defender, or invalid credentials from a timeout alone. A `bun` port owner is not necessarily this app.
10. Login starts the already-built app using `deploy/run.sh` (macOS) or `deploy/run.ps1` (Windows) and the absolute Bun path registered by the installer. Re-run the installer after source updates or moving the app; do not reintroduce builds at login or rely on the scheduler's PATH. Windows Task Scheduler retries a failed launch up to 3 times at one-minute intervals; restart intervals must be at least one minute.

## Installation source of truth

- Use `README.md` → “직접 설치하기” for Google Cloud links, API/scopes, credential setup, and platform commands. Do not maintain a second copy here.
- Run commands from the actual repository root containing `package.json` and `deploy/`.
- Follow the README's conditional `.env` creation command. Never overwrite an existing `.env`.
- Installation validates credential format, not Google's acceptance of the credentials. Keep readiness, OAuth success, and API access as separate checks.

## Safety boundaries

- `.env` and OAuth tokens are secrets and must remain untracked.
- The server must bind to `127.0.0.1`; never set `HOST=0.0.0.0`.
- Do not replace the installers with ad-hoc startup commands. They install Bun when needed, build the app, register automatic startup, and verify readiness.
- Do not run macOS commands on Windows or Windows commands on macOS.
