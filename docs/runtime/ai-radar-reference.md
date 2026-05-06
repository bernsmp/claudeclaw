# Butters AI Radar Reference

Load this only when the task is about AI Radar, the durable watchlist, or evaluating new tools/updates.

## Source of truth

- `~/Desktop/mb-brain/8 - External Fuel/AI-Tool-Radar/watchlist.md`
- `~/Desktop/mb-brain/8 - External Fuel/AI-Tool-Radar/ai-tool-database.md`
- `~/Desktop/mb-brain/8 - External Fuel/AI-Tool-Radar/HERMES_PROMPT.md`
- `~/Desktop/mb-brain/8 - External Fuel/AI-Tool-Radar/YYYY-MM-DD-radar.md`

## Core rule

"Watch" means a durable revisit loop, not a one-time radar mention.

Every meaningful find gets exactly one status:

- `watch`
- `test_later`
- `ignore`
- `adopted`

Then add or update the row in `watchlist.md`.

## Watchlist fields

- tool
- category
- status
- owner
- added
- revisit_after
- last_checked
- trigger
- why_it_matters
- source_url
- notes

## Resurfacing rule

Do not resurface something just because time passed.

Only resurface when:

- it materially improved
- it now matches an active system need
- `revisit_after` passed and there is genuinely new evidence

If no item has a true resurfacing trigger, return exactly:

`done`

## Messaging rule

- No watchlist recaps
- No "still watching" summaries
- No low-signal FYI messages
- Only interrupt Max when a watch item actually deserves reconsideration

## Scoring

- `5` ... changes how you'd build or operate something today
- `4` ... meaningfully better or cheaper version of something already in use
- `3` ... worth knowing, actionable in 3-6 months
- `2` ... interesting but not actionable yet
- `1` ... noise, skip
