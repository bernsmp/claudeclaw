# Butters Cleanup Closeout - 2026-05-07

## Current state

- Fork remote: `https://github.com/bernsmp/claudeclaw.git`
- Upstream remote: `https://github.com/earlyaidopters/claudeclaw`
- Fork `main` contains the merged cleanup slices listed below.
- MCC root should track the latest Butters `main` SHA after this closeout doc is committed.
- Local preservation branch: `codex/butters-preservation-2026-05-06` at `e9cf4fc`
- Preservation PR: https://github.com/bernsmp/claudeclaw/pull/1 remains open as a record, not for wholesale merge.

## Merged cleanup slices

- PR #2, `Add Hermes backend shadow mode`
  - Adds `AGENT_BACKEND=claude|hermes|shadow`.
  - Keeps Claude as the default live path.
  - Allows Hermes for manual/dashboard, scheduler only by allowlist, and keeps delegation on Claude.
  - Logs shadow results to `hive_mind`.
- PR #3, `Align scheduler truncation test with stored result limit`
  - Updates the stale scheduler test to match the current 4000-character stored result limit.
- PR #4, `Ignore local agent and runtime artifacts`
  - Ignores local agent/tool mirrors, DB sidecars, runtime artifacts, generated local skill mirrors, and known local drafts.
  - Does not delete any local files.
- PR #5, `Add Node version config`
  - Adds `.nvmrc` with Node 22 for consistent local runtime selection.

## Verification

Run from `/Users/maxb/Desktop/max-command-center/butters` after PR #5 was merged:

```bash
npm run build
DB_ENCRYPTION_KEY=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef npm test
```

Result:

- Build passed.
- Test suite passed: 15 files, 230 tests.

Note: the test suite reads `.env` directly for Telegram file-send integration tests. On this machine those real Telegram tests ran and passed.

## Preserved local work

The original local cleanup/preservation commit chain is still available at:

```bash
git switch codex/butters-preservation-2026-05-06
```

Do not merge that branch wholesale. It contains valuable local work mixed with older upstream state and local-only artifacts.

## Remaining surgical review candidates

Review and port selectively from the preservation branch only if the current `main` does not already supersede them:

- WhatsApp approval gate.
- Fresh-session memory guard and recall UX.
- Selected docs/reference material that is still accurate after the upstream dashboard, memory, queueing, and external-config updates.

Current fork `main` should continue to win by default for:

- External config layout.
- Encrypted WhatsApp/Slack storage.
- Migrations and Memory v2 behavior.
- Message queueing.
- Launchd templates.
- MCP filtering.
- Dashboard overhaul.

## Do not delete

Local generated and runtime folders are now ignored, but they were not removed. Do not delete them unless separately classified and approved.

Representative local-only ignored paths include:

- `.adal/`, `.agents/`, `.claude/`, `.cursor/`, `.goose/`, `.qwen/`, `.roo/`, `.windsurf/`
- `store/`, `workspace/`, local `*.db` files and SQLite sidecars
- `skills-lock.json`, local `skills/higgsfield-*` mirrors
- `assets/banner in paper.mp4`
- `x-profile-draft.md`

## Next recommended session

Start with a read-only comparison of the WhatsApp approval gate from `codex/butters-preservation-2026-05-06` against current `main`, then decide whether it deserves a small port PR.
