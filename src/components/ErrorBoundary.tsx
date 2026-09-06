import { Component, useState, type ReactNode } from 'react';
import { buildDiagnostics, copyText } from '../diagnostics';
import { t } from '../i18n';

/**
 * The last line of defense (#105): a render error anywhere below this
 * boundary must degrade to a readable page with a copyable report — never a
 * blank tab. Mounted at the very root (above Theme and I18nProvider), so the
 * fallback takes no dependency on them: inline styles instead of theme/CSS
 * classes, and the module-level t() instead of useI18n — any of those may be
 * part of the crash.
 */

interface ErrorBoundaryState {
  error: Error | null;
  componentStack: string | null;
}

export class ErrorBoundary extends Component<{ children: ReactNode }, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null, componentStack: null };

  static getDerivedStateFromError(error: Error): Partial<ErrorBoundaryState> {
    return { error };
  }

  componentDidCatch(error: Error, info: { componentStack?: string | null }) {
    // Through the console tap this line lands in the diagnostics ring too.
    console.error('[panda/crash] uncaught render error', error, info.componentStack ?? '');
    this.setState({ componentStack: info.componentStack ?? null });
  }

  render() {
    if (!this.state.error) return this.props.children;
    return <CrashFallback error={this.state.error} componentStack={this.state.componentStack} />;
  }
}

type CopyState = 'idle' | 'ok' | 'fail';

/** Shared copy verdict logic for both crash and settings paths: on failure
 * the report is dumped to the console so it is still recoverable by hand. */
export async function copyDiagnosticsReport(
  error?: unknown,
  componentStack?: string | null,
): Promise<CopyState> {
  const report = buildDiagnostics({ error, componentStack });
  if (await copyText(report)) return 'ok';
  console.error('[panda/diag] clipboard write failed, diagnostics follow\n' + report);
  return 'fail';
}

const shell: React.CSSProperties = {
  position: 'fixed',
  inset: 0,
  overflow: 'auto',
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 16,
  padding: 24,
  background: '#14161b',
  color: '#e6e6ea',
  fontFamily: 'system-ui, sans-serif',
  textAlign: 'center',
};

function CrashFallback({ error, componentStack }: { error: Error; componentStack: string | null }) {
  const [copy, setCopy] = useState<CopyState>('idle');
  return (
    <div style={shell} role="alert">
      <h1 style={{ fontSize: 20, margin: 0 }}>🐼 {t('diag.crashTitle')}</h1>
      <p style={{ margin: 0, maxWidth: 480 }}>{t('diag.crashDesc')}</p>
      <pre
        style={{
          margin: 0,
          maxWidth: 640,
          maxHeight: 160,
          overflow: 'auto',
          padding: '8px 12px',
          background: '#0d0e12',
          borderRadius: 8,
          fontSize: 12,
          textAlign: 'left',
          whiteSpace: 'pre-wrap',
        }}
      >
        {error.message}
      </pre>
      <div style={{ display: 'flex', gap: 8 }}>
        <button
          type="button"
          onClick={() => void copyDiagnosticsReport(error, componentStack).then(setCopy)}
          style={{ padding: '8px 16px', borderRadius: 8, border: '1px solid #4a4d57', background: '#262932', color: 'inherit', cursor: 'pointer' }}
        >
          {copy === 'ok' ? `✓ ${t('diag.copied')}` : copy === 'fail' ? t('diag.copyFailed') : t('diag.copyDiagnostics')}
        </button>
        <button
          type="button"
          onClick={() => location.reload()}
          style={{ padding: '8px 16px', borderRadius: 8, border: '1px solid #4a4d57', background: 'transparent', color: 'inherit', cursor: 'pointer' }}
        >
          {t('diag.reload')}
        </button>
      </div>
    </div>
  );
}
