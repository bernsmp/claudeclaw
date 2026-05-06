const Database = require('better-sqlite3');
const { CronExpressionParser } = require('cron-parser');

const db = new Database('/Users/maxb/Desktop/max-command-center/butters/store/claudeclaw.db');

const prompt = `IMPORTANT: Your entire response will be sent as a Telegram message. Do NOT add commentary or meta-text.

Run the weekly AI Watchlist resurfacer.

Your source of truth is:
- ~/Desktop/mb-brain/8 - External Fuel/AI-Tool-Radar/watchlist.md
- ~/Desktop/mb-brain/8 - External Fuel/AI-Tool-Radar/ai-tool-database.md
- The most recent 3 radar reports in ~/Desktop/mb-brain/8 - External Fuel/AI-Tool-Radar/

Goal: make "watch" mean something. Do NOT send a recap of the whole watchlist. Only resurface an item if it materially changed or now matches an active need.

## Step 1: Read the watchlist

For each row in watchlist.md with status = watch or test_later, extract:
- tool
- category
- status
- owner
- added_date
- revisit_after
- trigger
- why_it_matters
- source_url

## Step 2: Check for valid resurfacing triggers

An item should resurface ONLY if at least one is true:
1. The tool materially improved since it was added
2. It now solves a live system need Max is actively dealing with
3. Its revisit_after date has passed AND there is new evidence worth considering

Do NOT resurface an item just because time passed.

## Step 3: Update the watchlist

For each reviewed item:
- Set last_checked to today
- Update notes with one short line: "still watch", "promote to test", "ignore for now", or "adopted"
- If the item clearly graduated, update status:
  - watch -> test_later
  - test_later -> ready_to_test
  - watch/test_later -> ignore

Keep the table tidy. Preserve existing rows.

## Step 4: Decide whether to interrupt Max

If NO item has a real resurfacing trigger, respond with exactly:
done

If exactly one or two items deserve resurfacing, send only those.

Use this format:

👀 AI Watchlist — [date]

[Tool name]
THEN: [why it was originally a watch item]
NOW: [what changed]
CALL: [watch / test / ignore]
WHY: [1 sentence tied to Max's actual system]
Source: [URL]

Reply: test it / keep watching / ignore

No summaries. No "everything still looks good." No list of untouched items.`;

const cronExpr = '0 11 * * 6';
const interval = CronExpressionParser.parse(cronExpr, { tz: 'America/New_York' });
const nextRun = Math.floor(interval.next().toDate().getTime() / 1000);
const id = 'ai-watchlist-review';

const existing = db.prepare('SELECT id FROM scheduled_tasks WHERE id = ?').get(id);
if (existing) {
  db.prepare('DELETE FROM scheduled_tasks WHERE id = ?').run(id);
  console.log('Replaced existing task.');
}

db.prepare(`INSERT INTO scheduled_tasks (id, prompt, schedule, next_run, status, created_at, agent_id)
  VALUES (?, ?, ?, ?, 'active', ?, 'main')`)
  .run(id, prompt, cronExpr, nextRun, Math.floor(Date.now() / 1000));

console.log('AI Watchlist review task created: Saturdays at 11am ET.');
console.log('Next run:', new Date(nextRun * 1000).toLocaleString('en-US', { timeZone: 'America/New_York' }));
db.close();
