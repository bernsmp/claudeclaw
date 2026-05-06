# Butters Upstream Conflict Review — 2026-05-06

Scope: PR `bernsmp/claudeclaw#1`, branch `codex/butters-cleanup-2026-05-06`, base `bernsmp/claudeclaw:main`.

## Bottom Line

Do not merge this preservation branch wholesale into `main`.

The branch successfully preserves Max's local Butters work, but the fork's `main` has evolved into a newer generic ClaudeClaw product line with external config, security, encrypted message storage, migration tooling, Memory v2, queueing, launchd templates, MCP filtering, and newer dashboard work. A direct merge would mix a personalized Butters installation into generic upstream code and would regress or delete newer upstream systems.

Best path: keep this branch as the preservation reference, then port selected features in small PRs against current `main`.

## Merge Probe

I created an isolated review worktree at `/tmp/butters-conflict-review-2026-05-06` and ran:

```bash
git merge --no-commit --no-ff origin/main
```

Result: automatic merge failed with direct conflicts.

Conflicted files:

- `.env.example`
- `.gitignore`
- `CLAUDE.md`
- `README.md`
- `REBUILD_PROMPT.md`
- `agents/_template/CLAUDE.md`
- `agents/comms/CLAUDE.md`
- `agents/comms/agent.yaml.example`
- `agents/content/CLAUDE.md`
- `agents/ops/CLAUDE.md`
- `agents/research/CLAUDE.md`
- `assets/multi-agent-architecture.png`
- `scripts/agent-create.sh`
- `scripts/setup.ts`
- `src/agent-config.ts`
- `src/agent.ts`
- `src/battle-test.ts`
- `src/bot.ts`
- `src/config.ts`
- `src/dashboard-html.ts`
- `src/dashboard.ts`
- `src/db.test.ts`
- `src/db.ts`
- `src/index.ts`
- `src/memory.test.ts`
- `src/memory.ts`
- `src/obsidian.ts`
- `src/orchestrator.ts`
- `src/schedule-cli.ts`
- `src/scheduler.ts`
- `src/voice.ts`

## Upstream `main` Should Win By Default

Keep current `main` as the base for:

- External config boundary: `CLAUDECLAW_CONFIG`, `CLAUDE.md.example`, launchd templates, config sanitization
- Security: PIN lock, kill switch, audit log, dashboard auth hardening
- Message privacy: encrypted WA/Slack body storage and purge behavior
- Memory v2: embeddings, Gemini extraction, consolidation, semantic search, high-importance callbacks
- Runtime controls: message queueing, `AGENT_MAX_TURNS`, timeout behavior, structured logger improvements
- Migration system: `migrations.ts`, `scripts/migrate.ts`, startup guard, migration skill
- Agent productization: current templates, setup wizard, agent creation CLI, MCP allowlist
- Dashboard overhaul and Mission Control UI

These are broad upstream product features. The preservation branch predates or forks around many of them.

## Port Candidates

### 1. Hermes backend and shadow mode

Worth porting, but only as a surgical PR.

Source files on preservation branch:

- `src/agent-types.ts`
- `src/claude-runner.ts`
- `src/hermes-runner.ts`
- Hermes portions of `src/agent.ts`
- Hermes env vars in `.env.example` / `src/config.ts`
- `src/agent.test.ts`

Port strategy:

- Keep upstream `src/agent.ts` behavior for MCP loading, `AGENT_MAX_TURNS`, and external config.
- Introduce backend abstraction without removing upstream Claude runner features.
- Gate Hermes to manual/dashboard or explicit scheduler allowlist.
- Keep shadow mode read-only by default and log shadow outputs to `hive_mind`.

### 2. WhatsApp approval gate

Worth porting carefully.

Source file:

- `scripts/wa-daemon.ts`

Port strategy:

- Preserve upstream encryption/purge assumptions.
- Add `approval_required`, `approved_at`, and `approval_source` to `wa_outbox` through the current migration system, not ad hoc runtime ALTERs only.
- Ensure send loop only dispatches approved messages unless explicit bypass is configured.

### 3. Fresh-session memory guard and `/recall`

Partially worth porting.

Source files:

- `src/bot.ts`
- `src/memory.ts`
- `src/lcm/**`

Port strategy:

- Do not replace upstream Memory v2 with LCM.
- Port the UX guard that distinguishes a fresh Claude session from durable memory recall.
- Evaluate whether `/recall` should use upstream conversation history and Memory v2 search rather than the LCM DAG.
- Treat LCM as experimental unless it is integrated with Memory v2 and migrations.

### 4. Pending draft review and QA approval commands

Possibly worth porting if the product still needs Butters-specific content ops.

Source files:

- `src/bot.ts`
- `src/db.ts`
- `scripts/draft-quality-gate.mjs`
- social/content scripts

Port strategy:

- Keep this out of generic ClaudeClaw unless the fork is intentionally becoming Max's Butters distribution.
- If ported, add migrations and tests against current schema.

### 5. Runtime docs and cleanup inventory

Keep on preservation branch or move to a Max-specific docs area.

Source files:

- `docs/runtime/**`
- `reports/butters-cleanup-inventory-2026-05-06.md`
- `AGENTS.md`, `TROUBLESHOOTING.md`, operator/social docs

Port strategy:

- Do not merge Max-specific operations docs into generic upstream `main`.
- If useful, create a `docs/max-butters/` or private operations repo.

## Leave Preserved, Do Not Port Wholesale

- Max-specific AM network under `agents/am-*`, `agents/pm`, `agents/compound-extractor`, `agents/content-intelligence`, `agents/pattern-archaeologist`, `agents/strategic-intelligence`
- AI Radar, Typefully, PM poller, CF refresh, Gmail prescan, Substack, and social content scripts
- `CLAUDE.md` personalization for Butters
- top-level operator/social voice docs
- `butters-architecture-whiteboard.png`
- `REBUILD_PROMPT.md`

These are valuable, but they are personal operating assets, not generic ClaudeClaw source.

## Suggested PR Sequence

1. `feat: add agent backend abstraction with Hermes shadow mode`
2. `feat: require approval before WhatsApp outbox sends`
3. `fix: clarify fresh session versus durable memory recall`
4. `docs: preserve Max-specific Butters operations as non-product reference`

Each PR should be based on current `bernsmp/claudeclaw:main`, not on the preservation branch merge result.

## Verification Already Done On Preservation Branch

- `npm run typecheck` passed
- `npm test` passed after local `npm rebuild better-sqlite3`
- SQLite DBs, secrets, generated runtime folders, and local tool mirrors were not committed

