import { useEffect, useState } from 'react';
import { Menu } from 'lucide-react';
import { Sidebar } from './components/Sidebar';
import { MessageStream } from './components/MessageStream';
import { AuthGate } from './components/AuthGate';
import { StatusBar } from './components/StatusBar';
import { Composer } from './components/Composer';
import { PlanDock } from './components/PlanDock';
import {
  useActiveConnection,
  useActiveDoc,
  useActiveEffectiveCapabilities,
  useActiveSessions,
  usePanda,
} from './store';
import { useForegroundLifecycle, useSessionModes } from './projector/hooks';
import { useHashRoute } from './routes';
import { SettingsPage } from './components/SettingsPage';
import { useReplaySession } from './useReplaySession';
import { useLiveSession } from './useLiveSession';
import type { ForegroundSessionController } from './session-controller';
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

  const demo = useReplaySession();
  const live = useLiveSession();
  const liveActive = mode === 'live';
  // One pick per render (#51): both drivers implement the foreground
  // session controller; members are handed down from here individually.
  const controller: ForegroundSessionController = liveActive ? live : demo;
  // Status meaning comes from the lifecycle projection (#53) — busy,
  // composer gating, hint and the auth-gate branch are consumed, not derived.
  const lifecycle = useForegroundLifecycle();
  // The mode picker's view + write channel (protocol policy, not App's to derive).
  const sessionModes = useSessionModes(controller);

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
        {liveActive && lifecycle.phase === 'auth-required' ? (
          <AuthGate
            methods={connection.authMethods ?? []}
            message={connection.error}
            elicitation={connection.authElicitation}
            onAuthenticate={live.authenticate}
            onResolveElicitation={controller.resolveElicitation}
            onOpenElicitationUrl={controller.openElicitationUrl}
          />
        ) : (
          <MessageStream onResolvePermission={controller.resolvePermission} onResolveElicitation={controller.resolveElicitation} onOpenElicitationUrl={controller.openElicitationUrl} />
        )}
        <StatusBar
          doc={doc}
          connection={connection}
          mode={mode}
          onAuthenticate={live.authenticate}
        />
        <Composer
          onSend={controller.send}
          disabled={lifecycle.composerDisabled}
          hint={lifecycle.hint}
          canAttachImages={!liveActive || effectiveCaps.image.available}
          canStop={lifecycle.canStop}
          onStop={live.cancel}
          modes={sessionModes.modes}
          onSetMode={sessionModes.onSetMode}
          commands={doc.availableCommands}
          configOptions={doc.configOptions}
          onSetConfigOption={controller.setConfigOption}
        />
      </main>
    </div>
  );
}
