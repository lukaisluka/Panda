import { describe, expect, it } from 'vitest';
import {
  NO_WORKSPACE_LABEL,
  WORKSPACE_NONE_CWD,
  cwdToWorkspace,
  isWorkspace,
  workspaceDisplay,
  workspaceLabel,
  workspaceToCwd,
} from './workspace';

/** 工作区的派生与显示规则(issue #23, ADR 0005)。 */
describe('workspaceToCwd', () => {
  it('local-directory sends its path; none sends the placeholder constant', () => {
    expect(workspaceToCwd({ kind: 'local-directory', path: '/tmp/project' })).toBe('/tmp/project');
    expect(workspaceToCwd({ kind: 'none' })).toBe(WORKSPACE_NONE_CWD);
    expect(WORKSPACE_NONE_CWD).toBe('/');
  });
});

describe('cwdToWorkspace', () => {
  it("reads `/` back as 无工作区 (the accepted `/` ≡ none equivalence)", () => {
    expect(cwdToWorkspace('/')).toEqual({ kind: 'none' });
    expect(cwdToWorkspace('/tmp/project')).toEqual({ kind: 'local-directory', path: '/tmp/project' });
  });

  it('round-trips every workspace through its derived cwd', () => {
    const workspaces = [
      { kind: 'none' },
      { kind: 'local-directory', path: '/a/b' },
    ] as const;
    for (const workspace of workspaces) {
      expect(cwdToWorkspace(workspaceToCwd(workspace))).toEqual(workspace);
    }
  });
});

describe('isWorkspace', () => {
  it('accepts none and a pathed local-directory, rejects the rest', () => {
    expect(isWorkspace({ kind: 'none' })).toBe(true);
    expect(isWorkspace({ kind: 'local-directory', path: '/x' })).toBe(true);
    expect(isWorkspace({ kind: 'local-directory', path: '' })).toBe(false);
    expect(isWorkspace({ kind: 'remote-repository', uri: 'https://…' })).toBe(false);
    expect(isWorkspace('/tmp')).toBe(false);
    expect(isWorkspace(null)).toBe(false);
  });
});

describe('workspaceLabel / workspaceDisplay', () => {
  it('labels the placeholder as 无工作区 and other cwds by folder name', () => {
    expect(workspaceLabel('/')).toBe(NO_WORKSPACE_LABEL);
    expect(NO_WORKSPACE_LABEL).toBe('无工作区'); // the pinned UI literal
    expect(workspaceLabel('/tmp/project')).toBe('project');
  });

  it('displays a workspace as its path or 无工作区', () => {
    expect(workspaceDisplay({ kind: 'local-directory', path: '/tmp/project' })).toBe('/tmp/project');
    expect(workspaceDisplay({ kind: 'none' })).toBe(NO_WORKSPACE_LABEL);
  });
});
