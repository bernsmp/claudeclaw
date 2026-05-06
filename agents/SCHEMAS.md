# Hive Mind Schemas

Every agent writes to the same `hive_mind` table. This file enforces consistent JSON in the `artifacts` column so the PM can aggregate without parsing guesswork.

---

## Core Insert Statement

```sql
INSERT INTO hive_mind (agent_id, chat_id, action, summary, artifacts, created_at)
VALUES (
  '{agent_id}',
  'system',
  '{action}',
  '{summary}',
  '{artifacts_json}',
  strftime('%s','now')
);
```

**Rules:**
- `agent_id`: must match the agent's directory name (e.g., `am-zed`, `pm`, `compound-extractor`)
- `chat_id`: always `'system'` for background agents
- `summary`: max 200 chars, 1-2 sentences, human-readable
- `artifacts`: valid JSON string, nullable. Must conform to the schema for the given `action` type below
- `created_at`: always `strftime('%s','now')` (unix timestamp)

---

## Priority Field (Required on All Entries)

Every artifacts JSON object MUST include a `priority` field:

```json
{
  "priority": "low|medium|high|critical",
  ...
}
```

| Priority | Meaning | PM behavior |
|----------|---------|-------------|
| `critical` | Needs Max's attention within the hour | PM writes `pm_escalation` immediately |
| `high` | Include in next morning synthesis, don't wait | PM includes in next brief |
| `medium` | Include in morning synthesis if relevant | PM batches with other medium items |
| `low` | Record-keeping, available if PM needs context | PM skips unless pattern emerges |

---

## Action Schemas by Agent Type

### Account Manager Actions

#### `health_check`
```json
{
  "priority": "low|medium|high",
  "scores": {
    "cadence": 1-5,
    "loops": 1-5,
    "billing": 1-5,
    "velocity": 1-5,
    "engagement": 1-5,
    "progress": 1-5
  },
  "total": 6-30,
  "trend": "improving|stable|declining",
  "flags": ["string array of specific concerns"],
  "checkpoints": [1-5]
}
```

#### `risk_alert`
```json
{
  "priority": "high|critical",
  "risk_type": "billing_overdue|cadence_missed|engagement_drop|deliverable_stall|churn_signal",
  "detail": "specific description of the risk",
  "days_overdue": null|number,
  "suggested_action": "what Max should do",
  "checkpoints": [3]
}
```

#### `opportunity`
```json
{
  "priority": "medium|high",
  "opportunity_type": "expansion|case_study_ready|team_growth|referral|upsell",
  "detail": "specific description",
  "revenue_impact": null|"estimated dollar impact",
  "checkpoints": [3, 4]
}
```

#### `precall_brief`
```json
{
  "priority": "high",
  "meeting_time": "ISO datetime",
  "health_score": number,
  "open_loops_count": number,
  "top_talking_points": ["point 1", "point 2", "point 3"],
  "recent_deliverables": ["deliverable 1", "deliverable 2"],
  "checkpoints": []
}
```

#### `postcall_update`
```json
{
  "priority": "medium",
  "decisions": ["list of decisions made"],
  "new_loops": ["list of new open loops"],
  "closed_loops": ["list of closed loops"],
  "team_changes": null|"description of team engagement changes",
  "checkpoints": [1-5]
}
```

#### `precall_receipt_prompt`
```json
{
  "priority": "high",
  "receipt_code": "short code tied to one meeting",
  "event_id": "calendar event id",
  "title": "meeting title",
  "status": "sent|send_failed",
  "checkpoints": [3]
}
```

#### `precall_receipt_reminder`
```json
{
  "priority": "high",
  "receipt_code": "short code tied to one meeting",
  "title": "meeting title",
  "status": "sent",
  "checkpoints": [3]
}
```

#### `precall_receipt`
```json
{
  "priority": "high",
  "receipt_code": "short code tied to one meeting",
  "used_brief": "yes|no|skip",
  "changed_call": "yes|no|skip",
  "note": null|"short freeform note",
  "checkpoints": [3]
}
```

#### `compound_deposit`
```json
{
  "priority": "medium",
  "deposit_type": "methodology_pattern|cadence_feature|content_angle|reusable_asset|ai_director_pattern|case_study_seed|brand_signal",
  "detail": "specific description with evidence",
  "source_interaction": "what triggered this (meeting date, deliverable, etc.)",
  "reusable": true|false,
  "checkpoints": [1-5]
}
```

