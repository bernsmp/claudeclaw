const Database = require('better-sqlite3');
const { CronExpressionParser } = require('cron-parser');

const db = new Database('/Users/maxb/Desktop/max-command-center/butters/store/claudeclaw.db');

const prompt = `IMPORTANT: Your entire response will be sent as a Telegram message. Do NOT add commentary or meta-text.

Run the weekly Content Recon scan. Three jobs: competitor content analysis, trend detection, and idea generation.

Load EXA_API_KEY:
export EXA_API_KEY=$(grep EXA_API_KEY ~/Desktop/max-command-center/butters/.env | cut -d= -f2)
TODAY=$(date +%Y-%m-%d)
SINCE=$(date -v-7d +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -d '7 days ago' +%Y-%m-%dT%H:%M:%SZ)

## CONTEXT

Load these files before starting:
- ~/Desktop/mb-brain/0 - System/LLM-context/competitor-watch-list.md (competitor list + monitoring rules)
- ~/Desktop/mb-brain/0 - System/LLM-context/content-creator-profile.md (pillars, proof points, audience segments)
- ~/Desktop/mb-brain/0 - System/LLM-context/voice-guide-external.md (voice rules for hook generation)

Content pillars (filter ALL results through these):
1. Invisible Expertise / Cognitive Fingerprint
2. AI Installation (Not Adoption)
3. Beware the Defaults
4. Build in Public / Practitioner Stories
5. Case Studies from Client Work

## STEP 1: COMPARE — What Are They Doing?

For each Tier 1 competitor, search Exa for their last 5-7 posts/videos from the past week:

curl -s -X POST "https://api.exa.ai/search" \\
  -H "x-api-key: $EXA_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"query": "[COMPETITOR NAME] AI post", "numResults": 5, "type": "neural", "startPublishedDate": "'"$SINCE"'", "contents": {"highlights": {"numSentences": 3}, "text": false}}'

Run for each Tier 1:
- "Nate B Jones AI strategy"
- "Mark Kashef AI LinkedIn"
- "Andrew Dunn AI consulting newsletter"
- "Dan Shipper Every AI"
- "Alex Lieberman AI building"

For Tier 2 (YouTube), search for recent videos:
- "site:youtube.com Daniel Priestley 2026"
- "site:youtube.com Rick Mulready AI 2026"
- "site:youtube.com Nick Saraev Claude" (skip n8n content)
- "site:youtube.com Riley Brown Claude Code"

For each piece found, extract: title/hook, topic (3-5 words), angle, format, platform.

Analyze across all competitors:
- WAVES: Topic covered by 3+ competitors in last 2 weeks. Name topic + angles used.
- GAPS: Topic fitting Max's pillars that NO competitor covered.
- ANGLES: Hook styles or formats getting engagement.

## STEP 2: TRENDS — What's Moving Right Now?

Run Exa searches filtered through pillars (last 7 days):

curl -s -X POST "https://api.exa.ai/search" \\
  -H "x-api-key: $EXA_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"query": "AI expertise extraction invisible expertise knowledge capture founder", "numResults": 5, "type": "neural", "startPublishedDate": "'"$SINCE"'", "contents": {"highlights": {"numSentences": 2}, "text": false}}'

Also search:
- "AI adoption failure implementation challenges rollout problems"
- "building with AI non-developer Claude Code vibe coding business"
- "Anthropic Claude announcement update new feature"
- "AI consulting case study client results"

Cross-reference with COMPARE: trending + no competitor coverage = high-value gap. Trending + 3+ competitors = saturated.

Output: 3-5 trending signals mapped to pillars with saturation level.

## STEP 3: IDEATE — What Should Max Write?

Take top opportunities from Steps 1-2 and generate 5-7 content ideas.

For each idea:
1. Name the topic + angle
2. Assign an article arc:
   - Borrowed Lens (outside story pivots to AI)
   - Washing Machine (historical parallel repeating now)
   - Dropped Pancake (practitioner failure reveals pattern)
   - Shrinking Island (dying category, 3 forces killing it)
3. CRAFT score (each factor 1-5):
   - C (Catchy): Would this stop a scroll?
   - R (Resonates): Segment A (founders w/ teams) or B (solo experts)?
   - A (Authority): Does Max have proof? Below 3 = kill.
   - F (Fresh): New angle? Below 3 = find practitioner angle or kill.
   - T (Trending): Current momentum?
4. For ideas scoring 4/5+, generate 3 hook variations
5. Strip test each hook (read as flat text, no formatting — Y/N)
6. For each surviving idea, note platform versions:
   - Newsletter: format note
   - LinkedIn: format note
   - X: format note
   - Substack Note: format note

## STEP 4: Save report

Write to ~/Desktop/mb-brain/4 - Content/_agent-deposits/$TODAY-content-recon.md:

---
date: $TODAY
type: content-recon
---

# Content Recon — $TODAY

## Market Snapshot

### Waves (3+ competitors covering)
- [topic]: covered by [names]. Angles: [angles]

### Gaps (nobody covering, fits pillars)
- [topic]: maps to [pillar]. Why it matters: [reason]

### Trending (current momentum)
- [signal]: pillar fit [pillar]. Saturation: [low/medium/high]

## Scored Ideas (ranked by CRAFT)

### 1. [Idea Title] — CRAFT: X/5
- Topic: [topic]
- Arc: [arc name]
- Segment: [A / B / Both]
- CRAFT: C:x R:x A:x F:x T:x
- Authority proof: [what Max built/did/saw]
- Hook (winner): "[hook text]"
  - Strip test: [Y/N + note]
- Alt hooks:
  - "[alt 1]" — Segment [X]
  - "[alt 2]" — Segment [X]
- Platform versions:
  - Newsletter: [format note]
  - LinkedIn: [format note]
  - X: [format note]
  - Substack Note: [format note]

[repeat for each idea]

### Content Bank (3/5 CRAFT — save for later)
- [idea]: [why it scored 3]

## STEP 5: Send Telegram summary

After saving:
- Default to report-only. Save the full report and respond with exactly: done unless there is a same-day writing opportunity that is both high-confidence and time-sensitive.
- "Time-sensitive" means the angle depends on fresh news, a same-day market event, or a narrow timing window where waiting a day materially weakens the opportunity.
- If there are NO ideas with CRAFT 4+ OR none of them are time-sensitive enough to justify an interruption, respond with exactly: done
- Otherwise send only ONE idea in concise recommendation format

Use this format:

📡 Content Recon — $TODAY

[Idea 1 title]
DEFAULT: [the generic content angle]
EXPERT: [the better angle once you account for proof, audience, and pillar fit]
GAP: [what changed and why]
Reply: draft it / save for later

📁 Full report → 4 - Content/_agent-deposits/$TODAY-content-recon.md`;

// Monday at 10am ET
const cronExpr = '0 10 * * 1';
const interval = CronExpressionParser.parse(cronExpr, { tz: 'America/New_York' });
const nextRun = Math.floor(interval.next().toDate().getTime() / 1000);
const id = 'weekly-content-recon';

const existing = db.prepare('SELECT id FROM scheduled_tasks WHERE id = ?').get(id);
if (existing) {
  db.prepare('DELETE FROM scheduled_tasks WHERE id = ?').run(id);
  console.log('Replaced existing task.');
}

db.prepare(`INSERT INTO scheduled_tasks (id, prompt, schedule, next_run, status, created_at, agent_id)
  VALUES (?, ?, ?, ?, 'active', ?, 'main')`)
  .run(id, prompt, cronExpr, nextRun, Math.floor(Date.now()/1000));

console.log('Content Recon task scheduled: Monday at 10am ET.');
console.log('Next run:', new Date(nextRun * 1000).toLocaleString('en-US', { timeZone: 'America/New_York' }));
db.close();
