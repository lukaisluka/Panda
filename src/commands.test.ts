import { describe, expect, it } from 'vitest';
import type { AcpAvailableCommand } from './protocol/types';
import { commandCompletion, commandKeyAction, matchCommands, wrapIndex } from './commands';

const commands: AcpAvailableCommand[] = [
  { name: 'status', description: '查看状态', inputHint: null },
  { name: 'tag', description: '打 tag', inputHint: '版本号' },
  { name: 'ci', description: '触发 CI', inputHint: null },
];

describe('matchCommands (panel open/close + filtering)', () => {
  it('opens on a bare slash and lists every command', () => {
    expect(matchCommands(commands, '/')).toEqual(commands);
  });

  it('filters by command-name prefix, case-insensitively, preserving agent order', () => {
    expect(matchCommands(commands, '/t')).toEqual([commands[1]]);
    expect(matchCommands(commands, '/STATUS')).toEqual([commands[0]]);
  });

  it('closes for non-command input, settled names (argument phase), and no matches', () => {
    expect(matchCommands(commands, '普通消息')).toBe(null);
    expect(matchCommands(commands, '/tag v1.3.0')).toBe(null); // space: the name is settled
    expect(matchCommands(commands, '见 /tag')).toBe(null); // not at position zero
    expect(matchCommands(commands, '/zzz')).toBe(null);
  });
});

describe('commandCompletion', () => {
  it('produces /name with a trailing space so the argument starts immediately', () => {
    expect(commandCompletion({ name: 'tag', description: '打 tag', inputHint: '版本号' })).toBe('/tag ');
  });
});

describe('commandKeyAction (keyboard while the panel is open)', () => {
  it('Enter completes; Shift+Enter falls through to a newline', () => {
    expect(commandKeyAction({ key: 'Enter', shiftKey: false })).toEqual({ type: 'complete' });
    expect(commandKeyAction({ key: 'Enter', shiftKey: true })).toBe(null);
  });

  it('Tab completes, arrows move, Escape closes, everything else falls through', () => {
    expect(commandKeyAction({ key: 'Tab', shiftKey: false })).toEqual({ type: 'complete' });
    expect(commandKeyAction({ key: 'ArrowDown', shiftKey: false })).toEqual({ type: 'move', delta: 1 });
    expect(commandKeyAction({ key: 'ArrowUp', shiftKey: false })).toEqual({ type: 'move', delta: -1 });
    expect(commandKeyAction({ key: 'Escape', shiftKey: false })).toEqual({ type: 'close' });
    expect(commandKeyAction({ key: 'a', shiftKey: false })).toBe(null);
  });
});

describe('wrapIndex', () => {
  it('wraps around both ends of the list', () => {
    expect(wrapIndex(2, 1, 3)).toBe(0);
    expect(wrapIndex(0, -1, 3)).toBe(2);
  });
});
