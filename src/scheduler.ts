import { CronExpressionParser } from 'cron-parser';

import { ALLOWED_CHAT_ID } from './config.js';
import {
  getDueTasks,
  claimTask,
  updateTaskAfterRun,
} from './db.js';
import { logger } from './logger.js';
import { runAgent } from './agent.js';
import { delegateToAgent } from './orchestrator.js';
import { formatForTelegram } from './bot.js';

/** Max concurrent task executions to prevent resource exhaustion */
const MAX_CONCURRENT_TASKS = 2;
const RESERVED_CRITICAL_SLOT = Math.max(1, MAX_CONCURRENT_TASKS - 1);

const CRITICAL_TASK_IDS = new Set([
  '9f64f736',      // 8am morning brief
  'brief-watchdog',
  'ea6d94e6',      // 6pm EOD recap
]);

type TaskOutputPolicy = 'critical' | 'actionable' | 'silent';

/**
 * Phase 1 runtime policy:
 * - critical/actionable tasks may message Max when they produce a real result
 * - silent tasks should update state, not Telegram
 * - unknown tasks default to silent so drift does not turn into noise
 */
const TASK_OUTPUT_POLICIES: Record<string, TaskOutputPolicy> = {
  '9f64f736': 'critical',           // morning brief
  'brief-watchdog': 'silent',       // watchdog should only surface failures
  'ea6d94e6': 'critical',           // eod recap
  '5b4637b8': 'actionable',         // overdue loops
  '627e0910': 'actionable',         // monday hygiene
  'a347459b': 'actionable',         // billing alert
  'cfdfb1e3': 'actionable',         // week-ahead brief
  'weekly-ai-radar': 'actionable',
  'claude-routines-review': 'actionable',
  'ai-watchlist-review': 'actionable',
  'weekly-qa-loop': 'actionable',
  'typefully-sync': 'silent',
  '21351cac': 'silent',             // morning gmail prescan
  '50fd16d6': 'silent',             // eod gmail prescan
  'bcefa2bf': 'silent',             // ai news cache for morning brief
};

/** Match "Delegate to agent {id}: {prompt}" */
const DELEGATION_RE = /^Delegate to agent ([a-z0-9_-]+):\s*/i;

/** Max retries before giving up on a failed task */
const MAX_RETRIES = 2;
/** Delay between retries in ms (5 minutes) */
const RETRY_DELAY_MS = 5 * 60 * 1000;

/** Track retry state per task (resets on success or max retries) */
const retryState = new Map<string, { attempts: number; timer: ReturnType<typeof setTimeout> | null }>();

type Sender = (text: string) => Promise<void>;

let sender: Sender;

function getTaskOutputPolicy(taskId: string): TaskOutputPolicy {
  return TASK_OUTPUT_POLICIES[taskId] ?? 'silent';
}

function shouldSuppressTaskOutput(task: { id: string; prompt: string | Buffer }, text: string): boolean {
  const normalized = text.trim().toLowerCase();
  if (!normalized || normalized === 'done') return true;

  if (getTaskOutputPolicy(task.id) === 'silent') {
    return true;
  }

  const prompt = normalizePrompt(task.prompt).toLowerCase();
  const isCompoundSweep = task.id === '17cfce3d'
    || prompt.includes('compound-extractor')
    || prompt.includes('compound_deposit');

  if (!isCompoundSweep) return false;

  // Guard against model drift: compound sweeps should stay silent unless there is a NEW deposit.
  return normalized.includes('no postcall_update entries')
    || normalized.includes('all five checkpoints: no on new deposits')
    || normalized.includes('no new deposits')
    || normalized.includes('same signal, no new transcript or deliverable')
    || normalized.includes('already captured by compound-extractor');
}

function normalizePrompt(prompt: string | Buffer): string {
  if (typeof prompt === 'string') return prompt;
  if (Buffer.isBuffer(prompt)) return prompt.toString('utf8');
  return String(prompt);
}

