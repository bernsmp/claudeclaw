/**
 * LCM Compaction Engine for Butters.
 * Builds the DAG of summaries from raw messages.
 * Adapted from lossless-claw's compaction.ts — stripped of OpenClaw-specific features.
 */

import { createHash } from 'node:crypto';

import type { LcmConfig } from './config.js';
import type { LcmStore, MessageRecord } from './store.js';
import type { SummarizeFn } from './summarize.js';
import { estimateTokens } from './summarize.js';

export interface CompactionResult {
  actionTaken: boolean;
  tokensBefore: number;
  tokensAfter: number;
  createdSummaryId?: string;
  condensed: boolean;
}

export class CompactionEngine {
  constructor(
    private store: LcmStore,
    private config: LcmConfig,
    private summarize: SummarizeFn,
  ) {}

  /**
   * Run compaction if the context window exceeds the threshold.
   * Multi-round: keeps compacting until under budget or no progress.
   */
  async compact(
    conversationId: number,
    tokenBudget: number,
  ): Promise<CompactionResult> {
    const threshold = tokenBudget * this.config.contextThreshold;
    const currentTokens = this.store.getContextTokenCount(conversationId);

    if (currentTokens <= threshold) {
      return {
        actionTaken: false,
        tokensBefore: currentTokens,
        tokensAfter: currentTokens,
        condensed: false,
      };
    }

    const tokensBefore = currentTokens;
    let lastSummaryId: string | undefined;
    let didCondense = false;
    const maxRounds = 10;

    for (let round = 0; round < maxRounds; round++) {
      const tokens = this.store.getContextTokenCount(conversationId);
      if (tokens <= threshold) break;

      const aggressive = round > 0;
      const leafResult = await this.runLeafPass(
        conversationId,
        aggressive,
      );

      if (!leafResult) break; // No compactable messages
      lastSummaryId = leafResult.summaryId;

      // Run condensation passes if configured
      if (this.config.incrementalMaxDepth !== 0) {
        const condensed = await this.runCondensedPass(conversationId);
        if (condensed) didCondense = true;
      }
    }

    const tokensAfter = this.store.getContextTokenCount(conversationId);

    return {
      actionTaken: tokensBefore !== tokensAfter,
      tokensBefore,
      tokensAfter,
      createdSummaryId: lastSummaryId,
      condensed: didCondense,
    };
  }

  /**
   * Leaf pass: find compactable messages outside the fresh tail,
   * group them into chunks, summarize each chunk, replace in context.
   */
  private async runLeafPass(
    conversationId: number,
    aggressive: boolean,
  ): Promise<{ summaryId: string } | null> {
    const contextItems = this.store.getContextItems(conversationId);
    const freshTailCount = this.config.freshTailCount;

    // Find message items outside the fresh tail
    const protectedStart = Math.max(
      0,
      contextItems.length - freshTailCount,
    );
    const compactableItems = contextItems
      .slice(0, protectedStart)
      .filter((item) => item.itemType === 'message');

    if (compactableItems.length < 2) return null;

    // Gather the actual messages
    const messages: Array<MessageRecord & { ordinal: number }> = [];
    for (const item of compactableItems) {
      if (!item.messageId) continue;
      const msg = this.store.getMessageById(item.messageId);
      if (msg) {
        messages.push({ ...msg, ordinal: item.ordinal });
      }
    }

    if (messages.length < 2) return null;

    // Chunk messages by token budget
    const chunks = this.chunkMessages(messages);
    let lastSummaryId: string | null = null;

    for (const chunk of chunks) {
      if (chunk.length === 0) continue;

      // Format messages into text for summarization
      const text = chunk
        .map(
          (m) =>
            `[${m.role}] (${m.createdAt})\n${m.content}`,
        )
        .join('\n\n---\n\n');

      // Summarize
      const summaryText = await this.summarize(text, aggressive);
      if (!summaryText) continue;

      const summaryTokens = estimateTokens(summaryText);
      const messageTokens = chunk.reduce(
        (sum, m) => sum + m.tokenCount,
        0,
      );

      // Determine time range
      const earliest = chunk[0]?.createdAt;
      const latest = chunk[chunk.length - 1]?.createdAt;

      // Create the summary
      const summary = this.store.insertSummary({
        conversationId,
        kind: 'leaf',
        depth: 0,
        content: summaryText,
        tokenCount: summaryTokens,
        earliestAt: earliest,
        latestAt: latest,
        sourceMessageTokenCount: messageTokens,
      });

      // Link to source messages
      this.store.linkSummaryToMessages(
        summary.summaryId,
        chunk.map((m) => m.messageId),
      );

      // Replace context items
      const startOrd = chunk[0].ordinal;
      const endOrd = chunk[chunk.length - 1].ordinal;
      this.store.replaceContextRangeWithSummary({
        conversationId,
        startOrdinal: startOrd,
        endOrdinal: endOrd,
        summaryId: summary.summaryId,
      });

      lastSummaryId = summary.summaryId;
    }

    return lastSummaryId ? { summaryId: lastSummaryId } : null;
  }

