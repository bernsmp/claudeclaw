# Butters Capabilities Reference

Load this only when the task is about what Butters can do, which recurring loops exist, whether a capability is currently part of the live operating surface, or how to use the installed CLI tools safely.

## Sanity check first

Before saying something does not exist, check the live scheduled task table:

```bash
sqlite3 ~/Desktop/max-command-center/butters/store/claudeclaw.db "SELECT id, schedule, status FROM scheduled_tasks ORDER BY id;"
```

## Core active capabilities

- Morning brief
- EOD recap
- Overdue loops alert
- Monday hygiene
- Billing alert
- Week-ahead brief
- AI Radar
- Weekly QA loop
- Beyond Prompts drafting on request only
- Gmail prescans for morning and EOD briefs
- AI news cache for morning brief

Note:
- verify the live set against `scheduled_tasks` before stating a loop is active
- do not trust this file over the DB when they disagree

## Silence rules

- Never send health check results, heartbeat summaries, or all-clear reports to Telegram
- Never send "nothing found" compound sweeps
- Default to `done` when a recurring loop found nothing worth Max's attention

## Subagent network

- Retainer AMs ... Illuminated, Zed, VPT, Mike David
- Cadence AMs ... Jessica Bruno, Mark Wallace, David Limiero
- AM-Portfolio
- PM Agent
- Compound Extractor
- Pattern Archaeologist
- Strategic Intelligence
- Content Intelligence

All of them write to `hive_mind`. PM synthesizes from there.

## CLI tools

Load this section when the task needs X, web research/browser automation, Google Workspace, or TTS from the shell.

### `bird`

Use for X posting, reading, search, replies, threads, and bookmarks.

Key rules:
- avoid `bird check` because it can trigger macOS Keychain prompts and hang
- use `bird whoami` to verify the logged-in account instead
- configured account is `@BeyondPrompts`
- `@MentalWeapons_1` is retired and should not be used

Auth pattern:
```bash
export AUTH_TOKEN=$(grep '^AUTH_TOKEN=' ~/Desktop/max-command-center/butters/.env | cut -d= -f2-)
export CT0=$(grep '^CT0=' ~/Desktop/max-command-center/butters/.env | cut -d= -f2-)
bird whoami
```

### `firecrawl`

Use for web scraping, search, and browser automation. Prefer it over ad hoc browser scraping.

Useful commands:
```bash
firecrawl scrape <url>
firecrawl search "query" --json --limit 20
firecrawl interact "describe what you see"
firecrawl interact -c "await page.click('.btn')"
firecrawl interact stop
```

Current high-signal features:
- `--only-main-content` for cleaner extraction with less nav/ad/cookie noise
- `interact` after scrape for buttons, forms, pagination, and JS-heavy pages
- `--scrape-formats` for markdown, html, links, or audio output
- `--pdf-mode fast|auto|ocr` with `--max-pages N` for controlled PDF extraction

Use pattern:
- search or scrape first
- escalate to `interact` only when content is hidden behind JS, buttons, tabs, or pagination
- always stop interact sessions when done

Bird workaround:
- if X search is flaky, scrape the search URL and then use `firecrawl interact` to scroll or extract

### `gog`

Use for Gmail, Drive, Calendar, Docs, Sheets, Contacts, and Tasks.

Accounts:
- `bernsmp@gmail.com`
- `max@maxpbernstein.com`

### `sag`

Use for ElevenLabs TTS from shell when spoken output is needed.

## Quick command examples

- `brief`
- `client [name]`
- `loops`
- `tasks`
- `health`
- `inbox`
- `radar`
- `library [topic]`
- `checkpoint`
