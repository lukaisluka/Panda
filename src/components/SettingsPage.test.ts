import { describe, expect, it } from 'vitest';
import { profileDraftErrors, type ProfileDraft } from './SettingsPage';

const draft = (patch: Partial<ProfileDraft> = {}): ProfileDraft => ({
  name: 'test-agent',
  url: 'ws://localhost:8766/acp',
  workspace: { kind: 'local-directory', path: '/tmp/project' },
  ...patch,
});

describe('profileDraftErrors', () => {
  it('passes a complete draft', () => {
    expect(profileDraftErrors(draft())).toEqual({});
  });

  it('flags blank name and url', () => {
    expect(profileDraftErrors(draft({ name: '   ', url: '' }))).toEqual({
      name: '配置名称不能为空',
      url: '端点地址不能为空',
    });
  });

  it('requires a path only for local-directory workspaces (无工作区 needs none, ADR 0005)', () => {
    expect(profileDraftErrors(draft({ workspace: { kind: 'none', path: '' } }))).toEqual({});
    expect(profileDraftErrors(draft({ workspace: { kind: 'local-directory', path: ' ' } }))).toEqual({
      path: '本机文件夹需要路径',
    });
  });
});
