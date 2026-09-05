import { useEffect, useState } from 'react';
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
import { modeStateFromConfigOptions } from './protocol/modes';
import { useHashRoute } from './routes';
import { SettingsPage } from './components/SettingsPage';
import { useReplaySession } from './useReplaySession';
import { useLiveSession } from './useLiveSession';
import './App.css';

/** Route-level shell (IA refactor phase 1): `#/` is the session screen,
 * `#/settings` the settings screen. Everything session-related (both live
 * and demo replay) lives in MainScreen so the settings route renders none
 * of its state. */
export default function App() {
  const route = useHashRoute();
  // Phase 2: the hash owns the session mode — `#/demo` (dev builds only)
  // switches the UI to the scripted replay and auto-plays it; every other
  // route renders live connections. Mode changes never touch connections
  // (issue #21): the replay is a display layer over the same store.
  useEffect(() => {
    usePanda.getState().setMode(route === 'demo' ? 'demo' : 'live');
  }, [route]);
  if (route === 'settings') return <SettingsPage />;
  return <MainScreen />;
}

function MainScreen() {
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
  const openElicitationUrl = liveActive ? live.openElicitationUrl : demo.openElicitationUrl;
  const setMode = liveActive ? live.setMode : demo.setMode;
  const setConfigOption = liveActive ? live.setConfigOption : demo.setConfigOption;
  // protocol/v1 session-config-options: a client with config options SHOULD
  // use them exclusively and ignore `modes` — when the agent models its mode
  // selector as a config option, the picker derives from it and writes go
  // through set_config_option (one full-list response refreshes both views).
  const derivedModes = modeStateFromConfigOptions(doc.configOptions);

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
        <MessageStream onResolvePermission={resolvePermission} onResolveElicitation={resolveElicitation} onOpenElicitationUrl={openElicitationUrl} />
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
          modes={derivedModes ?? doc.modes}
          onSetMode={derivedModes ? (modeId: string) => setConfigOption('mode', modeId) : setMode}
          commands={doc.availableCommands}
          configOptions={doc.configOptions}
          onSetConfigOption={setConfigOption}
        />
      </main>
    </div>
  );
}
