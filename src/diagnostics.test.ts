import { describe, expect, it } from 'vitest';
import {
  buildDiagnostics,
  installConsoleTap,
  recentConsole,
  summarizeUserAgent,
  type ConsoleEntry,
} from './diagnostics';

/** Fresh fake console per test — the tap is idempotent per target, so a new
 * object also gives us a fresh tap without any global reset hook. */
function fakeConsole() {
  const calls: string[] = [];
  const target = {
    error: (...a: unknown[]) => calls.push(`error:${a.length}`),
    warn: (...a: unknown[]) => calls.push(`warn:${a.length}`),
    info: (...a: unknown[]) => calls.push(`info:${a.length}`),
  } as unknown as Console;
  return { target, calls };
}

const entry = (over: Partial<ConsoleEntry> = {}): ConsoleEntry => ({
  level: 'error',
  at: '2026-09-06T00:00:00.000Z',
  text: 'boom',
  ...over,
});

describe('installConsoleTap', () => {
  it('records error/warn/info lines and still calls through to the original', () => {
    const { target, calls } = fakeConsole();
    installConsoleTap(target);
    target.error('one');
    target.warn('two');
    target.info('three');
    // log() etc. untouched — the tap stays on the three noisy levels only
    expect(calls).toEqual(['error:1', 'warn:1', 'info:1']);
    const ring = recentConsole().slice(-3);
    expect(ring.map((e) => [e.level, e.text])).toEqual([
      ['error', 'one'],
      ['warn', 'two'],
      ['info', 'three'],
    ]);
  });

  it('is idempotent per target (no double-wrap, no double ring entries)', () => {
    const { target } = fakeConsole();
    installConsoleTap(target);
    installConsoleTap(target);
    const before = recentConsole().length;
    target.error('once');
    expect(recentConsole().length - before).toBe(1);
  });

  it('expands Error arguments to their stack and caps a single entry length', () => {
    const { target } = fakeConsole();
    installConsoleTap(target);
    const err = new Error('kaput');
    target.error('ctx', err);
    const last = recentConsole().at(-1)!;
    expect(last.text).toContain('ctx');
    expect(last.text).toContain('Error: kaput');

    const huge = 'x'.repeat(50_000);
    target.error(huge);
    expect(recentConsole().at(-1)!.text.length).toBeLessThan(3_000);
  });

  it('never lets a JSON.stringify-hostile object escape as an exception', () => {
    const { target } = fakeConsole();
    installConsoleTap(target);
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    target.error(cyclic);
    expect(recentConsole().at(-1)!.text).toContain('object');
  });
});

describe('buildDiagnostics', () => {
  const env = {
    now: '2026-09-06T02:03:04.000Z',
    url: 'https://lukaisluka.github.io/Panda/#/settings',
    locale: 'en',
    userAgent: 'test-agent',
    host: 'browser' as const,
  };

  it('reports the host environment (#125: browser vs desktop shell)', () => {
    const report = buildDiagnostics({ env, entries: [] });
    expect(report).toContain('- host: browser');
    expect(buildDiagnostics({ env: { ...env, host: 'desktop' }, entries: [] })).toContain('- host: desktop');
  });

  it('assembles environment + error + component stack + console sections', () => {
    const report = buildDiagnostics({
      error: new Error('render blew up'),
      componentStack: '\n    at MainScreen\n    at App',
      entries: [entry({ level: 'warn', text: '[panda/acp] reconnecting' }), entry()],
      env,
    });
    expect(report).toContain('# Panda diagnostics');
    expect(report).toContain('- url: https://lukaisluka.github.io/Panda/#/settings');
    expect(report).toContain('- userAgent: test-agent');
    expect(report).toContain('## Error');
    expect(report).toContain('Error: render blew up');
    expect(report).toContain('## Component stack');
    expect(report).toContain('at MainScreen');
    expect(report).toContain('[warn] 2026-09-06T00:00:00.000Z [panda/acp] reconnecting');
  });

  it('omits the error and component-stack sections on the settings path', () => {
    const report = buildDiagnostics({ env, entries: [] });
    expect(report).not.toContain('## Error');
    expect(report).not.toContain('## Component stack');
    expect(report).not.toContain('## Recent console');
  });

  it('truncates a pathological component stack', () => {
    const report = buildDiagnostics({
      componentStack: 'x'.repeat(20_000),
      env,
    });
    expect(report.length).toBeLessThan(22_000);
    expect(report).toContain('## Component stack');
  });

  it('does not print the V8 stack headline twice (stack already opens with it)', () => {
    const report = buildDiagnostics({ error: new Error('dupe check'), env });
    const occurrences = report.split('Error: dupe check').length - 1;
    expect(occurrences).toBe(1);
  });

  it('collects env defensively in node (no location/navigator) instead of crashing', () => {
    const report = buildDiagnostics({ error: 'plain string' });
    expect(report).toContain('- url: (unavailable)');
    expect(report).toContain('plain string');
  });
});

describe('summarizeUserAgent', () => {
  it('Chrome on macOS', () => {
    expect(
      summarizeUserAgent(
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
      ),
    ).toBe('Chrome 140 · macOS');
  });

  it('Edge UAs also carry a Chrome token but report Edge (match order)', () => {
    expect(
      summarizeUserAgent(
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36 Edg/140.0.0.0',
      ),
    ).toBe('Edge 140 · Windows');
  });

  it('Firefox on Windows', () => {
    expect(
      summarizeUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:141.0) Gecko/20100101 Firefox/141.0'),
    ).toBe('Firefox 141 · Windows');
  });

  it('Safari on iOS (Android before Linux, iOS before macOS)', () => {
    expect(
      summarizeUserAgent(
        'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
      ),
    ).toBe('Safari 18 · iOS');
  });

  it('Android UA reports Android, not the embedded Linux token', () => {
    expect(
      summarizeUserAgent('Mozilla/5.0 (Linux; Android 15) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36'),
    ).toBe('Chrome 140 · Android');
  });

  it('unknown browser falls back to the platform alone', () => {
    expect(summarizeUserAgent('Mozilla/5.0 (X11; Linux x86_64) some-custom-agent/1.0')).toBe('Linux');
  });

  it('nothing recognizable stays visible as (unknown)', () => {
    expect(summarizeUserAgent('curl/8.7.1')).toBe('(unknown)');
  });
});
