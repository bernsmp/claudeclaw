import { agentObsidianConfig } from './config.js';
import {
  decayMemories,
  getRecentMemories,
  logConversationTurn,
  pruneConversationLog,
  saveMemory,
  searchMemories,
  touchMemory,
} from './db.js';
import { buildObsidianContext } from './obsidian.js';
import type { LcmEngine } from './lcm/index.js';

const SEMANTIC_SIGNALS = /\b(my|i am|i'm|i prefer|remember|always|never)\b/i;

// ── LCM integration ──────────────────────────────────────────────────────────

let lcmEngine: LcmEngine | null = null;

/** Called once at startup to wire in the LCM engine. */
export function setLcmEngine(engine: LcmEngine): void {
  lcmEngine = engine;
}

/** Get the LCM engine (if initialized). */
export function getLcmEngine(): LcmEngine | null {
  return lcmEngine;
}

// ── Memory context ───────────────────────────────────────────────────────────

/**
 * Build a compact memory context string to prepend to the user's message.
 *
 * Three-layer progressive disclosure:
 *   Layer 1: FTS5 keyword search against user message -> top 3 results
 *   Layer 2: Most recent 5 memories (recency)
 *   Layer 3: LCM DAG search (summaries from full conversation history)
 *   Deduplicates between layers 1 & 2.
 *
 * Returns empty string if no memories exist for this chat.
 */
export async function buildMemoryContext(
  chatId: string,
  userMessage: string,
  options: { afterSessionReset?: boolean } = {},
): Promise<string> {
  const seen = new Set<number>();
  const lines: string[] = [];

  // Layer 1: keyword search
  const searched = searchMemories(chatId, userMessage, 3);
  for (const mem of searched) {
    seen.add(mem.id);
    touchMemory(mem.id);
    lines.push(`- ${mem.content} (${mem.sector})`);
  }

  // Layer 2: recent memories (deduplicated)
  const recent = getRecentMemories(chatId, 5);
  for (const mem of recent) {
    if (seen.has(mem.id)) continue;
    seen.add(mem.id);
    touchMemory(mem.id);
    lines.push(`- ${mem.content} (${mem.sector})`);
  }

  const memBlock = lines.length > 0
    ? `[Memory context]\n${lines.join('\n')}\n[End memory context]`
    : '';

  // Layer 3: LCM DAG recall (searches full conversation history)
  let lcmBlock = '';
  if (lcmEngine && userMessage.length > 10) {
    try {
      lcmBlock = lcmEngine.buildContext(userMessage, 3);
    } catch (err) {
      console.error('[lcm] Failed to build DAG context:', err);
    }
  }

  const obsidianBlock = buildObsidianContext(agentObsidianConfig);

  const blocks = [memBlock, lcmBlock, obsidianBlock].filter(Boolean);
  if (blocks.length === 0) return '';

  if (options.afterSessionReset) {
    blocks.unshift(
      '[Session reset guard]\n' +
      'This chat was just reset with /newchat or /forget.\n' +
      'Any memory, LCM, or Obsidian context below is restored background context, not a continuation of the old live session.\n' +
      'Treat recalled claims as possibly stale until re-verified.\n' +
      'If you use recalled context, label it as remembered context instead of presenting it as freshly verified truth.\n' +
      '[End session reset guard]',
    );
  }

  return blocks.join('\n\n');
}

// ── Conversation turn ────────────────────────────────────────────────────────

/**
 * Extract and save memorable facts from a conversation turn.
 * Called AFTER Claude responds, with both user message and Claude's response.
 *
 * Now also ingests both messages into the LCM DAG for lossless history.
 */
export function saveConversationTurn(
  chatId: string,
  userMessage: string,
  claudeResponse: string,
  sessionId?: string,
  agentId = 'main',
): void {
  try {
    // Always log full conversation to conversation_log (for /respin)
    logConversationTurn(chatId, 'user', userMessage, sessionId, agentId);
    logConversationTurn(chatId, 'assistant', claudeResponse, sessionId, agentId);
  } catch (err) {
    // DB write failure should not crash the bot
    console.error('Failed to log conversation turn:', err);
  }

  // LCM ingest — persist to DAG (never lost, even after compaction)
  if (lcmEngine && sessionId) {
    try {
      lcmEngine.ingest({ sessionId, role: 'user', content: userMessage });
      lcmEngine.ingest({ sessionId, role: 'assistant', content: claudeResponse });
    } catch (err) {
      console.error('[lcm] Failed to ingest into DAG:', err);
    }
  }

  // Skip short or command-like messages for memory extraction
  if (userMessage.length <= 20 || userMessage.startsWith('/')) return;

  try {
    if (SEMANTIC_SIGNALS.test(userMessage)) {
      saveMemory(chatId, userMessage, 'semantic');
    } else {
      saveMemory(chatId, userMessage, 'episodic');
    }
  } catch (err) {
    console.error('Failed to save memory:', err);
  }
}

// ── Compaction trigger ───────────────────────────────────────────────────────

/**
 * Trigger LCM compaction for a session.
 * Call this when the CLI emits a compact_boundary event.
 */
export async function triggerLcmCompaction(
  sessionId: string,
  tokenBudget?: number,
): Promise<void> {
  if (!lcmEngine) return;
  try {
    const result = await lcmEngine.compact(sessionId, tokenBudget);
    if (result.actionTaken) {
      console.log(
        `[lcm] Compacted: ${result.tokensBefore} → ${result.tokensAfter} tokens`,
      );
    }
  } catch (err) {
    console.error('[lcm] Compaction failed:', err);
  }
}

// ── Decay ────────────────────────────────────────────────────────────────────

/**
 * Run the daily decay sweep. Call once on startup and every 24h.
 * Also prunes old conversation_log entries to prevent unbounded growth.
 */
export function runDecaySweep(): void {
  decayMemories();
  pruneConversationLog(500);
}
