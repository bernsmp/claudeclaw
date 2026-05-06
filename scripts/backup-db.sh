#!/bin/bash
# Butters DB backup — exports key SQLite tables as JSON to MCC data/backups/
# Mirrors the D1 backup pattern: dated JSON files, 30-day retention, git commit + push
# Scheduled: daily at 3:30 AM via launchd (after D1 backup at 3:00 AM)

set -euo pipefail

DB="$HOME/Desktop/max-command-center/butters/store/claudeclaw.db"
BACKUP_DIR="$HOME/Desktop/max-command-center/data/backups"
REPO_ROOT="$HOME/Desktop/max-command-center"
DATE=$(date +%Y-%m-%d)
KEEP_DAYS=30

if [ ! -f "$DB" ]; then
  echo "ERROR: claudeclaw.db not found at $DB"
  exit 1
fi

mkdir -p "$BACKUP_DIR"

TABLES=(
  "user_preferences"
  "voice_learning_log"
  "pending_drafts"
  "qa_scores"
  "behavior_changes"
  "scheduled_tasks"
)

BACKED_UP=()

for TABLE in "${TABLES[@]}"; do
  OUTFILE="$BACKUP_DIR/butters-${TABLE}-${DATE}.json"

  ROWS=$(sqlite3 "$DB" "SELECT json_group_array(json_object(
    $(sqlite3 "$DB" "PRAGMA table_info(${TABLE});" | awk -F'|' '{printf "'\''"$2"'\'', "$2", "}' | sed 's/, $//')
  )) FROM ${TABLE};" 2>/dev/null || echo "[]")

  echo "$ROWS" > "$OUTFILE"
  COUNT=$(echo "$ROWS" | python3 -c "import json,sys; print(len(json.load(sys.stdin)))" 2>/dev/null || echo "?")
  echo "  + butters-${TABLE}: ${COUNT} records"
  BACKED_UP+=("${TABLE}:${COUNT}")
done

# Also copy the raw DB as a binary backup (single file, overwritten daily)
cp "$DB" "$BACKUP_DIR/butters-claudeclaw-${DATE}.db"
echo "  + raw DB copy: butters-claudeclaw-${DATE}.db"

# Prune old Butters backups (30 days)
PRUNED=0
find "$BACKUP_DIR" -name "butters-*" -type f -mtime +${KEEP_DAYS} -delete 2>/dev/null && true
echo "Pruned backups older than ${KEEP_DAYS} days"

# Git commit + push (same repo as D1 backups)
cd "$REPO_ROOT"
git add data/backups/butters-* 2>/dev/null || true

STATUS=$(git status --porcelain data/backups/butters-* 2>/dev/null || echo "")
if [ -z "$STATUS" ]; then
  echo "No changes to commit — Butters backups already up to date"
  exit 0
fi

SUMMARY=$(IFS=', '; echo "${BACKED_UP[*]}")
git commit -m "chore: Butters DB backup ${DATE} (${SUMMARY}) [skip ci]" 2>/dev/null || true
git push 2>/dev/null || echo "WARN: git push failed (non-fatal)"
echo "Committed and pushed: Butters DB backup ${DATE}"
