const Database = require('better-sqlite3');

const DB_PATH = '/Users/maxb/Desktop/max-command-center/butters/store/claudeclaw.db';
const db = new Database(DB_PATH, { readonly: true });

const EXPECTED_ACTIVE = new Set([
  '9f64f736',
  'brief-watchdog',
  'ea6d94e6',
  '5b4637b8',
  '627e0910',
  'a347459b',
  'cfdfb1e3',
  'weekly-ai-radar',
  'ai-watchlist-review',
  'weekly-qa-loop',
  'typefully-sync',
  '21351cac',
  '50fd16d6',
  'bcefa2bf',
]);

const EXPECTED_PAUSED = new Set([
  '12c40b97',
  '13984910',
  '17cfce3d',
  '1b804027',
  '1b877d99',
  '3347a478',
  '33e97ff8',
  '52f5ed75',
  '5ece73e9',
  '696390d6',
  '74dfe72c',
  '79e2cefa',
  '84538902',
  '924baf27',
  '9463868d',
  '9b62ab07',
  'b27a0664',
  'b41e1804',
  'bd60eff0',
  'bp-queue-refill',
  'c23d9a86',
  'c7ad9f24',
  'c93d9abb',
  'd17c92d3',
  'ea2553d8',
  'f2ed07d3',
  'f8334ca7',
  'feature-friday',
  'mrbuttersai-nightly-preview',
  'nightly-blocker-removal',
  'sun-voice-summary',
  'weekly-content-recon',
]);

function unixToAgeDays(unixSeconds) {
  if (!unixSeconds) return null;
  return Math.floor((Date.now() / 1000 - unixSeconds) / 86400);
}

function line(prefix, text) {
  console.log(`${prefix} ${text}`);
}

function listLine(prefix, items) {
  if (items.length === 0) {
    line(prefix, 'none');
    return;
  }
  line(prefix, items.join(', '));
}

const taskRows = db.prepare(`
  SELECT id, status, last_run, next_run
  FROM scheduled_tasks
  ORDER BY id
`).all();

const activeIds = taskRows.filter((row) => row.status === 'active').map((row) => row.id);
const pausedIds = taskRows.filter((row) => row.status === 'paused').map((row) => row.id);
const completedIds = taskRows.filter((row) => row.status === 'completed').map((row) => row.id);

const unexpectedActive = activeIds.filter((id) => !EXPECTED_ACTIVE.has(id));
const missingActive = [...EXPECTED_ACTIVE].filter((id) => !activeIds.includes(id));
const unexpectedPaused = pausedIds.filter((id) => !EXPECTED_PAUSED.has(id));

const coreNeverRun = taskRows
  .filter((row) => EXPECTED_ACTIVE.has(row.id) && !row.last_run)
  .map((row) => row.id);

const pendingRows = db.prepare(`
  SELECT id, timestamp, account, platform
  FROM pending_drafts
  WHERE status = 'awaiting'
  ORDER BY timestamp ASC
`).all();

const oldestAwaiting = pendingRows[0];
const awaitingCount = pendingRows.length;
const staleAwaiting30d = pendingRows.filter((row) => unixToAgeDays(row.timestamp) !== null && unixToAgeDays(row.timestamp) >= 30).length;

const pendingFixes = db.prepare(`
  SELECT COUNT(*) AS count
  FROM qa_scores
  WHERE fix_status = 'pending'
`).get().count;

const behaviorChanges = db.prepare(`
  SELECT COUNT(*) AS count
  FROM behavior_changes
`).get().count;

const recentOutcomeRows = db.prepare(`
  SELECT action, COUNT(*) AS count
  FROM hive_mind
  WHERE created_at > strftime('%s','now','-14 days')
    AND action IN ('precall_brief', 'precall_receipt_prompt', 'precall_receipt_reminder', 'precall_receipt')
  GROUP BY action
  ORDER BY action
`).all();

const outcomeCounts = Object.fromEntries(recentOutcomeRows.map((row) => [row.action, row.count]));

const legacyPrecallNoise14d = db.prepare(`
  SELECT COUNT(*) AS count
  FROM hive_mind
  WHERE created_at > strftime('%s','now','-14 days')
    AND action = 'precall_check'
`).get().count;

console.log('Butters Phase 1 Drift Report');
console.log('');

line('active:', `${activeIds.length}`);
line('paused:', `${pausedIds.length}`);
line('completed:', `${completedIds.length}`);
listLine('unexpected_active:', unexpectedActive);
listLine('missing_active:', missingActive);
listLine('unexpected_paused:', unexpectedPaused);
listLine('core_never_run:', coreNeverRun);

console.log('');

line('awaiting_drafts:', `${awaitingCount}`);
line('awaiting_drafts_30d_plus:', `${staleAwaiting30d}`);
if (oldestAwaiting) {
  line(
    'oldest_awaiting:',
    `id=${oldestAwaiting.id} account=${oldestAwaiting.account} platform=${oldestAwaiting.platform} age_days=${unixToAgeDays(oldestAwaiting.timestamp)}`,
  );
} else {
  line('oldest_awaiting:', 'none');
}

console.log('');

line('qa_pending_fixes:', `${pendingFixes}`);
line('behavior_changes_logged:', `${behaviorChanges}`);

console.log('');

line('precall_briefs_14d:', `${outcomeCounts.precall_brief ?? 0}`);
line('receipt_prompts_14d:', `${outcomeCounts.precall_receipt_prompt ?? 0}`);
line('receipt_reminders_14d:', `${outcomeCounts.precall_receipt_reminder ?? 0}`);
line('receipts_logged_14d:', `${outcomeCounts.precall_receipt ?? 0}`);
line('legacy_precall_check_rows_14d:', `${legacyPrecallNoise14d}`);

console.log('');

const hasSchedulerDrift = unexpectedActive.length > 0 || missingActive.length > 0 || unexpectedPaused.length > 0 || coreNeverRun.length > 0;
const hasQueueDrift = awaitingCount > 50 || staleAwaiting30d > 0;
const hasQaDrift = pendingFixes > 0 && behaviorChanges === 0;
const status = hasSchedulerDrift || hasQueueDrift || hasQaDrift ? 'DRIFT' : 'TIGHT';

line('overall:', status);

db.close();
