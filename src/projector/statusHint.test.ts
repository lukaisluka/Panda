import { describe, expect, it } from 'vitest';
import { statusHint, type StatusHintInput } from './statusHint';

const connected = { status: 'connected' as const, error: null };

function hint(overrides: Partial<StatusHintInput>): string | undefined {
  return statusHint({
    mode: 'live',
    docStatus: 'idle',
    connection: connected,
    switching: false,
    ...overrides,
  });
}

describe('statusHint (demo replay)', () => {
  it('asks for approval while a permission is pending', () => {
    expect(hint({ mode: 'demo', docStatus: 'requires_action' })).toBe('等待批准中…');
  });

  it('announces work while the turn runs', () => {
    expect(hint({ mode: 'demo', docStatus: 'running' })).toBe('Panda 正在工作…');
  });

  it('stays empty when idle', () => {
    expect(hint({ mode: 'demo', docStatus: 'idle' })).toBeUndefined();
  });
});

describe('statusHint (live connection)', () => {
  it('leads with connection progress and failures before session state', () => {
    expect(hint({ connection: { status: 'connecting', error: null } })).toBe('连接中…');
    expect(hint({ connection: { status: 'error', error: 'boom' } })).toBe(
      '连接失败 — 在侧栏重连并恢复，或重新连接',
    );
  });

  it('tells the user to connect when no session is possible', () => {
    expect(hint({ connection: { status: 'disconnected', error: null } })).toBe('未连接 ACP 服务 — 在侧栏连接');
  });

  it('surfaces an in-flight session switch', () => {
    expect(hint({ switching: true })).toBe('切换会话中…');
  });

  it('surfaces a non-fatal connection error on an otherwise healthy link', () => {
    expect(hint({ connection: { status: 'connected', error: '上次切换失败' } })).toBe('上次切换失败');
  });

  it('announces work for both running and awaiting-approval turns', () => {
    expect(hint({ docStatus: 'running' })).toBe('Panda 正在工作…');
    expect(hint({ docStatus: 'requires_action' })).toBe('Panda 正在工作…');
  });

  it('stays empty when connected and idle', () => {
    expect(hint({})).toBeUndefined();
  });
});
