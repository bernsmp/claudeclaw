import {
  AGENT_BACKEND,
  AgentBackend,
  HERMES_SCHEDULER_TASK_IDS,
} from './config.js';
import { logToHiveMind } from './db.js';
import { runClaudeAgent } from './claude-runner.js';
import { runHermesAgent } from './hermes-runner.js';
import { logger } from './logger.js';
import {
  AgentProgressEvent,
  AgentResult,
  AgentSource,
  RunAgentOptions,
  UsageInfo,
} from './agent-types.js';

export type {
  AgentProgressEvent,
  AgentResult,
  AgentSource,
  RunAgentOptions,
  UsageInfo,
} from './agent-types.js';

function sourceAllowsHermes(
  options?: RunAgentOptions,
  schedulerTaskIds: ReadonlySet<string> = HERMES_SCHEDULER_TASK_IDS,
): boolean {
  const source = options?.source ?? 'unknown';
  if (source === 'manual' || source === 'dashboard') return true;

  if (source === 'scheduler' && options?.taskId) {
    return schedulerTaskIds.has(options.taskId);
  }

  return false;
}

export function resolveAgentBackend(
  configuredBackend: AgentBackend,
  options?: RunAgentOptions,
  schedulerTaskIds: ReadonlySet<string> = HERMES_SCHEDULER_TASK_IDS,
): AgentBackend {
  if (configuredBackend === 'claude') return 'claude';
  if (!sourceAllowsHermes(options, schedulerTaskIds)) return 'claude';
  return configuredBackend;
}

function logHermesShadowResult(
  status: 'success' | 'failed',
  options: RunAgentOptions | undefined,
  startedAt: number,
  resultOrError: AgentResult | unknown,
): void {
  const durationMs = Date.now() - startedAt;
  const chatId = options?.chatId || 'system';
  const source = options?.source ?? 'unknown';
  const taskId = options?.taskId;

  try {
    if (status === 'success') {
      const result = resultOrError as AgentResult;
      const text = result.text?.trim() || '';
      logToHiveMind(
        'hermes-shadow',
        chatId,
        'agent_shadow',
        `Hermes shadow completed for ${source}${taskId ? ` task ${taskId}` : ''}: ${text.slice(0, 500)}`,
        JSON.stringify({
          status,
          source,
          taskId,
          duration_ms: durationMs,
          text,
          new_session_id: result.newSessionId,
        }),
      );
      return;
    }

    const err = resultOrError instanceof Error ? resultOrError.message : String(resultOrError);
    logToHiveMind(
      'hermes-shadow',
      chatId,
      'agent_shadow_failed',
      `Hermes shadow failed for ${source}${taskId ? ` task ${taskId}` : ''}: ${err.slice(0, 500)}`,
      JSON.stringify({
        status,
        source,
        taskId,
        duration_ms: durationMs,
        error: err,
      }),
    );
  } catch (dbErr) {
    logger.error({ err: dbErr }, 'Failed to record Hermes shadow result');
  }
}

export function isSafeForHermesShadow(message: string): boolean {
  const compact = message.toLowerCase().replace(/\s+/g, ' ').trim();
  const obviousMutation = /\b(write|edit|update|delete|remove|apply|patch|commit|push|deploy|send|post|schedule|publish|create|add|install|rebuild|restart|start|stop|run|execute|fix|mark|clear|archive|move|copy)\b/.test(compact);
  if (obviousMutation) return false;

  return /\b(check|review|explain|summarize|analyse|analyze|compare|find|search|look up|what|why|how|list|show|audit|inspect)\b/.test(compact);
}

function runHermesShadow(
  message: string,
  sessionId: string | undefined,
  options?: RunAgentOptions,
): void {
  const safetyText = options?.shadowSafetyText ?? message;
  if (!isSafeForHermesShadow(safetyText)) {
    try {
      logToHiveMind(
        'hermes-shadow',
        options?.chatId || 'system',
        'agent_shadow_skipped',
        `Hermes shadow skipped for ${options?.source ?? 'unknown'} because prompt was not read-only safe.`,
        JSON.stringify({
          source: options?.source ?? 'unknown',
          taskId: options?.taskId,
          reason: 'not_read_only_safe',
        }),
      );
    } catch (dbErr) {
      logger.error({ err: dbErr }, 'Failed to record Hermes shadow skip');
    }
    return;
  }

  const startedAt = Date.now();
  void runHermesAgent(message, sessionId, () => {}, undefined, options)
    .then((result) => logHermesShadowResult('success', options, startedAt, result))
    .catch((err) => logHermesShadowResult('failed', options, startedAt, err));
}

function logHermesFallback(
  options: RunAgentOptions | undefined,
  err: unknown,
): void {
  const source = options?.source ?? 'unknown';
  const chatId = options?.chatId || 'system';
  const taskId = options?.taskId;
  const detail = err instanceof Error ? err.message : String(err);

  try {
    logToHiveMind(
      'hermes',
      chatId,
      'agent_backend_fallback',
      `Hermes backend failed for ${source}${taskId ? ` task ${taskId}` : ''}; falling back to Claude: ${detail.slice(0, 500)}`,
      JSON.stringify({
        source,
        taskId,
        error: detail,
        fallback: 'claude',
      }),
    );
  } catch (dbErr) {
    logger.error({ err: dbErr }, 'Failed to record Hermes fallback');
  }
}

/**
 * Run a single user message through the configured agent backend.
 *
 * Claude remains the default and rollback backend. Hermes is only used for
 * manual/dashboard turns unless a scheduler task is explicitly allowlisted.
 */
export async function runAgent(
  message: string,
  sessionId: string | undefined,
  onTyping: () => void,
  onProgress?: (event: AgentProgressEvent) => void,
  options?: RunAgentOptions,
  abortController?: AbortController,
): Promise<AgentResult> {
  const backend = resolveAgentBackend(AGENT_BACKEND, options);

  if (backend === 'shadow') {
    runHermesShadow(message, sessionId, options);
    return runClaudeAgent(message, sessionId, onTyping, onProgress, options, abortController);
  }

  if (backend === 'hermes') {
    try {
      return await runHermesAgent(message, sessionId, onTyping, onProgress, options, abortController);
    } catch (err) {
      if (abortController?.signal.aborted) {
        return { text: null, newSessionId: undefined, usage: null, aborted: true };
      }
      logger.error({ err }, 'Hermes backend failed; falling back to Claude');
      logHermesFallback(options, err);
      return runClaudeAgent(message, sessionId, onTyping, onProgress, options, abortController);
    }
  }

  return runClaudeAgent(message, sessionId, onTyping, onProgress, options, abortController);
}
