import { describe, expect, it } from 'vitest';
import { settledToolTitle } from './tool-title';

describe('settledToolTitle', () => {
  it('flips progressive verbs on settled calls', () => {
    expect(settledToolTitle('Editing src/auth/session.ts', 'completed')).toBe('Edit src/auth/session.ts');
    expect(settledToolTitle('Searching references to createHmac', 'completed')).toBe('Search references to createHmac');
    expect(settledToolTitle('Running test suite', 'failed')).toBe('Run test suite');
  });

  it('turns Thinking into Thought and drops the ellipsis', () => {
    expect(settledToolTitle('Thinking…', 'completed')).toBe('Thought');
    expect(settledToolTitle('Thinking...', 'completed')).toBe('Thought');
    expect(settledToolTitle('Thinking about the refactor', 'completed')).toBe('Thought about the refactor');
  });

  it('keeps case of the original first word', () => {
    expect(settledToolTitle('editing files', 'completed')).toBe('Edit files');
    expect(settledToolTitle('EDITING files', 'completed')).toBe('EDIT files');
  });

  it('leaves unmapped verbs and settled-form titles untouched', () => {
    expect(settledToolTitle('Read src/auth/session.ts', 'completed')).toBe('Read src/auth/session.ts');
    expect(settledToolTitle('Edit src/auth/session.ts — extract verifySession()', 'completed')).toBe('Edit src/auth/session.ts — extract verifySession()');
    expect(settledToolTitle('Run auth test suite', 'completed')).toBe('Run auth test suite');
  });

  it('does not rewrite while the call is still live', () => {
    expect(settledToolTitle('Editing src/a.ts', 'in_progress')).toBe('Editing src/a.ts');
    expect(settledToolTitle('Thinking…', 'pending')).toBe('Thinking…');
  });

  it('gives empty-title think calls their kind default', () => {
    expect(settledToolTitle('', 'in_progress', 'think')).toBe('Thinking…');
    expect(settledToolTitle('', 'pending', 'think')).toBe('Thinking…');
    expect(settledToolTitle('', 'completed', 'think')).toBe('Thought');
    expect(settledToolTitle('', 'failed', 'think')).toBe('Thought');
  });

  it('leaves empty titles of other kinds empty', () => {
    expect(settledToolTitle('', 'completed', 'read')).toBe('');
    expect(settledToolTitle('', 'in_progress')).toBe('');
  });
});
