#!/usr/bin/env node
/**
 * Kill-list scanner for content drafts.
 *
 * Usage:
 *   echo "draft text" | node kill-list-scanner.mjs
 *   node kill-list-scanner.mjs --scan-pending    # scan all awaiting drafts in DB
 *   node kill-list-scanner.mjs "inline text"     # scan inline text
 *
 * Exit codes:
 *   0 = clean (no violations)
 *   1 = violations found
 */

import { readFileSync } from 'fs';
import Database from 'better-sqlite3';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const DB_PATH = join(__dirname, '..', 'store', 'claudeclaw.db');

// ── Banned phrases (exact match, case-insensitive) ──────────────────────
const BANNED_PHRASES = [
  "just dropped",
  "just launched",
  "just released",
  "let's dive in",
  "dive into",
  "game-changer",
  "game changer",
  "unlock",
  "leverage",
  "transform",
  "here's what i learned",
  "in today's world",
  "in today's fast-paced",
  "in today's",
  "it's important to note",
  "it's worth noting",
  "delve",
  "unpack",
  "harness",
  "utilize",
  "landscape",
  "realm",
  "robust",
  "cutting-edge",
  "straightforward",
  "i'd be happy to help",
  "in order to",
  "furthermore",
  "additionally",
  "moreover",
  "moving forward",
  "at the end of the day",
  "to put this in perspective",
  "what makes this particularly interesting",
  "the implications here are",
  "in other words",
  "it goes without saying",
  "let that sink in",
  "read that again",
  "full stop",
  "this changes everything",
  "supercharge",
  "future-proof",
  "10x your productivity",
  "the ai revolution",
  "in the age of ai",
  "here's the part nobody's talking about",
  "what nobody tells you",
];

// ── Structural patterns (regex) ─────────────────────────────────────────
const STRUCTURAL_PATTERNS = [
  {
    name: '"Not X. Y." flip pattern',
    regex: /(?:this isn'?t|that isn'?t|it'?s not|forget)\b[^.]{0,60}\.\s*(?:this is|that'?s|it'?s)\b/gi,
    description: 'Negates one framing then asserts another (classic flip)',
  },
  {
    name: '"Less X, more Y" flip pattern',
    regex: /less \w[\w\s]{0,20}[,.]?\s*more \w/gi,
    description: 'Less/more opposition pattern',
  },
  {
    name: '"The [noun] isn\'t your [noun]" reversal',
    regex: /the \w+ (?:isn'?t|aren'?t|wasn'?t) (?:your|the) \w+\.\s*(?:your|the) \w+ (?:is|are|was)\b/gi,
    description: 'Classic AI reversal pattern',
  },
  {
    name: '"[Noun] isn\'t [noun]. [Noun] is/are." reversal',
    regex: /\w+ (?:isn'?t|aren'?t) (?:your |the |a )?[\w\s]{2,20}\.\s*(?:your |the |a )?\w+ (?:is|are)\./gi,
    description: 'Broader reversal pattern: negation then assertion',
  },
  {
    name: 'Em dash',
    regex: /\u2014/g,
    description: 'Em dashes are banned in all content',
  },
  {
    name: 'Exclamation point',
    regex: /!/g,
    description: 'Exclamation points are banned in content drafts',
  },
  {
    name: 'List items starting with same word (3+)',
    regex: null, // Custom check below
    description: 'Lists where every item starts identically signals AI voice',
  },
];

// ── Scanner ─────────────────────────────────────────────────────────────
function scanText(text) {
  const violations = [];
  const lower = text.toLowerCase();

  // Check banned phrases
  for (const phrase of BANNED_PHRASES) {
    const phraseLower = phrase.toLowerCase();
    if (lower.includes(phraseLower)) {
      // Find the line for context
      const lines = text.split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].toLowerCase().includes(phraseLower)) {
          violations.push({
            type: 'banned_phrase',
            match: phrase,
            line: i + 1,
            context: lines[i].trim().substring(0, 120),
          });
        }
      }
    }
  }

  // Check structural patterns
  for (const pattern of STRUCTURAL_PATTERNS) {
    if (!pattern.regex) continue;
    const matches = text.matchAll(pattern.regex);
    for (const match of matches) {
      const lineNum = text.substring(0, match.index).split('\n').length;
      violations.push({
        type: 'structural_pattern',
        match: pattern.name,
        line: lineNum,
        context: match[0].trim().substring(0, 120),
        description: pattern.description,
      });
    }
  }

  // Check for lists with same starting word (3+ items)
  const lines = text.split('\n');
  const listLines = lines.filter(l => /^[-•›▸]\s/.test(l.trim()) || /^\d+\.\s/.test(l.trim()));
  if (listLines.length >= 3) {
    const firstWords = listLines.map(l =>
      l.trim().replace(/^[-•›▸\d.]+\s*/, '').split(/\s+/)[0]?.toLowerCase()
    );
    const wordCounts = {};
    for (const w of firstWords) {
      wordCounts[w] = (wordCounts[w] || 0) + 1;
    }
    for (const [word, count] of Object.entries(wordCounts)) {
      if (count >= 3 && word) {
        violations.push({
          type: 'structural_pattern',
          match: 'Same-word list opener',
          line: 0,
          context: `${count} list items start with "${word}"`,
          description: 'Lists that all start with the same word signal AI voice',
        });
      }
    }
  }

  return violations;
}

