#!/bin/bash
# Post-call follow-up checker — runs every 5 minutes via ClaudeClaw scheduler
# Checks calendar for meetings that ended 10-20 minutes ago
# If found and not already followed up, triggers a post-call offer via Claude

set -euo pipefail

LOCKDIR="/tmp/butters-postcall-locks"
mkdir -p "$LOCKDIR"

BUTTERS_DIR="$HOME/Desktop/max-command-center/butters"
CLAUDE_BIN="${CLAUDE_BIN:-$HOME/.local/bin/claude}"
TIMEOUT_BIN="${TIMEOUT_BIN:-$(command -v timeout || command -v gtimeout || true)}"
export PATH="$HOME/.local/bin:/opt/homebrew/bin:$PATH"
MCC_API_KEY=$(grep -E '^MCC_API_KEY=' "$HOME/Desktop/max-command-center/.env.local" | cut -d= -f2-)
MCC_BASE="https://max-command-center.max-command-center.workers.dev"
MAIN_CHANNEL=$(grep -E '^ALLOWED_CHAT_ID=' "$BUTTERS_DIR/.env" | head -1 | cut -d= -f2-)
BOT_TOKEN=$(grep -E '^TELEGRAM_BOT_TOKEN=' "$BUTTERS_DIR/.env" | head -1 | cut -d= -f2-)
CF_CARD_PATH="$HOME/Desktop/mb-brain/0 - System/cf-operating-card.md"
DB_PATH="$BUTTERS_DIR/store/claudeclaw.db"

log_postcall_event() {
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
    ("butters-postcall", "system", action, summary, artifacts_json, int(time.time())),
)
conn.commit()
conn.close()
PY
}

if [ ! -x "$CLAUDE_BIN" ]; then
  log_postcall_event \
    "precall_receipt_prompt" \
    "Post-call receipt prompt failed because Claude CLI was not executable in the launchd environment." \
    "{\"status\":\"claude_missing\",\"claude_bin\":\"$CLAUDE_BIN\"}"
  exit 0
fi

run_claude_print() {
  local prompt="$1"
  if [ -n "$TIMEOUT_BIN" ] && [ -x "$TIMEOUT_BIN" ]; then
    printf '%s' "$prompt" | "$TIMEOUT_BIN" 300 "$CLAUDE_BIN" --print 2>>/tmp/butters-postcall-claude.err
  else
    printf '%s' "$prompt" | "$CLAUDE_BIN" --print 2>>/tmp/butters-postcall-claude.err
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

send_telegram_message() {
  local message="$1"
  curl -s -X POST "https://api.telegram.org/bot${BOT_TOKEN}/sendMessage" \
    -d "chat_id=${MAIN_CHANNEL}" \
    --data-urlencode "text=${message}" >/dev/null 2>&1 || true
}

NOW=$(date -u +%s)
WINDOW_START=$((NOW - 1200))  # 20 min ago
WINDOW_END=$((NOW - 600))     # 10 min ago

TIME_MIN=$(date -u -r "$WINDOW_START" +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null || date -u -d "@$WINDOW_START" +"%Y-%m-%dT%H:%M:%SZ")
TIME_MAX=$(date -u -r "$WINDOW_END" +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null || date -u -d "@$WINDOW_END" +"%Y-%m-%dT%H:%M:%SZ")

# Fetch events that started today (we'll filter by end time in Python)
TODAY_START=$(date -u +"%Y-%m-%dT00:00:00Z")
TODAY_END=$(date -u +"%Y-%m-%dT23:59:59Z")

EVENTS=$(curl -s -H "x-api-key: $MCC_API_KEY" \
  "$MCC_BASE/api/calendar/events?timeMin=$TODAY_START&timeMax=$TODAY_END" 2>/dev/null || echo '{"items":[]}')

echo "$EVENTS" | python3 -c "
import json, sys, hashlib, os
from datetime import datetime

data = json.load(sys.stdin)
events = data if isinstance(data, list) else data.get('items', [])
lockdir = '$LOCKDIR'
window_start = $WINDOW_START
window_end = $WINDOW_END

for event in events:
    event_id = event.get('id', '')
    if not event_id:
        continue

    end_raw = event.get('end', '')
    end_str = end_raw if isinstance(end_raw, str) else end_raw.get('dateTime', '')
    if not end_str:
        continue

    try:
        end_dt = datetime.fromisoformat(end_str.replace('Z', '+00:00'))
        end_ts = int(end_dt.timestamp())
    except Exception:
        continue

    if not (window_start <= end_ts <= window_end):
        continue

    lock_hash = hashlib.md5((event_id + '-postcall').encode()).hexdigest()
    lockfile = os.path.join(lockdir, lock_hash)
    if os.path.exists(lockfile):
        continue

    title = event.get('title', event.get('summary', 'Meeting'))
    attendees = event.get('attendees', [])
    link = event.get('link', '') or event.get('hangoutLink', '') or event.get('location', '')

    generic_domains = {'gmail.com','yahoo.com','hotmail.com','icloud.com','outlook.com','me.com','live.com'}
    attendee_info = []
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
        'meeting_end': end_str,
        'lockfile': lockfile,
    }))

    with open(lockfile, 'w') as f:
        f.write(event_id)
