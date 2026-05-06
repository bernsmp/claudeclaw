const Database = require('better-sqlite3');
const { CronExpressionParser } = require('cron-parser');

const db = new Database('/Users/maxb/Desktop/max-command-center/butters/store/claudeclaw.db');

const prompt = `IMPORTANT: Your entire response will be sent as a Telegram message. Do NOT add commentary or meta-text.

Review this week's social content drafts from the voice learning log and send a pattern summary to Max.

Run this to get the week's data:
sqlite3 ~/Desktop/max-command-center/butters/store/claudeclaw.db "SELECT original_draft, final_posted, was_edited, was_skipped, edit_diff, platform FROM voice_learning_log WHERE timestamp > strftime('%s', 'now', '-7 days') ORDER BY timestamp DESC;"

If there are no entries (empty result), respond with exactly: done

If there ARE entries, analyze what Max consistently edited, approved as-is, or skipped. Then send this format (skip sections with no data):

📊 Voice patterns this week

✅ Landing as-is:
› [pattern with example]

✂️ Consistently edited:
› [what changed and why, with example diff]

❌ Skipped:
› [pattern in what got dismissed]

💡 Adjustment:
› [one specific thing I'll do differently next week]

Keep it under 15 lines. Only include sections with actual data.`;

const cronExpr = '0 19 * * 0';
const interval = CronExpressionParser.parse(cronExpr, { tz: 'America/New_York' });
const nextRun = Math.floor(interval.next().toDate().getTime() / 1000);
const id = 'sun-voice-summary';

const existing = db.prepare('SELECT id FROM scheduled_tasks WHERE id = ?').get(id);
if (existing) {
  db.prepare('DELETE FROM scheduled_tasks WHERE id = ?').run(id);
  console.log('Replaced existing task.');
}

db.prepare(`INSERT INTO scheduled_tasks (id, prompt, schedule, next_run, status, created_at, agent_id)
  VALUES (?, ?, ?, ?, 'active', ?, 'main')`)
  .run(id, prompt, cronExpr, nextRun, Math.floor(Date.now()/1000));

console.log('Sunday voice summary task created.');
console.log('Next run:', new Date(nextRun * 1000).toLocaleString('en-US', { timeZone: 'America/New_York' }));
db.close();
