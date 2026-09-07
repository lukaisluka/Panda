import { describe, expect, it } from 'vitest';
import { customEndpointErrors, nsdRowAction } from './NewSessionDialog';

describe('customEndpointErrors (phase 3: 自定义地址 form)', () => {
  it('accepts a filled url with a local-directory workspace', () => {
    expect(
      customEndpointErrors({ url: 'ws://x:1/acp', workspace: { kind: 'local-directory', path: '/tmp/p' } }),
    ).toEqual({});
  });

  it('blocks an empty url and a pathless local directory', () => {
    expect(customEndpointErrors({ url: '  ', workspace: { kind: 'local-directory', path: '' } })).toEqual({
      url: 'Endpoint is required',
      path: 'A local directory needs a path',
    });
  });

  it('无工作区 needs no path (ADR 0005)', () => {
    expect(customEndpointErrors({ url: 'ws://x:1/acp', workspace: { kind: 'none' } })).toEqual({});
  });
});

describe('nsdRowAction (bug hunt #3/#5: what clicking one agent row does)', () => {
  it('an idle online agent with a cwd starts a session on its own connection', () => {
    expect(nsdRowAction({ phase: 'connected', cwd: '/repo', busy: false })).toBe('new');
  });

  it('a mid-turn (or mid-switch) online agent is blocked — its session must settle first', () => {
    expect(nsdRowAction({ phase: 'connected', cwd: '/repo', busy: true })).toBe('blocked');
    expect(nsdRowAction({ phase: 'switching-session', cwd: '/repo', busy: true })).toBe('blocked');
  });

  it('offline agents (and the cwd-less edge) fall back to connect', () => {
    expect(nsdRowAction({ phase: 'disconnected', cwd: null, busy: false })).toBe('connect');
    expect(nsdRowAction({ phase: 'error', cwd: '/repo', busy: false })).toBe('connect');
    expect(nsdRowAction({ phase: 'connected', cwd: null, busy: false })).toBe('connect');
  });
});
