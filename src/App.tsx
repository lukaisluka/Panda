import { useState } from 'react';
import { Menu } from 'lucide-react';
import { Sidebar } from './components/Sidebar';
import { MessageStream } from './components/MessageStream';
import { StatusBar } from './components/StatusBar';
import { Composer } from './components/Composer';
import {
  useActiveConnection,
  useActiveDoc,
  useActiveEffectiveCapabilities,
  useActiveSessions,
  useActiveSwitching,
  usePanda,
} from './store';
import { useStatusHint } from './projector/hooks';
import { useReplaySession } from './useReplaySession';
import { useLiveSession } from './useLiveSession';

export default function App() {
  const [mobileNavigationOpen, setMobileNavigationOpen] = useState(false);
  const mode = usePanda((s) => s.mode);
  const doc = useActiveDoc();
  const connection = useActiveConnection();
  const sessions = useActiveSessions();
  // The foreground connection's effective capabilities (issue #22) — the
  // single decision point, never the raw agent declaration.
  const effectiveCaps = useActiveEffectiveCapabilities();
  const switching = useActiveSwitching();

  const demo = useReplaySession();
  const live = useLiveSession();
  const liveActive = mode === 'live';
  const connected = connection.status === 'connected';

  const send = liveActive ? live.send : demo.send;
  const resolvePermission = liveActive ? live.resolvePermission : demo.resolvePermission;

  // A session switch in flight is busy too: the composer must not send into a
  // session that has not settled yet, and the sidebar locks other switches.
  const busy = doc.status !== 'idle' || switching !== null;
  const composerDisabled = liveActive ? !connected || busy : busy;
  const hint = useStatusHint();

  const activeSession = liveActive
    ? sessions.find((entry) => entry.sessionId === connection.sessionId)
    : undefined;
  const headerTitle = !liveActive
    ? '重构 auth 校验'
    : (activeSession?.title ?? connection.agentName ?? 'Live 会话');
  const headerMeta = liveActive ? (connection.url ?? 'acp') : 'acp://claude-code · demo replay';

  return (
    <div className="flex h-screen overflow-hidden">
      {mobileNavigationOpen && (
        <button
          type="button"
          className="fixed inset-0 z-20 bg-bg/70 md:hidden"
          aria-label="关闭导航"
          onClick={() => setMobileNavigationOpen(false)}
        />
      )}
      <Sidebar
        mode={mode}
        live={live}
        onReplayDemo={demo.replayDemo}
        mobileOpen={mobileNavigationOpen}
        onMobileClose={() => setMobileNavigationOpen(false)}
      />
      <main className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-14 shrink-0 items-center justify-between gap-3 border-b border-border px-3 sm:px-6">
          <div className="flex min-w-0 items-center gap-2">
            <button
              type="button"
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-muted transition-colors hover:bg-raised hover:text-fg md:hidden"
              aria-label="打开导航"
              onClick={() => setMobileNavigationOpen(true)}
            >
              <Menu size={18} />
            </button>
            <span className="truncate text-[13px] font-medium">{headerTitle}</span>
          </div>
          <span className="hidden shrink-0 font-mono text-[11px] text-faint md:block">{headerMeta}</span>
        </header>
        <MessageStream onResolvePermission={resolvePermission} />
        <StatusBar
          doc={doc}
          connection={connection}
          mode={mode}
          switching={switching !== null}
        />
        <Composer
          onSend={send}
          disabled={composerDisabled}
          hint={hint}
          canAttachImages={!liveActive || effectiveCaps.image.available}
          canStop={liveActive && connected && doc.status === 'running'}
          onStop={live.cancel}
        />
      </main>
    </div>
  );
}
