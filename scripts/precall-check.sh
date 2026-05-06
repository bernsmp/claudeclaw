#!/bin/bash
# Pre-call brief checker — runs every 5 minutes via ClaudeClaw scheduler
# Checks calendar for meetings starting in 10-20 minutes
# If found and not already briefed, triggers a pre-call brief via the Claude agent

set -euo pipefail

LOCKDIR="/tmp/butters-precall-locks"
mkdir -p "$LOCKDIR"

# Load env
BUTTERS_DIR="$HOME/Desktop/max-command-center/butters"
DB_PATH="$BUTTERS_DIR/store/claudeclaw.db"
CLAUDE_BIN="${CLAUDE_BIN:-$HOME/.local/bin/claude}"
TIMEOUT_BIN="${TIMEOUT_BIN:-$(command -v timeout || command -v gtimeout || true)}"
export PATH="$HOME/.local/bin:/opt/homebrew/bin:$PATH"
MCC_API_KEY=$(grep -E '^MCC_API_KEY=' "$HOME/Desktop/max-command-center/.env.local" | cut -d= -f2-)
MCC_BASE="https://max-command-center.max-command-center.workers.dev"
PRECALL_CHANNEL=$(grep -E '^TELEGRAM_PRECALL_CHANNEL_ID=' "$BUTTERS_DIR/.env" | cut -d= -f2-)
BOT_TOKEN=$(grep -E '^TELEGRAM_BOT_TOKEN=' "$BUTTERS_DIR/.env" | head -1 | cut -d= -f2-)
EXA_API_KEY=$(grep -E '^EXA_API_KEY=' "$BUTTERS_DIR/.env" | cut -d= -f2-)
CF_CARD_PATH="$HOME/Desktop/mb-brain/0 - System/cf-operating-card.md"

log_precall_event() {
  local action="$1"
  local summary="$2"
  local artifacts_json="$3"

  python3 - "$DB_PATH" "$action" "$summary" "$artifacts_json" <<'PY'
import sqlite3
import sys
import time

db_path, action, summary, artifacts_json = sys.argv[1:5]

conn = sqlite3.connect(db_path)
conn.execute(
    """
    INSERT INTO hive_mind (agent_id, chat_id, action, summary, artifacts, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
    """,
    ("butters-precall", "system", action, summary, artifacts_json, int(time.time())),
)
conn.commit()
conn.close()
PY
}

if [ ! -x "$CLAUDE_BIN" ]; then
  log_precall_event \
    "precall_brief" \
    "Pre-call brief failed because Claude CLI was not executable in the launchd environment." \
    "{\"status\":\"claude_missing\",\"claude_bin\":\"$CLAUDE_BIN\"}"
  exit 0
fi

run_claude_print() {
  local prompt="$1"
  if [ -n "$TIMEOUT_BIN" ] && [ -x "$TIMEOUT_BIN" ]; then
    printf '%s' "$prompt" | "$TIMEOUT_BIN" 300 "$CLAUDE_BIN" --print 2>>/tmp/butters-precall-claude.err
  else
    printf '%s' "$prompt" | "$CLAUDE_BIN" --print 2>>/tmp/butters-precall-claude.err
  fi
}

should_skip_event() {
  local title="$1"
  local attendees_raw="$2"
  local link="$3"

  python3 - "$title" "$attendees_raw" "$link" <<'PY'
import json
import re
import sys

title, attendees_raw, link = sys.argv[1:4]
# Strip emoji prefixes (Reclaim adds them: ✍ Focus time, 😎 Decompress, 🆓 🍱 Lunch, 🔒 ✍ Focus time)
import unicodedata
cleaned = ''.join(c for c in (title or '') if unicodedata.category(c) not in ('So', 'Sk', 'Mn', 'Mc', 'Me')).strip()
normalized = cleaned.lower()

skip_patterns = [
    r'^focus time$',
    r'^focus block$',
    r'^deep work$',
    r'^work block$',
    r'^admin block$',
    r'^lunch$',
    r'^break$',
    r'^hold$',
    r'^busy$',
    r'^personal time$',
    r'^travel time$',
    r'^commute$',
    r'^do not book$',
    r'^decompress$',
    r'^max\s*/\s*michelle$',
    r'^reservation\b',
]

for pattern in skip_patterns:
    if re.match(pattern, normalized):
        print(json.dumps({"skip": True, "reason": "title_filter"}))
        raise SystemExit

attendees = [item for item in attendees_raw.split(';') if item]
real_attendees = []
for item in attendees:
    parts = item.split('|')
    if len(parts) >= 4:
        name, email, domain, kind = parts[:4]
        if email != 'unknown@unknown.com':
            real_attendees.append({"name": name, "email": email, "domain": domain, "kind": kind})

has_external = any(a["domain"] not in {"maxpbernstein.com"} for a in real_attendees)
has_meeting_link = bool(link and ("zoom" in link.lower() or "meet.google.com" in link.lower() or "teams" in link.lower() or "webex" in link.lower()))

if not has_external and not has_meeting_link:
    print(json.dumps({"skip": True, "reason": "internal_no_signal"}))
else:
    print(json.dumps({"skip": False, "reason": ""}))
PY
}

