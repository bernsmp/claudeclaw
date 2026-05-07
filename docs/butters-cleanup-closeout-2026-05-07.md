# Butters Cleanup Closeout - 2026-05-07

## Current state

- Fork remote: `https://github.com/bernsmp/claudeclaw.git`
- Upstream remote: `https://github.com/earlyaidopters/claudeclaw`
- Fork `main` is at `f8fcb5c` / `f8fcb5ceffc7da187235277fb2d1d84b11603426`.
- MCC root `main` is at `5b759f7` and points `butters` at `f8fcb5c`.
- Local preservation branch: `codex/butters-preservation-2026-05-06` at `e9cf4fc`
- Preservation PR: https://github.com/bernsmp/claudeclaw/pull/1 is closed and unmerged. It is an archive only, not a merge candidate.
- Upstream `earlyaidopters/claudeclaw` `main` was fetched at `545a6d1` during final sanity review. Treat that as a separate future upstream-review question, not part of this preservation cleanup.

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
- PR #6, `Gate queued WhatsApp sends on approval`
  - Requires explicit approval before queued WhatsApp sends dispatch.
  - Preserves encrypted storage and purge assumptions.
- PR #7, `Add fresh-session memory guard`
  - Clarifies that `/newchat` resets active Claude session state only.
  - Preserves durable Memory v2 recall behavior and labels recalled context as potentially stale.
- PR #8, `Document external config for personal prompts`
  - Documents `CLAUDECLAW_CONFIG` and keeps personal prompts/private runtime context outside the public repo.
  - Confirms the default private config directory is `~/.claudeclaw`.

## Verification

Run from `/Users/maxb/Desktop/max-command-center/butters` after PR #8 was merged:

```bash
npm run typecheck
npm run build
node -e "import('./dist/config.js').then(m => console.log(m.CLAUDECLAW_CONFIG))"
DB_ENCRYPTION_KEY=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef npm test
```

Result:

- Typecheck passed.
- Build passed.
- Config check printed `/Users/maxb/.claudeclaw`.
- Test suite passed: 15 files, 235 tests.

Note: the test suite reads `.env` directly for Telegram file-send integration tests. On this machine those real Telegram tests ran and passed.

## Preserved local work

The original local cleanup/preservation commit chain is still available at:

```bash
git switch codex/butters-preservation-2026-05-06
```

Do not merge that branch wholesale. It contains valuable local work mixed with older upstream state and local-only artifacts.

## Final preservation decision

Do not keep searching the preservation branch by default. The useful surgical work has been ported. Remaining preservation-branch content is broad archive material: personal agents, operator docs, runtime references, social/content scripts, older dashboard and memory paths, and binary assets.

Only reopen the preservation branch if a concrete future bug or missing behavior points back to a specific file.

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

## Closeout

This cleanup is closed. Future work should start from fork `main`, not from the preservation branch.
