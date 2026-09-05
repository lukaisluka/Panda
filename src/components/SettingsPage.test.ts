import { describe, expect, it } from 'vitest';
import {
  mcpDraftErrors,
  mcpServerSummary,
  profileDraftErrors,
  type McpDraft,
  type ProfileDraft,
} from './SettingsPage';

const draft = (patch: Partial<ProfileDraft> = {}): ProfileDraft => ({
  name: 'test-agent',
  url: 'ws://localhost:8766/acp',
  workspace: { kind: 'local-directory', path: '/tmp/project' },
  ...patch,
});

const mcpDraft = (patch: Partial<McpDraft> = {}): McpDraft => ({
  name: 'filesystem',
  type: 'stdio',
  command: 'npx',
  args: '-y server-filesystem',
  url: '',
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

describe('mcpDraftErrors (issue #71)', () => {
  it('passes a complete stdio draft', () => {
    expect(mcpDraftErrors(mcpDraft())).toEqual({});
  });

  it('flags a blank name', () => {
    expect(mcpDraftErrors(mcpDraft({ name: ' ' }))).toEqual({ name: '服务器名称不能为空' });
  });

  it('stdio requires a command; args are optional', () => {
    expect(mcpDraftErrors(mcpDraft({ command: '', args: '' }))).toEqual({ command: 'stdio 类型需要可执行命令' });
  });

  it('http/sse require a url and not a command', () => {
    expect(mcpDraftErrors(mcpDraft({ type: 'http', command: '', url: 'https://x/mcp' }))).toEqual({});
    expect(mcpDraftErrors(mcpDraft({ type: 'sse', command: '', url: ' ' }))).toEqual({
      url: '需要一个 URL',
    });
  });
});

describe('mcpServerSummary (issue #71)', () => {
  it('summarizes stdio with command and args, url transports with their url', () => {
    expect(
      mcpServerSummary({ id: 'a', name: 'fs', type: 'stdio', command: 'npx', args: '-y srv' }),
    ).toBe('stdio · npx -y srv');
    expect(mcpServerSummary({ id: 'a', name: 'fs', type: 'stdio', command: 'uvx', args: '  ' })).toBe('stdio · uvx');
    expect(mcpServerSummary({ id: 'b', name: 'web', type: 'http', url: 'https://x/mcp' })).toBe('http · https://x/mcp');
    expect(mcpServerSummary({ id: 'c', name: 'old', type: 'sse', url: 'https://y/sse' })).toBe('sse · https://y/sse');
  });
});
