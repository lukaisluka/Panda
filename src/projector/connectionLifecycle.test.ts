import { describe, expect, it } from 'vitest';
import {
  connectionLifecycle,
  connectionPhase,
  foregroundLifecycle,
  isLinkUp,
  type ForegroundLifecycleInput,
} from './connectionLifecycle';
import type { ConnectionInfo, ConnectionState } from '../store';

// -- connectionPhase: the total precedence -------------------------------------

describe('connectionPhase', () => {
  it('maps each raw status to its phase', () => {
    expect(connectionPhase('connecting', null, false)).toBe('connecting');
    expect(connectionPhase('error', 'boom', false)).toBe('error');
    expect(connectionPhase('auth_required', null, false)).toBe('auth-required');
    expect(connectionPhase('disconnected', null, false)).toBe('disconnected');
    expect(connectionPhase('connected', null, false)).toBe('connected');
  });

  it('splits the connected status by side facts, switch first', () => {
    expect(connectionPhase('connected', null, true)).toBe('switching-session');
    expect(connectionPhase('connected', '上次切换失败', false)).toBe('connected-degraded');
    // A switch in flight outranks a non-fatal error (StatusBar precedence).
    expect(connectionPhase('connected', 'boom', true)).toBe('switching-session');
  });

  it('keeps the link up across the three connected phases only', () => {
    expect(isLinkUp('connected')).toBe(true);
    expect(isLinkUp('connected-degraded')).toBe(true);
    expect(isLinkUp('switching-session')).toBe(true);
    expect(isLinkUp('connecting')).toBe(false);
    expect(isLinkUp('error')).toBe(false);
    expect(isLinkUp('auth-required')).toBe(false);
    expect(isLinkUp('disconnected')).toBe(false);
  });
});

// -- connectionLifecycle: per-slot facts + 需要关注 reasons ----------------------

function slot(overrides: Partial<ConnectionState> = {}): ConnectionState {
  return {
    connection: { status: 'connected', error: null } as ConnectionInfo,
    capabilities: {} as ConnectionState['capabilities'],
    sessions: [],
    docs: {},
    switching: null,
    unreadCompletion: false,
    lastActivityAt: null,
    ...overrides,
  };
}

describe('connectionLifecycle', () => {
  it('aggregates running and busy across the slot, not just the foreground doc', () => {
    const idle = slot();
    expect(connectionLifecycle(idle).running).toBe(false);
    expect(connectionLifecycle(idle).busy).toBe(false);
  });

  it('carries phase and error through', () => {
    const failed = slot({ connection: { status: 'error', error: 'boom' } as ConnectionState['connection'] });
    const projected = connectionLifecycle(failed);
    expect(projected.phase).toBe('error');
    expect(projected.error).toBe('boom');
  });

  it('lists each 需要关注 source that actually fired, instead of folding to a boolean', () => {
    expect(connectionLifecycle(slot()).attention).toEqual([]);

    expect(connectionLifecycle(slot({ unreadCompletion: true })).attention).toEqual(['unread-completion']);

    const pending = slot({ docs: { s1: { permissions: { p1: { status: 'pending' } } } } as unknown as ConnectionState['docs'] });
    expect(connectionLifecycle(pending).attention).toEqual(['pending-permission']);

    const broken = slot({ connection: { status: 'error', error: 'boom' } as ConnectionState['connection'] });
    expect(connectionLifecycle(broken).attention).toEqual(['connection-error']);

    const auth = slot({ connection: { status: 'auth_required', error: null } as ConnectionState['connection'] });
    expect(connectionLifecycle(auth).attention).toEqual(['auth-required']);

    // Multiple sources ride along together.
    const several = slot({
      unreadCompletion: true,
      connection: { status: 'error', error: 'boom' } as ConnectionState['connection'],
    });
    expect(connectionLifecycle(several).attention).toEqual(['unread-completion', 'connection-error']);
  });
});

// -- foregroundLifecycle: composer gates + hint ---------------------------------

function foreground(overrides: Partial<ForegroundLifecycleInput>): ForegroundLifecycleInput {
  return {
    mode: 'live',
    docStatus: 'idle',
    connection: { status: 'connected', error: null },
    switching: false,
    ...overrides,
  };
}

