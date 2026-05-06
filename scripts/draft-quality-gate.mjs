#!/usr/bin/env node
/**
 * Draft quality gate — runs every 60 seconds via scheduled task.
 * Scans new pending_drafts for kill-list violations.
 *
 * If violations found:
 *   1. Rewrites the draft via Claude (--print, no session)
 *   2. Updates the draft in DB with clean version
 *   3. Adds a note column so we know it was auto-cleaned
 *
 * If no violations: does nothing (draft passes through untouched).
 *
 * Usage:
 *   node draft-quality-gate.mjs          # scan and auto-rewrite
 *   node draft-quality-gate.mjs --dry    # scan only, don't rewrite
 */

import Database from 'better-sqlite3';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { readFileSync, writeFileSync, unlinkSync, existsSync } from 'fs';
import { tmpdir } from 'os';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const DB_PATH = join(__dirname, '..', 'store', 'claudeclaw.db');
const DRY_RUN = process.argv.includes('--dry');

// ── Import scanner logic ────────────────────────────────────────────────
// We inline the core scanning logic to avoid import issues with the
// scanner's CLI entry point.

const BANNED_PHRASES = [
  "just dropped", "just launched", "just released",
  "let's dive in", "dive into",
  "game-changer", "game changer",
  "unlock", "leverage", "transform",
  "here's what i learned",
  "in today's world", "in today's fast-paced", "in today's",
  "it's important to note", "it's worth noting",
  "delve", "unpack", "harness", "utilize",
  "landscape", "realm", "robust", "cutting-edge", "straightforward",
  "i'd be happy to help", "in order to",
  "furthermore", "additionally", "moreover", "moving forward",
  "at the end of the day", "to put this in perspective",
  "what makes this particularly interesting",
  "the implications here are", "in other words",
  "it goes without saying", "let that sink in", "read that again",
  "full stop", "this changes everything",
  "supercharge", "future-proof", "10x your productivity",
  "the ai revolution", "in the age of ai",
  "here's the part nobody's talking about", "what nobody tells you",
];

const STRUCTURAL_PATTERNS = [
  {
    name: '"Not X. Y." flip',
    regex: /(?:this isn'?t|that isn'?t|it'?s not|forget)\b[^.]{0,60}\.\s*(?:this is|that'?s|it'?s)\b/gi,
  },
  {
    name: '"Less X, more Y" flip',
    regex: /less \w[\w\s]{0,20}[,.]?\s*more \w/gi,
  },
  {
    name: '"The [noun] isn\'t your [noun]" reversal',
    regex: /the \w+ (?:isn'?t|aren'?t|wasn'?t) (?:your|the) \w+\.\s*(?:your|the) \w+ (?:is|are|was)\b/gi,
  },
  {
    name: 'Broader reversal',
    regex: /\w+ (?:isn'?t|aren'?t) (?:your |the |a )?[\w\s]{2,20}\.\s*(?:your |the |a )?\w+ (?:is|are)\./gi,
  },
  {
    name: 'Em dash',
    regex: /\u2014/g,
  },
  {
    name: 'Exclamation point',
    regex: /!/g,
  },
];

function scanText(text) {
  const violations = [];
  const lower = text.toLowerCase();

  for (const phrase of BANNED_PHRASES) {
    if (lower.includes(phrase.toLowerCase())) {
      violations.push({ type: 'banned_phrase', match: phrase });
    }
  }

  for (const pattern of STRUCTURAL_PATTERNS) {
    if (!pattern.regex) continue;
    const matches = [...text.matchAll(pattern.regex)];
    if (matches.length > 0) {
      violations.push({ type: 'structural', match: pattern.name, count: matches.length });
    }
  }

  return violations;
}

// ── Rewrite via Claude ──────────────────────────────────────────────────
function rewriteDraft(originalText, violations) {
  const violationList = violations.map(v => `- ${v.match}`).join('\n');

  const prompt = `Rewrite this social media draft to fix the following kill-list violations. Keep the meaning, tone, and structure identical. Only fix the specific violations. Do NOT add em dashes, exclamation points, or any banned phrases. Return ONLY the rewritten text, nothing else.

VIOLATIONS:
${violationList}

ORIGINAL DRAFT:
${originalText}`;

  try {
    const tmpFile = join(tmpdir(), `butters-rewrite-${Date.now()}.txt`);
    writeFileSync(tmpFile, prompt, 'utf-8');
    // Try multiple known Claude CLI locations
    const claudePaths = [
      '/Users/maxb/conductor/cc/claude',
      '/Users/maxb/Library/Application Support/Claude/claude-code/2.1.51/claude',
    ];
    const claudeBin = claudePaths.find(p => existsSync(p)) || 'claude';
    const result = execSync(
      `cat "${tmpFile}" | "${claudeBin}" --print 2>/dev/null`,
      { timeout: 90000, encoding: 'utf-8', cwd: join(__dirname, '..') }
    );
    try { unlinkSync(tmpFile); } catch (_) {}
    return result.trim();
  } catch (e) {
    console.error('Claude rewrite failed:', e.message?.substring(0, 200));
    return null;
  }
}

// ── Main ────────────────────────────────────────────────────────────────
const db = new Database(DB_PATH);

// Ensure quality_gate_scanned column exists
try {
  db.exec(`ALTER TABLE pending_drafts ADD COLUMN quality_gate_scanned INTEGER DEFAULT 0`);
} catch (e) {
  // Column already exists, that's fine
}

// Get unscanned awaiting drafts
const drafts = db.prepare(
  `SELECT id, platform, account, draft_text, source
   FROM pending_drafts
   WHERE status = 'awaiting' AND quality_gate_scanned = 0
   ORDER BY timestamp ASC`
).all();

if (drafts.length === 0) {
  process.exit(0);
}

for (const draft of drafts) {
  const violations = scanText(draft.draft_text);

  if (violations.length === 0) {
    // Mark as scanned, no issues
    db.prepare(`UPDATE pending_drafts SET quality_gate_scanned = 1 WHERE id = ?`).run(draft.id);
    console.log(`✅ Draft #${draft.id} — clean, marked scanned`);
    continue;
  }

  console.log(`⚠️ Draft #${draft.id} — ${violations.length} violation(s):`);
  for (const v of violations) {
    console.log(`  › ${v.match}`);
  }

  if (DRY_RUN) {
    console.log('  (dry run — skipping rewrite)');
    continue;
  }

  // Rewrite
  console.log('  Rewriting via Claude...');
  const rewritten = rewriteDraft(draft.draft_text, violations);

  if (rewritten) {
    // Verify the rewrite is clean
    const newViolations = scanText(rewritten);
    if (newViolations.length > 0) {
      console.log(`  ⚠️ Rewrite still has ${newViolations.length} violation(s) — keeping original, flagging for manual review`);
      db.prepare(`UPDATE pending_drafts SET quality_gate_scanned = 2 WHERE id = ?`).run(draft.id);
    } else {
      // Update draft with clean version
      db.prepare(
        `UPDATE pending_drafts SET draft_text = ?, quality_gate_scanned = 1 WHERE id = ?`
      ).run(rewritten, draft.id);
      console.log(`  ✅ Rewritten and updated in DB`);
    }
  } else {
    // Claude failed, mark for manual review
    db.prepare(`UPDATE pending_drafts SET quality_gate_scanned = 2 WHERE id = ?`).run(draft.id);
    console.log(`  ⚠️ Rewrite failed — flagged for manual review`);
  }
}

db.close();
