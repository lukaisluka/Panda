import { describe, expect, it } from 'vitest';
import { splitFilePath } from './FileTypeIcon';

describe('splitFilePath', () => {
  it('splits a nested path into basename + trailing-slash dir', () => {
    expect(splitFilePath('src/auth/session.ts')).toEqual({ base: 'session.ts', dir: 'src/auth/' });
  });

  it('keeps an empty dir at repo root', () => {
    expect(splitFilePath('package.json')).toEqual({ base: 'package.json', dir: '' });
  });

  it('keeps the leading slash of absolute paths as the dir', () => {
    expect(splitFilePath('/etc/hosts')).toEqual({ base: 'hosts', dir: '/etc/' });
  });

  it('treats a path with only slashes as empty base', () => {
    expect(splitFilePath('src/')).toEqual({ base: '', dir: 'src/' });
  });

  it('does not treat dots as separators (dotfiles keep their base)', () => {
    expect(splitFilePath('.env.local')).toEqual({ base: '.env.local', dir: '' });
  });
});
