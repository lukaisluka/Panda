import { beforeEach, describe, expect, it } from 'vitest';
import {
  composerDraftKey,
  useComposerDrafts,
  DEMO_DRAFT_KEY,
  type ComposerDraft,
} from './composerDrafts';
import type { ImageAttachment } from './attachments';

const image = (id: string): ImageAttachment => ({
  id,
  name: `${id}.png`,
  mimeType: 'image/png',
  data: 'aGk=',
  size: 2,
});

const reset = () => {
  useComposerDrafts.setState({ drafts: {} });
};

const draftOfKey = (key: string): ComposerDraft | undefined =>
  useComposerDrafts.getState().drafts[key];

describe('composerDraftKey (bug hunt #15: drafts are per foreground session)', () => {
  it('separates connections, sessions on one connection, and the no-session anchor', () => {
    expect(composerDraftKey('conn-a', 's1')).toBe('conn-a::s1');
    expect(composerDraftKey('conn-a', 's2')).not.toBe(composerDraftKey('conn-a', 's1'));
    expect(composerDraftKey('conn-b', 's1')).not.toBe(composerDraftKey('conn-a', 's1'));
    expect(composerDraftKey('conn-a', null)).toBe('conn-a::none');
    expect(DEMO_DRAFT_KEY).toBe('demo');
  });
});

describe('draft store', () => {
  beforeEach(reset);

  it('starts empty and merges patches field by field', () => {
    const store = useComposerDrafts.getState();
    store.setDraft('k', { value: '为 A 写的消息' });
    store.setDraft('k', { attachments: [image('img-1')] });
    expect(draftOfKey('k')).toEqual({
      value: '为 A 写的消息',
      attachments: [image('img-1')],
      attachmentError: null,
    });
  });

  it('keeps drafts of different sessions independent', () => {
    const store = useComposerDrafts.getState();
    store.setDraft('conn-a::s1', { value: '给 A 的' });
    store.setDraft('conn-b::s2', { value: '给 B 的' });
    expect(draftOfKey('conn-a::s1')?.value).toBe('给 A 的');
    expect(draftOfKey('conn-b::s2')?.value).toBe('给 B 的');
  });

  it('clearDraft empties one session without touching its neighbours', () => {
    const store = useComposerDrafts.getState();
    store.setDraft('conn-a::s1', { value: 'x', attachments: [image('i')] });
    store.setDraft('conn-a::s2', { value: 'y' });
    store.clearDraft('conn-a::s1');
    expect(draftOfKey('conn-a::s1')).toBeUndefined();
    expect(draftOfKey('conn-a::s2')?.value).toBe('y');
  });

  it('clearDraft on a missing key is a no-op', () => {
    expect(() => useComposerDrafts.getState().clearDraft('missing')).not.toThrow();
  });

  it('clearSessionDrafts drops the session across all connections (delete path)', () => {
    const store = useComposerDrafts.getState();
    store.setDraft('conn-a::s1', { value: 'x', attachments: [image('i')] });
    store.setDraft('conn-b::s1', { value: 'y' });
    store.setDraft('conn-b::s2', { value: 'keep' });
    // A sessionId must not match by substring — only as the session segment.
    store.setDraft('conn-c::s10', { value: 'prefix collision' });
    store.clearSessionDrafts('s1');
    expect(draftOfKey('conn-a::s1')).toBeUndefined();
    expect(draftOfKey('conn-b::s1')).toBeUndefined();
    expect(draftOfKey('conn-b::s2')?.value).toBe('keep');
    expect(draftOfKey('conn-c::s10')?.value).toBe('prefix collision');
  });
});
