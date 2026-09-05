import { describe, expect, it } from 'vitest';
import { titleFromFirstUserText } from '../src/sessionTitles';

describe('titleFromFirstUserText', () => {
  it('用首条用户文本压成一行作为标题', () => {
    expect(titleFromFirstUserText('  重构\n auth   校验 ')).toBe('重构 auth 校验');
  });

  it('空白文本不生成标题', () => {
    expect(titleFromFirstUserText(' \n\t ')).toBeNull();
  });

  it('超长文本截断,不发起第二次模型调用', () => {
    expect(titleFromFirstUserText('a'.repeat(60))).toBe('a'.repeat(47) + '…');
  });
});