### Cadence AM Additional Actions

#### `cadence_update`
```json
{
  "priority": "medium",
  "session_number": number,
  "drive_scores": {"D": 1-5, "R": 1-5, "I": 1-5, "V": 1-5, "E": 1-5},
  "drive_total": 5-25,
  "drive_trend": "improving|stable|declining",
  "pipeline_stage": "discovery|extraction|profile|delivery|activation",
  "patterns_found": number,
  "next_session": "YYYY-MM-DD"|null,
  "blockers": ["string array"],
  "checkpoints": [1, 2]
}
```

### PM Actions

#### `morning_synthesis`
```json
{
  "priority": "high",
  "red": [{"client": "slug", "reason": "string"}],
  "orange": [{"client": "slug", "reason": "string"}],
  "green": ["client-slug"],
  "highlights": ["one-liner about best thing happening"]
}
```

#### `pm_escalation`
```json
{
  "priority": "critical",
  "source_agent": "agent-id that triggered this",
  "source_action": "the action type that triggered this",
  "client": "client-slug",
  "reason": "why this needs Max's attention now",
  "suggested_action": "what Max should do"
}
```

#### `weekly_report`
```json
{
  "priority": "high",
  "period": "YYYY-MM-DD to YYYY-MM-DD",
  "client_count": number,
  "red_count": number,
  "orange_count": number,
  "green_count": number,
  "compound_deposits": number,
  "top_risk": "string",
  "top_opportunity": "string",
  "heartbeat": {
    "all_reporting": true|false,
    "silent_agents": ["agent-ids"]
  }
}
```

#### `heartbeat_alert`
```json
{
  "priority": "high",
  "silent_agent": "agent-id",
  "last_seen": "ISO datetime or null",
  "expected_interval": "4h|weekly|etc",
  "hours_silent": number
}
```

### Compound Extractor Actions

#### `compound_deposit`
```json
{
  "priority": "medium|high",
  "checkpoints": [1-5],
  "deposit_type": "methodology_pattern|cadence_feature|content_angle|reusable_asset|ai_director_pattern|case_study_seed|brand_signal",
  "source": "agent-id/action that triggered this",
  "detail": "specific, evidence-backed description",
  "content_angle": null|"one-line content framing if applicable",
  "reusable": true|false,
  "cross_client": null|["client-slugs this applies to"]
}
```

#### `weekly_compound`
```json
{
  "priority": "high",
  "deposits_by_checkpoint": {
    "cp1_refine_cf": ["list"],
    "cp2_build_cadence": ["list"],
    "cp3_fund": ["list"],
    "cp4_distribute": ["list"],
    "cp5_ai_director": ["list"]
  },
  "total_deposits": number,
  "top_deposit": "the single most valuable deposit this week",
  "leakage": "work that should have deposited but didn't",
  "content_ready": ["angles ready to write"],
  "cross_client_transfers": ["asset from client A that client B needs"]
}
```

### Pattern Archaeologist Actions

#### `archaeology_find`
```json
{
  "priority": "medium|high",
  "find_type": "buried_referral|same_problem_twice|premature_opportunity|orphaned_insight|slow_decline|capability_gap",
  "original_date": "YYYY-MM-DD",
  "clients": ["client-slug"],
  "detail": "specific description with names, dates, and context",
  "suggested_action": "what to do about it",
  "urgency": "high|medium|low",
  "actionable": true|false,
  "checkpoints": [1-5]
}
```

#### `weekly_archaeology`
```json
{
  "priority": "high",
  "finds_count": number,
  "actionable_count": number,
  "top_finds": [{"type": "string", "client": "slug", "summary": "string"}],
  "cross_client_patterns": number
}
```

### Strategic Intelligence Actions

#### `weekly_strategic`
```json
{
  "priority": "high",
  "checkpoint_progress": {
    "cp1": "one-line status",
    "cp2": "one-line status",
    "cp3": "one-line status",
    "cp4": "one-line status",
    "cp5": "one-line status"
  },
  "top_opportunity": "string with evidence",
  "top_risk": "string with evidence",
  "cross_client_patterns": ["pattern descriptions"],
  "brand_signals": ["what strengthened Max's positioning this week"],
  "bottleneck": "the single biggest constraint right now"
}
```

