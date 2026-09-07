import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { unifiedPatch } from './diff-utils';

/**
 * End-to-end counterpart to the string-shape tests in diff-utils.test.ts:
 * the acceptance criterion of #6 is not「looks like git diff」but「git apply
 * accepts it」— git itself is the patch format's referee. Covers every
 * no-newline-EOF shape plus a plain control case; runs the real `git apply`
 * on a tmp dir (git is present wherever the suite runs — CI included).
 */
describe('unifiedPatch — git apply end-to-end (#6)', () => {
  it('patches across the no-newline-EOF shapes apply cleanly and produce the new text', () => {
    const dir = mkdtempSync(join(tmpdir(), 'panda-patch-'));
    mkdirSync(join(dir, 'repo'));
    const cases = [
      { path: 'both.txt', old: 'a\nb', next: 'a\nB' }, // del AND add are EOF-no-newline
      { path: 'old-only.txt', old: 'x\ny', next: 'x\ny\n' }, // newline added at EOF
      { path: 'append.txt', old: 'a\nb', next: 'a\nb\nc' }, // appends past a no-newline EOF
      { path: 'ctx-eof.txt', old: 'a\nb\nc', next: 'A\nb\nc' }, // ctx EOF line, both sides bare
      { path: 'plain.txt', old: 'old\ncontent\n', next: 'new\ncontent\n' }, // control
    ];
    for (const { path, old } of cases) {
      writeFileSync(join(dir, 'repo', path), old);
    }
    for (const { path, old, next } of cases) {
      writeFileSync(join(dir, 'patch.diff'), unifiedPatch(path, old, next));
      execFileSync('git', ['-C', join(dir, 'repo'), 'apply', '../patch.diff'], { stdio: 'pipe' });
      expect(readFileSync(join(dir, 'repo', path), 'utf8')).toBe(next);
    }
  });
});
