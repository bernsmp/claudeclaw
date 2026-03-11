import { readEnvFile } from './env.js';
import { logger } from './logger.js';
import type { AgentInfo } from './orchestrator.js';

// ── Types ────────────────────────────────────────────────────────────

export interface TaskNode {
  id: string;
  description: string;
  targetAgent: string;
  prompt: string;
  dependsOn: string[];
}

export interface TaskPlan {
  type: 'simple' | 'complex';
  reasoning: string;
  tasks: TaskNode[];
}

// ── Planning Prompt ──────────────────────────────────────────────────

function buildPlanningPrompt(message: string, agents: AgentInfo[]): string {
  const agentList = agents
    .map((a) => `- ${a.id}: ${a.description}`)
    .join('\n');

  return `You are a task router for a multi-agent system. Classify the user's request and route it.

AVAILABLE AGENTS:
${agentList}
- main: General-purpose assistant. Handles anything that doesn't clearly fit a specialist, including casual conversation, greetings, questions about itself, and ambiguous requests.

RULES:
1. If the request is a single task for one agent, classify as "simple" with one task.
2. If the request requires multiple agents OR sequential steps across domains, classify as "complex".
3. For complex: decompose into 2-5 subtasks. Each subtask targets one agent.
4. Set dependsOn when a step needs output from a previous step.
5. Independent steps should have empty dependsOn (they run in parallel).
6. Prefer fewer steps. Don't over-decompose.
7. Default to "main" when the intent is ambiguous or conversational.
8. The prompt field should be a clear, actionable instruction for the target agent.

USER MESSAGE:
${message}

Respond with ONLY valid JSON (no markdown, no code fences, no explanation):
{"type":"simple","reasoning":"...","tasks":[{"id":"step-1","description":"...","targetAgent":"...","prompt":"...","dependsOn":[]}]}`;
}

// ── Classifier ───────────────────────────────────────────────────────

// OpenRouter uses OpenAI-compatible API with Haiku for fast/cheap classification
const PLANNER_MODEL = 'anthropic/claude-haiku-4-5-20251001';
const PLANNER_TIMEOUT_MS = 10_000;
const API_BASE = 'https://openrouter.ai/api/v1/chat/completions';

/**
 * Classify a user message and optionally decompose it into subtasks.
 * Uses OpenRouter (Haiku) for speed — no Claude Code subprocess.
 */
export async function classifyAndPlan(
  message: string,
  agents: AgentInfo[],
): Promise<TaskPlan> {
  const secrets = readEnvFile(['OPENROUTER_API_KEY']);
  const apiKey = secrets.OPENROUTER_API_KEY || process.env.OPENROUTER_API_KEY;

  if (!apiKey) {
    logger.warn('No OPENROUTER_API_KEY — skipping planner, falling back to main');
    return fallbackPlan(message);
  }

  const prompt = buildPlanningPrompt(message, agents);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PLANNER_TIMEOUT_MS);

  try {
    const res = await fetch(API_BASE, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: PLANNER_MODEL,
        max_tokens: 1024,
        messages: [{ role: 'user', content: prompt }],
      }),
      signal: controller.signal,
    });

    clearTimeout(timer);

    if (!res.ok) {
      const body = await res.text();
      logger.error({ status: res.status, body: body.slice(0, 200) }, 'Planner API error');
      return fallbackPlan(message);
    }

    const data = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };

    const text = data.choices?.[0]?.message?.content;
    if (!text) {
      logger.warn('Planner returned no text content');
      return fallbackPlan(message);
    }

    return parsePlanResponse(text, message);
  } catch (err) {
    clearTimeout(timer);
    if ((err as Error).name === 'AbortError') {
      logger.warn('Planner timed out');
    } else {
      logger.error({ err }, 'Planner call failed');
    }
    return fallbackPlan(message);
  }
}

// ── Response Parsing ─────────────────────────────────────────────────

function parsePlanResponse(raw: string, originalMessage: string): TaskPlan {
  // Strip markdown code fences if present
  let cleaned = raw.trim();
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '');
  }

  try {
    const parsed = JSON.parse(cleaned) as TaskPlan;

    // Validate structure
    if (!parsed.type || !Array.isArray(parsed.tasks) || parsed.tasks.length === 0) {
      logger.warn({ parsed }, 'Planner returned invalid structure');
      return fallbackPlan(originalMessage);
    }

    // Validate each task
    for (const task of parsed.tasks) {
      if (!task.id || !task.targetAgent || !task.prompt) {
        logger.warn({ task }, 'Planner returned invalid task node');
        return fallbackPlan(originalMessage);
      }
      if (!Array.isArray(task.dependsOn)) {
        task.dependsOn = [];
      }
    }

    return parsed;
  } catch {
    logger.warn({ raw: raw.slice(0, 200) }, 'Failed to parse planner JSON');
    return fallbackPlan(originalMessage);
  }
}

// ── Fallback ─────────────────────────────────────────────────────────

function fallbackPlan(message: string): TaskPlan {
  return {
    type: 'simple',
    reasoning: 'Fallback — routing to main agent',
    tasks: [
      {
        id: 'step-1',
        description: 'Handle with main agent',
        targetAgent: 'main',
        prompt: message,
        dependsOn: [],
      },
    ],
  };
}
