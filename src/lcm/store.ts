/**
 * LCM Store for Butters.
 * Combined conversation + summary store using better-sqlite3.
 * Adapted from lossless-claw's conversation-store.ts and summary-store.ts.
 */

import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';

// ── Types ────────────────────────────────────────────────────────────────────

export type MessageRole = 'system' | 'user' | 'assistant' | 'tool';
export type SummaryKind = 'leaf' | 'condensed';

export interface MessageRecord {
  messageId: number;
  conversationId: number;
  seq: number;
  role: MessageRole;
  content: string;
  tokenCount: number;
  createdAt: string;
}

export interface SummaryRecord {
  summaryId: string;
  conversationId: number;
  kind: SummaryKind;
  depth: number;
  content: string;
  tokenCount: number;
  earliestAt: string | null;
  latestAt: string | null;
  descendantCount: number;
  descendantTokenCount: number;
  sourceMessageTokenCount: number;
  createdAt: string;
}

export interface ContextItemRecord {
  conversationId: number;
  ordinal: number;
  itemType: 'message' | 'summary';
  messageId: number | null;
  summaryId: string | null;
}

export interface SearchResult {
  id: string | number;
  type: 'message' | 'summary';
  role?: MessageRole;
  kind?: SummaryKind;
  snippet: string;
  createdAt: string;
}

// ── Store ────────────────────────────────────────────────────────────────────

export class LcmStore {
  constructor(private db: Database.Database) {}

  // ── Conversations ─────────────────────────────────────────────────────────

  getOrCreateConversation(sessionId: string): number {
    const existing = this.db
      .prepare(
        `SELECT conversation_id FROM lcm_conversations WHERE session_id = ? LIMIT 1`,
      )
      .get(sessionId) as { conversation_id: number } | undefined;

    if (existing) return existing.conversation_id;

    const result = this.db
      .prepare(`INSERT INTO lcm_conversations (session_id) VALUES (?)`)
      .run(sessionId);

    return Number(result.lastInsertRowid);
  }

  // ── Messages ──────────────────────────────────────────────────────────────