function describeTask(task: { id: string; prompt: string | Buffer }): string {
  const prompt = normalizePrompt(task.prompt);
  const firstLine = prompt.split('\n').map((line) => line.trim()).find(Boolean) || 'scheduled-task';
  const compact = firstLine.replace(/\s+/g, ' ');

  if (compact.startsWith('IMPORTANT:')) {
    return task.id;
  }

  return `${task.id} — ${compact.slice(0, 60)}`;
}

function describeError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  return raw.replace(/\s+/g, ' ').trim().slice(0, 180);
}

function isCriticalTask(task: { id: string; prompt: string | Buffer }): boolean {
  if (CRITICAL_TASK_IDS.has(task.id)) return true;

  const prompt = normalizePrompt(task.prompt);
  return /pull morning brief|daily digest at 8am|eod recap|end of day recap/i.test(prompt);
}

function sortDueTasks<T extends { id: string; prompt: string | Buffer; next_run: number }>(tasks: T[]): T[] {
  return [...tasks].sort((a, b) => {
    const priorityDelta = Number(isCriticalTask(a)) - Number(isCriticalTask(b));
    if (priorityDelta !== 0) return -priorityDelta;
    if (a.next_run !== b.next_run) return a.next_run - b.next_run;
    return a.id.localeCompare(b.id);
  });
}

/**
 * Initialise the scheduler. Call once after the Telegram bot is ready.
 * @param send  Function that sends a message to the user's Telegram chat.
 */
let schedulerAgentId = 'main';

export function initScheduler(send: Sender, agentId = 'main'): void {
  if (!ALLOWED_CHAT_ID) {
    logger.warn('ALLOWED_CHAT_ID not set — scheduler will not send results');
  }
  sender = send;
  schedulerAgentId = agentId;
  setInterval(() => void runDueTasks(), 60_000);
  logger.info({ agentId }, 'Scheduler started (checking every 60s)');
}

/**
 * Execute a single task (delegation or direct). Returns the result text.
 * Throws on failure so the caller can handle retries.
 */
async function executeTask(task: { id: string; prompt: string | Buffer }): Promise<string> {
  const prompt = normalizePrompt(task.prompt);
  const delegationMatch = prompt.match(DELEGATION_RE);

  if (delegationMatch) {
    const targetAgent = delegationMatch[1];
    const agentPrompt = prompt.slice(delegationMatch[0].length);
    logger.info({ taskId: task.id, targetAgent }, 'Delegating scheduled task to sub-agent');

    const result = await delegateToAgent(
      targetAgent,
      agentPrompt,
      'system',       // chatId — background task
      'scheduler',    // fromAgent
      undefined,      // no progress callback
      10 * 60 * 1000, // 10 min timeout for agent tasks
    );
    return result.text?.trim() || '';
  }

  // Standard execution — run as main agent
  const result = await runAgent(prompt, undefined, () => {}, undefined, {
    source: 'scheduler',
    chatId: 'system',
    taskId: task.id,
  });
  return result.text?.trim() || '';
}

/**
 * Schedule a retry for a failed task after RETRY_DELAY_MS.
 * The retry runs the task again outside the normal cron cycle.
 */
function scheduleRetry(task: { id: string; prompt: string | Buffer; schedule: string }, attempt: number): void {
  const state = retryState.get(task.id) || { attempts: 0, timer: null };
  state.attempts = attempt;

  state.timer = setTimeout(async () => {
    logger.info({ taskId: task.id, attempt }, 'Retrying failed task');

    try {
      const text = await executeTask(task);

      if (!shouldSuppressTaskOutput(task, text)) {
        await sender(formatForTelegram(text));
      }

      const nextRun = computeNextRun(task.schedule);
      updateTaskAfterRun(task.id, nextRun, text);
      retryState.delete(task.id);

      logger.info({ taskId: task.id, attempt }, 'Retry succeeded');
    } catch (retryErr) {
      logger.error({ err: retryErr, taskId: task.id, attempt }, 'Retry failed');

      if (attempt < MAX_RETRIES) {
        scheduleRetry(task, attempt + 1);
        try {
          await sender(`⚠️ Scheduled task failed: ${describeTask(task)}. Retrying in 5 min (${attempt}/${MAX_RETRIES}). ${describeError(retryErr)}`);
        } catch { /* ignore */ }
      } else {
        retryState.delete(task.id);
        try {
          await sender(`🚨 Scheduled task failed: ${describeTask(task)}. Giving up until next scheduled run. ${describeError(retryErr)}`);
        } catch { /* ignore */ }
      }
    }
  }, RETRY_DELAY_MS);

  retryState.set(task.id, state);
}

