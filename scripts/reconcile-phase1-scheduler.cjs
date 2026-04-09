const Database = require('better-sqlite3');

const DB_PATH = '/Users/maxb/Desktop/max-command-center/butters/store/claudeclaw.db';
const db = new Database(DB_PATH);

const KEEP_ACTIVE = new Set([
  '9f64f736',          // morning brief
  'brief-watchdog',    // brief watchdog
  'ea6d94e6',          // eod recap
  '5b4637b8',          // overdue loops
  '627e0910',          // monday hygiene
  'a347459b',          // billing alert
  'cfdfb1e3',          // week-ahead brief
  'weekly-ai-radar',   // ai radar
  'ai-watchlist-review',
  'weekly-qa-loop',
  'typefully-sync',
  '21351cac',          // morning gmail prescan
  '50fd16d6',          // eod gmail prescan
  'bcefa2bf',          // ai news cache for morning brief
]);

const DELETE_IDS = new Set([
  '72be55e7',          // removed Kevin Jennings runtime surface
]);

const rows = db.prepare(
  `SELECT id, status
   FROM scheduled_tasks
   WHERE status != 'completed'
   ORDER BY id`,
).all();

const pauseTask = db.prepare(`UPDATE scheduled_tasks SET status = 'paused' WHERE id = ?`);
const resumeTask = db.prepare(`UPDATE scheduled_tasks SET status = 'active' WHERE id = ?`);
const deleteTask = db.prepare(`DELETE FROM scheduled_tasks WHERE id = ?`);

const summary = {
  keptActive: [],
  paused: [],
  resumed: [],
  deleted: [],
};

const tx = db.transaction(() => {
  for (const row of rows) {
    if (DELETE_IDS.has(row.id)) {
      deleteTask.run(row.id);
      summary.deleted.push(row.id);
      continue;
    }

    if (KEEP_ACTIVE.has(row.id)) {
      if (row.status !== 'active') {
        resumeTask.run(row.id);
        summary.resumed.push(row.id);
      }
      summary.keptActive.push(row.id);
      continue;
    }

    if (row.status !== 'paused') {
      pauseTask.run(row.id);
      summary.paused.push(row.id);
    }
  }
});

tx();

console.log(JSON.stringify(summary, null, 2));
db.close();
