#!/bin/bash
# tool-drift-detector.sh — Twice-weekly AI tool landscape scan
# Runs Mon/Thu 7am via Butters scheduler
# Uses last30days to detect tool shifts, model releases, sentiment changes
# Writes delta to ~/Desktop/mb-brain/0 - System/LLM-context/tool-drift-latest.md
# Only interrupts via Telegram if high-signal change detected

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
OUTPUT_DIR="$HOME/Documents/Last30Days"
DRIFT_FILE="$HOME/Desktop/mb-brain/0 - System/LLM-context/tool-drift-latest.md"
DRIFT_PREV="$HOME/Documents/Last30Days/tool-drift-previous.md"
NOTIFY="$SCRIPT_DIR/notify.sh"
DATE=$(date +%Y-%m-%d)
DAY=$(date +%A)

# Resolve Python 3.12+
LAST30DAYS_PYTHON=""
for py in python3.14 python3.13 python3.12 python3; do
  command -v "$py" >/dev/null 2>&1 || continue
  "$py" -c 'import sys; raise SystemExit(0 if sys.version_info >= (3, 12) else 1)' 2>/dev/null || continue
  LAST30DAYS_PYTHON="$py"
  break
done

if [ -z "$LAST30DAYS_PYTHON" ]; then
  echo "ERROR: Python 3.12+ required"
  exit 1
fi

# Find skill root
SKILL_ROOT=""
for dir in \
  "$HOME/.claude/skills/last30days" \
  "$HOME/.claude/skills/last30days-3-nogem" \
  "$HOME/.claude/skills/last30days-3" \
  "$HOME/.claude/plugins/cache/last30days-skill-private/last30days-3-nogem/3.0.0-nogem" \
  "$HOME/.claude/plugins/cache/last30days-skill-private/last30days-3/3.0.0-alpha"; do
  [ -f "$dir/scripts/last30days.py" ] && SKILL_ROOT="$dir" && break
done

if [ -z "$SKILL_ROOT" ]; then
  echo "ERROR: Could not find last30days skill"
  exit 1
fi

mkdir -p "$OUTPUT_DIR"

echo "[$DATE $DAY] Running tool drift detector..."

# Save previous run for delta comparison
[ -f "$DRIFT_FILE" ] && cp "$DRIFT_FILE" "$DRIFT_PREV"

# Run last30days with agent flag — focused on the tools Max uses and recommends
PLAN='{
  "intent": "breaking_news",
  "freshness_mode": "strict_recent",
  "cluster_mode": "story",
  "subqueries": [
    {
      "label": "primary",
      "search_query": "Claude Code Cursor AI coding agents",
      "ranking_query": "What major updates, releases, or changes happened with Claude Code, Cursor, or AI coding tools?",
      "sources": ["reddit", "x", "hackernews", "youtube"],
      "weight": 1.0
    },
    {
      "label": "models",
      "search_query": "Anthropic Claude GPT OpenAI model release",
      "ranking_query": "What new AI models or major updates were released by Anthropic or OpenAI?",
      "sources": ["reddit", "x", "hackernews", "youtube"],
      "weight": 0.9
    },
    {
      "label": "workflow",
      "search_query": "AI workflow automation agents MCP tools",
      "ranking_query": "What new AI workflow tools, MCP servers, or agent frameworks are gaining traction?",
      "sources": ["reddit", "x", "hackernews"],
      "weight": 0.7
    }
  ]
}'

RAW_OUTPUT=$("$LAST30DAYS_PYTHON" "$SKILL_ROOT/scripts/last30days.py" \
  "Claude Code Cursor AI coding Anthropic GPT" \
  --emit=compact \
  --save-dir="$OUTPUT_DIR" \
  --save-suffix=tool-drift \
  --plan "$PLAN" \
  --x-handle=alexalbert__ \
  --x-related=AnthropicAI,OpenAI,cursor_ai,aaborovkov \
  --days=4 \
  2>/dev/null) || true

# Write raw output to file for Claude to synthesize
RAW_FILE="$OUTPUT_DIR/tool-drift-raw-$DATE.md"
echo "$RAW_OUTPUT" > "$RAW_FILE"

echo "Raw output saved to $RAW_FILE"
echo "Delta comparison and synthesis will be done by Claude in the cron prompt."
echo "done"
