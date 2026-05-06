/**
 * LCM database migration for Butters.
 * Adds DAG tables to the existing claudeclaw.db alongside Butters' own tables.
 * Adapted from lossless-claw's migration.ts for better-sqlite3.
 */

import type Database from 'better-sqlite3';

export function runLcmMigrations(db: Database.Database): void {
  db.exec(`
    -- LCM conversations (maps to Butters sessions)
    CREATE TABLE IF NOT EXISTS lcm_conversations (
      conversation_id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      title TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_lcm_conv_session
      ON lcm_conversations(session_id);

    -- LCM messages (raw message archive — never deleted)
    CREATE TABLE IF NOT EXISTS lcm_messages (
      message_id INTEGER PRIMARY KEY AUTOINCREMENT,
      conversation_id INTEGER NOT NULL
        REFERENCES lcm_conversations(conversation_id) ON DELETE CASCADE,
      seq INTEGER NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('system', 'user', 'assistant', 'tool')),
      content TEXT NOT NULL,
      token_count INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE (conversation_id, seq)
    );

    CREATE INDEX IF NOT EXISTS idx_lcm_msg_conv_seq
      ON lcm_messages(conversation_id, seq);

    -- LCM summaries (DAG nodes — leaf and condensed)
    CREATE TABLE IF NOT EXISTS lcm_summaries (
      summary_id TEXT PRIMARY KEY,
      conversation_id INTEGER NOT NULL
        REFERENCES lcm_conversations(conversation_id) ON DELETE CASCADE,
      kind TEXT NOT NULL CHECK (kind IN ('leaf', 'condensed')),
      depth INTEGER NOT NULL DEFAULT 0,
      content TEXT NOT NULL,
      token_count INTEGER NOT NULL,
      earliest_at TEXT,
      latest_at TEXT,
      descendant_count INTEGER NOT NULL DEFAULT 0,
      descendant_token_count INTEGER NOT NULL DEFAULT 0,
      source_message_token_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_lcm_sum_conv
      ON lcm_summaries(conversation_id, created_at);

    -- Links leaf summaries to their source messages
    CREATE TABLE IF NOT EXISTS lcm_summary_messages (
      summary_id TEXT NOT NULL
        REFERENCES lcm_summaries(summary_id) ON DELETE CASCADE,
      message_id INTEGER NOT NULL
        REFERENCES lcm_messages(message_id) ON DELETE RESTRICT,
      ordinal INTEGER NOT NULL,
      PRIMARY KEY (summary_id, message_id)
    );

    -- Links condensed summaries to their parent summaries (DAG edges)
    CREATE TABLE IF NOT EXISTS lcm_summary_parents (
      summary_id TEXT NOT NULL
        REFERENCES lcm_summaries(summary_id) ON DELETE CASCADE,
      parent_summary_id TEXT NOT NULL
        REFERENCES lcm_summaries(summary_id) ON DELETE RESTRICT,
      ordinal INTEGER NOT NULL,
      PRIMARY KEY (summary_id, parent_summary_id)
    );

    -- Ordered list of what's currently "in context" (messages or summaries)
    CREATE TABLE IF NOT EXISTS lcm_context_items (
      conversation_id INTEGER NOT NULL
        REFERENCES lcm_conversations(conversation_id) ON DELETE CASCADE,
      ordinal INTEGER NOT NULL,
      item_type TEXT NOT NULL CHECK (item_type IN ('message', 'summary')),
      message_id INTEGER REFERENCES lcm_messages(message_id) ON DELETE RESTRICT,
      summary_id TEXT REFERENCES lcm_summaries(summary_id) ON DELETE RESTRICT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (conversation_id, ordinal),
      CHECK (
        (item_type = 'message' AND message_id IS NOT NULL AND summary_id IS NULL) OR
        (item_type = 'summary' AND summary_id IS NOT NULL AND message_id IS NULL)
      )
    );

    CREATE INDEX IF NOT EXISTS idx_lcm_ctx_conv
      ON lcm_context_items(conversation_id, ordinal);

    -- FTS5 for full-text search across messages
    CREATE VIRTUAL TABLE IF NOT EXISTS lcm_messages_fts USING fts5(
      content,
      tokenize='porter unicode61'
    );

    -- FTS5 for full-text search across summaries
    CREATE VIRTUAL TABLE IF NOT EXISTS lcm_summaries_fts USING fts5(
      summary_id UNINDEXED,
      content,
      tokenize='porter unicode61'
    );

    -- Credit alert tracking
    CREATE TABLE IF NOT EXISTS lcm_credit_alerts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      error_type TEXT NOT NULL,
      error_message TEXT NOT NULL,
      alerted_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
}
