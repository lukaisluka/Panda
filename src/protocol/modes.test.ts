import { describe, expect, it } from 'vitest';
import type { AcpConfigOption } from './types';
import { modeStateFromConfigOptions } from './modes';

describe('modeStateFromConfigOptions', () => {
  const modeSelect: AcpConfigOption = {
    type: 'select',
    id: 'mode',
    name: 'Session Mode',
    description: 'Controls how the agent requests permission',
    category: 'mode',
    currentValue: 'accept_edits',
    choices: [
      { value: 'ask_before_edits', name: 'Ask before edits', description: '每一步都要确认', group: null },
      { value: 'accept_edits', name: 'Accept edits', description: null, group: null },
    ],
  };

  it('derives mode state from a select with the reserved mode category', () => {
    expect(modeStateFromConfigOptions([modeSelect])).toEqual({
      currentModeId: 'accept_edits',
      availableModes: [
        { id: 'ask_before_edits', name: 'Ask before edits', description: '每一步都要确认' },
        { id: 'accept_edits', name: 'Accept edits', description: undefined },
      ],
    });
  });

  it('returns null for absent, empty, or mode-less lists', () => {
    expect(modeStateFromConfigOptions(null)).toBe(null);
    expect(modeStateFromConfigOptions([])).toBe(null);
    const modelSelect: AcpConfigOption = { ...modeSelect, id: 'model', category: 'model' };
    expect(modeStateFromConfigOptions([modelSelect])).toBe(null);
    const bool: AcpConfigOption = { type: 'boolean', id: 'mode', name: 'Mode', description: null, category: 'mode', currentValue: true };
    expect(modeStateFromConfigOptions([bool])).toBe(null);
  });

  it('derives from the first mode-category entry even alongside other options', () => {
    const other: AcpConfigOption = { type: 'boolean', id: 'verbose', name: '思考过程', description: null, category: null, currentValue: false };
    expect(modeStateFromConfigOptions([other, modeSelect])?.currentModeId).toBe('accept_edits');
  });
});
