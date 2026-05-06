#!/bin/bash
# precall-industry-intel.sh — Run last30days for a retainer client's industry
# Called by precall-check.sh when a retainer client meeting is detected
# Usage: precall-industry-intel.sh <client-slug>
# Output: writes to ~/Desktop/mb-brain/1 - Clients/{name}/industry-intel/ and stdout

set -euo pipefail

CLIENT_SLUG="${1:-}"
if [ -z "$CLIENT_SLUG" ]; then
  echo "Usage: precall-industry-intel.sh <client-slug>"
  exit 1
fi

OUTPUT_DIR="$HOME/Documents/Last30Days"
DATE=$(date +%Y-%m-%d)

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

# Client-specific query plans
case "$CLIENT_SLUG" in
  zed-trackable-med|zed|trackablemed)
    QUERY="medical device tracking FDA compliance medtech SaaS"
    PLAN='{
      "intent": "breaking_news",
      "freshness_mode": "balanced_recent",
      "cluster_mode": "story",
      "subqueries": [
        {
          "label": "primary",
          "search_query": "medical device tracking software FDA compliance",
          "ranking_query": "What is happening in medical device tracking, FDA compliance software, and medtech SaaS?",
          "sources": ["reddit", "x", "hackernews", "youtube"],
          "weight": 1.0
        },
        {
          "label": "competitors",
          "search_query": "medtech SaaS device management hospital",
          "ranking_query": "What new medtech SaaS tools or device management platforms are gaining traction?",
          "sources": ["reddit", "x", "hackernews"],
          "weight": 0.7
        }
      ]
    }'
    SUBREDDITS="medicaldevices,healthIT,biotech,DigitalHealth"
    CLIENT_DIR="Zed - TrackableMed"
    ;;

  nick-tim-vpt-financial|vpt|vpt-financial)
    QUERY="financial advisor technology wealth management fintech RIA"
    PLAN='{
      "intent": "breaking_news",
      "freshness_mode": "balanced_recent",
      "cluster_mode": "story",
      "subqueries": [
        {
          "label": "primary",
          "search_query": "financial advisor technology wealth management software",
          "ranking_query": "What is happening in financial advisor technology, wealth management tools, and fintech for RIAs?",
          "sources": ["reddit", "x", "hackernews", "youtube"],
          "weight": 1.0
        },
        {
          "label": "ai-finance",
          "search_query": "AI financial planning advisor automation",
          "ranking_query": "How are financial advisors using AI and automation tools?",
          "sources": ["reddit", "x", "hackernews"],
          "weight": 0.7
        }
      ]
    }'
    SUBREDDITS="financialplanning,FinancialAdvisors,wealthmanagement,fintech"
    CLIENT_DIR="Nick Tim - VPT Financial"
    ;;

  dj-katelyn-illuminated|illuminated)
    QUERY="marketing agency AI automation client acquisition"
    PLAN='{
      "intent": "breaking_news",
      "freshness_mode": "balanced_recent",
      "cluster_mode": "story",
      "subqueries": [
        {
          "label": "primary",
          "search_query": "marketing agency AI automation client acquisition",
          "ranking_query": "What trends are affecting marketing agencies? How are they using AI and getting clients?",
          "sources": ["reddit", "x", "hackernews", "youtube"],
          "weight": 1.0
        }
      ]
    }'
    SUBREDDITS="marketing,digital_marketing,agency,Entrepreneur"
    CLIENT_DIR="DJ Katelyn - Illuminated"
    ;;

  mike-david|mjm-ventures)
    QUERY="AI implementation small business consulting automation"
    PLAN='{
      "intent": "breaking_news",
      "freshness_mode": "balanced_recent",
      "cluster_mode": "story",
      "subqueries": [
        {
          "label": "primary",
          "search_query": "AI implementation small business consulting",
          "ranking_query": "What are small businesses doing with AI implementation and automation?",
          "sources": ["reddit", "x", "hackernews", "youtube"],
          "weight": 1.0
        }
      ]
    }'
    SUBREDDITS="smallbusiness,Entrepreneur,artificial,ChatGPT"
    CLIENT_DIR="Mike David"
    ;;

  *)
    echo "Unknown client slug: $CLIENT_SLUG. Supported: zed-trackable-med, nick-tim-vpt-financial, dj-katelyn-illuminated, mike-david"
    exit 1
    ;;
esac

# Create client intel directory
INTEL_DIR="$HOME/Desktop/mb-brain/1 - Clients/$CLIENT_DIR/industry-intel"
mkdir -p "$INTEL_DIR"

echo "Running industry intel for $CLIENT_SLUG..."

RAW_OUTPUT=$("$LAST30DAYS_PYTHON" "$SKILL_ROOT/scripts/last30days.py" \
  "$QUERY" \
  --emit=compact \
  --save-dir="$OUTPUT_DIR" \
  --save-suffix="precall-$CLIENT_SLUG" \
  --plan "$PLAN" \
  --subreddits="$SUBREDDITS" \
  --days=7 \
  --quick \
  2>/dev/null) || true

# Save raw output
RAW_FILE="$INTEL_DIR/$DATE-industry-intel.md"
cat > "$RAW_FILE" << EOF
# Industry Intel: $CLIENT_SLUG
Date: $DATE
Query: $QUERY

$RAW_OUTPUT
EOF

echo "Saved to $RAW_FILE"
echo "$RAW_OUTPUT"
