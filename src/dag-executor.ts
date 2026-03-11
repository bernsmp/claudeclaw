import crypto from 'crypto';

import { delegateToAgent } from './orchestrator.js';
import { savePlanStep, updatePlanStepStatus } from './db.js';
import { logger } from './logger.js';
import type { TaskNode, TaskPlan } from './planner.js';

// ── Types ────────────────────────────────────────────────────────────

export interface StepResult {
  taskId: string;
  agentId: string;
  description: string;
  text: string | null;
  durationMs: number;
  status: 'completed' | 'failed' | 'skipped';
  error?: string;
}

export interface ExecutionResult {
  steps: StepResult[];
  totalDurationMs: number;
}

// ── DAG Validation ───────────────────────────────────────────────────

/** Detect cycles via DFS. Returns true if cycle-free. */
function validateDAG(tasks: TaskNode[]): boolean {
  const WHITE = 0, GRAY = 1, BLACK = 2;
  const color = new Map<string, number>();
  for (const t of tasks) color.set(t.id, WHITE);

  function dfs(id: string): boolean {
    color.set(id, GRAY);
    const node = tasks.find((t) => t.id === id);
    if (!node) return true;
    for (const dep of node.dependsOn) {
      const c = color.get(dep);
      if (c === GRAY) return false; // cycle
      if (c === WHITE && !dfs(dep)) return false;
    }
    color.set(id, BLACK);
    return true;
  }

  for (const t of tasks) {
    if (color.get(t.id) === WHITE && !dfs(t.id)) return false;
  }
  return true;
}

/** Group tasks into execution waves (topological layers). */
function buildWaves(tasks: TaskNode[]): TaskNode[][] {
  const completed = new Set<string>();
  const remaining = [...tasks];
  const waves: TaskNode[][] = [];

  while (remaining.length > 0) {
    const ready = remaining.filter((t) =>
      t.dependsOn.every((dep) => completed.has(dep)),
    );

    if (ready.length === 0) {
      // Shouldn't happen after DAG validation, but safety net
      logger.warn('DAG executor stalled — running remaining tasks sequentially');
      waves.push([...remaining]);
      break;
    }

    waves.push(ready);
    for (const t of ready) {
      completed.add(t.id);
      const idx = remaining.indexOf(t);
      if (idx >= 0) remaining.splice(idx, 1);
    }
  }

  return waves;
}

// ── Context Injection ────────────────────────────────────────────────

/** Build a prompt that includes results from dependency steps. */
function injectContext(
  task: TaskNode,
  results: Map<string, StepResult>,
): string {
  if (task.dependsOn.length === 0) return task.prompt;

  const contextBlocks: string[] = [];
  for (const depId of task.dependsOn) {
    const dep = results.get(depId);
    if (dep && dep.text && dep.status === 'completed') {
      contextBlocks.push(
        `[Context from "${dep.description}" (${dep.agentId})]\n${dep.text}\n[End context]`,
      );
    }
  }

  if (contextBlocks.length === 0) return task.prompt;
  return `${contextBlocks.join('\n\n')}\n\n${task.prompt}`;
}

// ── Executor ─────────────────────────────────────────────────────────

/**
 * Execute a task plan as a DAG with parallel waves.
 *
 * @param plan       The classified task plan
 * @param planId     UUID for DB tracking
 * @param chatId     Telegram chat ID
 * @param fromAgent  The agent initiating (usually 'main')
 * @param onProgress Callback for Telegram status updates
 */
export async function executePlan(
  plan: TaskPlan,
  planId: string,
  chatId: string,
  fromAgent: string,
  onProgress: (msg: string) => void,
): Promise<ExecutionResult> {
  const start = Date.now();
  const results = new Map<string, StepResult>();
  const allSteps: StepResult[] = [];
  const totalSteps = plan.tasks.length;

  // Validate DAG
  if (!validateDAG(plan.tasks)) {
    logger.warn('Cycle detected in task plan — executing sequentially');
    // Fall back to sequential by clearing all dependencies
    for (const task of plan.tasks) task.dependsOn = [];
  }

  // Save steps to DB
  for (let i = 0; i < plan.tasks.length; i++) {
    savePlanStep(planId, plan.tasks[i], i);
  }

  const waves = buildWaves(plan.tasks);
  let stepNum = 0;

  for (const wave of waves) {
    const wavePromises = wave.map(async (task) => {
      stepNum++;
      const stepLabel = `[${stepNum}/${totalSteps}]`;
      onProgress(`${stepLabel} ${task.description} (${task.targetAgent})`);

      updatePlanStepStatus(task.id, 'running');
      const taskStart = Date.now();

      // Check if any dependency failed — skip if so
      const failedDep = task.dependsOn.find(
        (dep) => results.get(dep)?.status === 'failed',
      );
      if (failedDep) {
        const result: StepResult = {
          taskId: task.id,
          agentId: task.targetAgent,
          description: task.description,
          text: null,
          durationMs: 0,
          status: 'skipped',
          error: `Dependency "${failedDep}" failed`,
        };
        results.set(task.id, result);
        allSteps.push(result);
        updatePlanStepStatus(task.id, 'skipped', result.error, 0);
        return;
      }

      try {
        const prompt = injectContext(task, results);
        const delegationResult = await delegateToAgent(
          task.targetAgent,
          prompt,
          chatId,
          fromAgent,
          undefined, // no inner progress
          5 * 60 * 1000, // 5 min timeout per step
        );

        const durationMs = Date.now() - taskStart;
        const result: StepResult = {
          taskId: task.id,
          agentId: task.targetAgent,
          description: task.description,
          text: delegationResult.text,
          durationMs,
          status: 'completed',
        };
        results.set(task.id, result);
        allSteps.push(result);
        updatePlanStepStatus(task.id, 'completed', delegationResult.text?.slice(0, 2000), durationMs);
      } catch (err) {
        const durationMs = Date.now() - taskStart;
        const errMsg = err instanceof Error ? err.message : String(err);
        const result: StepResult = {
          taskId: task.id,
          agentId: task.targetAgent,
          description: task.description,
          text: null,
          durationMs,
          status: 'failed',
          error: errMsg,
        };
        results.set(task.id, result);
        allSteps.push(result);
        updatePlanStepStatus(task.id, 'failed', errMsg.slice(0, 2000), durationMs);
        logger.error({ err, taskId: task.id, agentId: task.targetAgent }, 'Plan step failed');
      }
    });

    // Run all tasks in this wave in parallel
    await Promise.all(wavePromises);
  }

  return {
    steps: allSteps,
    totalDurationMs: Date.now() - start,
  };
}

/** Build a synthesis prompt from completed step results. */
export function buildSynthesisPrompt(
  originalMessage: string,
  steps: StepResult[],
): string {
  const stepSummaries = steps
    .filter((s) => s.status === 'completed' && s.text)
    .map(
      (s, i) =>
        `## Step ${i + 1}: ${s.description} (${s.agentId})\n${s.text}`,
    )
    .join('\n\n');

  const failed = steps.filter((s) => s.status === 'failed');
  const failedNote = failed.length > 0
    ? `\n\nNote: ${failed.length} step(s) failed: ${failed.map((s) => s.description).join(', ')}`
    : '';

  return `The user asked: "${originalMessage}"

Here are the results from the specialist agents:

${stepSummaries}${failedNote}

Synthesize these results into a single coherent response for the user. Be concise. Lead with the answer. Don't repeat the user's question.`;
}
