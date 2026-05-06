/**
 * LCM Summarization for Butters.
 * Uses OpenRouter API (OpenAI-compatible) for Haiku summarization.
 * Includes credit/billing alert detection.
 *
 * Adapted from lossless-claw's summarize.ts — single provider (OpenRouter),
 * single model (Haiku via OpenRouter).
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { LcmConfig } from './config.js';

export type AlertCallback = (error: {
  type: string;
  message: string;
}) => void;

type SummaryMode = 'normal' | 'aggressive';

const SYSTEM_PROMPT =
  'You are a context-compaction summarization engine. Follow user instructions exactly and return plain text summary content only.';

const OPENROUTER_BASE = 'https://openrouter.ai/api/v1';

/** Rough token estimate: ~4 chars per token. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Resolve the OpenRouter API key.
 * Checks: process.env → butters/.env file.
 */
function resolveApiKey(): string | undefined {
  if (process.env.OPENROUTER_API_KEY) return process.env.OPENROUTER_API_KEY;

  // Try reading from butters .env file
  const envPaths = [
    join(process.cwd(), '.env'),
    join(process.cwd(), '..', '.env.local'),
    join(process.cwd(), '..', '.dev.vars'),
  ];
  for (const p of envPaths) {
    try {
      const content = readFileSync(p, 'utf-8');
      const match = content.match(/^OPENROUTER_API_KEY=(.+)$/m);
      if (match) return match[1].trim();
    } catch { /* file not found, try next */ }
  }

  return undefined;
}

function resolveTargetTokens(params: {
  inputTokens: number;
  mode: SummaryMode;
  isCondensed: boolean;
  condensedTargetTokens: number;
}): number {
  if (params.isCondensed) {
    return Math.max(512, params.condensedTargetTokens);
  }
  const { inputTokens, mode } = params;
  if (mode === 'aggressive') {
    return Math.max(96, Math.min(640, Math.floor(inputTokens * 0.2)));
  }
  return Math.max(192, Math.min(1200, Math.floor(inputTokens * 0.35)));
}

// ── Prompt builders ────────────────────────────────────────────────────────

function buildLeafPrompt(params: {
  text: string;
  mode: SummaryMode;
  targetTokens: number;
  previousSummary?: string;
}): string {
  const { text, mode, targetTokens, previousSummary } = params;
  const prevCtx = previousSummary?.trim() || '(none)';

  const policy =
    mode === 'aggressive'
      ? [
          'Aggressive summary policy:',
          '- Keep only durable facts and current task state.',
          '- Remove examples, repetition, and low-value narrative details.',
          '- Preserve explicit TODOs, blockers, decisions, and constraints.',
        ].join('\n')
      : [
          'Normal summary policy:',
          '- Preserve key decisions, rationale, constraints, and active tasks.',
          '- Keep essential technical details needed to continue work safely.',
          '- Remove obvious repetition and conversational filler.',
        ].join('\n');

  return [
    'You summarize a SEGMENT of a conversation for future model turns.',
    'Treat this as incremental memory compaction input, not a full-conversation summary.',
    policy,
    [
      'Output requirements:',
      '- Plain text only.',
      '- No preamble, headings, or markdown formatting.',
      '- Keep it concise while preserving required details.',
      '- Track file operations (created, modified, deleted, renamed) with file paths and current status.',
      '- If no file operations appear, include exactly: "Files: none".',
      '- End with exactly: "Expand for details about: <comma-separated list of what was dropped or compressed>".',
      `- Target length: about ${targetTokens} tokens or less.`,
    ].join('\n'),
    `<previous_context>\n${prevCtx}\n</previous_context>`,
    `<conversation_segment>\n${text}\n</conversation_segment>`,
  ].join('\n\n');
}

