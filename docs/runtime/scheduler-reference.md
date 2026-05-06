# Butters Scheduler Reference

Load this only when the task is about scheduling, rebuilding scheduled tasks, or understanding what the live recurring loops are supposed to do.

## Schedule CLI

```bash
node ~/Desktop/max-command-center/butters/dist/schedule-cli.js create "PROMPT" "CRON"
node ~/Desktop/max-command-center/butters/dist/schedule-cli.js list
node ~/Desktop/max-command-center/butters/dist/schedule-cli.js delete <id>
node ~/Desktop/max-command-center/butters/dist/schedule-cli.js pause <id>
```

## Core recurring loops

- Morning brief ... 8am daily
- Evening Big 3 check-in ... 9pm daily
- Billing check ... 9am Monday
- Week-ahead brief ... 5pm Friday
- Monday hygiene ... 9am Monday
- Overdue loop alert ... 9am daily
- BP queue refill ... currently disabled by design. Beyond Prompts is on-demand only.
- AI Radar ... 4pm Monday/Wednesday/Friday
- Claude Routines review ... 11am Monday
- Weekly QA loop ... Sunday

For the exact live task list, query:

```bash
sqlite3 ~/Desktop/max-command-center/butters/store/claudeclaw.db "SELECT id, schedule, status FROM scheduled_tasks ORDER BY id;"
```

## Morning brief operating notes

- Pull calendar, open loops, active tasks, system status, and billing summary from MCC
- Read `~/Desktop/mb-brain/0 - System/goals.md`
- Load latest AI Table output only if it is fresh enough to matter
- Suggest exactly 3 Daily Big 3 items when there is real work to prioritize
- After sending, run:

```bash
cd ~/Desktop/max-command-center && npm run write-planner
```

## Evening Big 3 operating notes

- Suggest tomorrow's Big 3 from tomorrow-first, then this-week tasks
- Max can confirm, replace, partially edit, or skip
- Once confirmed:
  - write tomorrow's planner via `write-full-focus-planner.mjs --tomorrow`
  - patch matching MCC tasks with `today-big-3`

## Silence rules

- If a recurring loop finds nothing new, return exactly `done`
- Do not send all-clear summaries
- Do not send low-signal no-op recaps just because a task ran