  createMessage(params: {
    conversationId: number;
    seq: number;
    role: MessageRole;
    content: string;
    tokenCount: number;
  }): MessageRecord {
    const result = this.db
      .prepare(
        `INSERT INTO lcm_messages (conversation_id, seq, role, content, token_count)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        params.conversationId,
        params.seq,
        params.role,
        params.content,
        params.tokenCount,
      );

    const messageId = Number(result.lastInsertRowid);

    // Index in FTS5
    try {
      this.db
        .prepare(`INSERT INTO lcm_messages_fts(rowid, content) VALUES (?, ?)`)
        .run(messageId, params.content);
    } catch {
      // FTS indexing is best-effort
    }

    return {
      messageId,
      conversationId: params.conversationId,
      seq: params.seq,
      role: params.role,
      content: params.content,
      tokenCount: params.tokenCount,
      createdAt: new Date().toISOString(),
    };
  }

  getMaxSeq(conversationId: number): number {
    const row = this.db
      .prepare(
        `SELECT COALESCE(MAX(seq), 0) AS max_seq
         FROM lcm_messages WHERE conversation_id = ?`,
      )
      .get(conversationId) as { max_seq: number };
    return row?.max_seq ?? 0;
  }

  getMessages(
    conversationId: number,
    opts?: { afterSeq?: number; limit?: number },
  ): MessageRecord[] {
    const afterSeq = opts?.afterSeq ?? -1;
    const limit = opts?.limit;

    const sql = limit
      ? `SELECT message_id, conversation_id, seq, role, content, token_count, created_at
         FROM lcm_messages
         WHERE conversation_id = ? AND seq > ?
         ORDER BY seq LIMIT ?`
      : `SELECT message_id, conversation_id, seq, role, content, token_count, created_at
         FROM lcm_messages
         WHERE conversation_id = ? AND seq > ?
         ORDER BY seq`;

    const args = limit
      ? [conversationId, afterSeq, limit]
      : [conversationId, afterSeq];

    const rows = this.db.prepare(sql).all(...args) as Array<{
      message_id: number;
      conversation_id: number;
      seq: number;
      role: string;
      content: string;
      token_count: number;
      created_at: string;
    }>;

    return rows.map((r) => ({
      messageId: r.message_id,
      conversationId: r.conversation_id,
      seq: r.seq,
      role: r.role as MessageRole,
      content: r.content,
      tokenCount: r.token_count,
      createdAt: r.created_at,
    }));
  }

  getMessageById(messageId: number): MessageRecord | null {
    const row = this.db
      .prepare(
        `SELECT message_id, conversation_id, seq, role, content, token_count, created_at
         FROM lcm_messages WHERE message_id = ?`,
      )
      .get(messageId) as
      | {
          message_id: number;
          conversation_id: number;
          seq: number;
          role: string;
          content: string;
          token_count: number;
          created_at: string;
        }
      | undefined;

    if (!row) return null;

    return {
      messageId: row.message_id,
      conversationId: row.conversation_id,
      seq: row.seq,
      role: row.role as MessageRole,
      content: row.content,
      tokenCount: row.token_count,
      createdAt: row.created_at,
    };
  }

  // ── Summaries ─────────────────────────────────────────────────────────────

  insertSummary(params: {
    conversationId: number;
    kind: SummaryKind;
    depth: number;
    content: string;
    tokenCount: number;
    earliestAt?: string;
    latestAt?: string;
    sourceMessageTokenCount?: number;
  }): SummaryRecord {
    const summaryId = `sum_${randomUUID().slice(0, 12)}`;

    this.db
      .prepare(
        `INSERT INTO lcm_summaries
           (summary_id, conversation_id, kind, depth, content, token_count,
            earliest_at, latest_at, source_message_token_count)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        summaryId,
        params.conversationId,
        params.kind,
        params.depth,
        params.content,
        params.tokenCount,
        params.earliestAt ?? null,
        params.latestAt ?? null,
        params.sourceMessageTokenCount ?? 0,
      );

    // Index in FTS5
    try {
      this.db
        .prepare(
          `INSERT INTO lcm_summaries_fts(summary_id, content) VALUES (?, ?)`,
        )
        .run(summaryId, params.content);
    } catch {
      // Best-effort
    }

    return {
      summaryId,
      conversationId: params.conversationId,
      kind: params.kind,
      depth: params.depth,
      content: params.content,
      tokenCount: params.tokenCount,
      earliestAt: params.earliestAt ?? null,
      latestAt: params.latestAt ?? null,
      descendantCount: 0,
      descendantTokenCount: 0,
      sourceMessageTokenCount: params.sourceMessageTokenCount ?? 0,
      createdAt: new Date().toISOString(),
    };
  }

  getSummary(summaryId: string): SummaryRecord | null {
    const row = this.db
      .prepare(
        `SELECT summary_id, conversation_id, kind, depth, content, token_count,
                earliest_at, latest_at, descendant_count, descendant_token_count,
                source_message_token_count, created_at
         FROM lcm_summaries WHERE summary_id = ?`,
      )
      .get(summaryId) as Record<string, unknown> | undefined;

    if (!row) return null;
    return this.mapSummaryRow(row);
  }

  getSummariesByConversation(conversationId: number): SummaryRecord[] {
    const rows = this.db
      .prepare(
        `SELECT summary_id, conversation_id, kind, depth, content, token_count,
                earliest_at, latest_at, descendant_count, descendant_token_count,
                source_message_token_count, created_at
         FROM lcm_summaries
         WHERE conversation_id = ?
         ORDER BY created_at`,
      )
      .all(conversationId) as Array<Record<string, unknown>>;
    return rows.map((r) => this.mapSummaryRow(r));
  }

  // ── Summary lineage ───────────────────────────────────────────────────────

