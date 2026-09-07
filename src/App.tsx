import { useEffect, useState } from 'react';
import { ArrowLeft, Menu } from 'lucide-react';
import { IconButton } from '@astryxdesign/core/IconButton';
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
import { navigate, useHashRoute } from './routes';
import { SettingsPage, SETTINGS_SECTIONS, type SettingsSectionId } from './components/SettingsPage';
import { useReplaySession } from './useReplaySession';
import { useLiveSession } from './useLiveSession';
import type { ForegroundSessionController } from './session-controller';
import './App.css';
import { useI18n } from './i18n/context';

/** Route-level shell: `#/` is the session screen, `#/settings` the settings
 * screen. MainScreen owns the shell (sidebar + header); the settings route
 * swaps only the main column's content (#111) so the app chrome — sidebar,
 * header, mobile drawer — never unmounts across routes. */
export default function App() {
  const route = useHashRoute();
  // Phase 2: the hash owns the session mode — `#/demo` (dev builds only)
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
  const { t } = useI18n();

  const activeSession = liveActive
    ? sessions.find((entry) => entry.sessionId === connection.sessionId)
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
      : 'acp://claude-code · demo replay';

  return (
    <div className="app-shell">
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
          </>
        )}
      </main>
    </div>
  );
}
