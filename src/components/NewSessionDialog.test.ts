import { describe, expect, it } from 'vitest';
import { customEndpointErrors } from './NewSessionDialog';

describe('customEndpointErrors (phase 3: 自定义地址 form)', () => {
  it('accepts a filled url with a local-directory workspace', () => {
    expect(
      customEndpointErrors({ url: 'ws://x:1/acp', workspace: { kind: 'local-directory', path: '/tmp/p' } }),
    ).toEqual({});
  });

  it('blocks an empty url and a pathless local directory', () => {
    expect(customEndpointErrors({ url: '  ', workspace: { kind: 'local-directory', path: '' } })).toEqual({
      url: '端点地址不能为空',
      path: '本机文件夹需要路径',
    });
  });

  it('无工作区 needs no path (ADR 0005)', () => {
    expect(customEndpointErrors({ url: 'ws://x:1/acp', workspace: { kind: 'none' } })).toEqual({});
  });
});
