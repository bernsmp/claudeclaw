const Database = require('better-sqlite3');
const { CronExpressionParser } = require('cron-parser');

const db = new Database('/Users/maxb/Desktop/max-command-center/butters/store/claudeclaw.db');

const prompt = `IMPORTANT: Your entire response will be sent as a Telegram message. Do NOT add commentary or meta-text.

Run the AI Tool Radar scan. Three jobs: scan for new tools, check updates to Max's current stack, and maintain the durable watchlist.

Load EXA_API_KEY:
export EXA_API_KEY=$(grep EXA_API_KEY ~/Desktop/max-command-center/butters/.env | cut -d= -f2)
TODAY=$(date +%Y-%m-%d)
SINCE=$(date -v-3d +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -d '3 days ago' +%Y-%m-%dT%H:%M:%SZ)

## PART 1: New AI Tools & APIs

Search 1 — Exa /answer for new tools (this returns synthesized answer WITH source URLs in citations array):
curl -s -X POST "https://api.exa.ai/answer" \\
  -H "x-api-key: $EXA_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"query": "new AI tools APIs CLIs developer capabilities released this week '"$TODAY"'", "text": true}'

Extract from response: answer text AND all citations[].url fields. Every finding MUST include its source URL.

Search 2 — Reddit sweep (extract title, url, highlights for each result):
curl -s -X POST "https://api.exa.ai/search" \\
  -H "x-api-key: $EXA_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"query": "new AI tool API launch release announced", "numResults": 6, "includeDomains": ["reddit.com"], "type": "neural", "startPublishedDate": "'"$SINCE"'", "contents": {"highlights": {"numSentences": 2}, "text": false}}'

Search 3 — X/Twitter sweep (extract title, url, highlights):
curl -s -X POST "https://api.exa.ai/search" \\
  -H "x-api-key: $EXA_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"query": "just released new AI API tool worth knowing for developers", "numResults": 6, "includeDomains": ["x.com", "twitter.com"], "type": "neural", "startPublishedDate": "'"$SINCE"'", "contents": {"highlights": {"numSentences": 2}, "text": false}}'

Search 4 — Product Hunt AI (new AI products):
curl -s -X POST "https://api.exa.ai/search" \\
  -H "x-api-key: $EXA_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"query": "new AI product launched this week", "numResults": 4, "includeDomains": ["producthunt.com"], "type": "neural", "startPublishedDate": "'"$SINCE"'", "contents": {"highlights": {"numSentences": 1}, "text": false}}'

## PART 2: Stack update checks

For each tool, run an Exa /answer search and capture both the answer AND citation URLs:

Tools to check (only if something genuinely new in the last 3 days):
- "Anthropic Claude API new features '"$TODAY"'"
- "Exa AI search API update '"$TODAY"'"  
- "Cloudflare Workers AI new features '"$TODAY"'"
- "Cursor IDE update '"$TODAY"'"
- "ElevenLabs API update '"$TODAY"'"
- "Groq API new models '"$TODAY"'"
- "Typefully new features '"$TODAY"'"
- "Gemini Google AI new release '"$TODAY"'"
- "Chrome DevTools MCP server update '"$TODAY"'"

For each stack check, extract: what changed + source URL from citations[0].url

## PART 3: Score and store findings

For each meaningful find (score 3+), append a row to ~/Desktop/mb-brain/8 - External Fuel/AI-Tool-Radar/ai-tool-database.md.

IMPORTANT: Every row must include the actual source URL. Format:
| $TODAY | [Tool name] | [Category] | [Score 1-5] | [✅/🟡/❌] | [What it means for a business owner — 1 sentence] | [full URL] |

Scoring:
- 5: Changes how you'd build or operate something today
- 4: Better/cheaper version of something already in use
- 3: Worth knowing, actionable in 3-6 months
- 2: Interesting but not yet actionable
- 1: Noise — skip

Skip anything already logged this week (check ai-tool-database.md for $TODAY entries first).

## PART 4: Maintain watchlist

Read and update:
- ~/Desktop/mb-brain/8 - External Fuel/AI-Tool-Radar/watchlist.md

For each score 4-5 find:
- decide one status: watch / test_later / ignore / adopted
- if it belongs on the watchlist, add or update a row

For each score 3 find:
- default to watch unless there is a strong reason to ignore it

Every tracked row must include:
- tool
- category
- status
- owner (Max / Butters / Hermes)
- added date
- revisit_after date
- last_checked date
- trigger
- why_it_matters
- source_url
- notes

Rules:
- update existing rows instead of duplicating them
- do NOT add noise items scored 1-2
- if an item is already on the watchlist and nothing material changed, only update last_checked and notes
- if an item is already adopted, leave it as adopted unless it clearly regressed

## PART 5: Save report file

Write to ~/Desktop/mb-brain/8 - External Fuel/AI-Tool-Radar/$TODAY-radar.md:

---
date: $TODAY
---

# AI Radar — $TODAY

## 🔥 Top Finds (score 4-5)

**[Tool Name]** — [Score]/5
[1-2 sentences what it does]
→ *What it means: [business owner angle]*
→ Source: [full clickable URL]

## 📡 Worth Watching (score 3)

**[Tool Name]**
[what it does + why to watch]
→ Source: [full clickable URL]

## 🔄 Stack Updates

| Tool | What Changed | Source |
|------|-------------|--------|
| [tool] | [change] | [URL] |

(Skip section if nothing in stack changed today)

## ✍️ Content Angles

1. **[Headline]**
   [2-sentence angle — what it is + what it actually means for a non-technical business owner]
   → Best platform: [X / LinkedIn / Substack Notes]

## 👀 Watchlist Changes

- Added: [tool] — [status]
- Updated: [tool] — [what changed]
- Deferred: [tool] — [why]

---

## PART 6: Send Telegram summary

After saving:
- If there are NO score 4-5 finds AND NO stack updates that change tools Max actively uses, respond with exactly: done
- Otherwise send a concise Telegram summary with only the 1-2 highest-signal items

Use this format:

📡 AI Radar — $TODAY

[Finding 1]
DEFAULT: [generic takeaway]
EXPERT: [what actually matters once you apply Max''s stack and operator context]
GAP: [what changed and why]
Source: [URL]

[Finding 2 if truly worth sending]
DEFAULT: [generic takeaway]
EXPERT: [better takeaway]
GAP: [what changed and why]
Source: [URL]

Report saved → 8 - External Fuel/AI-Tool-Radar/$TODAY-radar.md`;

// Mon/Wed/Fri at 4pm ET
const cronExpr = '0 16 * * 1,3,5';
const interval = CronExpressionParser.parse(cronExpr, { tz: 'America/New_York' });
const nextRun = Math.floor(interval.next().toDate().getTime() / 1000);
const id = 'weekly-ai-radar';

const existing = db.prepare('SELECT id FROM scheduled_tasks WHERE id = ?').get(id);
if (existing) {
  db.prepare('DELETE FROM scheduled_tasks WHERE id = ?').run(id);
  console.log('Replaced existing task.');
}

db.prepare(`INSERT INTO scheduled_tasks (id, prompt, schedule, next_run, status, created_at, agent_id)
  VALUES (?, ?, ?, ?, 'active', ?, 'main')`)
  .run(id, prompt, cronExpr, nextRun, Math.floor(Date.now()/1000));

console.log('AI Radar task updated: Mon/Wed/Fri at 4pm ET.');
console.log('Next run:', new Date(nextRun * 1000).toLocaleString('en-US', { timeZone: 'America/New_York' }));
db.close();
