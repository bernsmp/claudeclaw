const Database = require('better-sqlite3');

function usage() {
  console.error('Usage: node record-behavior-change.cjs --feature <feature> --summary <summary> [--before <text>] [--after <text>] [--approved-by <name>]');
  process.exit(1);
}

const args = process.argv.slice(2);
const values = {
  feature: '',
  summary: '',
  before: '',
  after: '',
  approvedBy: 'max',
};

for (let i = 0; i < args.length; i += 1) {
  const arg = args[i];
  const next = args[i + 1];

  if ((arg === '--feature' || arg === '--summary' || arg === '--before' || arg === '--after' || arg === '--approved-by') && !next) {
    usage();
  }

  if (arg === '--feature') {
    values.feature = next;
    i += 1;
  } else if (arg === '--summary') {
    values.summary = next;
    i += 1;
  } else if (arg === '--before') {
    values.before = next;
    i += 1;
  } else if (arg === '--after') {
    values.after = next;
    i += 1;
  } else if (arg === '--approved-by') {
    values.approvedBy = next;
    i += 1;
  } else {
    usage();
  }
}

if (!values.feature || !values.summary) {
  usage();
}

const db = new Database('/Users/maxb/Desktop/max-command-center/butters/store/claudeclaw.db');

const result = db
  .prepare(
    `INSERT INTO behavior_changes (feature, change_summary, before_text, after_text, approved_by)
     VALUES (?, ?, ?, ?, ?)`
  )
  .run(values.feature, values.summary, values.before, values.after, values.approvedBy);

console.log(`Recorded behavior change #${result.lastInsertRowid} for feature "${values.feature}".`);
db.close();
