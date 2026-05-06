const Database = require('better-sqlite3');

function usage() {
  console.error(
    'Usage: node record-social-result.cjs --draft-id <id> [--status <status>] [--typefully-id <id>] [--private-url <url>] [--x-url <url>] [--scheduled-for <iso>] [--posted-at <unix>] [--impressions <n>] [--likes <n>] [--replies <n>] [--reposts <n>] [--bookmarks <n>]'
  );
  process.exit(1);
}

const args = process.argv.slice(2);
const values = {
  draftId: '',
  status: '',
  typefullyId: '',
  privateUrl: '',
  xUrl: '',
  scheduledFor: '',
  postedAt: '',
  impressions: '',
  likes: '',
  replies: '',
  reposts: '',
  bookmarks: '',
};

for (let i = 0; i < args.length; i += 1) {
  const arg = args[i];
  const next = args[i + 1];

  if (!next) usage();

  if (arg === '--draft-id') {
    values.draftId = next;
  } else if (arg === '--status') {
    values.status = next;
  } else if (arg === '--typefully-id') {
    values.typefullyId = next;
  } else if (arg === '--private-url') {
    values.privateUrl = next;
  } else if (arg === '--x-url') {
    values.xUrl = next;
  } else if (arg === '--scheduled-for') {
    values.scheduledFor = next;
  } else if (arg === '--posted-at') {
    values.postedAt = next;
  } else if (arg === '--impressions') {
    values.impressions = next;
  } else if (arg === '--likes') {
    values.likes = next;
  } else if (arg === '--replies') {
    values.replies = next;
  } else if (arg === '--reposts') {
    values.reposts = next;
  } else if (arg === '--bookmarks') {
    values.bookmarks = next;
  } else {
    usage();
  }

  i += 1;
}

if (!values.draftId) usage();

const db = new Database('/Users/maxb/Desktop/max-command-center/butters/store/claudeclaw.db');

const draft = db.prepare('SELECT id FROM pending_drafts WHERE id = ?').get(values.draftId);
if (!draft) {
  console.error(`Draft ${values.draftId} not found.`);
  process.exit(1);
}

const updates = [];
const params = [];

const push = (fragment, value) => {
  updates.push(fragment);
  params.push(value);
};

if (values.status) push('status = ?', values.status);
if (values.typefullyId) push('typefully_id = ?', values.typefullyId);
if (values.privateUrl) push('private_url = ?', values.privateUrl);
if (values.xUrl) push('x_published_url = ?', values.xUrl);
if (values.scheduledFor) push('scheduled_for = ?', values.scheduledFor);
if (values.postedAt) push('posted_at = ?', Number(values.postedAt));
if (values.impressions) push('impressions = ?', Number(values.impressions));
if (values.likes) push('likes = ?', Number(values.likes));
if (values.replies) push('replies = ?', Number(values.replies));
if (values.reposts) push('reposts = ?', Number(values.reposts));
if (values.bookmarks) push('bookmarks = ?', Number(values.bookmarks));

if (
  values.impressions ||
  values.likes ||
  values.replies ||
  values.reposts ||
  values.bookmarks
) {
  push('performance_checked_at = ?', Math.floor(Date.now() / 1000));
}

if (updates.length === 0) {
  console.error('No updates provided.');
  process.exit(1);
}

params.push(values.draftId);
db.prepare(`UPDATE pending_drafts SET ${updates.join(', ')} WHERE id = ?`).run(...params);

console.log(`Updated pending_draft ${values.draftId}.`);
db.close();