  linkSummaryToMessages(summaryId: string, messageIds: number[]): void {
    const stmt = this.db.prepare(
      `INSERT INTO lcm_summary_messages (summary_id, message_id, ordinal)
       VALUES (?, ?, ?) ON CONFLICT DO NOTHING`,
    );
    for (let i = 0; i < messageIds.length; i++) {
      stmt.run(summaryId, messageIds[i], i);
    }
  }

  linkSummaryToParents(
    summaryId: string,
    parentSummaryIds: string[],
  ): void {
    const stmt = this.db.prepare(
      `INSERT INTO lcm_summary_parents (summary_id, parent_summary_id, ordinal)
       VALUES (?, ?, ?) ON CONFLICT DO NOTHING`,
    );
    for (let i = 0; i < parentSummaryIds.length; i++) {
      stmt.run(summaryId, parentSummaryIds[i], i);
    }
  }

  getSummaryMessages(summaryId: string): number[] {
    const rows = this.db
      .prepare(
        `SELECT message_id FROM lcm_summary_messages
         WHERE summary_id = ? ORDER BY ordinal`,
      )
      .all(summaryId) as Array<{ message_id: number }>;
    return rows.map((r) => r.message_id);
  }

  getSummaryChildren(parentSummaryId: string): SummaryRecord[] {
    const rows = this.db
      .prepare(
        `SELECT s.summary_id, s.conversation_id, s.kind, s.depth, s.content,
                s.token_count, s.earliest_at, s.latest_at, s.descendant_count,
                s.descendant_token_count, s.source_message_token_count, s.created_at
         FROM lcm_summaries s
         JOIN lcm_summary_parents sp ON sp.summary_id = s.summary_id
         WHERE sp.parent_summary_id = ?
         ORDER BY sp.ordinal`,
      )
      .all(parentSummaryId) as Array<Record<string, unknown>>;
    return rows.map((r) => this.mapSummaryRow(r));
  }

  getSummaryParents(summaryId: string): SummaryRecord[] {
    const rows = this.db
      .prepare(
        `SELECT s.summary_id, s.conversation_id, s.kind, s.depth, s.content,
                s.token_count, s.earliest_at, s.latest_at, s.descendant_count,
                s.descendant_token_count, s.source_message_token_count, s.created_at
         FROM lcm_summaries s
         JOIN lcm_summary_parents sp ON sp.parent_summary_id = s.summary_id
         WHERE sp.summary_id = ?
         ORDER BY sp.ordinal`,
      )
      .all(summaryId) as Array<Record<string, unknown>>;
    return rows.map((r) => this.mapSummaryRow(r));
  }

  // ── Context items ─────────────────────────────────────────────────────────

  getContextItems(conversationId: number): ContextItemRecord[] {
    const rows = this.db
      .prepare(
        `SELECT conversation_id, ordinal, item_type, message_id, summary_id
         FROM lcm_context_items
         WHERE conversation_id = ? ORDER BY ordinal`,
      )
      .all(conversationId) as Array<{
      conversation_id: number;
      ordinal: number;
      item_type: string;
      message_id: number | null;
      summary_id: string | null;
    }>;

    return rows.map((r) => ({
      conversationId: r.conversation_id,
      ordinal: r.ordinal,
      itemType: r.item_type as 'message' | 'summary',
      messageId: r.message_id,
      summaryId: r.summary_id,
    }));
  }

  appendContextMessage(conversationId: number, messageId: number): void {
    const row = this.db
      .prepare(
        `SELECT COALESCE(MAX(ordinal), -1) AS max_ordinal
         FROM lcm_context_items WHERE conversation_id = ?`,
      )
      .get(conversationId) as { max_ordinal: number };

    this.db
      .prepare(
        `INSERT INTO lcm_context_items (conversation_id, ordinal, item_type, message_id)
         VALUES (?, ?, 'message', ?)`,
      )
      .run(conversationId, row.max_ordinal + 1, messageId);
  }