# Time window: 15-45 min ahead for first attempts; retries allowed until meeting starts
NOW=$(date -u +%s)
WINDOW_START=$((NOW + 900))
WINDOW_END=$((NOW + 2700))

# ISO format for API
TIME_MIN=$(date -u -r "$WINDOW_START" +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null || date -u -d "@$WINDOW_START" +"%Y-%m-%dT%H:%M:%SZ")
TIME_MAX=$(date -u -r "$WINDOW_END" +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null || date -u -d "@$WINDOW_END" +"%Y-%m-%dT%H:%M:%SZ")

# Fetch upcoming events
EVENTS=$(curl -s -H "x-api-key: $MCC_API_KEY" \
  "$MCC_BASE/api/calendar/events?timeMin=$TIME_MIN&timeMax=$TIME_MAX" 2>/dev/null || echo '{"items":[]}')

# Check if we got any events
# MCC API returns a flat array, not {items: [...]}
EVENT_COUNT=$(echo "$EVENTS" | python3 -c "import json,sys; d=json.load(sys.stdin); items=d if isinstance(d,list) else d.get('items',[]); print(len(items))" 2>/dev/null || echo "0")

if [ "$EVENT_COUNT" = "0" ]; then
  exit 0
fi

# Process each event — with retry counter and start-time cutoff
echo "$EVENTS" | python3 -c "
import json, sys, hashlib, os, time
from datetime import datetime

data = json.load(sys.stdin)
events = data if isinstance(data, list) else data.get('items', [])
lockdir = '$LOCKDIR'
now = int(time.time())
MAX_RETRIES = 5

for event in events:
    event_id = event.get('id', '')
    if not event_id:
        continue

    title = event.get('title', event.get('summary', 'Meeting'))
    start_raw = event.get('start', '')
    start = start_raw if isinstance(start_raw, str) else start_raw.get('dateTime', '')

    if not start:
        continue

    # Parse start time — skip if meeting has already started
    try:
        start_dt = datetime.fromisoformat(start.replace('Z', '+00:00'))
        start_ts = int(start_dt.timestamp())
    except Exception:
        continue

    if start_ts <= now:
        continue

    minutes_until = (start_ts - now) / 60

    lock_hash = hashlib.md5(event_id.encode()).hexdigest()
    lockfile = os.path.join(lockdir, lock_hash)

    if os.path.exists(lockfile):
        content = open(lockfile).read().strip()
        # Success marker — already sent
        if content.startswith('sent:'):
            continue
        # Retry counter
        try:
            attempts = int(content)
            if attempts >= MAX_RETRIES:
                continue
            # Allow retry — increment counter
            with open(lockfile, 'w') as f:
                f.write(str(attempts + 1))
        except ValueError:
            # Old-format lockfile (event_id string) = already sent
            continue
    else:
        # First encounter — only trigger if 15-45 min away
        if minutes_until < 15 or minutes_until > 45:
            continue
        with open(lockfile, 'w') as f:
            f.write('1')

    attendees = event.get('attendees', [])
    link = event.get('link', '') or event.get('hangoutLink', '') or event.get('location', '')

    attendee_info = []
    generic_domains = {'gmail.com','yahoo.com','hotmail.com','icloud.com','outlook.com','me.com','live.com'}
    for a in attendees:
        email = a.get('email', '')
        name = a.get('displayName', email.split('@')[0])
        domain = email.split('@')[-1] if '@' in email else ''
        if 'resource.calendar' in email or email in ('bernsmp@gmail.com','max@maxpbernstein.com'):
            continue
        is_generic = domain in generic_domains
        attendee_info.append(f'{name}|{email}|{domain}|{\"generic\" if is_generic else \"company\"}')

    if not attendee_info:
        attendee_info = ['Unknown|unknown@unknown.com|unknown.com|generic']

    print(json.dumps({
        'kind': 'event',
        'event_id': event_id,
        'title': title,
        'attendees_raw': ';'.join(attendee_info),
        'link': link,
        'meeting_time': start,
        'lockfile': lockfile,
    }))
