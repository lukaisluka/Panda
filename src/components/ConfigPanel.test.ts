import { describe, expect, it } from 'vitest';
import { groupChoices } from './ConfigPanel';
import type { AcpConfigChoice } from '../protocol/types';

const choice = (value: string, group: string | null): AcpConfigChoice => ({
  value,
  name: value,
  description: null,
  group,
});

describe('groupChoices (optgroup bucketing)', () => {
  it('merges consecutive same-group choices into buckets, preserving order', () => {
    const buckets = groupChoices([
      choice('im', '即时通讯'),
      choice('im-teams', '即时通讯'),
      choice('mail', '邮件'),
      choice('sms', '邮件'),
    ]);
    expect(buckets).toEqual([
      { group: '即时通讯', items: [choice('im', '即时通讯'), choice('im-teams', '即时通讯')] },
      { group: '邮件', items: [choice('mail', '邮件'), choice('sms', '邮件')] },
    ]);
  });

  it('keeps ungrouped choices as top-level null buckets', () => {
    expect(groupChoices([choice('a', null), choice('b', null)])).toEqual([
      { group: null, items: [choice('a', null), choice('b', null)] },
    ]);
    expect(groupChoices([choice('a', null), choice('b', 'g'), choice('c', null)])).toEqual([
      { group: null, items: [choice('a', null)] },
      { group: 'g', items: [choice('b', 'g')] },
      { group: null, items: [choice('c', null)] },
    ]);
  });
});