  getContextTokenCount(conversationId: number): number {
    const row = this.db
      .prepare(
        `SELECT COALESCE(SUM(token_count), 0) AS total
         FROM (
           SELECT m.token_count
           FROM lcm_context_items ci
           JOIN lcm_messages m ON m.message_id = ci.message_id
           WHERE ci.conversation_id = ? AND ci.item_type = 'message'
           UNION ALL
           SELECT s.token_count
           FROM lcm_context_items ci
           JOIN lcm_summaries s ON s.summary_id = ci.summary_id
           WHERE ci.conversation_id = ? AND ci.item_type = 'summary'
         ) sub`,
      )
      .get(conversationId, conversationId) as { total: number };
    return row?.total ?? 0;
  }

  replaceContextRangeWithSummary(params: {
    conversationId: number;
    startOrdinal: number;
    endOrdinal: number;
    summaryId: string;
  }): void {
    const { conversationId, startOrdinal, endOrdinal, summaryId } = params;

    const trx = this.db.transaction(() => {
      // Delete items in range
      this.db
        .prepare(
          `DELETE FROM lcm_context_items
           WHERE conversation_id = ? AND ordinal >= ? AND ordinal <= ?`,
        )
        .run(conversationId, startOrdinal, endOrdinal);

      // Insert summary at startOrdinal
      this.db
        .prepare(
          `INSERT INTO lcm_context_items (conversation_id, ordinal, item_type, summary_id)
           VALUES (?, ?, 'summary', ?)`,
        )
        .run(conversationId, startOrdinal, summaryId);

      // Resequence ordinals
      const items = this.db
        .prepare(
          `SELECT ordinal FROM lcm_context_items
           WHERE conversation_id = ? ORDER BY ordinal`,
        )
        .all(conversationId) as Array<{ ordinal: number }>;

      const updateStmt = this.db.prepare(
        `UPDATE lcm_context_items SET ordinal = ?
         WHERE conversation_id = ? AND ordinal = ?`,
      );

      // Use negative temp ordinals to avoid unique constraint conflicts
      for (let i = 0; i < items.length; i++) {
        updateStmt.run(-(i + 1), conversationId, items[i].ordinal);
      }
      for (let i = 0; i < items.length; i++) {
        updateStmt.run(i, conversationId, -(i + 1));
      }
    });

    trx();
  }

  // ── Search ────────────────────────────────────────────────────────────────

