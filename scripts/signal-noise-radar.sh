#!/bin/bash
# signal-noise-radar.sh — Twice-weekly content topic radar for Signal>Noise
# Runs Mon/Thu 12pm via Butters scheduler
# Uses last30days to detect which AI topics have community momentum
# Writes ranked topics to ~/Desktop/mb-brain/4 - Content/signal-noise-topic-radar.md

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
OUTPUT_DIR="$HOME/Documents/Last30Days"
RADAR_FILE="$HOME/Desktop/mb-brain/4 - Content/signal-noise-topic-radar.md"
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

echo "[$DATE $DAY] Running Signal>Noise topic radar..."

# Query plan targeting Max's content pillars
PLAN='{
  "intent": "opinion",
  "freshness_mode": "balanced_recent",
  "cluster_mode": "debate",
  "subqueries": [
    {
      "label": "primary",
      "search_query": "AI workflow automation business practical",
      "ranking_query": "What AI workflows, tools, or automation approaches are people actually using in their businesses?",
      "sources": ["reddit", "x", "hackernews", "youtube"],
      "weight": 1.0
    },
    {
      "label": "consulting",
      "search_query": "AI consulting strategy implementation director",
      "ranking_query": "What are people saying about AI consulting, AI strategy roles, and implementing AI in companies?",
      "sources": ["reddit", "x", "hackernews"],
      "weight": 0.8
    },
    {
      "label": "prompting",
      "search_query": "prompt engineering AI agents Claude Code skills",
      "ranking_query": "What prompt engineering techniques, AI agent patterns, or Claude Code skills are gaining traction?",
      "sources": ["reddit", "x", "youtube", "hackernews"],
      "weight": 0.7
    },
    {
      "label": "expertise",
      "search_query": "AI expertise extraction knowledge management tacit",
      "ranking_query": "What are people discussing about AI for expertise extraction, knowledge capture, or tacit knowledge?",
      "sources": ["reddit", "x", "hackernews"],
      "weight": 0.6
    }
  ]
}'

RAW_OUTPUT=$("$LAST30DAYS_PYTHON" "$SKILL_ROOT/scripts/last30days.py" \
  "AI workflow automation consulting prompt engineering" \
  --emit=compact \
  --save-dir="$OUTPUT_DIR" \
  --save-suffix=sn-radar \
  --plan "$PLAN" \
  --subreddits=MachineLearning,artificial,ChatGPT,ClaudeAI,LocalLLaMA \
  --days=4 \
  2>/dev/null) || true

# Write raw output for Claude to synthesize
RAW_FILE="$OUTPUT_DIR/sn-radar-raw-$DATE.md"
echo "$RAW_OUTPUT" > "$RAW_FILE"

echo "Raw output saved to $RAW_FILE"
echo "Synthesis and ranking will be done by Claude in the cron prompt."
echo "done"
