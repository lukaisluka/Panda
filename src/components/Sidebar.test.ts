import { describe, expect, it } from 'vitest';
import { emptySession } from '../protocol/reducer';
import type { SessionDocument } from '../protocol/types';
import type { SessionEntry } from '../store';
import { firstUserMessageText, sessionRowLabel, sessionRowMeta } from './Sidebar';

/** A document whose turns carry the given user-message content parts. */
function docWith(parts: Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }>): SessionDocument {
  const doc = emptySession();
  doc.turns.push({ id: 't-1', blocks: [{ kind: 'user_message', content: parts }] });
  return doc;
}

const entry = (patch: Partial<SessionEntry> = {}): SessionEntry => ({
  sessionId: 'session-91f53c9a',
  cwd: '/Users/dev/sandbox',
  title: null,
  updatedAt: null,
  ...patch,
});

describe('sessionRowLabel (#221: the conversation names itself)', () => {
  it('an agent-provided title always wins', () => {
    expect(sessionRowLabel(entry({ title: 'Refactor auth' }), docWith([{ type: 'text', text: 'hi' }]))).toBe('Refactor auth');
  });

  it('falls back to the first user message — the old `cwd · short-id` label helped nobody', () => {
    expect(sessionRowLabel(entry(), docWith([{ type: 'text', text: '为什么这个测试挂了?' }]))).toBe('为什么这个测试挂了?');
  });

  it('collapses whitespace across text parts before showing', () => {
    const doc = docWith([
      { type: 'text', text: '  fix\n  the' },
      { type: 'text', text: 'flaky test  ' },
    ]);
    expect(sessionRowLabel(entry(), doc)).toBe('fix the flaky test');
  });

  it('truncates long openings with an ellipsis', () => {
    const text = 'a'.repeat(60);
    expect(sessionRowLabel(entry(), docWith([{ type: 'text', text }]))).toBe(`${'a'.repeat(48)}…`);
    expect(sessionRowLabel(entry(), docWith([{ type: 'text', text }]), 10)).toBe('aaaaaaaaaa…');
  });

  it('an image-only opener yields no text — the workspace label stands in', () => {
    const doc = docWith([{ type: 'image', data: 'x', mimeType: 'image/png' }]);
    expect(sessionRowLabel(entry(), doc)).toBe('sandbox');
  });

  it('sessions never loaded locally (no document) fall back to the workspace label', () => {
    expect(sessionRowLabel(entry(), undefined)).toBe('sandbox');
  });
});

describe('firstUserMessageText', () => {
  it('scans forward: the first message with text wins, later turns are never consulted', () => {
    const doc = emptySession();
    doc.turns.push({ id: 't-1', blocks: [{ kind: 'agent_message', messageId: 'm-1', parts: [{ type: 'text', text: 'greeting' }] }] });
    doc.turns.push({ id: 't-2', blocks: [{ kind: 'user_message', content: [{ type: 'text', text: 'the opener' }] }] });
    doc.turns.push({ id: 't-3', blocks: [{ kind: 'user_message', content: [{ type: 'text', text: 'later' }] }] });
    expect(firstUserMessageText(doc)).toBe('the opener');
  });

  it('an empty document yields null', () => {
    expect(firstUserMessageText(emptySession())).toBeNull();
  });
});

describe('sessionRowMeta (#221: the short id demotes to hover meta)', () => {
  it('pairs the workspace label with the id\'s last six characters', () => {
    expect(sessionRowMeta(entry())).toBe('sandbox · f53c9a');
  });
});