describe('foregroundLifecycle (demo replay)', () => {
  it('asks for approval while a permission is pending', () => {
    expect(foregroundLifecycle(foreground({ mode: 'demo', docStatus: 'requires_action' })).hint).toBe('等待批准中…');
  });

  it('announces work while the turn runs', () => {
    expect(foregroundLifecycle(foreground({ mode: 'demo', docStatus: 'running' })).hint).toBe('Panda 正在工作…');
  });

  it('stays empty when idle', () => {
    expect(foregroundLifecycle(foreground({ mode: 'demo', docStatus: 'idle' })).hint).toBeUndefined();
  });

  it('never gates the composer on the connection, only on the turn', () => {
    const demo = foregroundLifecycle(foreground({ mode: 'demo', docStatus: 'running' }));
    expect(demo.composerDisabled).toBe(true);
    expect(demo.busy).toBe(true);
  });
});

describe('foregroundLifecycle (live connection)', () => {
  it('leads with connection progress and failures before session state', () => {
    expect(foregroundLifecycle(foreground({ connection: { status: 'connecting', error: null } })).hint).toBe('连接中…');
    expect(foregroundLifecycle(foreground({ connection: { status: 'error', error: 'boom' } })).hint).toBe(
      '连接失败 — 在侧栏重连并恢复，或重新连接',
    );
  });

  it('tells the user to connect when no session is possible', () => {
    expect(foregroundLifecycle(foreground({ connection: { status: 'disconnected', error: null } })).hint).toBe(
      '未连接 ACP 服务 — 在侧栏连接',
    );
  });

  it('surfaces an in-flight session switch', () => {
    expect(foregroundLifecycle(foreground({ switching: true })).hint).toBe('切换会话中…');
  });

  it('surfaces a non-fatal connection error on an otherwise healthy link', () => {
    expect(foregroundLifecycle(foreground({ connection: { status: 'connected', error: '上次切换失败' } })).hint).toBe(
      '上次切换失败',
    );
  });

  it('announces work for both running and awaiting-approval turns', () => {
    expect(foregroundLifecycle(foreground({ docStatus: 'running' })).hint).toBe('Panda 正在工作…');
    expect(foregroundLifecycle(foreground({ docStatus: 'requires_action' })).hint).toBe('Panda 正在工作…');
  });

  it('stays empty when connected and idle', () => {
    expect(foregroundLifecycle(foreground({})).hint).toBeUndefined();
  });

  it('gates the composer on the link, the turn and in-flight switches', () => {
    expect(foregroundLifecycle(foreground({})).composerDisabled).toBe(false);
    expect(foregroundLifecycle(foreground({ connection: { status: 'disconnected', error: null } })).composerDisabled).toBe(true);
    expect(foregroundLifecycle(foreground({ connection: { status: 'connecting', error: null } })).composerDisabled).toBe(true);
    // A non-fatal error keeps the link usable.
    expect(foregroundLifecycle(foreground({ connection: { status: 'connected', error: '上次切换失败' } })).composerDisabled).toBe(false);
    expect(foregroundLifecycle(foreground({ docStatus: 'running' })).composerDisabled).toBe(true);
    expect(foregroundLifecycle(foreground({ switching: true })).composerDisabled).toBe(true);
  });

  it('offers stop only while a turn runs on a healthy live link', () => {
    expect(foregroundLifecycle(foreground({ docStatus: 'running' })).canStop).toBe(true);
    expect(foregroundLifecycle(foreground({ docStatus: 'idle' })).canStop).toBe(false);
    expect(foregroundLifecycle(foreground({ docStatus: 'running', connection: { status: 'error', error: 'boom' } })).canStop).toBe(false);
    expect(foregroundLifecycle(foreground({ mode: 'demo', docStatus: 'running' })).canStop).toBe(false);
  });

  it('keeps the foreground busy through turns and switches', () => {
    expect(foregroundLifecycle(foreground({ docStatus: 'requires_action' })).busy).toBe(true);
    expect(foregroundLifecycle(foreground({ switching: true })).busy).toBe(true);
    expect(foregroundLifecycle(foreground({})).busy).toBe(false);
  });
});