#### `strategic_alert`
```json
{
  "priority": "high|critical",
  "alert_type": "expansion|churn_risk|industry_shift|competitive_threat|brand_opportunity",
  "clients": ["client-slug"],
  "detail": "what you found with evidence",
  "time_sensitive": true|false,
  "suggested_action": "what Max should do",
  "checkpoints": [1-5]
}
```

#### `monthly_cf_health`
```json
{
  "priority": "high",
  "month": "YYYY-MM",
  "consistency_score": "how consistently CF is described across clients",
  "gaps": ["dimensions or patterns not covered"],
  "strongest_proof": "most compelling evidence CF works",
  "evolution_signals": ["what should change based on N extractions"],
  "cadence_implications": ["what Cadence should automate"]
}
```

### Content Intelligence Actions

#### `content_angle`
```json
{
  "priority": "medium|high",
  "source": "compound-extractor|pattern-archaeologist|ai-table|direct",
  "format": "newsletter|linkedin|thread|case_study|keynote",
  "platform": "email|substack|linkedin|x",
  "hook": "one sentence opener",
  "proof": "specific evidence from real work",
  "trending_match": null|"trending topic this intersects with",
  "checkpoints": [4]
}
```

#### `weekly_content_brief`
```json
{
  "priority": "high",
  "angles": [
    {
      "title": "working title",
      "format": "newsletter|linkedin|thread|case_study",
      "platform": "email|substack|linkedin|x",
      "hook": "one sentence",
      "source": "where this came from",
      "checkpoints": [4]
    }
  ],
  "content_debt": {
    "active": number,
    "stale": number,
    "archived": number
  },
  "newsletter_status": "on_track|behind|overdue"
}
```

#### `content_alert`
```json
{
  "priority": "critical",
  "alert_type": "newsletter_overdue|content_debt_high|no_angles_ready",
  "detail": "what's wrong",
  "top_ready_angle": null|"title of the most ready-to-write angle",
  "hook": null|"hook for that angle"
}
```

---

## Correction Entries

Any agent can receive corrections from Max (via Butters relay). When corrected, write:

#### `correction_received`
```json
{
  "priority": "high",
  "corrected_by": "max",
  "original_action": "the action type that was wrong",
  "original_summary": "what the agent originally said",
  "correction": "what Max said was actually true",
  "rule_change": null|"new rule the agent should follow going forward",
  "applies_to": ["agent-ids this correction applies to, including self"]
}
```

Corrections are persisted to `butters/agents/{agent-id}/corrections.jsonl` (append-only). The agent MUST read this file on startup and apply all corrections before running.

### Portfolio AM Actions

#### `portfolio_sweep`
```json
{
  "priority": "low",
  "clients_checked": number,
  "clients_flagged": number,
  "flags": [
    {
      "client": "client-slug",
      "type": "recency|billing|loops|opportunity",
      "detail": "one-line description"
    }
  ],
  "all_clear": ["client-slug"],
  "checkpoints": [1-5]
}
```

#### `ai_table_briefing`
```json
{
  "priority": "medium|high",
  "client": "client-slug",
  "category": "health|opportunity|risk|milestone",
  "finding": "one-line finding for AI Table to surface",
  "source_agent": "am-portfolio|am-illuminated|am-zed|am-vpt|am-mike-david|pm|etc"
}
```

### System / Orchestrator Actions

#### `delegate_degraded`
```json
{
  "priority": "high|critical",
  "source_agent": "agent-id that initiated the delegation",
  "delegated_agent": "agent-id that returned degraded output",
  "detail": "what failed or went missing",
  "retryable": true|false
}
```

---

## Validation Rules

1. Every `artifacts` value must be valid JSON parseable by `JSON.parse()`
2. Every JSON object must include `priority`
3. `checkpoints` arrays must only contain integers 1-5
4. `client` and `clients` values must use D1 client slugs (e.g., `zed-trackable-med`, not `Zed`)
5. `summary` must be ≤ 200 characters
6. Date fields use ISO 8601 (`YYYY-MM-DD` or full datetime)
7. Agent IDs must match directory names exactly
