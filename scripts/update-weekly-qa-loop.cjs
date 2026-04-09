const Database = require('better-sqlite3');

const db = new Database('/Users/maxb/Desktop/max-command-center/butters/store/claudeclaw.db');

const prompt = `Run the weekly QA/QC self-improvement loop. IMPORTANT: Your entire response will be sent as a Telegram message.

TODAY=$(date +%Y-%m-%d)
WEEK=$(date +%Y-W%V)

## STEP 1 — Score each active feature against its rubric

Load recent data:
sqlite3 ~/Desktop/max-command-center/butters/store/claudeclaw.db "
  SELECT id, last_result, status FROM scheduled_tasks WHERE last_run > strftime('%s','now','-7 days');
"
sqlite3 ~/Desktop/max-command-center/butters/store/claudeclaw.db "
  SELECT platform, was_edited, was_skipped, edit_diff FROM voice_learning_log WHERE timestamp > strftime('%s','now','-7 days');
"
sqlite3 ~/Desktop/max-command-center/butters/store/claudeclaw.db "
  SELECT id, account, platform, status, typefully_id, x_published_url, posted_at, scheduled_for, impressions, likes, replies, reposts, bookmarks
  FROM pending_drafts
  WHERE timestamp > strftime('%s','now','-7 days')
  ORDER BY timestamp DESC;
"
sqlite3 ~/Desktop/max-command-center/butters/store/claudeclaw.db "
  SELECT agent_id, action, summary, artifacts, created_at
  FROM hive_mind
  WHERE agent_id IN ('butters-precall', 'butters-postcall', 'butters-receipts')
    AND action IN ('precall_brief', 'precall_receipt_prompt', 'precall_receipt_reminder', 'precall_receipt')
    AND created_at > strftime('%s','now','-7 days')
  ORDER BY created_at DESC;
"
sqlite3 ~/Desktop/max-command-center/butters/store/claudeclaw.db "
  SELECT feature, change_summary, applied_at
  FROM behavior_changes
  WHERE applied_at > datetime('now','-30 days')
  ORDER BY applied_at DESC;
"

Score each feature 1-10 against these rubrics:

**morning_brief**: Did it include calendar + tasks + billing + AI news? Was it under 30 lines? No hallucinated client data?
**precall_brief**: Score only from outcome rows in hive_mind: \`precall_brief\`, \`precall_receipt_prompt\`, \`precall_receipt_reminder\`, and \`precall_receipt\`. Ignore \`precall_check\` rows entirely. Did sent briefs land in the 10-20 minute window? Did they include real client context? Did the loop produce receipt prompts and any actual receipts? Treat silent non-meeting skips and empty polling windows as expected behavior, not misses.
**eod_recap**: Did it include completed tasks + open items + tomorrow's schedule? Was inbox check included?
**content_draft**: Were drafts free of kill-list patterns? Did voice match Max's style? For Beyond Prompts, separate approval health from post health: drafts in "awaiting" are pending Max review, not failures. Score misses when drafts pile up too long without review, when approved drafts fail to get scheduled, or when posted drafts still require heavy edits. If pending_drafts contains live/scheduled rows with URLs or metrics, use that as the publish ledger. If metrics are present, mention them as supporting evidence, not the only score driver.
**ai_radar**: Did it find real tools with real URLs? Were content drafts produced?

When scoring \`precall_brief\`, treat missing outcome observability as a serious miss. The canonical evidence source is only the outcome rows from \`butters-precall\`, \`butters-postcall\`, and \`butters-receipts\`. Legacy \`precall_check\` rows are scheduler noise and must not count for or against the score.

Also compute a compact receipt summary for the week:
- briefs_sent = count of \`precall_brief\` rows with status = sent
- receipt_prompts_sent = count of \`precall_receipt_prompt\` rows with status = sent
- receipt_reminders_sent = count of \`precall_receipt_reminder\` rows
- receipts_logged = count of \`precall_receipt\` rows
- used_yes = count of \`precall_receipt\` rows where used_brief = yes
- changed_yes = count of \`precall_receipt\` rows where changed_call = yes

If there are 0 receipts_logged but prompts were sent, say that clearly. The point is to make the loop visible, not flattering.
If there are 0 briefs_sent and 0 receipt_prompts_sent for the week, do not invent a failure from that alone. Call out low sample size and score based on the quality of observed outcomes plus whether failures were logged clearly.

## STEP 2 — Insert scores

For each feature, insert into qa_scores:
sqlite3 ~/Desktop/max-command-center/butters/store/claudeclaw.db "
  INSERT INTO qa_scores (week, feature, score, rubric_hits, rubric_miss, evidence, proposed_fix)
  VALUES ('$WEEK', '[feature]', [score], '[hits json]', '[miss json]', '[example]', '[fix]');
"

After inserting each row, keep track of the inserted row id so you can reference the top proposed fix precisely.

## STEP 3 — Identify top improvement

Find the lowest-scoring feature. Write 1-2 sentence proposed fix. Insert with fix_status='pending'.

If a recent row already exists in behavior_changes for the same feature, mention whether this week's score suggests the change helped, failed, or is still inconclusive.

## STEP 4 — Send Telegram summary

Format:
📊 Weekly QA — $WEEK

✅ Better:
› [feature] — [what improved, with one concrete reason]
[omit section if nothing clearly improved]

⚠️ Needs work:
› [feature] — [what missed, with one concrete reason]
› [feature] — [second important miss]

📈 Scorecard:
› [feature]: [score]/10
› [feature]: [score]/10
› [feature]: [score]/10
› [feature]: [score]/10
› [feature]: [score]/10

Overall: [avg]/10

🎯 Pre-call receipt loop:
› briefs sent: [n]
› receipt prompts: [n]
› reminders: [n]
› receipts logged: [n]
› used=yes: [n]
› changed=yes: [n]
› read: [one sentence on whether the loop is actually being used]

🔧 Top fix:
› [feature] (fix id [qa_score_id]) — [one-line proposed change]

If a recently applied behavior change clearly helped, include:
✅ Change check:
› [feature]: [change summary] → [better / flat / worse]

Reply:
› approve fix [qa_score_id]
› reject fix [qa_score_id]: [reason]

Keep the whole message tight. Lead with what changed, not just the numbers.`;

const taskId = 'weekly-qa-loop';
const existing = db.prepare('SELECT id FROM scheduled_tasks WHERE id = ?').get(taskId);

if (!existing) {
  console.error('weekly-qa-loop task not found.');
  process.exit(1);
}

db.prepare('UPDATE scheduled_tasks SET prompt = ? WHERE id = ?').run(prompt, taskId);
console.log('Updated weekly-qa-loop prompt.');
db.close();