  search(query: string, limit = 20): SearchResult[] {
    const results: SearchResult[] = [];

    // Search messages via FTS5
    try {
      const msgRows = this.db
        .prepare(
          `SELECT m.message_id, m.role,
                  snippet(lcm_messages_fts, 0, '', '', '...', 32) AS snippet,
                  m.created_at
           FROM lcm_messages_fts
           JOIN lcm_messages m ON m.message_id = lcm_messages_fts.rowid
           WHERE lcm_messages_fts MATCH ?
           ORDER BY m.created_at DESC
           LIMIT ?`,
        )
        .all(query, limit) as Array<{
        message_id: number;
        role: string;
        snippet: string;
        created_at: string;
      }>;

      for (const r of msgRows) {
        results.push({
          id: r.message_id,
          type: 'message',
          role: r.role as MessageRole,
          snippet: r.snippet,
          createdAt: r.created_at,
        });
      }
    } catch {
      // FTS5 query may fail on syntax — fall back to LIKE
      const likeRows = this.db
        .prepare(
          `SELECT message_id, role, content, created_at
           FROM lcm_messages
           WHERE content LIKE ?
           ORDER BY created_at DESC LIMIT ?`,
        )
        .all(`%${query}%`, limit) as Array<{
        message_id: number;
        role: string;
        content: string;
        created_at: string;
      }>;

      for (const r of likeRows) {
        const idx = r.content.toLowerCase().indexOf(query.toLowerCase());
        const start = Math.max(0, idx - 50);
        const end = Math.min(r.content.length, idx + query.length + 50);
        results.push({
          id: r.message_id,
          type: 'message',
          role: r.role as MessageRole,
          snippet: r.content.slice(start, end),
          createdAt: r.created_at,
        });
      }
    }

    // Search summaries via FTS5
    try {
      const sumRows = this.db
        .prepare(
          `SELECT sf.summary_id, s.kind,
                  snippet(lcm_summaries_fts, 1, '', '', '...', 32) AS snippet,
                  s.created_at
           FROM lcm_summaries_fts sf
           JOIN lcm_summaries s ON s.summary_id = sf.summary_id
           WHERE lcm_summaries_fts MATCH ?
           ORDER BY s.created_at DESC
           LIMIT ?`,
        )
        .all(query, limit) as Array<{
        summary_id: string;
        kind: string;
        snippet: string;
        created_at: string;
      }>;

      for (const r of sumRows) {
        results.push({
          id: r.summary_id,
          type: 'summary',
          kind: r.kind as SummaryKind,
          snippet: r.snippet,
          createdAt: r.created_at,
        });
      }
    } catch {
      // FTS5 fallback for summaries
      const likeRows = this.db
        .prepare(
          `SELECT summary_id, kind, content, created_at
           FROM lcm_summaries
           WHERE content LIKE ?
           ORDER BY created_at DESC LIMIT ?`,
        )
        .all(`%${query}%`, limit) as Array<{
        summary_id: string;
        kind: string;
        content: string;
        created_at: string;
      }>;

      for (const r of likeRows) {
        const idx = r.content.toLowerCase().indexOf(query.toLowerCase());
        const start = Math.max(0, idx - 50);
        const end = Math.min(r.content.length, idx + query.length + 50);
        results.push({
          id: r.summary_id,
          type: 'summary',
          kind: r.kind as SummaryKind,
          snippet: r.content.slice(start, end),
          createdAt: r.created_at,
        });
      }
    }

    // Sort by recency
    results.sort(
      (a, b) =>
        new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
    );

    return results.slice(0, limit);
  }

  // ── Expand ────────────────────────────────────────────────────────────────

  expand(
    summaryId: string,
    opts?: { depth?: number; includeMessages?: boolean; tokenCap?: number },
  ): {
    children: Array<{
      summaryId: string;
      kind: SummaryKind;
      content: string;
      tokenCount: number;
    }>;
    messages: Array<{
      messageId: number;
      role: MessageRole;
      content: string;
    }>;
    truncated: boolean;
  } {
    const depth = opts?.depth ?? 1;
    const includeMessages = opts?.includeMessages ?? false;
    const tokenCap = opts?.tokenCap ?? Infinity;

    const result = {
      children: [] as Array<{
        summaryId: string;
        kind: SummaryKind;
        content: string;
        tokenCount: number;
      }>,
      messages: [] as Array<{
        messageId: number;
        role: MessageRole;
        content: string;
      }>,
      truncated: false,
      _tokens: 0,
    };

    this.expandRecursive(summaryId, depth, includeMessages, tokenCap, result);

    return {
      children: result.children,
      messages: result.messages,
      truncated: result.truncated,
    };
  }

