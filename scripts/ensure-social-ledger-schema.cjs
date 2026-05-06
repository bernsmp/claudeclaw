const Database = require('better-sqlite3');

const db = new Database('/Users/maxb/Desktop/max-command-center/butters/store/claudeclaw.db');

const cols = db.prepare(`PRAGMA table_info(pending_drafts)`).all();

const ensure = (name, sql) => {
  if (!cols.some((c) => c.name === name)) {
    db.exec(`ALTER TABLE pending_drafts ADD COLUMN ${sql}`);
    console.log(`Added pending_drafts.${name}`);
  }
};

ensure('quality_gate_scanned', 'quality_gate_scanned INTEGER DEFAULT 0');
ensure('private_url', `private_url TEXT DEFAULT ''`);
ensure('x_published_url', `x_published_url TEXT DEFAULT ''`);
ensure('posted_at', 'posted_at INTEGER');
ensure('scheduled_for', `scheduled_for TEXT DEFAULT ''`);
ensure('substack_note_status', `substack_note_status TEXT DEFAULT ''`);
ensure('substack_note_url', `substack_note_url TEXT DEFAULT ''`);
ensure('substack_note_posted_at', 'substack_note_posted_at INTEGER');
ensure('performance_checked_at', 'performance_checked_at INTEGER');
ensure('impressions', 'impressions INTEGER');
ensure('likes', 'likes INTEGER');
ensure('replies', 'replies INTEGER');
ensure('reposts', 'reposts INTEGER');
ensure('bookmarks', 'bookmarks INTEGER');

db.close();
