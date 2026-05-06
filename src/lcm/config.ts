/**
 * LCM Configuration for Butters.
 * Simplified from lossless-claw's config — no plugin system, just env vars + defaults.
 */

export type LcmConfig = {
  enabled: boolean;
  /** Fraction of context window that triggers compaction (0.0–1.0) */
  contextThreshold: number;
  /** Number of recent messages protected from compaction */
  freshTailCount: number;
  /** Minimum leaf summaries before condensing */
  leafMinFanout: number;
  /** Minimum condensed summaries before re-condensing */
  condensedMinFanout: number;
  /** How deep incremental compaction goes (-1 = unlimited) */
  incrementalMaxDepth: number;
  /** Max source tokens per leaf compaction chunk */
  leafChunkTokens: number;
  /** Target token count for leaf summaries */
  leafTargetTokens: number;
  /** Target token count for condensed summaries */
  condensedTargetTokens: number;
  /** Max token output for expand queries */
  maxExpandTokens: number;
  /** Model to use for summarization */
  summaryModel: string;
  /** IANA timezone for timestamps */
  timezone: string;
};

export function resolveLcmConfig(
  env: NodeJS.ProcessEnv = process.env,
): LcmConfig {
  return {
    enabled: env.LCM_ENABLED !== 'false',
    contextThreshold: env.LCM_CONTEXT_THRESHOLD
      ? parseFloat(env.LCM_CONTEXT_THRESHOLD)
      : 0.75,
    freshTailCount: env.LCM_FRESH_TAIL_COUNT
      ? parseInt(env.LCM_FRESH_TAIL_COUNT, 10)
      : 32,
    leafMinFanout: env.LCM_LEAF_MIN_FANOUT
      ? parseInt(env.LCM_LEAF_MIN_FANOUT, 10)
      : 8,
    condensedMinFanout: env.LCM_CONDENSED_MIN_FANOUT
      ? parseInt(env.LCM_CONDENSED_MIN_FANOUT, 10)
      : 4,
    incrementalMaxDepth: env.LCM_INCREMENTAL_MAX_DEPTH
      ? parseInt(env.LCM_INCREMENTAL_MAX_DEPTH, 10)
      : -1,
    leafChunkTokens: env.LCM_LEAF_CHUNK_TOKENS
      ? parseInt(env.LCM_LEAF_CHUNK_TOKENS, 10)
      : 20000,
    leafTargetTokens: env.LCM_LEAF_TARGET_TOKENS
      ? parseInt(env.LCM_LEAF_TARGET_TOKENS, 10)
      : 1200,
    condensedTargetTokens: env.LCM_CONDENSED_TARGET_TOKENS
      ? parseInt(env.LCM_CONDENSED_TARGET_TOKENS, 10)
      : 2000,
    maxExpandTokens: env.LCM_MAX_EXPAND_TOKENS
      ? parseInt(env.LCM_MAX_EXPAND_TOKENS, 10)
      : 4000,
    summaryModel: env.LCM_SUMMARY_MODEL || 'anthropic/claude-haiku-4-5',
    timezone:
      env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone,
  };
}
