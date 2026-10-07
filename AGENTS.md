# Agent instructions

Read and follow [CLAUDE.md](CLAUDE.md) before running or changing anything. It is the single source of truth for installing, updating and operating this app, for every coding agent (Codex, Claude Code and others). Do not duplicate its rules here.

The essentials, in case a tool shows only this file:

- Install and update with the README one-liner (`deploy/bootstrap.ps1` on Windows, `deploy/bootstrap.sh` on macOS; nothing needs to be preinstalled), or `npx @sj00c/mail@latest setup` / `bunx @sj00c/mail@latest setup` when Node.js or Bun exists. Older ZIP/git/agent installations migrate with the same command.
- Diagnose with `npm run doctor` in the workspace (`~/sj-mail`); it never prints secrets.
- Never ask the user to paste a Client Secret into chat or a command argument; they type credentials into the workspace `.env` themselves.
- The server binds to `127.0.0.1` only.
