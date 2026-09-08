import { useEffect, useState } from 'react';
import { ArrowLeft, Menu } from 'lucide-react';
import { IconButton } from '@astryxdesign/core/IconButton';
import { Sidebar } from './components/Sidebar';
import { MessageStream } from './components/MessageStream';
import { EmptyState } from './components/EmptyState';
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
import { useForegroundLifecycle, useMainView, useSessionModes } from './projector/hooks';
import { navigate, useHashRoute } from './routes';
import { composerDraftKey, DEMO_DRAFT_KEY } from './composerDrafts';
import { SettingsPage, SETTINGS_SECTIONS, type SettingsSectionId } from './components/SettingsPage';
import { useReplaySession } from './useReplaySession';
import { useLiveSession } from './useLiveSession';
import { UserNoticeToasts } from './components/UserNoticeToasts';
import type { ForegroundSessionController } from './session-controller';
import './App.css';
import { useI18n } from './i18n/context';

/** Route-level shell: `#/` is the session screen, `#/settings` the settings
 * screen. MainScreen owns the shell (sidebar + header); the settings route
 * swaps only the main column's content (#111) so the app chrome — sidebar,
 * header, mobile drawer — never unmounts across routes. */
export default function App() {
  const route = useHashRoute();
  // Phase 2: the hash owns the session mode — `#/demo` (production-
  // reachable since #196; the first-run empty state is its in-UI entry)
  // switches the UI to the scripted replay and auto-plays it; every other
  // route renders live connections. Mode changes never touch connections
  // (issue #21): the replay is a display layer over the same store.
  useEffect(() => {
    usePanda.getState().setMode(route === 'demo' ? 'demo' : 'live');
  }, [route]);
  return <MainScreen />;
}