/** Track how many tasks are currently executing */
let activeTasks = 0;

async function runDueTasks(): Promise<void> {
  const tasks = sortDueTasks(getDueTasks(schedulerAgentId));
  if (tasks.length === 0) return;

  logger.info({ count: tasks.length }, 'Running due scheduled tasks');

  for (const [index, task] of tasks.entries()) {
    // Skip tasks that are currently being retried
    if (retryState.has(task.id)) {
      logger.info({ taskId: task.id }, 'Task has pending retry — skipping');
      continue;
    }

    const remainingCriticalTasks = tasks.slice(index).filter((candidate) => !retryState.has(candidate.id) && isCriticalTask(candidate));
    const concurrencyLimit = isCriticalTask(task) || remainingCriticalTasks.length === 0
      ? MAX_CONCURRENT_TASKS
      : RESERVED_CRITICAL_SLOT;

    // Respect concurrency limit to avoid spawning too many Claude processes
    if (activeTasks >= concurrencyLimit) {
      logger.info(
        { activeTasks, taskId: task.id, concurrencyLimit, reservedCriticalSlot: concurrencyLimit !== MAX_CONCURRENT_TASKS },
        'Concurrency limit reached — deferring remaining tasks',
      );
      break;
    }

    // Compute next_run safely — invalid cron expressions (oneshot, manual) get auto-completed
    let nextRun: number;
    try {
      nextRun = computeNextRun(task.schedule);
    } catch {
      logger.warn({ taskId: task.id, schedule: task.schedule }, 'Unparseable schedule — marking task completed');
      updateTaskAfterRun(task.id, Math.floor(Date.now() / 1000), 'auto-completed: invalid schedule');
      // Also mark as completed so it stops firing
      const db = (await import('./db.js')).getDatabase();
      db.prepare('UPDATE scheduled_tasks SET status = ? WHERE id = ?').run('completed', task.id);
      continue;
    }

    // Optimistically advance next_run before execution so a slow-running task
    // doesn't get re-fired on the next 60s tick while still in progress.
    const claimed = claimTask(task.id, nextRun);
    if (!claimed) {
      logger.info({ taskId: task.id }, 'Task already claimed by another tick — skipping');
      continue;
    }

    logger.info({ taskId: task.id, prompt: normalizePrompt(task.prompt).slice(0, 60) }, 'Firing task');
    activeTasks++;

    try {
      const text = await executeTask(task);

      // Only send if the agent produced meaningful output (skip "done" responses)
      if (!shouldSuppressTaskOutput(task, text)) {
        await sender(formatForTelegram(text));
      }

      // next_run was already set optimistically via claimTask; persist last_run + result
      updateTaskAfterRun(task.id, nextRun, text);

      logger.info({ taskId: task.id, nextRun }, 'Task complete, next run scheduled');
    } catch (err) {
      logger.error({ err, taskId: task.id }, 'Scheduled task failed');

      // Schedule a retry instead of just giving up
      scheduleRetry(task, 1);

      try {
        await sender(`⚠️ Scheduled task failed: ${describeTask(task)}. Retrying in 5 min (1/${MAX_RETRIES}). ${describeError(err)}`);
      } catch {
        // ignore send failure
      }
    } finally {
      activeTasks--;
    }
  }
}

export function computeNextRun(cronExpression: string): number {
  const interval = CronExpressionParser.parse(cronExpression);
  return Math.floor(interval.next().getTime() / 1000);
}