function formatViolations(violations) {
  if (violations.length === 0) return null;

  let out = `⚠️ Kill-list violations found (${violations.length}):\n`;
  for (const v of violations) {
    if (v.type === 'banned_phrase') {
      out += `  › Line ${v.line}: banned phrase "${v.match}" — "${v.context}"\n`;
    } else {
      out += `  › Line ${v.line}: ${v.match} — ${v.context}\n`;
    }
  }
  return out;
}

// ── Pending drafts scanner ──────────────────────────────────────────────
function scanPendingDrafts() {
  const db = new Database(DB_PATH, { readonly: true });
  const drafts = db.prepare(
    `SELECT id, platform, account, draft_text, source FROM pending_drafts WHERE status = 'awaiting' ORDER BY timestamp ASC`
  ).all();
  db.close();

  if (drafts.length === 0) {
    console.log('No pending drafts to scan.');
    return 0;
  }

  let totalViolations = 0;

  for (const draft of drafts) {
    const violations = scanText(draft.draft_text);
    if (violations.length > 0) {
      totalViolations += violations.length;
      console.log(`\n─── Draft #${draft.id} (${draft.platform} / ${draft.account}) ───`);
      console.log(formatViolations(violations));
    } else {
      console.log(`✅ Draft #${draft.id} (${draft.platform} / ${draft.account}) — clean`);
    }
  }

  return totalViolations;
}

// ── Main ────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);

if (args.includes('--scan-pending')) {
  const count = scanPendingDrafts();
  process.exit(count > 0 ? 1 : 0);
} else if (args.includes('--json')) {
  // JSON mode for programmatic use — reads stdin
  let text = '';
  if (!process.stdin.isTTY) {
    text = readFileSync('/dev/stdin', 'utf-8');
  } else if (args.length > 0) {
    text = args.filter(a => a !== '--json').join(' ');
  }
  const violations = scanText(text);
  console.log(JSON.stringify({ violations, clean: violations.length === 0 }));
  process.exit(violations.length > 0 ? 1 : 0);
} else if (args.length > 0 && args[0] !== '--help') {
  // Inline text
  const text = args.join(' ');
  const violations = scanText(text);
  if (violations.length > 0) {
    console.log(formatViolations(violations));
    process.exit(1);
  } else {
    console.log('✅ Clean — no violations found.');
    process.exit(0);
  }
} else if (!process.stdin.isTTY) {
  // Stdin
  let text = readFileSync('/dev/stdin', 'utf-8');
  const violations = scanText(text);
  if (violations.length > 0) {
    console.log(formatViolations(violations));
    process.exit(1);
  } else {
    console.log('✅ Clean — no violations found.');
    process.exit(0);
  }
} else {
  console.log(`Usage:
  echo "draft text" | node kill-list-scanner.mjs
  node kill-list-scanner.mjs "some text to check"
  node kill-list-scanner.mjs --scan-pending
  node kill-list-scanner.mjs --json < file.txt`);
  process.exit(0);
}