function MainScreen() {
  const route = useHashRoute();
  const onSettings = route === 'settings';
  const [mobileNavigationOpen, setMobileNavigationOpen] = useState(false);
  // Which settings section is showing (#117) — MainScreen-level so it
  // survives settings ⇄ main route flips (returning lands where you left).
  const [settingsSection, setSettingsSection] = useState<SettingsSectionId>('general');
  const mode = usePanda((s) => s.mode);
  const doc = useActiveDoc();
  const connection = useActiveConnection();
  const activeConnectionId = usePanda((s) => s.activeConnectionId);
  const activeSessionId = usePanda((s) => s.activeSessionId);
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
  // Which surface owns the content column (#200/#218) — projected, not
  // derived here: onboarding is pointer-decided so a retained document stays
  // readable after a clean disconnect.
  const view = useMainView();
  // The mode picker's view + write channel (protocol policy, not App's to derive).
  const sessionModes = useSessionModes(controller);
  const { t } = useI18n();
  // Foreground session identity (bug hunts #15/#17): swaps with the
  // foreground — different connection, or a different session on it. The
  // composer keys its draft store by it (a message composed for one agent is
  // never sent to another), and the message stream is REMOUNTED on it (key):
  // flat-item keys (`turn-1-0`…) are identical across sessions, so without
  // the remount one session's expanded cards and scroll-follow mode would
  // leak into the next. Keyed by the UI POINTER, not the connection's settled
  // anchor (#218): offline retained-document viewing diverges the two (the
  // anchor is null while the pointer moves between retained documents), and
  // an anchor-keyed key would collapse every offline view onto one bucket.
  const foregroundSessionKey = liveActive
    ? composerDraftKey(activeConnectionId ?? 'none', activeSessionId)
    : DEMO_DRAFT_KEY;

  const activeSession = liveActive
    ? sessions.find((entry) => entry.sessionId === activeSessionId)
    : undefined;
  // On the settings route the header carries the ACTIVE SECTION's title and
  // description (#140): the page-level header inside the column is gone, so
  // the top bar is where "which settings page am I on" answers itself. The
  // back arrow stays — it is one of the settings route's three exits.
  const settingsSectionMeta = SETTINGS_SECTIONS.find((entry) => entry.id === settingsSection);
  const headerTitle = onSettings
    ? t(settingsSectionMeta?.titleKey ?? 'settings.title')
    : !liveActive
      ? t('app.demoHeaderTitle')
      : (activeSession?.title ?? connection.agentName ?? t('app.liveSessionTitle'));
  const headerMeta = onSettings
    ? (settingsSectionMeta ? t(settingsSectionMeta.descKey) : null)
    : liveActive
      ? (connection.url ?? 'acp')
      : 'acp://demo-agent · demo replay';

  return (
    <div className="app-shell">
      <UserNoticeToasts />
      {mobileNavigationOpen && (
        <button
          type="button"
          className="app-nav-overlay"
          aria-label={t('app.closeNav')}
          onClick={() => setMobileNavigationOpen(false)}
        />
      )}
      <Sidebar
        mode={mode}
        live={live}
        mobileOpen={mobileNavigationOpen}
        onMobileClose={() => setMobileNavigationOpen(false)}
        settingsSection={settingsSection}
        onSelectSettingsSection={setSettingsSection}
      />
      <main className="app-main">
        <header className="app-header">
          <div className="app-header-lead">
            <button
              type="button"
              className="app-nav-toggle"
              aria-label={t('app.openNav')}
              onClick={() => setMobileNavigationOpen(true)}
            >
              <Menu size={18} />
            </button>
            {onSettings && (
              <IconButton
                variant="ghost"
                icon={<ArrowLeft size={16} />}
                label={t('app.back')}
                tooltip={t('app.backTooltip')}
                clickAction={() => navigate('main')}
              />
            )}
            <span className="truncate app-header-title">{headerTitle}</span>
          </div>
          {headerMeta !== null && (
            <span className={`app-header-meta ${onSettings ? 'app-header-meta--desc' : ''}`}>
              {headerMeta}
            </span>
          )}
        </header>
        {onSettings ? (
          <SettingsPage section={settingsSection} />
        ) : (
          <>
            {doc.plan && doc.plan.length > 0 && <PlanDock entries={doc.plan} />}
            {/* The auth gate owns the main view for a login challenge AND for
                the login flow's elicitation while the link stays up (bug
                hunt #8): mid-connection re-login keeps the old session, and
                its request-scoped OAuth card must be answerable. Without a
                challenge the standing offer (#90) feeds the method list. */}
            {view === 'auth-gate' ? (
              <AuthGate
                methods={connection.authMethods ?? connection.availableAuthMethods}
                message={connection.error}
                elicitation={connection.authElicitation}
                onAuthenticate={live.authenticate}
                onResolveElicitation={controller.resolveElicitation}
                onOpenElicitationUrl={controller.openElicitationUrl}
              />
            ) : view === 'onboarding' ? (
              // First-run onboarding (#200): no foreground session document
              // to show → the three ways in (demo / connect your own agent /
              // existing agents). A connection still opening its first
              // session (connecting, session/new in flight) passes through
              // here briefly — the status bar narrates that phase. A clean
              // disconnect does NOT land here (#218): its retained document
              // stays readable, so the pointer is still set.
              <EmptyState />
            ) : (
              <MessageStream key={foregroundSessionKey} onResolvePermission={controller.resolvePermission} onResolveElicitation={controller.resolveElicitation} onOpenElicitationUrl={controller.openElicitationUrl} />
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
              inputLocked={lifecycle.composerInputLocked}
              hint={lifecycle.hint}
              // Undefined until the live link is up and capabilities are
              // negotiated (#214): no agent, no capability claims either way.
              canAttachImages={
                !liveActive ||
                (connection.status === 'connected' ? effectiveCaps.image.available : undefined)
              }
              canStop={lifecycle.canStop}
              onStop={live.cancel}
              modes={sessionModes.modes}
              onSetMode={sessionModes.onSetMode}
              commands={doc.availableCommands}
              configOptions={doc.configOptions}
              onSetConfigOption={controller.setConfigOption}
              sessionKey={foregroundSessionKey}
            />
          </>
        )}
      </main>
    </div>
  );
}