  /**
   * Condensed pass: if enough same-depth summaries exist,
   * condense them into a higher-depth summary.
   */
  private async runCondensedPass(
    conversationId: number,
  ): Promise<boolean> {
    const contextItems = this.store.getContextItems(conversationId);
    const summaryItems = contextItems.filter(
      (item) => item.itemType === 'summary' && item.summaryId,
    );

    if (summaryItems.length < this.config.leafMinFanout) return false;

    // Group consecutive same-depth summaries
    const summaries = summaryItems
      .map((item) => {
        const sum = this.store.getSummary(item.summaryId!);
        return sum ? { ...sum, ordinal: item.ordinal } : null;
      })
      .filter(Boolean) as Array<
      ReturnType<LcmStore['getSummary']> & { ordinal: number }
    >;

    // Find groups of consecutive same-depth summaries
    const groups: Array<
      Array<NonNullable<ReturnType<LcmStore['getSummary']>> & { ordinal: number }>
    > = [];
    let currentGroup: Array<
      NonNullable<ReturnType<LcmStore['getSummary']>> & { ordinal: number }
    > = [];

    for (const sum of summaries) {
      if (!sum) continue;
      if (
        currentGroup.length > 0 &&
        currentGroup[0].depth !== sum.depth
      ) {
        if (currentGroup.length >= this.config.condensedMinFanout) {
          groups.push([...currentGroup]);
        }
        currentGroup = [];
      }
      currentGroup.push(sum);
    }
    if (currentGroup.length >= this.config.condensedMinFanout) {
      groups.push(currentGroup);
    }

    if (groups.length === 0) return false;

    let didCondense = false;

    for (const group of groups) {
      const depth = group[0].depth + 1;
      const minFanout =
        depth <= 1
          ? this.config.leafMinFanout
          : this.config.condensedMinFanout;

      if (group.length < minFanout) continue;

      // Build text from summaries
      const text = group
        .map(
          (s) =>
            `[Summary ${s.summaryId} | ${s.kind} | depth ${s.depth}]\n${s.content}`,
        )
        .join('\n\n---\n\n');

      const summaryText = await this.summarize(text, false, {
        isCondensed: true,
        depth,
      });
      if (!summaryText) continue;

      const summaryTokens = estimateTokens(summaryText);
      const earliest = group[0].earliestAt;
      const latest = group[group.length - 1].latestAt;

      const condensed = this.store.insertSummary({
        conversationId,
        kind: 'condensed',
        depth,
        content: summaryText,
        tokenCount: summaryTokens,
        earliestAt: earliest ?? undefined,
        latestAt: latest ?? undefined,
      });

      // Link to parent summaries
      this.store.linkSummaryToParents(
        condensed.summaryId,
        group.map((s) => s.summaryId),
      );

      // Replace context items
      const startOrd = group[0].ordinal;
      const endOrd = group[group.length - 1].ordinal;
      this.store.replaceContextRangeWithSummary({
        conversationId,
        startOrdinal: startOrd,
        endOrdinal: endOrd,
        summaryId: condensed.summaryId,
      });

      didCondense = true;
    }

    return didCondense;
  }

  /**
   * Chunk messages into groups that fit within leafChunkTokens.
   */
  private chunkMessages(
    messages: Array<MessageRecord & { ordinal: number }>,
  ): Array<Array<MessageRecord & { ordinal: number }>> {
    const chunks: Array<Array<MessageRecord & { ordinal: number }>> = [];
    let current: Array<MessageRecord & { ordinal: number }> = [];
    let currentTokens = 0;

    for (const msg of messages) {
      if (
        currentTokens + msg.tokenCount > this.config.leafChunkTokens &&
        current.length > 0
      ) {
        chunks.push(current);
        current = [];
        currentTokens = 0;
      }
      current.push(msg);
      currentTokens += msg.tokenCount;
    }

    if (current.length > 0) {
      chunks.push(current);
    }

    return chunks;
  }
}