function buildCondensedPrompt(params: {
  text: string;
  targetTokens: number;
  depth: number;
  previousSummary?: string;
}): string {
  const { text, targetTokens, depth, previousSummary } = params;
  const prevCtx = previousSummary?.trim();

  if (depth <= 1) {
    const prevBlock = prevCtx
      ? `It already has this preceding summary as context. Do not repeat information that appears there unchanged. Focus on what is new, changed, or resolved:\n\n<previous_context>\n${prevCtx}\n</previous_context>`
      : 'Focus on what matters for continuation:';
    return [
      'You are compacting leaf-level conversation summaries into a single condensed memory node.',
      'You are preparing context for a fresh model instance that will continue this conversation.',
      prevBlock,
      [
        'Preserve:',
        '- Decisions made and their rationale when rationale matters going forward.',
        '- Earlier decisions that were superseded, and what replaced them.',
        '- Completed tasks/topics with outcomes.',
        '- In-progress items with current state and what remains.',
        '- Blockers, open questions, and unresolved tensions.',
        '- Specific references (names, paths, URLs, identifiers) needed for continuation.',
        '',
        'Drop low-value detail:',
        '- Context that has not changed from previous_context.',
        '- Intermediate dead ends where the conclusion is already known.',
        '- Transient states that are already resolved.',
        '- Tool-internal mechanics and process scaffolding.',
        '',
        'Use plain text. No mandatory structure.',
        'Include a timeline with timestamps for significant events.',
        'Present information chronologically and mark superseded decisions.',
        '"Expand for details about: <comma-separated list of what was dropped or compressed>".',
        `Target length: about ${targetTokens} tokens.`,
      ].join('\n'),
      `<conversation_to_condense>\n${text}\n</conversation_to_condense>`,
    ].join('\n\n');
  }

  if (depth === 2) {
    return [
      'You are condensing multiple session-level summaries into a higher-level memory node.',
      'A future model should understand trajectory, not per-session minutiae.',
      [
        'Preserve:',
        '- Decisions still in effect and their rationale.',
        '- Decisions that evolved: what changed and why.',
        '- Completed work with outcomes.',
        '- Active constraints, limitations, and known issues.',
        '- Current state of in-progress work.',
        '',
        'Drop:',
        '- Session-local operational detail and process mechanics.',
        '- Identifiers that are no longer relevant.',
        '- Intermediate states superseded by later outcomes.',
        '',
        'Use plain text. Brief headers are fine if useful.',
        'Include a timeline with dates for key milestones.',
        '"Expand for details about: <comma-separated list of what was dropped or compressed>".',
        `Target length: about ${targetTokens} tokens.`,
      ].join('\n'),
      `<conversation_to_condense>\n${text}\n</conversation_to_condense>`,
    ].join('\n\n');
  }

  // D3+
  return [
    'You are creating a high-level memory node from multiple phase-level summaries.',
    'This may persist for the rest of the conversation. Keep only durable context.',
    [
      'Preserve:',
      '- Key decisions and rationale.',
      '- What was accomplished and current state.',
      '- Active constraints and hard limitations.',
      '- Important relationships between people, systems, or concepts.',
      '- Durable lessons learned.',
      '',
      'Drop:',
      '- Operational and process detail.',
      '- Method details unless the method itself was the decision.',
      '- Specific references unless essential for continuation.',
      '',
      'Use plain text. Be concise.',
      'Include a brief timeline with dates for major milestones.',
      '"Expand for details about: <comma-separated list>".',
      `Target length: about ${targetTokens} tokens.`,
    ].join('\n'),
    `<conversation_to_condense>\n${text}\n</conversation_to_condense>`,
  ].join('\n\n');
}

function buildFallbackSummary(text: string, targetTokens: number): string {
  const trimmed = text.trim();
  if (!trimmed) return '';
  const maxChars = Math.max(256, targetTokens * 4);
  if (trimmed.length <= maxChars) return trimmed;
  return `${trimmed.slice(0, maxChars)}\n[LCM fallback summary; truncated for context management]`;
}

// ── OpenRouter API call ─────────────────────────────────────────────────────

interface OpenRouterResponse {
  choices?: Array<{
    message?: { content?: string };
  }>;
  error?: { message?: string; code?: string | number };
}

async function callOpenRouter(params: {
  apiKey: string;
  model: string;
  system: string;
  prompt: string;
  maxTokens: number;
  temperature: number;
}): Promise<string> {
  const response = await fetch(`${OPENROUTER_BASE}/chat/completions`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${params.apiKey}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://butters.local',
      'X-Title': 'Butters LCM',
    },
    body: JSON.stringify({
      model: params.model,
      max_tokens: params.maxTokens,
      temperature: params.temperature,
      messages: [
        { role: 'system', content: params.system },
        { role: 'user', content: params.prompt },
      ],
    }),
  });

  if (!response.ok) {
    const errorBody = await response.text().catch(() => '');
    const err = new Error(
      `OpenRouter ${response.status}: ${errorBody || response.statusText}`,
    ) as Error & { status: number };
    err.status = response.status;
    throw err;
  }

  const data = (await response.json()) as OpenRouterResponse;

  if (data.error) {
    const err = new Error(
      `OpenRouter error: ${data.error.message || JSON.stringify(data.error)}`,
    ) as Error & { status: number };
    err.status = typeof data.error.code === 'number' ? data.error.code : 500;
    throw err;
  }

  return data.choices?.[0]?.message?.content?.trim() || '';
}

