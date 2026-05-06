/**
 * LCM (Lossless Context Management) for Butters.
 *
 * DAG-based conversation memory that never forgets.
 * Every message is persisted, summarized into layers, and searchable.
 *
 * Extracted from lossless-claw (github.com/martian-engineering/lossless-claw)
 * and adapted for Butters' ClaudeClaw architecture.
 */

import type Database from 'better-sqlite3';

import { resolveLcmConfig, type LcmConfig } from './config.js';
import { runLcmMigrations } from './migration.js';
import { LcmStore, type SearchResult } from './store.js';
import { CompactionEngine } from './compaction.js';
import { createSummarizer, estimateTokens, type AlertCallback } from './summarize.js';

export type { SearchResult } from './store.js';
export type { LcmConfig } from './config.js';

/** Context budget for Opus 4.6 with 1M context window */
const DEFAULT_TOKEN_BUDGET = 1_000_000;

export class LcmEngine {
  private store: LcmStore;
  private compaction: CompactionEngine;
  private config: LcmConfig;
  private onCreditAlert: AlertCallback;

  constructor(
    db: Database.Database,
    opts?: {
      config?: Partial<LcmConfig>;
      onCreditAlert?: AlertCallback;
      tokenBudget?: number;
    },
  ) {
    // Run migrations
    runLcmMigrations(db);

    // Resolve config
    this.config = resolveLcmConfig();
    if (opts?.config) {
      Object.assign(this.config, opts.config);
    }

    // Set up alert callback
    this.onCreditAlert = opts?.onCreditAlert ?? (() => {});

    // Initialize store
    this.store = new LcmStore(db);

    // Create summarizer
    const summarize = createSummarizer(this.config, (error) => {
      // Log to DB
      this.store.logCreditAlert(error.type, error.message);
      // Fire callback (sends Telegram alert)
      this.onCreditAlert(error);
    });

    // Initialize compaction engine
    this.compaction = new CompactionEngine(
      this.store,
      this.config,
      summarize,
    );
  }

  /**
   * Ingest a message into the LCM DAG.
   * Call this after every conversation turn (both user and assistant messages).
   */
  ingest(params: {
    sessionId: string;
    role: 'user' | 'assistant';
    content: string;
    tokenCount?: number;
  }): { conversationId: number; messageId: number } {
    const { sessionId, role, content } = params;
    const tokenCount = params.tokenCount ?? estimateTokens(content);

    // Get or create conversation
    const conversationId =
      this.store.getOrCreateConversation(sessionId);

    // Get next sequence number
    const seq = this.store.getMaxSeq(conversationId) + 1;

    // Create message
    const msg = this.store.createMessage({
      conversationId,
      seq,
      role,
      content,
      tokenCount,
    });

    // Append to context items
    this.store.appendContextMessage(conversationId, msg.messageId);

    return { conversationId, messageId: msg.messageId };
  }

  /**
   * Run compaction on a conversation.
   * Call this when the CLI detects a compact_boundary event,
   * or proactively after ingesting messages.
   */
  async compact(
    sessionId: string,
    tokenBudget?: number,
  ): Promise<{
    actionTaken: boolean;
    tokensBefore: number;
    tokensAfter: number;
  }> {
    const conversationId =
      this.store.getOrCreateConversation(sessionId);
    const budget = tokenBudget ?? DEFAULT_TOKEN_BUDGET;
    return this.compaction.compact(conversationId, budget);
  }

  /**
   * Search across all conversations — messages and summaries.
   * Powers the /recall command.
   */
  search(query: string, limit?: number): SearchResult[] {
    return this.store.search(query, limit);
  }

  /**
   * Build a memory context string from the DAG for a given query.
   * Returns relevant summaries formatted for injection into the prompt.
   */
  buildContext(query: string, maxResults = 5): string {
    const results = this.store.search(query, maxResults);
    if (results.length === 0) return '';

    const lines = results.map((r) => {
      const prefix =
        r.type === 'summary' ? `[${r.kind} summary]` : `[${r.role}]`;
      return `${prefix} (${r.createdAt}): ${r.snippet}`;
    });

    return `[LCM recall context]\n${lines.join('\n')}\n[End LCM recall]`;
  }

  /**
   * Expand a summary to see its children or source messages.
   */
  expand(
    summaryId: string,
    opts?: {
      depth?: number;
      includeMessages?: boolean;
      tokenCap?: number;
    },
  ) {
    return this.store.expand(summaryId, opts);
  }

  /**
   * Get DAG statistics.
   */
  getStats() {
    return this.store.getStats();
  }

  /**
   * Check if there's been a recent credit alert.
   */
  hasRecentCreditAlert(withinMinutes = 60): boolean {
    return this.store.getRecentCreditAlert(withinMinutes) !== null;
  }
}
