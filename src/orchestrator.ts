import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

import { runAgent, UsageInfo } from './agent.js';
import { loadAgentConfig, listAgentIds } from './agent-config.js';
import { PROJECT_ROOT } from './config.js';
import { logToHiveMind, createInterAgentTask, completeInterAgentTask, savePlan, updatePlanStatus } from './db.js';
import { classifyAndPlan } from './planner.js';
import { executePlan, buildSynthesisPrompt } from './dag-executor.js';
import { logger } from './logger.js';

// ── Types ────────────────────────────────────────────────────────────

export interface DelegationResult {
  agentId: string;
  text: string | null;
  usage: UsageInfo | null;
  taskId: string;
  durationMs: number;
}

export interface AgentInfo {
  id: string;
  name: string;
  description: string;
}

// ── Registry ─────────────────────────────────────────────────────────

/** Cache of available agents loaded at startup. */
let agentRegistry: AgentInfo[] = [];

/** Default timeout for a delegated task (5 minutes). */
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Initialize the orchestrator by scanning `agents/` for valid configs.
 * Safe to call even if no agents are configured — the registry will be empty.
 */
export function initOrchestrator(): void {
  const ids = listAgentIds();
  agentRegistry = [];

  for (const id of ids) {
    try {
      const config = loadAgentConfig(id);
      agentRegistry.push({
        id,
        name: config.name,
        description: config.description,
      });
    } catch (err) {
      // Agent config is broken (e.g. missing token) — skip it but warn
      logger.warn({ agentId: id, err }, 'Skipping agent — config load failed');
    }
  }

  logger.info(
    { agents: agentRegistry.map((a) => a.id) },
    'Orchestrator initialized',
  );
}

/** Return all agents that were successfully loaded. */
export function getAvailableAgents(): AgentInfo[] {
  return [...agentRegistry];
}

// ── Delegation ───────────────────────────────────────────────────────

/**
 * Parse a user message for delegation syntax.
 *
 * Supported forms:
 *   @agentId: prompt text
 *   @agentId prompt text   (only if agentId is a known agent)
 *   /delegate agentId prompt text
 *
 * Returns `{ agentId, prompt }` or `null` if no delegation detected.
 */
export function parseDelegation(
  message: string,
): { agentId: string; prompt: string } | null {
  // /delegate agentId prompt
  const cmdMatch = message.match(
    /^\/delegate\s+(\S+)\s+([\s\S]+)/i,
  );
  if (cmdMatch) {
    return { agentId: cmdMatch[1], prompt: cmdMatch[2].trim() };
  }

  // @agentId: prompt
  const atMatch = message.match(
    /^@(\S+?):\s*([\s\S]+)/,
  );
  if (atMatch) {
    return { agentId: atMatch[1], prompt: atMatch[2].trim() };
  }

  // @agentId prompt (only for known agents to avoid false positives)
  const atMatchNoColon = message.match(
    /^@(\S+)\s+([\s\S]+)/,
  );
  if (atMatchNoColon) {
    const candidate = atMatchNoColon[1];
    if (agentRegistry.some((a) => a.id === candidate)) {
      return { agentId: candidate, prompt: atMatchNoColon[2].trim() };
    }
  }

  return null;
}

/**
 * Delegate a task to another agent. Runs the agent's Claude Code session
 * in-process (same Node.js process) with the target agent's cwd and
 * system prompt.
 *
 * The delegation is logged to both `inter_agent_tasks` and `hive_mind`.
 *
 * @param agentId    Target agent identifier (must exist in agents/)
 * @param prompt     The task to delegate
 * @param chatId     Telegram chat ID (for DB tracking)
 * @param fromAgent  The requesting agent's ID (usually 'main')
 * @param onProgress Optional callback for status updates
 * @param timeoutMs  Maximum execution time (default 5 min)
 */