// ── Summarizer factory ──────────────────────────────────────────────────────

export type SummarizeFn = (
  text: string,
  aggressive?: boolean,
  options?: {
    previousSummary?: string;
    isCondensed?: boolean;
    depth?: number;
  },
) => Promise<string>;

/**
 * Creates a summarize function backed by OpenRouter (Haiku).
 * Catches billing/credit errors and fires the alert callback.
 */
export function createSummarizer(
  config: LcmConfig,
  onCreditAlert: AlertCallback,
): SummarizeFn {
  const apiKey = resolveApiKey();
  if (!apiKey) {
    console.warn('[lcm] No OPENROUTER_API_KEY found — summarization will use deterministic fallback');
  }

  return async (text, aggressive, options) => {
    if (!text.trim()) return '';
    if (!apiKey) return buildFallbackSummary(text, 1200);

    const mode: SummaryMode = aggressive ? 'aggressive' : 'normal';
    const isCondensed = options?.isCondensed === true;
    const targetTokens = resolveTargetTokens({
      inputTokens: estimateTokens(text),
      mode,
      isCondensed,
      condensedTargetTokens: config.condensedTargetTokens,
    });

    const prompt = isCondensed
      ? buildCondensedPrompt({
          text,
          targetTokens,
          depth: options?.depth ?? 1,
          previousSummary: options?.previousSummary,
        })
      : buildLeafPrompt({
          text,
          mode,
          targetTokens,
          previousSummary: options?.previousSummary,
        });

    try {
      const summary = await callOpenRouter({
        apiKey,
        model: config.summaryModel,
        system: SYSTEM_PROMPT,
        prompt,
        maxTokens: targetTokens,
        temperature: aggressive ? 0.1 : 0.2,
      });

      if (!summary) {
        // Retry once with conservative settings
        try {
          const retrySummary = await callOpenRouter({
            apiKey,
            model: config.summaryModel,
            system: SYSTEM_PROMPT,
            prompt,
            maxTokens: targetTokens,
            temperature: 0.05,
          });
          if (retrySummary) return retrySummary;
        } catch {
          // Fall through to deterministic fallback
        }
        return buildFallbackSummary(text, targetTokens);
      }

      return summary;
    } catch (err: unknown) {
      if (isCreditError(err)) {
        onCreditAlert({
          type: getCreditErrorType(err),
          message: getErrorMessage(err),
        });
      }
      console.error('[lcm] summarization failed:', getErrorMessage(err));
      return buildFallbackSummary(text, targetTokens);
    }
  };
}

// ── Error classification ─────────────────────────────────────────────────────

function isCreditError(err: unknown): boolean {
  const msg = getErrorMessage(err).toLowerCase();
  const status = getErrorStatus(err);
  return (
    status === 402 ||
    status === 429 ||
    msg.includes('credit') ||
    msg.includes('billing') ||
    msg.includes('insufficient') ||
    msg.includes('payment') ||
    msg.includes('quota')
  );
}

function getCreditErrorType(err: unknown): string {
  const status = getErrorStatus(err);
  if (status === 402) return 'payment_required';
  if (status === 429) return 'rate_limited';
  const msg = getErrorMessage(err).toLowerCase();
  if (msg.includes('credit') || msg.includes('insufficient'))
    return 'insufficient_credits';
  if (msg.includes('billing')) return 'billing_error';
  if (msg.includes('quota')) return 'quota_exceeded';
  return 'unknown_billing';
}

function getErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

function getErrorStatus(err: unknown): number | undefined {
  if (
    err &&
    typeof err === 'object' &&
    'status' in err &&
    typeof (err as { status: unknown }).status === 'number'
  ) {
    return (err as { status: number }).status;
  }
  return undefined;
}