  private expandRecursive(
    summaryId: string,
    depth: number,
    includeMessages: boolean,
    tokenCap: number,
    result: {
      children: Array<{
        summaryId: string;
        kind: SummaryKind;
        content: string;
        tokenCount: number;
      }>;
      messages: Array<{
        messageId: number;
        role: MessageRole;
        content: string;
      }>;
      truncated: boolean;
      _tokens: number;
    },
  ): void {
    if (depth <= 0 || result.truncated) return;

    const summary = this.getSummary(summaryId);
    if (!summary) return;

    if (summary.kind === 'condensed') {
      const children = this.getSummaryChildren(summaryId);
      for (const child of children) {
        if (result._tokens + child.tokenCount > tokenCap) {
          result.truncated = true;
          break;
        }
        result.children.push({
          summaryId: child.summaryId,
          kind: child.kind,
          content: child.content,
          tokenCount: child.tokenCount,
        });
        result._tokens += child.tokenCount;
        if (depth > 1) {
          this.expandRecursive(
            child.summaryId,
            depth - 1,
            includeMessages,
            tokenCap,
            result,
          );
        }
      }
    } else if (summary.kind === 'leaf' && includeMessages) {
      const messageIds = this.getSummaryMessages(summaryId);
      for (const msgId of messageIds) {
        if (result.truncated) break;
        const msg = this.getMessageById(msgId);
        if (!msg) continue;
        if (result._tokens + msg.tokenCount > tokenCap) {
          result.truncated = true;
          break;
        }
        result.messages.push({
          messageId: msg.messageId,
          role: msg.role,
          content: msg.content,
        });
        result._tokens += msg.tokenCount;
      }
    }
  }

  // ── Credit alerts ─────────────────────────────────────────────────────────

  logCreditAlert(errorType: string, errorMessage: string): void {
    this.db
      .prepare(
        `INSERT INTO lcm_credit_alerts (error_type, error_message) VALUES (?, ?)`,
      )
      .run(errorType, errorMessage);
  }

  getRecentCreditAlert(withinMinutes = 60): { error_type: string } | null {
    return (
      (this.db
        .prepare(
          `SELECT error_type FROM lcm_credit_alerts
         WHERE alerted_at > datetime('now', ? || ' minutes')
         ORDER BY alerted_at DESC LIMIT 1`,
        )
        .get(`-${withinMinutes}`) as { error_type: string } | undefined) ??
      null
    );
  }

  // ── Stats ─────────────────────────────────────────────────────────────────

  getStats(): {
    conversations: number;
    messages: number;
    summaries: number;
    leafSummaries: number;
    condensedSummaries: number;
    maxDepth: number;
  } {
    const convCount = (
      this.db
        .prepare(`SELECT COUNT(*) AS c FROM lcm_conversations`)
        .get() as { c: number }
    ).c;
    const msgCount = (
      this.db
        .prepare(`SELECT COUNT(*) AS c FROM lcm_messages`)
        .get() as { c: number }
    ).c;
    const sumCount = (
      this.db
        .prepare(`SELECT COUNT(*) AS c FROM lcm_summaries`)
        .get() as { c: number }
    ).c;
    const leafCount = (
      this.db
        .prepare(
          `SELECT COUNT(*) AS c FROM lcm_summaries WHERE kind = 'leaf'`,
        )
        .get() as { c: number }
    ).c;
    const condensedCount = (
      this.db
        .prepare(
          `SELECT COUNT(*) AS c FROM lcm_summaries WHERE kind = 'condensed'`,
        )
        .get() as { c: number }
    ).c;
    const maxDepth = (
      this.db
        .prepare(
          `SELECT COALESCE(MAX(depth), 0) AS d FROM lcm_summaries`,
        )
        .get() as { d: number }
    ).d;

    return {
      conversations: convCount,
      messages: msgCount,
      summaries: sumCount,
      leafSummaries: leafCount,
      condensedSummaries: condensedCount,
      maxDepth,
    };
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  private mapSummaryRow(row: Record<string, unknown>): SummaryRecord {
    return {
      summaryId: row.summary_id as string,
      conversationId: row.conversation_id as number,
      kind: row.kind as SummaryKind,
      depth: (row.depth as number) ?? 0,
      content: row.content as string,
      tokenCount: row.token_count as number,
      earliestAt: (row.earliest_at as string) ?? null,
      latestAt: (row.latest_at as string) ?? null,
      descendantCount: (row.descendant_count as number) ?? 0,
      descendantTokenCount: (row.descendant_token_count as number) ?? 0,
      sourceMessageTokenCount:
        (row.source_message_token_count as number) ?? 0,
      createdAt: row.created_at as string,
    };
  }
}
