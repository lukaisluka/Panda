import { beforeEach, describe, expect, it } from 'vitest';
import { draftValuesFor, useElicitationDrafts } from './elicitationDrafts';

beforeEach(() => {
  useElicitationDrafts.setState({ drafts: {} });
});

describe('elicitation form drafts (bug hunt #16: values survive remounts)', () => {
  it('creates the draft on first touch and merges field writes', () => {
    const store = useElicitationDrafts.getState();
    store.setField('elicit-1', 'title', '发布');
    store.setField('elicit-1', 'tags', ['release']);
    expect(useElicitationDrafts.getState().drafts['elicit-1']).toEqual({
      title: '发布',
      tags: ['release'],
    });
  });

  it('keeps two pending forms independent', () => {
    const store = useElicitationDrafts.getState();
    store.setField('elicit-1', 'q', '第一张卡');
    store.setField('elicit-2', 'q', '第二张卡');
    expect(useElicitationDrafts.getState().drafts['elicit-1']?.q).toBe('第一张卡');
    expect(useElicitationDrafts.getState().drafts['elicit-2']?.q).toBe('第二张卡');
  });

  it('draftValuesFor returns a stable empty object for an untouched form', () => {
    const s1 = useElicitationDrafts.getState();
    const s2 = useElicitationDrafts.getState();
    expect(draftValuesFor(s1, 'unknown')).toBe(draftValuesFor(s2, 'unknown'));
  });

  it('clearDraft drops the settled form only', () => {
    const store = useElicitationDrafts.getState();
    store.setField('elicit-1', 'q', 'done');
    store.setField('elicit-2', 'q', 'pending');
    store.clearDraft('elicit-1');
    expect(useElicitationDrafts.getState().drafts['elicit-1']).toBeUndefined();
    expect(useElicitationDrafts.getState().drafts['elicit-2']?.q).toBe('pending');
  });

  it('clearDraft on a missing draft is a no-op', () => {
    expect(() => useElicitationDrafts.getState().clearDraft('missing')).not.toThrow();
  });
});
