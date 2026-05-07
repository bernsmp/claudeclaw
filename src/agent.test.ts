import { describe, expect, it } from 'vitest';

import {
  isSafeForHermesShadow,
  resolveAgentBackend,
} from './agent.js';
import { hermesInternalsForTest } from './hermes-runner.js';

describe('agent backend routing', () => {
  it('keeps Claude when backend is claude', () => {
    expect(resolveAgentBackend('claude', { source: 'manual' })).toBe('claude');
  });

  it('allows Hermes for manual and dashboard sources', () => {
    expect(resolveAgentBackend('hermes', { source: 'manual' })).toBe('hermes');
    expect(resolveAgentBackend('shadow', { source: 'dashboard' })).toBe('shadow');
  });

  it('keeps scheduled tasks on Claude unless allowlisted', () => {
    const allowlist = new Set(['allowed-task']);
    expect(resolveAgentBackend('hermes', { source: 'scheduler', taskId: 'other-task' }, allowlist)).toBe('claude');
    expect(resolveAgentBackend('hermes', { source: 'scheduler', taskId: 'allowed-task' }, allowlist)).toBe('hermes');
  });

  it('keeps delegation on Claude', () => {
    expect(resolveAgentBackend('shadow', { source: 'delegation' })).toBe('claude');
  });
});

describe('Hermes shadow safety', () => {
  it('allows read-only prompts', () => {
    expect(isSafeForHermesShadow('Can you review and summarize this file?')).toBe(true);
    expect(isSafeForHermesShadow('What should we check next?')).toBe(true);
  });

  it('skips obvious mutation prompts', () => {
    expect(isSafeForHermesShadow('Please edit the file and commit it')).toBe(false);
    expect(isSafeForHermesShadow('Deploy this and restart the service')).toBe(false);
  });
});

describe('Hermes stdout parsing', () => {
  it('removes chrome and extracts session ids', () => {
    const parsed = hermesInternalsForTest.parseHermesStdout([
      '╭────────╮',
      'Hermes session id: abc123',
      'Final answer line one',
      'Final answer line two',
    ].join('\n'));

    expect(parsed.sessionId).toBe('abc123');
    expect(parsed.text).toBe('Final answer line one\nFinal answer line two');
  });
});