" 2>/dev/null | while IFS= read -r line; do
  KIND=$(python3 -c 'import json,sys; print(json.loads(sys.argv[1]).get("kind",""))' "$line")
  if [ "$KIND" = "skiplock" ]; then
    continue
  elif [ "$KIND" = "event" ]; then
    EVENT_ID=$(python3 -c 'import json,sys; print(json.loads(sys.argv[1]).get("event_id",""))' "$line")
    TITLE=$(python3 -c 'import json,sys; print(json.loads(sys.argv[1]).get("title",""))' "$line")
    ATTENDEES_RAW=$(python3 -c 'import json,sys; print(json.loads(sys.argv[1]).get("attendees_raw",""))' "$line")
    LINK=$(python3 -c 'import json,sys; print(json.loads(sys.argv[1]).get("link",""))' "$line")
    START_TIME=$(python3 -c 'import json,sys; print(json.loads(sys.argv[1]).get("meeting_time",""))' "$line")
    LOCKFILE=$(python3 -c 'import json,sys; print(json.loads(sys.argv[1]).get("lockfile",""))' "$line")

    # Detect retainer client from attendees and run industry intel
    INDUSTRY_INTEL=""
    CLIENT_SLUG=$(python3 -c "
import sys
attendees = '''$ATTENDEES_RAW'''.lower()
client_map = {
    'trackablemed': 'zed-trackable-med',
    'trackable': 'zed-trackable-med',
    'vptfinancial': 'nick-tim-vpt-financial',
    'vpt': 'nick-tim-vpt-financial',
    'illuminatedmarketing': 'dj-katelyn-illuminated',
    'illuminated': 'dj-katelyn-illuminated',
    'mjmventures': 'mike-david',
}
for keyword, slug in client_map.items():
    if keyword in attendees:
        print(slug)
        sys.exit(0)
print('')
" 2>/dev/null || true)

    if [ -n "$CLIENT_SLUG" ]; then
      INTEL_SCRIPT="$BUTTERS_DIR/scripts/precall-industry-intel.sh"
      if [ -x "$INTEL_SCRIPT" ]; then
        INTEL_OUTPUT=$("$TIMEOUT_BIN" 120 bash "$INTEL_SCRIPT" "$CLIENT_SLUG" 2>/dev/null | tail -50 || true)
        if [ -n "$INTEL_OUTPUT" ]; then
          INDUSTRY_INTEL="
INDUSTRY INTELLIGENCE (from last30days scan, last 7 days):
$INTEL_OUTPUT
Use the 1-2 most relevant findings in a new brief section:
🌐 Their world this week:
› [top finding]
› [engagement signal if notable]
Only include if findings are relevant to the client."
        fi
      fi
    fi

    PROMPT="Generate a pre-call brief for an upcoming meeting. Send it to Telegram channel $PRECALL_CHANNEL using the Telegram Bot API (token: $BOT_TOKEN, use sendMessage to chat_id $PRECALL_CHANNEL).

Meeting: $TITLE
Attendees (pipe-delimited: name|email|domain|type): $ATTENDEES_RAW
Link: $LINK
EXA_API_KEY: $EXA_API_KEY
CF operating card: $CF_CARD_PATH
$INDUSTRY_INTEL

Steps:

0. CF LANE CHECK — Read the operating card and classify the meeting into one lane:
   - Prospect / sales
   - Client delivery
   - Internal / team
   Surface exactly one CF coaching sentence. Bias toward externalizing reasoning before or alongside the output. If the meeting is purely admin, omit the CF cue.

1. GRANOLA CHECK (PRIMARY) — Use the Granola MCP tools to find previous meetings with these attendees.
   a. Call list_meetings to get recent meetings (last 30 days).
   b. Filter for meetings where attendee names or email domains appear.
   c. For the most recent matching meeting, call get_meeting_transcript to pull what was discussed.
   d. Surface: last meeting date, key topics discussed, any commitments or open threads.
   This is the most valuable context for Max. If Granola has history, lead with it.

2. VAULT CHECK — Search Obsidian ~/Desktop/mb-brain/1 - Clients/ for files matching attendee names or company domains.

3. D1 CHECK — GET https://max-command-center.max-command-center.workers.dev/api/clients (header x-api-key: $MCC_API_KEY) — match by name or email domain.

4. EXA RESEARCH — For attendees with type='company' (non-generic email domain), use Exa to research them. Only do this for NEW contacts not found in Granola or D1.
   Run TWO searches per company attendee:

   People search (find the person's profile):
   curl -s -X POST 'https://api.exa.ai/search' \
     -H 'x-api-key: $EXA_API_KEY' \
     -H 'Content-Type: application/json' \
     -d '{\"query\": \"[FULL NAME] [COMPANY DOMAIN] professional profile\", \"numResults\": 3, \"type\": \"neural\", \"contents\": {\"text\": {\"maxCharacters\": 400}}}' 

   Company search (what does the company do):
   curl -s -X POST 'https://api.exa.ai/search' \
     -H 'x-api-key: $EXA_API_KEY' \
     -H 'Content-Type: application/json' \
     -d '{\"query\": \"[COMPANY DOMAIN] company what do they do\", \"numResults\": 2, \"type\": \"neural\", \"contents\": {\"text\": {\"maxCharacters\": 300}}}' 

   Only include web research that you can verify matches the attendee's actual name + company. If uncertain, omit.
   Skip research for generic email domains (gmail, yahoo, hotmail, icloud, outlook).

5. FORMAT and send as Telegram message:

$TITLE — in 15 min

👤 Who:
› [Name] — [Company/context]
› [Role or bio if found]

🎙 Last Meeting (from Granola):
› [date] — [key topics, decisions, open threads]
› [any commitments that may need follow-up]
[skip section if no Granola history found]

📝 Context:
› [vault/D1 context, if any]
› [verified web research if found]

[If INDUSTRY INTELLIGENCE was provided above, add:]
🌐 Their world this week:
› [1-2 most relevant findings from the industry scan]
› [include engagement signal if notable, e.g. '400-upvote thread about X']
[skip this section if no industry intel was provided or findings are not relevant]

[If there is a real CF cue, add:]
🧠 CF cue:
› [one sentence only, lane-specific, something Max can literally say out loud or remember in the room]

🔗 Link: [link or 'not provided']

💡 One thing worth knowing:
› [most useful prep note — or 'no prior context found, ask how they found you']

[Only if a CF cue is shown, add one short footer line:]
Reply 'skip cf' if this coaching does not apply to this call.

Keep it tight. No padding. If no external attendees, say 'Internal / no external attendees'."

    SKIP_JSON=$(should_skip_event "$TITLE" "$ATTENDEES_RAW" "$LINK")
    SHOULD_SKIP=$(python3 -c 'import json,sys; print("1" if json.loads(sys.argv[1]).get("skip") else "0")' "$SKIP_JSON")
    SKIP_REASON=$(python3 -c 'import json,sys; print(json.loads(sys.argv[1]).get("reason",""))' "$SKIP_JSON")

    if [ "$SHOULD_SKIP" = "1" ]; then
      rm -f "$LOCKFILE"
      continue
    fi

    # Fire through Claude and record the result for weekly QA.
    cd "$BUTTERS_DIR"
    set +e
    CLAUDE_OUTPUT=$(run_claude_print "$PROMPT")
    CLAUDE_STATUS=$?
    set -e

    ATTENDEE_COUNT=$(python3 - <<PY
raw = """$ATTENDEES_RAW""".strip()
print(len([item for item in raw.split(';') if item]))
PY
)

    if [ "$CLAUDE_STATUS" -eq 0 ] && [ -n "${CLAUDE_OUTPUT:-}" ]; then
      ARTIFACTS=$(python3 - <<PY
import json
print(json.dumps({
  "status": "sent",
  "event_id": """$EVENT_ID""",
  "title": """$TITLE""",
  "meeting_time": """$START_TIME""",
  "link": """$LINK""",
  "attendee_count": int("""$ATTENDEE_COUNT"""),
  "telegram_channel": """$PRECALL_CHANNEL""",
  "response_excerpt": """${CLAUDE_OUTPUT:0:280}"""
}))
PY
)
      log_precall_event "precall_brief" "Pre-call brief sent for $TITLE." "$ARTIFACTS"
      # Mark lockfile as sent so no more retries
      [ -n "${LOCKFILE:-}" ] && echo "sent:$EVENT_ID" > "$LOCKFILE"
    else
      # Don't release the lock — Python tracks retry count in it
      ARTIFACTS=$(python3 - <<PY
import json
print(json.dumps({
  "status": "send_failed",
  "event_id": """$EVENT_ID""",
  "title": """$TITLE""",
  "meeting_time": """$START_TIME""",
  "link": """$LINK""",
  "attendee_count": int("""$ATTENDEE_COUNT"""),
  "claude_exit_code": int("""$CLAUDE_STATUS"""),
  "response_excerpt": """${CLAUDE_OUTPUT:0:280}"""
}))
PY
)
      log_precall_event "precall_brief" "Pre-call brief failed for $TITLE." "$ARTIFACTS"
    fi
  fi
done

# Clean up old lockfiles (older than 24 hours)
find "$LOCKDIR" -type f -mtime +1 -delete 2>/dev/null || true
