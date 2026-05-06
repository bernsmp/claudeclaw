const Database = require('better-sqlite3');
const fs = require('fs');
const { execFileSync } = require('child_process');

const db = new Database('/Users/maxb/Desktop/max-command-center/butters/store/claudeclaw.db');
const envPath = '/Users/maxb/Desktop/max-command-center/butters/.env';
const env = fs.readFileSync(envPath, 'utf8');
const tokenMatch = env.match(/^TYPEFULLY_API_KEY=(.+)$/m);

if (!tokenMatch) {
  console.error('TYPEFULLY_API_KEY not found in .env');
  process.exit(1);
}

const TYPEFULLY_API_KEY = tokenMatch[1].trim();
const ACCOUNT_MAP = {
  274760: 'Beyond Prompts',
  289434: 'Butters',
};
const SOCIAL_SET_IDS = [274760, 289434];
const SUBSTACK_SCRIPT = '/Users/maxb/Desktop/max-command-center/butters/scripts/post-substack-note.mjs';

function ensurePendingDraftColumns() {
  const cols = db.prepare(`PRAGMA table_info(pending_drafts)`).all();

  const ensure = (name, sql) => {
    if (!cols.some((c) => c.name === name)) {
      db.exec(`ALTER TABLE pending_drafts ADD COLUMN ${sql}`);
    }
  };

  ensure('substack_note_status', `substack_note_status TEXT DEFAULT ''`);
  ensure('substack_note_url', `substack_note_url TEXT DEFAULT ''`);
  ensure('substack_note_posted_at', 'substack_note_posted_at INTEGER');
  ensure('public_safety_status', `public_safety_status TEXT DEFAULT ''`);
  ensure('public_safety_notes', `public_safety_notes TEXT DEFAULT ''`);
  ensure('public_safety_checked_at', 'public_safety_checked_at INTEGER');
}

function extractTweetId(url) {
  const match = url?.match(/status\/(\d+)/);
  return match ? match[1] : '';
}

function previewLead(preview) {
  return (preview || '').replace(/\s+/g, ' ').trim().slice(0, 120);
}

