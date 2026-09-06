import { describe, expect, it } from 'vitest';
import { encodeMessage, LineAssembler, tryParseJsonLine } from './stdioFraming';

const encoder = new TextEncoder();

describe('LineAssembler', () => {
  it('splits complete lines and retains a partial tail across chunks', () => {
    const assembler = new LineAssembler();
    expect(assembler.push(encoder.encode('{"a":1}\n{"b":'))).toEqual(['{"a":1}']);
    expect(assembler.push(encoder.encode('2}\n'))).toEqual(['{"b":2}']);
  });

  it('stitches a multi-byte character split across chunk boundaries', () => {
    const assembler = new LineAssembler();
    const bytes = encoder.encode('{"t":"你好"}\n');
    const cut = 9; // inside the first multibyte character's bytes
    expect(assembler.push(bytes.slice(0, cut))).toEqual([]);
    expect(assembler.push(bytes.slice(cut))).toEqual(['{"t":"你好"}']);
  });

  it('drops blank lines and trims stray whitespace (\\r\\n included)', () => {
    const assembler = new LineAssembler();
    expect(assembler.push(encoder.encode('\r\n{"a":1}\r\n\n  \n'))).toEqual(['{"a":1}']);
  });

  it('flush reports the unterminated tail (the caller drops it loudly)', () => {
    const assembler = new LineAssembler();
    assembler.push(encoder.encode('{"a":1}\n{"trunc'));
    expect(assembler.flush()).toBe('{"trunc');
    expect(assembler.flush()).toBeNull();
  });
});

describe('tryParseJsonLine', () => {
  it('parses JSON and reports bad lines without throwing', () => {
    expect(tryParseJsonLine('{"method":"x"}')).toEqual({ ok: true, value: { method: 'x' } });
    expect(tryParseJsonLine('not json')).toEqual({ ok: false, raw: 'not json' });
  });
});

describe('encodeMessage', () => {
  it('serializes one newline-terminated JSON line', () => {
    expect(encodeMessage({ id: 1, method: 'ping' })).toBe('{"id":1,"method":"ping"}\n');
  });
});