" 2>/dev/null | while IFS= read -r line; do
  KIND=$(python3 -c 'import json,sys; print(json.loads(sys.argv[1]).get("kind",""))' "$line")
  if [ "$KIND" = "event" ]; then
    EVENT_ID=$(python3 -c 'import json,sys; print(json.loads(sys.argv[1]).get("event_id",""))' "$line")
    TITLE=$(python3 -c 'import json,sys; print(json.loads(sys.argv[1]).get("title",""))' "$line")
    ATTENDEES_RAW=$(python3 -c 'import json,sys; print(json.loads(sys.argv[1]).get("attendees_raw",""))' "$line")
    LINK=$(python3 -c 'import json,sys; print(json.loads(sys.argv[1]).get("link",""))' "$line")
    END_TIME=$(python3 -c 'import json,sys; print(json.loads(sys.argv[1]).get("meeting_end",""))' "$line")
    LOCKFILE=$(python3 -c 'import json,sys; print(json.loads(sys.argv[1]).get("lockfile",""))' "$line")
    RECEIPT_CODE=$(printf '%s' "$EVENT_ID" | tr -cd '[:alnum:]' | cut -c1-8)
    if [ -z "$RECEIPT_CODE" ]; then
      RECEIPT_CODE="pc$(date +%s | tail -c 5)"
    fi

    SKIP_JSON=$(should_skip_event "$TITLE" "$ATTENDEES_RAW" "$LINK")
    SHOULD_SKIP=$(python3 -c 'import json,sys; print("1" if json.loads(sys.argv[1]).get("skip") else "0")' "$SKIP_JSON")
    if [ "$SHOULD_SKIP" = "1" ]; then
      rm -f "$LOCKFILE"
      continue
    fi

    PROMPT="Generate a post-call follow-up offer. Send it to Telegram chat $MAIN_CHANNEL using the Telegram Bot API (token: $BOT_TOKEN, use sendMessage to chat_id $MAIN_CHANNEL).

Meeting just ended: $TITLE
Attendees (pipe-delimited: name|email|domain|type): $ATTENDEES_RAW
CF operating card: $CF_CARD_PATH
Receipt code: $RECEIPT_CODE

Steps:
1. GRANOLA TRANSCRIPT (PRIMARY) — Use Granola MCP tools to pull this meeting's transcript.
   a. Call list_meetings to find today's meetings.
   b. Match by title ('$TITLE') or attendee names.
   c. Call get_meeting_transcript on the matching meeting.
   d. Extract: action items, decisions made, commitments, and any follow-up threads.
   If Granola has the transcript, use it as the primary source for the follow-up context.
2. Check Obsidian vault ~/Desktop/mb-brain/1 - Clients/ for any files matching the attendee names or their company domains
3. Check MCC API: GET /api/open-loops?status=open (header x-api-key: $MCC_API_KEY, base: $MCC_BASE) for open loops tied to these clients
4. Check MCC API: GET /api/tasks?status=active (header x-api-key: $MCC_API_KEY, base: $MCC_BASE) for tasks tied to these clients

Format the message as:

$TITLE just wrapped

Want me to:
1. Draft a follow-up to [attendee name]?
2. Create a task in MCC for commitments made?
3. Set a 48h reminder to follow up if no reply?

[If Granola transcript found, add:]
🎙 From the call:
› [key decisions or action items extracted from transcript]
› [any commitments that need tracking]

[If you found open loops or pending tasks for this client, add:]
📋 Active context:
› [open loop or task, brief]

[If there is a meaningful CF reflection surface, add this short block:]
🧠 Quick CF check:
› Did you externalize the reasoning before showing the recommendation?
› Did you frame value before teaching?
› Did you solve at the right altitude?
Reply y, n, or skip with a few words if useful.

Close with exactly these two lines:
Receipt: reply with \`receipt $RECEIPT_CODE y y optional-note\`
Shortcut: \`rr $RECEIPT_CODE y y optional-note\`
Meaning: first y/n/skip = used the pre-call brief, second y/n/skip = the brief changed the call.

If no reply comes in, Butters will send one reminder automatically.

Reply 1, 2, 3, or any combo (e.g. '1 3'). Or 'skip' to pass."

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
  "meeting_end": """$END_TIME""",
  "link": """$LINK""",
  "attendee_count": int("""$ATTENDEE_COUNT"""),
  "receipt_code": """$RECEIPT_CODE""",
  "response_excerpt": """${CLAUDE_OUTPUT:0:280}"""
}))
PY
)
      log_postcall_event "precall_receipt_prompt" "Sent receipt prompt for $TITLE." "$ARTIFACTS"
    else
      [ -n "${LOCKFILE:-}" ] && rm -f "$LOCKFILE"
      ARTIFACTS=$(python3 - <<PY
import json
print(json.dumps({
  "status": "send_failed",
  "event_id": """$EVENT_ID""",
  "title": """$TITLE""",
  "meeting_end": """$END_TIME""",
  "link": """$LINK""",
  "attendee_count": int("""$ATTENDEE_COUNT"""),
  "receipt_code": """$RECEIPT_CODE""",
  "lock_released": True,
  "claude_exit_code": int("""$CLAUDE_STATUS"""),
  "response_excerpt": """${CLAUDE_OUTPUT:0:280}"""
}))
PY
)
      log_postcall_event "precall_receipt_prompt" "Failed to send receipt prompt for $TITLE." "$ARTIFACTS"
    fi
  fi
done

# Clean up old lockfiles (older than 24 hours)
find "$LOCKDIR" -type f -mtime +1 -delete 2>/dev/null || true