async function fetchDrafts(socialSetId, status) {
  const url = `https://api.typefully.com/v2/social-sets/${socialSetId}/drafts?status=${status}&limit=25`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${TYPEFULLY_API_KEY}` },
  });

  if (!res.ok) {
    throw new Error(`Typefully API failed for social set ${socialSetId} (${status}): ${res.status}`);
  }

  const json = await res.json();
  return json.results || [];
}

function findMatchingDraft(apiDraft, accountName) {
  const tweetId = extractTweetId(apiDraft.x_published_url || '');
  const preview = previewLead(apiDraft.preview);

  let row = db.prepare(
    `SELECT * FROM pending_drafts
     WHERE typefully_id = ?
     LIMIT 1`
  ).get(String(apiDraft.id));
  if (row) return row;

  row = db.prepare(
    `SELECT * FROM pending_drafts
     WHERE private_url = ?
     LIMIT 1`
  ).get(apiDraft.private_url || '');
  if (row) return row;

  row = db.prepare(
    `SELECT * FROM pending_drafts
     WHERE x_published_url = ?
     LIMIT 1`
  ).get(apiDraft.x_published_url || '');
  if (row) return row;

  row = db.prepare(
    `SELECT * FROM pending_drafts
     WHERE account = ?
       AND platform = 'x'
       AND substr(replace(replace(draft_text, char(10), ' '), char(13), ' '), 1, 120) = ?
     ORDER BY timestamp DESC
     LIMIT 1`
  ).get(accountName, preview);
  if (row) return row;

  if (tweetId) {
    row = db.prepare(
      `SELECT * FROM pending_drafts
       WHERE account = ?
         AND platform = 'x'
         AND x_published_url LIKE ?
       ORDER BY timestamp DESC
       LIMIT 1`
    ).get(accountName, `%${tweetId}`);
    if (row) return row;
  }

  return null;
}

function upsertFromApiDraft(apiDraft, accountName) {
  const status = apiDraft.status === 'published'
    ? 'posted'
    : apiDraft.status === 'scheduled'
      ? 'scheduled'
      : apiDraft.status;

  const postedAt = apiDraft.published_at
    ? Math.floor(new Date(apiDraft.published_at).getTime() / 1000)
    : null;

  const match = findMatchingDraft(apiDraft, accountName);

  if (match) {
    db.prepare(
      `UPDATE pending_drafts
       SET status = CASE
             WHEN status = 'awaiting' AND ? IN ('scheduled', 'posted') THEN ?
             ELSE ?
           END,
           typefully_id = ?,
           private_url = ?,
           x_published_url = ?,
           posted_at = COALESCE(?, posted_at),
           scheduled_for = ?,
           performance_checked_at = CASE
             WHEN ? IS NOT NULL OR ? IS NOT NULL OR ? IS NOT NULL OR ? IS NOT NULL OR ? IS NOT NULL
             THEN strftime('%s','now')
             ELSE performance_checked_at
           END,
           impressions = COALESCE(?, impressions),
           likes = COALESCE(?, likes),
           replies = COALESCE(?, replies),
           reposts = COALESCE(?, reposts),
           bookmarks = COALESCE(?, bookmarks)
       WHERE id = ?`
    ).run(
      status,
      status,
      status,
      String(apiDraft.id),
      apiDraft.private_url || '',
      apiDraft.x_published_url || '',
      postedAt,
      apiDraft.scheduled_date || '',
      apiDraft.impressions ?? null,
      apiDraft.likes ?? null,
      apiDraft.replies ?? null,
      apiDraft.reposts ?? null,
      apiDraft.bookmarks ?? null,
      apiDraft.impressions ?? null,
      apiDraft.likes ?? null,
      apiDraft.replies ?? null,
      apiDraft.reposts ?? null,
      apiDraft.bookmarks ?? null,
      match.id
    );
    return { kind: 'updated', id: match.id };
  }

  db.prepare(
    `INSERT INTO pending_drafts
      (timestamp, platform, account, draft_text, source, status, typefully_id, private_url, x_published_url, posted_at, scheduled_for)
     VALUES (?, 'x', ?, ?, 'typefully-sync', ?, ?, ?, ?, ?, ?)`
  ).run(
    postedAt || Math.floor(Date.now() / 1000),
    accountName,
    apiDraft.preview || '',
    status,
    String(apiDraft.id),
    apiDraft.private_url || '',
    apiDraft.x_published_url || '',
    postedAt,
    apiDraft.scheduled_date || ''
  );
  return { kind: 'inserted' };
}

function parseSubstackResult(output) {
  const trimmed = output.trim();
  const lines = trimmed.split('\n').map((line) => line.trim()).filter(Boolean);
  const lastLine = lines[lines.length - 1] || '';

  if (trimmed.includes('POSTED via API:') || trimmed.includes('POSTED via browser:')) {
    const match = trimmed.match(/POSTED via (?:API|browser):\s*(.+)$/m);
    return {
      status: 'posted',
      location: match ? match[1].trim() : lastLine,
      postedAt: Math.floor(Date.now() / 1000),
    };
  }

  if (trimmed.includes('SAVED to Obsidian:')) {
    const match = trimmed.match(/SAVED to Obsidian:\s*(.+)$/m);
    return {
      status: 'saved',
      location: match ? match[1].trim() : lastLine,
      postedAt: null,
    };
  }

  return {
    status: 'failed',
    location: lastLine || 'unknown substack result',
    postedAt: null,
  };
}

function evaluatePublicFacingSafety(draft) {
  const reasons = [];
  const text = (draft.draft_text || '').trim();

  if (!text) reasons.push('draft_text_missing');
  if (text.length < 50) reasons.push('draft_too_short');
  if (draft.quality_gate_scanned !== 1) reasons.push(`quality_gate_scanned=${draft.quality_gate_scanned ?? 0}`);

  if (/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i.test(text)) reasons.push('contains_email');
  if (/https?:\/\/|www\./i.test(text)) reasons.push('contains_url');
  if (/\+?\d[\d(). -]{7,}\d/.test(text)) reasons.push('contains_phone_number');
  if (/\[[^\]]+\]\([^)]+\)/.test(text)) reasons.push('contains_markdown_link');

  const likelyClientIdentifiers = [
    /\bTrackableMed\b/i,
    /\bIlluminated\b/i,
    /\bVPT\b/i,
    /\bLodestone\b/i,
    /\bAbraham Group\b/i,
    /\bZed\b/i,
    /\bCadence\b/i,
    /\bCognitive Fingerprint\b/i,
  ];

  for (const pattern of likelyClientIdentifiers) {
    if (pattern.test(text)) {
      reasons.push(`possible_client_identifier:${pattern.source}`);
      break;
    }
  }

  return {
    ok: reasons.length === 0,
    reasons,
    checkedAt: Math.floor(Date.now() / 1000),
  };
}

function setPublicSafetyStatus(draftId, status, notes, checkedAt) {
  db.prepare(
    `UPDATE pending_drafts
     SET public_safety_status = ?,
         public_safety_notes = ?,
         public_safety_checked_at = ?
     WHERE id = ?`
  ).run(status, notes, checkedAt, draftId);
}

function postSubstackNoteForDraft(draft) {
  if (draft.account !== 'Beyond Prompts') return false;
  if (draft.status !== 'posted') return false;
  if (!draft.draft_text || !draft.draft_text.trim()) return false;
  if (draft.substack_note_status === 'posted' || draft.substack_note_status === 'saved') return false;

  const safety = evaluatePublicFacingSafety(draft);
  if (!safety.ok) {
    const notes = safety.reasons.join(', ');
    setPublicSafetyStatus(draft.id, 'review_required', notes, safety.checkedAt);
    db.prepare(
      `UPDATE pending_drafts
       SET substack_note_status = 'review_required',
           substack_note_url = ?
       WHERE id = ?`
    ).run(`Blocked by public safety gate: ${notes}`.slice(0, 500), draft.id);
    return true;
  }

  setPublicSafetyStatus(draft.id, 'passed', '', safety.checkedAt);

  db.prepare(
    `UPDATE pending_drafts
     SET substack_note_status = 'processing'
     WHERE id = ?`
  ).run(draft.id);

  try {
    const output = execFileSync('node', [SUBSTACK_SCRIPT, draft.draft_text], {
      encoding: 'utf8',
      timeout: 180000,
    });
    const result = parseSubstackResult(output);
    db.prepare(
      `UPDATE pending_drafts
       SET substack_note_status = ?,
           substack_note_url = ?,
           substack_note_posted_at = COALESCE(?, substack_note_posted_at)
       WHERE id = ?`
    ).run(result.status, result.location, result.postedAt, draft.id);
    return true;
  } catch (error) {
    const stderr = error.stderr?.toString?.() || '';
    const stdout = error.stdout?.toString?.() || '';
    const message = [stderr.trim(), stdout.trim(), error.message].filter(Boolean)[0] || 'substack note failed';

    db.prepare(
      `UPDATE pending_drafts
       SET substack_note_status = 'failed',
           substack_note_url = ?
       WHERE id = ?`
    ).run(message.slice(0, 500), draft.id);
    return true;
  }
}

async function main() {
  let changes = 0;
  ensurePendingDraftColumns();

  for (const socialSetId of SOCIAL_SET_IDS) {
    const accountName = ACCOUNT_MAP[socialSetId] || `social-set-${socialSetId}`;
    for (const status of ['scheduled', 'published']) {
      const drafts = await fetchDrafts(socialSetId, status);
      for (const draft of drafts) {
        const result = upsertFromApiDraft(draft, accountName);
        if (result.kind === 'updated' || result.kind === 'inserted') {
          changes += 1;
        }
      }
    }
  }

  const postedBeyondPrompts = db.prepare(
    `SELECT * FROM pending_drafts
     WHERE account = 'Beyond Prompts'
       AND status = 'posted'
       AND (substack_note_status = '' OR substack_note_status = 'failed')
     ORDER BY posted_at ASC, timestamp ASC`
  ).all();

  for (const draft of postedBeyondPrompts) {
    if (postSubstackNoteForDraft(draft)) {
      changes += 1;
    }
  }

  db.close();
  console.log('done');
}

main().catch((err) => {
  console.error(err.message || String(err));
  process.exit(1);
});
