# Evals: precall_brief

## Binary Checks

- `ON_TIME_WINDOW` — brief was sent for a meeting starting within the intended 10-20 minute window
- `OBSERVABLE_DECISION` — every evaluated meeting has a recorded `hive_mind` decision: `sent`, `skipped_locked`, `send_failed`, or `no_events`
- `CONTEXT_PRESENT` — brief includes at least one concrete context source: vault, D1, or verified web research
- `RESEARCH_DISCIPLINE` — web research is only used for company-domain attendees and omitted when identity match is uncertain
- `USEFUL_PREP_NOTE` — final brief ends with one specific thing worth knowing or an explicit fallback prompt when no context exists
- `DELIVERABLES_FOR_RETAINERS` — retainer-client briefs include recent deliverables summary when client match exists
- `CF_CUE_DISCIPLINE` — if a CF cue appears, it is one lane-appropriate sentence that changes how Max should enter the call, not a mini-analysis
- `READS_TIGHT` — output is brief-ready, compact, and free of padding

## Sample Inputs

1. Retainer meeting with known client and company-domain attendees. Expect vault/D1 context plus deliverables summary.
2. Prospect call with one company-domain attendee and no vault history. Expect verified web research or an explicit "no prior context found" fallback.
3. Internal meeting with no external attendees. Expect `Internal / no external attendees` and no unnecessary web research.
4. Duplicate calendar event caught by lockfile. Expect a `skipped_locked` evidence row rather than a second brief.
