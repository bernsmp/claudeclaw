import { describe, expect, it } from 'vitest';

import { isSafeForHermesShadow, resolveAgentBackend } from './agent.js';
import { hermesInternalsForTest } from './hermes-runner.js';

describe('resolveAgentBackend', () => {
  it('defaults to Claude when configured backend is Claude', () => {
    expect(resolveAgentBackend('claude', { source: 'manual' })).toBe('claude');
  });

  it('allows Hermes for manual and dashboard turns', () => {
    expect(resolveAgentBackend('hermes', { source: 'manual' })).toBe('hermes');
    expect(resolveAgentBackend('shadow', { source: 'dashboard' })).toBe('shadow');
  });

  it('keeps scheduler and delegation on Claude unless scheduler task is allowlisted', () => {
    expect(resolveAgentBackend('hermes', { source: 'delegation' })).toBe('claude');
    expect(resolveAgentBackend('hermes', { source: 'scheduler', taskId: 'daily' })).toBe('claude');
    expect(
      resolveAgentBackend(
        'hermes',
        { source: 'scheduler', taskId: 'typefully-sync' },
        new Set(['typefully-sync']),
      ),
    ).toBe('hermes');
  });
});

describe('parseHermesStdout', () => {
  it('separates final response text from session metadata', () => {
    const parsed = hermesInternalsForTest.parseHermesStdout(
      '╭─ ⚕ Hermes ─────────────────╮\nHere is the answer.\nsession_id: abc-123\n',
    );

    expect(parsed).toEqual({
      text: 'Here is the answer.',
      sessionId: 'abc-123',
    });
  });

  it('preserves multiline response text when no session metadata is present', () => {
    const parsed = hermesInternalsForTest.parseHermesStdout('line one\nline two\n');

    expect(parsed).toEqual({
      text: 'line one\nline two',
      sessionId: undefined,
    });
  });
});

describe('isSafeForHermesShadow', () => {
  it('allows read-only inspection prompts', () => {
    expect(isSafeForHermesShadow('Can you check the Butters setup?')).toBe(true);
    expect(isSafeForHermesShadow('Explain how the scheduler works')).toBe(true);
  });

  it('blocks prompts that are likely to mutate state', () => {
    expect(isSafeForHermesShadow('Please update the scheduler and deploy it')).toBe(false);
    expect(isSafeForHermesShadow('Post this draft to Typefully')).toBe(false);
  });

  it('allows a raw read-only prompt even when memory context contains mutation words', () => {
    const memoryInjectedPrompt = '[Memory]\nPrevious note: create a task and update the roadmap.\n\nCan you check the setup?';

    expect(isSafeForHermesShadow('Can you check the setup?')).toBe(true);
    expect(isSafeForHermesShadow(memoryInjectedPrompt)).toBe(false);
  });
});
