import { spawn } from 'child_process';

import {
  HERMES_BIN,
  HERMES_MODEL,
  HERMES_PROVIDER,
  HERMES_RESUME_ENABLED,
  HERMES_TIMEOUT_MS,
  PROJECT_ROOT,
  agentCwd,
} from './config.js';
import { readEnvFile } from './env.js';
import { logger } from './logger.js';
import {
  AgentProgressEvent,
  AgentResult,
  RunAgentOptions,
} from './agent-types.js';

const SESSION_PATTERNS = [
  /^session(?: id)?:\s*(\S+)$/i,
  /^session_id[=:]\s*(\S+)$/i,
  /^hermes session(?: id)?:\s*(\S+)$/i,
];

function isHermesChromeLine(line: string): boolean {
  return /^[╭╰│├└┌┐┘┬┴─]/.test(line.trim());
}

function parseHermesStdout(stdout: string): { text: string; sessionId: string | undefined } {
  const lines = stdout
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0);

  let sessionId: string | undefined;
  const responseLines: string[] = [];

  for (const line of lines) {
    if (isHermesChromeLine(line)) continue;

    const match = SESSION_PATTERNS.map((pattern) => line.match(pattern)).find(Boolean);
    if (match?.[1]) {
      sessionId = match[1];
      continue;
    }
    responseLines.push(line);
  }

  return {
    text: responseLines.join('\n').trim(),
    sessionId,
  };
}

function buildHermesEnv(): NodeJS.ProcessEnv {
  const secrets = readEnvFile([
    'OPENROUTER_API_KEY',
    'OPENAI_API_KEY',
    'ANTHROPIC_API_KEY',
    'NOUS_API_KEY',
    'HERMES_INFERENCE_PROVIDER',
  ]);

  return {
    ...process.env,
    ...secrets,
  };
}

function describeHermesFailure(
  code: number | null,
  signal: NodeJS.Signals | null,
  stderr: string,
  stdout: string,
): string {
  const detail = (stderr || stdout).trim().replace(/\s+/g, ' ').slice(0, 500);
  const exit = signal ? `signal ${signal}` : `exit ${code ?? 'unknown'}`;
  return detail ? `Hermes failed (${exit}): ${detail}` : `Hermes failed (${exit})`;
}

export async function runHermesAgent(
  message: string,
  sessionId: string | undefined = undefined,
  onTyping: () => void = () => {},
  onProgress?: (event: AgentProgressEvent) => void,
  options?: RunAgentOptions,
  abortController?: AbortController,
): Promise<AgentResult> {
  const cwd = options?.cwd ?? agentCwd ?? PROJECT_ROOT;
  const args = ['chat', '-Q', '--source', 'tool', '-q', message];
  const model = HERMES_MODEL || undefined;
  const provider = HERMES_PROVIDER || undefined;

  if (model) args.splice(2, 0, '-m', model);
  if (provider) args.splice(2, 0, '--provider', provider);
  if (HERMES_RESUME_ENABLED && sessionId) {
    args.push('--resume', sessionId);
  }

  logger.info(
    {
      backend: 'hermes',
      sessionId: HERMES_RESUME_ENABLED ? sessionId ?? 'new' : 'new',
      resumeEnabled: HERMES_RESUME_ENABLED,
      messageLen: message.length,
      cwd,
    },
    'Starting Hermes agent query',
  );
  onProgress?.({ type: 'tool_active', description: 'Hermes running' });

  return await new Promise<AgentResult>((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    let settled = false;

    const child = spawn(HERMES_BIN, args, {
      cwd,
      env: buildHermesEnv(),
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const typingInterval = setInterval(onTyping, 4000);
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGTERM');
      clearInterval(typingInterval);
      reject(new Error(`Hermes timed out after ${HERMES_TIMEOUT_MS}ms`));
    }, HERMES_TIMEOUT_MS);

    const abort = () => {
      if (settled) return;
      settled = true;
      child.kill('SIGTERM');
      clearTimeout(timeout);
      clearInterval(typingInterval);
      resolve({ text: null, newSessionId: undefined, usage: null, aborted: true });
    };

    abortController?.signal.addEventListener('abort', abort, { once: true });

    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });

    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      clearInterval(typingInterval);
      abortController?.signal.removeEventListener('abort', abort);
      reject(err);
    });

    child.on('close', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      clearInterval(typingInterval);
      abortController?.signal.removeEventListener('abort', abort);

      if (code !== 0 || signal) {
        reject(new Error(describeHermesFailure(code, signal, stderr, stdout)));
        return;
      }

      const parsed = parseHermesStdout(stdout);
      if (!parsed.text) {
        reject(new Error('Hermes returned empty output'));
        return;
      }

      logger.info(
        { hasResult: true, newSessionId: parsed.sessionId, stderrLen: stderr.length },
        'Hermes agent result received',
      );

      resolve({
        text: parsed.text,
        newSessionId: parsed.sessionId,
        usage: null,
      });
    });
  });
}

export const hermesInternalsForTest = {
  parseHermesStdout,
};
