const Database = require('better-sqlite3');
const { CronExpressionParser } = require('cron-parser');

const db = new Database('/Users/maxb/Desktop/max-command-center/butters/store/claudeclaw.db');

const prompt = `IMPORTANT: Your entire response will be sent as a Telegram message. Do NOT add commentary or meta-text.

Run the weekly Claude Routines migration review.

Goal... keep the migration alive, evaluate progress honestly, and suggest the next smallest safe step.

## Load these first

- /Users/maxb/Desktop/max-command-center/docs/plans/2026-04-14-claude-routines-migration-tracker.md
- /Users/maxb/Desktop/max-command-center/butters/docs/runtime/scheduler-reference.md
- /Users/maxb/Desktop/max-command-center/butters/docs/runtime/capabilities-reference.md

## What to do

1. Read the tracker and summarize the current state for yourself:
   - what changed since the last review
   - what is stalled
   - what is still a hypothesis
   - what is the next smallest migration step

2. Update the tracker file in place:
   - set "Last updated" to today's date
   - append a new entry under "Weekly Review Log"
   - update any "Last Review", "Next Action", "Status", or "Verdict" fields that clearly changed
   - do not invent progress that did not happen

3. Decide whether Max needs an interruption right now.

Only interrupt if at least one is true:
- a pilot choice is blocked and Max needs to decide
- a planned step is stale by 7+ days
- a routine candidate should be rejected, not just delayed
- a concrete next action should be added to Tabby Suggested

4. If there is a concrete next step Max has not explicitly committed to yet, create a Tabby suggestion:

node /Users/maxb/Desktop/max-command-center/butters/scripts/suggest-tabby-task.mjs \\
  --title "[clear next step]" \\
  --why "[why this matters now]" \\
  --description "[1-2 sentence context]" \\
  --priority 2 \\
  --label routines \\
  --label migration \\
  --source-id claude-routines-review

Create at most one suggestion per run. Do not create duplicates if the same suggested step is already reflected in the tracker and still current.

## Output rules

- If there is nothing Max needs to notice or decide this week, respond with exactly: done
- Otherwise send one concise Telegram message in this format:

🟡 Claude Routines review

[What changed or what is stuck]
DEFAULT: [generic move]
EXPERT: [better move once you apply stack and governance context]
GAP: [what changed and why it matters now]
Reply: do it / skip
`;

// Monday at 11am ET
const cronExpr = '0 11 * * 1';
const interval = CronExpressionParser.parse(cronExpr, { tz: 'America/New_York' });
const nextRun = Math.floor(interval.next().toDate().getTime() / 1000);
const id = 'claude-routines-review';

const existing = db.prepare('SELECT id FROM scheduled_tasks WHERE id = ?').get(id);
if (existing) {
  db.prepare('DELETE FROM scheduled_tasks WHERE id = ?').run(id);
  console.log('Replaced existing task.');
}

db.prepare(`INSERT INTO scheduled_tasks (id, prompt, schedule, next_run, status, created_at, agent_id)
  VALUES (?, ?, ?, ?, 'active', ?, 'main')`)
  .run(id, prompt, cronExpr, nextRun, Math.floor(Date.now() / 1000));

console.log('Claude Routines review task scheduled: Monday at 11am ET.');
console.log('Next run:', new Date(nextRun * 1000).toLocaleString('en-US', { timeZone: 'America/New_York' }));
db.close();