export async function delegateToAgent(
  agentId: string,
  prompt: string,
  chatId: string,
  fromAgent: string,
  onProgress?: (msg: string) => void,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<DelegationResult> {
  const agent = agentRegistry.find((a) => a.id === agentId);
  if (!agent) {
    const available = agentRegistry.map((a) => a.id).join(', ') || '(none)';
    throw new Error(
      `Agent "${agentId}" not found. Available: ${available}`,
    );
  }

  const taskId = crypto.randomUUID();
  const start = Date.now();

  // Record the task
  createInterAgentTask(taskId, fromAgent, agentId, chatId, prompt);
  logToHiveMind(
    fromAgent,
    chatId,
    'delegate',
    `Delegated to ${agentId}: ${prompt.slice(0, 100)}`,
  );

  onProgress?.(`Delegating to ${agent.name}...`);

  try {
    // Load agent config to get its system prompt
    const agentDir = path.join(PROJECT_ROOT, 'agents', agentId);
    const claudeMdPath = path.join(agentDir, 'CLAUDE.md');
    let systemPrompt = '';
    try {
      systemPrompt = fs.readFileSync(claudeMdPath, 'utf-8');
    } catch {
      // No CLAUDE.md for this agent — that's fine
    }

    // Build the delegated prompt with agent role context
    const fullPrompt = systemPrompt
      ? `[Agent role — follow these instructions]\n${systemPrompt}\n[End agent role]\n\n${prompt}`
      : prompt;

    // Create an AbortController with timeout
    const abortCtrl = new AbortController();
    const timer = setTimeout(() => abortCtrl.abort(), timeoutMs);

    try {
      const result = await runAgent(
        fullPrompt,
        undefined, // fresh session for each delegation
        () => {}, // no typing indicator needed for sub-delegation
        undefined, // no progress callback for inner agent
        undefined, // use default model
        abortCtrl,
      );

      clearTimeout(timer);

      const durationMs = Date.now() - start;
      completeInterAgentTask(taskId, 'completed', result.text);
      logToHiveMind(
        agentId,
        chatId,
        'delegate_result',
        `Completed delegation from ${fromAgent}: ${(result.text ?? '').slice(0, 120)}`,
      );

      onProgress?.(
        `${agent.name} completed (${Math.round(durationMs / 1000)}s)`,
      );

      return {
        agentId,
        text: result.text,
        usage: result.usage,
        taskId,
        durationMs,
      };
    } catch (innerErr) {
      clearTimeout(timer);
      throw innerErr;
    }
  } catch (err) {
    const durationMs = Date.now() - start;
    const errMsg = err instanceof Error ? err.message : String(err);
    completeInterAgentTask(taskId, 'failed', errMsg);
    logToHiveMind(
      agentId,
      chatId,
      'delegate_error',
      `Delegation from ${fromAgent} failed: ${errMsg.slice(0, 120)}`,
    );
    throw err;
  }
}

// ── Smart Routing ────────────────────────────────────────────────────

/** Messages that should skip the planner entirely (trivial/conversational). */
const SKIP_PLANNER = /^(\/|ok\b|thanks|yes\b|no\b|sure\b|got it|👍|hi\b|hey\b|hello\b)/i;

export interface SmartRouteResult {
  response: string;
  planId: string;
  planType: 'simple' | 'complex';
}

/**
 * Analyze a message, classify intent, and route to the best agent(s).
 *
 * Returns null when the message should be handled by the main agent
 * (either because there are no specialist agents, the message is trivial,
 * or the planner explicitly routed to main).
 */
export async function analyzeAndRoute(
  message: string,
  chatId: string,
  fromAgent: string,
  onProgress: (msg: string) => void,
): Promise<SmartRouteResult | null> {
  // Skip if no agents configured or message is trivial
  if (agentRegistry.length === 0) return null;
  if (message.length < 15 || SKIP_PLANNER.test(message.trim())) return null;

  onProgress('Analyzing...');

  const plan = await classifyAndPlan(message, agentRegistry);

  // If planner says "main", let the caller handle it normally
  if (
    plan.tasks.length === 1 &&
    plan.tasks[0].targetAgent === 'main'
  ) {
    logger.info({ reasoning: plan.reasoning }, 'Planner routed to main');
    return null;
  }

  const planId = crypto.randomUUID();
  savePlan(planId, chatId, message, plan);

  logger.info(
    { planId, type: plan.type, steps: plan.tasks.length, reasoning: plan.reasoning },
    'Plan created',
  );

  if (plan.type === 'simple') {
    // Single-agent delegation
    const task = plan.tasks[0];
    onProgress(`Routing to ${task.targetAgent}...`);

    try {
      const result = await delegateToAgent(
        task.targetAgent,
        task.prompt,
        chatId,
        fromAgent,
        onProgress,
      );

      const response = result.text?.trim() || 'Agent completed with no output.';
      updatePlanStatus(planId, 'completed', response.slice(0, 4000));

      return { response, planId, planType: 'simple' };
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      updatePlanStatus(planId, 'failed', errMsg);
      throw err;
    }
  }

  // Complex: execute the DAG
  onProgress(`Running ${plan.tasks.length}-step plan...`);

  const execResult = await executePlan(plan, planId, chatId, fromAgent, onProgress);

  // Synthesize results
  onProgress('Synthesizing results...');

  const completed = execResult.steps.filter((s) => s.status === 'completed');
  if (completed.length === 0) {
    const errMsg = 'All plan steps failed.';
    updatePlanStatus(planId, 'failed', errMsg);
    return { response: errMsg, planId, planType: 'complex' };
  }

  // If only one step completed, just return its output directly
  if (completed.length === 1) {
    const response = completed[0].text || 'Completed with no output.';
    updatePlanStatus(planId, 'completed', response.slice(0, 4000));
    return { response, planId, planType: 'complex' };
  }

  // Multiple steps: synthesize via a delegation to main
  const synthesisPrompt = buildSynthesisPrompt(message, execResult.steps);
  try {
    const synthesisResult = await runAgent(
      synthesisPrompt,
      undefined, // fresh session
      () => {},
      undefined,
      undefined,
    );

    const response = synthesisResult.text?.trim() || 'Plan completed.';
    updatePlanStatus(planId, 'completed', response.slice(0, 4000));

    const totalSecs = Math.round(execResult.totalDurationMs / 1000);
    return {
      response: `${response}\n\n_${plan.tasks.length} steps, ${totalSecs}s total_`,
      planId,
      planType: 'complex',
    };
  } catch {
    // Synthesis failed — just concatenate results
    const fallback = completed
      .map((s) => `**${s.description}** (${s.agentId}):\n${s.text}`)
      .join('\n\n---\n\n');
    updatePlanStatus(planId, 'completed', fallback.slice(0, 4000));
    return { response: fallback, planId, planType: 'complex' };
  }
}
