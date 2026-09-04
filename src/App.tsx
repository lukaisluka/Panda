import { useState } from 'react';
import { Menu } from 'lucide-react';
import { Sidebar } from './components/Sidebar';
import { MessageStream } from './components/MessageStream';
import { StatusBar } from './components/StatusBar';
import { Composer } from './components/Composer';
import { PlanDock } from './components/PlanDock';
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
import './App.css';

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
  const resolveElicitation = liveActive ? live.resolveElicitation : demo.resolveElicitation;
  const setMode = liveActive ? live.setMode : demo.setMode;

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
    <div className="app-shell">
      {mobileNavigationOpen && (
        <button
          type="button"
          className="app-nav-overlay"
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
      <main className="app-main">
        <header className="app-header">
          <div className="app-header-lead">
            <button
              type="button"
              className="app-nav-toggle"
              aria-label="打开导航"
              onClick={() => setMobileNavigationOpen(true)}
            >
              <Menu size={18} />
            </button>
            <span className="truncate app-header-title">{headerTitle}</span>
          </div>
          <span className="app-header-meta">{headerMeta}</span>
        </header>
        {doc.plan && doc.plan.length > 0 && <PlanDock entries={doc.plan} />}
        <MessageStream onResolvePermission={resolvePermission} onResolveElicitation={resolveElicitation} />
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
          modes={doc.modes}
          onSetMode={setMode}
        />
      </main>
    </div>
  );
}
