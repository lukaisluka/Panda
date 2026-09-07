/**
 * Diagnostics (#105): the client-side observability minimum. No telemetry,
 * no upload — the user copies the report and hands it over. Two halves:
 *
 * - a console tap keeping the last N error/warn/info lines in a ring buffer,
 *   so "what happened before the crash" survives;
 * - buildDiagnostics(), folding environment + error + component stack +
 *   that ring into one markdown report. Pure assembly — callers decide what
 *   to do with it (clipboard today).
 *
 * Diagnostics content is deliberately NOT localized: it is a log-style
 * report read by developers (same scope decision as #91's non-goals).
 */

export interface ConsoleEntry {
  level: 'error' | 'warn' | 'info';
  at: string;
  text: string;
}

const RING_LIMIT = 200;
const ENTRY_CHAR_LIMIT = 2000;
const STACK_LIMIT = 4000;

const ring: ConsoleEntry[] = [];
const tapped = new WeakSet<object>();

function formatArg(value: unknown): string {
  if (value instanceof Error) return value.stack ?? `${value.name}: ${value.message}`;
  if (typeof value === 'string') return value;
  if (typeof value === 'object' && value !== null) {
    try {
      return JSON.stringify(value) ?? String(value);
    } catch {
      return String(value);
    }
  }
  return String(value);
}

function formatArgs(args: unknown[]): string {
  const text = args.map(formatArg).join(' ');
  return text.length > ENTRY_CHAR_LIMIT
    ? `${text.slice(0, ENTRY_CHAR_LIMIT)}… [truncated ${text.length - ENTRY_CHAR_LIMIT} chars]`
    : text;
}

/** Wrap error/warn/info on `target` (default: the real console) so every
 * line also lands in the ring. Idempotent per target; the wrapped methods
 * still call through to the originals. */
export function installConsoleTap(target: Console = console): void {
  if (tapped.has(target)) return;
  tapped.add(target);
  for (const level of ['error', 'warn', 'info'] as const) {
    const original = target[level].bind(target);
    target[level] = (...args: unknown[]) => {
      ring.push({ level, at: new Date().toISOString(), text: formatArgs(args) });
      if (ring.length > RING_LIMIT) ring.splice(0, ring.length - RING_LIMIT);
      original(...args);
    };
  }
}

/** A copy of the ring, oldest first. */
export function recentConsole(): ConsoleEntry[] {
  return [...ring];
}

function formatError(error: unknown): string {
  if (error instanceof Error) {
    const stack = (error.stack ?? '').slice(0, STACK_LIMIT);
    const headline = `${error.name}: ${error.message}`;
    // V8 stacks already open with "Name: message" — don't print it twice.
    return stack.startsWith(headline) ? stack : stack ? `${headline}\n${stack}` : headline;
  }
  return String(error);
}

export interface DiagnosticsEnv {
  now: string;
  url: string;
  locale: string;
  userAgent: string;
  /** Host the app is running in (#125): 'desktop' inside the Tauri shell
   * (stdio agents available), 'browser' everywhere else. */
  host: 'browser' | 'desktop';
}

function defaultEnv(): DiagnosticsEnv {
  // Node (unit tests) has no location/navigator — degrade visibly instead of
  // crashing on import or lying with an empty value.
  const nav = typeof navigator !== 'undefined' ? navigator : undefined;
  return {
    now: new Date().toISOString(),
    url: typeof location !== 'undefined' ? location.href : '(unavailable)',
    locale: nav?.language ?? '(unavailable)',
    userAgent: nav?.userAgent ?? '(unavailable)',
    host: desktopHost() ? 'desktop' : 'browser',
  };
}

/** True only inside the Tauri shell — the same probe main.tsx boots from. */
export function desktopHost(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

/** One-line user-agent summary for the settings diagnostics page, e.g.
 * `Chrome 140 · macOS`. Pure parsing, deliberately not localized: product
 * names are their own names. Order matters — Edge/Opera UAs also carry a
 * Chrome token, Android UAs carry Linux. Falls back to the platform alone
 * when the browser is unknown, and '(unknown)' when nothing matches, so a
 * surprising UA stays visible instead of silently blanking the row. */
export function summarizeUserAgent(ua: string): string {
  const BROWSERS: readonly [RegExp, string][] = [
    [/Edg\/(\d+)/, 'Edge'],
    [/OPR\/(\d+)/, 'Opera'],
    [/Firefox\/(\d+)/, 'Firefox'],
    [/Chrome\/(\d+)/, 'Chrome'],
    // Safari: "Version/18.0 Safari/605.1.15" (macOS) and, on iOS,
    // "Version/18.0 Mobile/15E148 Safari/604.1" — anything may ride between
    // (build tokens carry hex), but no other capital-S word intervenes.
    [/Version\/(\d+)[^S]* Safari/, 'Safari'],
  ];
  const PLATFORMS: readonly [RegExp, string][] = [
    [/iPhone|iPad/, 'iOS'],
    [/Android/, 'Android'],
    [/Windows NT/, 'Windows'],
    [/Mac OS X/, 'macOS'],
    [/Linux/, 'Linux'],
  ];
  const browser = BROWSERS.flatMap(([re, name]) => {
    const match = re.exec(ua);
    return match ? [`${name} ${match[1]}`] : [];
  })[0];
  const platform = PLATFORMS.flatMap(([re, name]) => (re.test(ua) ? [name] : []))[0];
  return [browser, platform].filter(Boolean).join(' · ') || '(unknown)';
}

export interface DiagnosticsInput {
  error?: unknown;
  /** React componentStack from an error boundary; truncated hard — deep
   * trees have produced multi-hundred-KB stacks. */
  componentStack?: string | null;
  entries?: ConsoleEntry[];
  env?: Partial<DiagnosticsEnv>;
}

/** Assemble the copy-paste report. Section presence follows the input: no
 * error section when called from settings (the "attach context to a bug
 * report" path), console section only when the ring is non-empty. */
export function buildDiagnostics(input: DiagnosticsInput = {}): string {
  const env = { ...defaultEnv(), ...input.env };
  const lines: string[] = [
    '# Panda diagnostics',
    '',
    `- time: ${env.now}`,
    `- url: ${env.url}`,
    `- locale: ${env.locale}`,
    `- userAgent: ${env.userAgent}`,
    `- host: ${env.host}`,
  ];

  if (input.error !== undefined) {
    lines.push('', '## Error', '', formatError(input.error));
  }

  if (input.componentStack) {
    const stack = input.componentStack.slice(0, STACK_LIMIT);
    lines.push('', '## Component stack', '', stack);
  }

  const entries = input.entries ?? recentConsole();
  if (entries.length > 0) {
    lines.push('', `## Recent console (newest last, up to ${RING_LIMIT})`, '');
    for (const entry of entries) {
      lines.push(`[${entry.level}] ${entry.at} ${entry.text}`);
    }
  }

  return lines.join('\n');
}

/** Clipboard write with a boolean verdict — callers surface success/failure
 * instead of letting a rejected promise vanish. */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}
