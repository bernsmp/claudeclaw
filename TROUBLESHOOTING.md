# Butters — Debug context for Claude Code / Cursor

**You are helping a human troubleshoot Butters.** You are not Butters. Butters is the service being debugged.

## What Butters is

- **Butters** = always-on AI assistant reachable via **Telegram** (@max_command_center_bot). Built on **ClaudeClaw** (Claude Code as a Telegram bot).
- **Runs on:** Mac Mini (or the machine where this repo lives). This repo is his codebase: `~/Desktop/max-command-center/butters/`.
- **Behavior config:** `~/Desktop/max-command-center/butters/CLAUDE.md` — that file is written *for* Butters (personality, rules). When *you* are debugging, use this file (TROUBLESHOOTING.md) and the repo; don’t confuse your role with his.
- **Full product spec** (schedules, commands, data sources): if mb-brain is on this machine, see `~/Desktop/mb-brain/0 - System/butters.md`.

## Quick proof-of-life and restart

| Check | Command |
|-------|--------|
| Is the bot process running? | `launchctl list \| grep claudeclaw` → expect `PID  0  com.claudeclaw.app` (PID is a number, 0 = exit code) |
| Restart the bot (kill in-flight request, start fresh) | `launchctl kickstart -k gui/$(id -u)/com.claudeclaw.app` |
| Recent logs (stdout) | `tail -100 /tmp/claudeclaw.log` |
| Recent errors | `tail -50 /tmp/claudeclaw.err` |

Logs are written by launchd from the plist: `StandardOutPath` / `StandardErrorPath` → `/tmp/claudeclaw.log` and `/tmp/claudeclaw.err`.

## Launchd services (this machine)

| Label | Purpose |
|-------|--------|
| `com.claudeclaw.app` | Main bot (Telegram). KeepAlive, so it restarts if it crashes. |
| `com.butters.precall-check` | Pre-call briefs every 5 min |
| `com.butters.postcall-check` | Post-call follow-ups every 5 min |
| `com.butters.db-backup` | DB backup 3:30 AM daily |

Plist location: `~/Library/LaunchAgents/` (e.g. `com.claudeclaw.app.plist`).

## When he’s “typing” forever

- Bot is in one long agent turn (big context, compaction, or many tool calls). Log will show `Starting agent query` and maybe `Context window compacted` without a following `Agent result received`.
- Options: wait; send a new Telegram message to try to supersede; or restart with the kickstart command above.

## Repo layout (relevant to debugging)

- `src/` — TypeScript source. Entry: bot + agent wiring.
- `dist/` — Compiled `node dist/index.js` is what launchd runs.
- `store/claudeclaw.db` — SQLite (sessions, tasks, user_preferences, etc.).
- `CLAUDE.md` — Butters’ own instructions (for the running bot), not for you.

## Making Claude Code on this machine “know” Butters

- **Option A — One-off:** When you start a session to debug Butters, run from this repo and tell Claude: “Read TROUBLESHOOTING.md for context on what Butters is and how to debug him.”
- **Option B — Always when in this project:** Use the Cursor rule in `.cursor/rules/butters-debug-context.mdc` (loads when this project is open). For Claude Code CLI, add a line to your **global** instructions so when you’re in `~/Desktop/max-command-center/butters` or ask about Butters, it has this context:
  - **Claude Code config:** `~/.config/claude/CLAUDE.md` or `~/.claude/CLAUDE.md` (machine-dependent). Add a short block, e.g.  
    *“When the user is in ~/Desktop/max-command-center/butters or asks about ‘Butters’, I am helping debug the Telegram bot that runs there. Read that repo’s TROUBLESHOOTING.md for who Butters is, log paths, and restart commands.”*
