const Database = require('better-sqlite3');
const { CronExpressionParser } = require('cron-parser');

const db = new Database('/Users/maxb/Desktop/max-command-center/butters/store/claudeclaw.db');

const prompt = `IMPORTANT: Your entire response will be sent as a Telegram message. Do NOT add commentary or meta-text.

# Feature Friday — Capability Rediscovery

You are running Max's Friday capability audit. Your job: find 3 non-obvious ways Max could use his existing tools and skills that he's NOT currently thinking about.

This is NOT "did you know you have X?" That's useless. This is: "Given what you're working on THIS WEEK, here's a specific capability collision you're missing."

---

## Step 1: Load current week context

Run these in parallel to understand what Max is doing right now:

**Calendar (this week + next week):**
Load MCC_API_KEY:
export MCC_API_KEY=$(grep MCC_API_KEY ~/Desktop/max-command-center/.env.local | cut -d= -f2)
export MCC_BASE="https://max-command-center.max-command-center.workers.dev"

curl -s -H "x-api-key: $MCC_API_KEY" "$MCC_BASE/api/calendar/events?timeMin=$(date -v-5d +%Y-%m-%dT00:00:00Z)&timeMax=$(date -v+7d +%Y-%m-%dT23:59:59Z)" 2>/dev/null

**Active tasks and open loops:**
curl -s -H "x-api-key: $MCC_API_KEY" "$MCC_BASE/api/tasks?status=active" 2>/dev/null
curl -s -H "x-api-key: $MCC_API_KEY" "$MCC_BASE/api/open-loops?status=open" 2>/dev/null

**Active clients (what retainers and projects are live):**
curl -s -H "x-api-key: $MCC_API_KEY" "$MCC_BASE/api/clients" 2>/dev/null

**Content pipeline status:**
Read ~/Desktop/mb-brain/0 - System/Dashboards/content-week.md (if it exists) for current content priorities.

**Recent skill usage (last 14 days):**
Check ~/.claude/ecc/sessions/ and ~/.claude/ecc/metrics/ for any skill invocation logs.
Also check the last 20 git commits in ~/Desktop/mb-brain/ for clues about what Max has been working on:
cd ~/Desktop/mb-brain && git log --oneline -20

---

## Step 2: Load the full skills manifest

Read ALL skill SKILL.md files to understand what each one does:

ls -d ~/.claude/skills/*/SKILL.md 2>/dev/null | head -80

For each skill, read the first 10 lines (the description/purpose section). Build a mental map of:
- What it takes as input
- What it produces as output
- What domain it operates in

Also scan the orchestration skills specifically (these chain other skills):
ls ~/Desktop/max-command-center/skills/orchestration/

---

## Step 3: Cross-reference — find the 3 suggestions

Apply these three lenses, one suggestion per lens:

### Lens 1: The Forgotten Tool
Find a skill that hasn't been used in 14+ days that would save time or improve quality on something Max is ALREADY doing this week. The question: "What are you doing the hard way right now?"

Look for:
- Manual work that a skill automates
- A task on the todo list that maps directly to a skill
- A client deliverable coming up that a skill could accelerate

### Lens 2: The Unexpected Angle
Take a skill designed for one domain and apply it to a completely different current problem. The question: "What would happen if you pointed this tool sideways?"

Examples of the kind of thinking:
- /competitor-website-analysis on Max's OWN site
- /voice-extractor on a client's competitor
- /pattern-extraction-universal on calendar data or email threads
- /implicit-insights on a client's own content (not just transcripts)
- /content-architecture on an internal process doc

### Lens 3: The Compounding Play
Identify two skills that have never been chained together but could create something new given this week's work. The question: "What pipeline doesn't exist yet but should?"

Look for:
- Output of skill A = natural input for skill B
- A recurring task that could become a one-command pipeline
- Two skills that each solve half of a current problem

---

## Step 4: Format and send

Send this exact format to Telegram:

🔮 Feature Friday — [date]

Here are 3 ways your tools could be working harder for you this week:

**1. 🔧 The Forgotten Tool**
[Skill name] — [what it does, one line]

→ This week you're [specific thing from context]. Instead of [how Max is probably doing it], run:
\`/[exact command]\`
[One sentence on what changes]

**2. 🔄 The Unexpected Angle**
[Skill name] — normally used for [X], but...

→ Point it at [specific current thing]. Why: [one sentence reasoning]
\`/[exact command with args]\`

**3. ⛓️ The Compounding Play**
[Skill A] → [Skill B]

→ [Describe the pipeline in one sentence]. This matters because [connects to current work].
Run: \`/[skill-a]\` then pipe output to \`/[skill-b]\`

---
💡 Reply with 1, 2, or 3 to run any of these now.`;

// Fridays at 9:00 AM ET
const cronExpr = '0 9 * * 5';
const interval = CronExpressionParser.parse(cronExpr, { tz: 'America/New_York' });
const nextRun = Math.floor(interval.next().toDate().getTime() / 1000);
const id = 'feature-friday';

const existing = db.prepare('SELECT id FROM scheduled_tasks WHERE id = ?').get(id);
if (existing) {
  db.prepare('DELETE FROM scheduled_tasks WHERE id = ?').run(id);
  console.log('Replaced existing task.');
}

db.prepare(`INSERT INTO scheduled_tasks (id, prompt, schedule, next_run, status, created_at, agent_id)
  VALUES (?, ?, ?, ?, 'active', ?, 'main')`)
  .run(id, prompt, cronExpr, nextRun, Math.floor(Date.now()/1000));

console.log('Feature Friday task registered: Fridays at 9:00 AM ET.');
console.log('Next run:', new Date(nextRun * 1000).toLocaleString('en-US', { timeZone: 'America/New_York' }));
db.close();
