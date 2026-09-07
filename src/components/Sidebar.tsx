import { useEffect, useState } from 'react';
import { IconButton } from '@astryxdesign/core/IconButton';
import { useImperativeAlertDialog } from '@astryxdesign/core/AlertDialog';
import { Dialog, DialogHeader } from '@astryxdesign/core/Dialog';
import { LayoutContent } from '@astryxdesign/core/Layout';
import { TextInput } from '@astryxdesign/core/TextInput';
import pandaBadge from '../assets/brand/panda-badge.png';
import { Button } from '@astryxdesign/core/Button';
import { Spinner } from '@astryxdesign/core/Spinner';
import { StatusDot } from '@astryxdesign/core/StatusDot';
import {
  Bot,
  BookmarkPlus,
  MessagesSquare,
  PlugZap,
  Plus,
  Settings,
  Trash2,
  Unplug,
  X,
} from 'lucide-react';
import {
  orderedSessions,
  useConnectionOrder,
  usePanda,
  type SessionMode,
} from '../store';
import { useConnectionLifecycle } from '../projector/hooks';
import { isLinkUp, type AttentionReason, type ConnectionPhase } from '../projector/connectionLifecycle';
import { isDirectConnectionId, reconcileProfileSlots } from '../liveConnections';
import { effectiveCapability, PANDA_HOST_CAPABILITIES } from '../capabilities';
import { useI18n } from '../i18n/context';
import { formatRelativeTime } from '../relativeTime';
import type { AgentProfile } from '../profiles';
import { loadProfiles, newProfileId, profileEndpoint, saveProfiles, subscribeProfiles } from '../profiles';
import { navigate, useHashRoute } from '../routes';
import { notifyUser } from '../userNotice';
import { cwdToWorkspace, workspaceLabel } from '../workspace';
import type { LiveSessionFacade } from '../useLiveSession';
import { NewSessionDialog } from './NewSessionDialog';
import { SettingsSideNav, type SettingsSectionId } from './SettingsPage';
import './Sidebar.css';

/**
 * Session-centered sidebar (IA refactor phase 3): every Agent 配置 renders as
 * a section — online ones with live sessions, offline ones as seeded
 * disconnected slots carrying the endpoint's remembered sessions (历史可见,
 * hover = 连接). Connection management lives in the settings page; the only
 * sidebar entry points are 新建会话 (picker dialog) and 添加 agent (settings).
 * 分组与会话行都按最后活动时间排 (#175), 切换不移动任何位置; each group row
 * subscribes narrowly to its own slot so a streaming connection only
 * re-renders its own group.
 */
export function Sidebar({ mode, live, mobileOpen, onMobileClose, settingsSection, onSelectSettingsSection }: {
  mode: SessionMode;
  live: LiveSessionFacade;
  mobileOpen: boolean;
  onMobileClose(): void;
  /** Which settings section is showing (#117) — lifted state so it survives
   * route flips; the settings-route nav and the add-agent shortcut both
   * write through onSelectSettingsSection. */
  settingsSection: SettingsSectionId;
  onSelectSettingsSection(id: SettingsSectionId): void;
}) {
  const { t } = useI18n();
  // Route-aware since #113: settings shares the shell, so the sidebar must
  // reflect (gear highlight + toggle-back) and respect it (any session action
  // below returns to the session view instead of changing nothing).
  const onSettings = useHashRoute() === 'settings';
  const exitSettings = () => {
    if (onSettings) navigate('main');
  };
  const [newSessionOpen, setNewSessionOpen] = useState(false);
  const orderedIds = useConnectionOrder();
  const [profiles, setProfiles] = useState<AgentProfile[]>(() => loadProfiles());
  // The settings page also writes profiles (CRUD) — storage is the single
  // source, the subscription keeps this copy from diverging.
  useEffect(() => subscribeProfiles(setProfiles), []);

  // Offline agent sections: the store's connection topology follows the
  // profile list (seed + prune) — the policy lives in liveConnections (#61).
  useEffect(() => {
    reconcileProfileSlots(profiles);
  }, [profiles]);

  const liveMode = mode === 'live';
  const activeConnectionId = usePanda((s) => s.activeConnectionId);
  const footerAgent = usePanda((s) =>
    s.mode === 'live'
      ? s.connections[s.activeConnectionId ?? '']?.connection.agentName ?? null
      : null,
  );

  return (
    <aside className={`sidebar ${mobileOpen ? 'sidebar--open' : ''}`}>
      <div className="sidebar-brand">
        <span className="sidebar-logo">
          <img src={pandaBadge} alt="" />
        </span>
        Panda
        <span className="sidebar-brand-actions">
          <span className="sidebar-close">
            <IconButton
              variant="ghost"
              size="sm"
              icon={<X size={16} />}
              label={t('app.closeNav')}
              clickAction={onMobileClose}
            />
          </span>
        </span>
      </div>

      {onSettings ? (
        <SettingsSideNav
          activeId={settingsSection}
          onSelect={onSelectSettingsSection}
          onNavigate={onMobileClose}
          onBack={exitSettings}
        />
      ) : (
        <>
          <div className="sidebar-sessions-head">
            <span className="sidebar-label">
              Sessions
            </span>
            <IconButton
              variant="ghost"
              size="sm"
              icon={<Plus size={13} />}
              label={t('side.newSession')}
              tooltip={t('side.newSessionTooltip')}
              clickAction={() => setNewSessionOpen(true)}
            />
          </div>
          <div className="sidebar-sessions">
            {!liveMode && (
              <div className="sidebar-demo-chip">
                <MessagesSquare size={13} className="sidebar-icon-faint" />
                <span className="truncate">{t('app.demoHeaderTitle')}</span>
              </div>
            )}
            <div className="sidebar-group-list">
              {orderedIds.map((connectionId) => (
                <ConnectionGroupRow
                  key={connectionId}
                  connectionId={connectionId}
                  profile={profiles.find((entry) => entry.id === connectionId) ?? null}
                  isActiveConnection={connectionId === activeConnectionId}
                  live={live}
                  onMobileClose={onMobileClose}
                  exitSettings={exitSettings}
                />
              ))}
              {liveMode && orderedIds.length === 0 && (
                <div className="sidebar-empty">{t('side.noAgents')}</div>
              )}
            </div>
          </div>
        </>
      )}

      <div className="sidebar-footer-block">
        {!onSettings && (
          <button
            type="button"
            className="sidebar-add-agent"
            onClick={() => {
              // Lands directly on the Agent profiles section (#117) — that
              // is the page this shortcut exists for.
              onSelectSettingsSection('agents');
              navigate('settings');
              onMobileClose();
            }}
          >
            <Plus size={13} />
            {t('side.addAgent')}
          </button>
        )}
        <div className="sidebar-footer">
          <Bot size={14} className="sidebar-footer-icon" />
          <span className="truncate">
            {liveMode
              ? footerAgent
                ? `${footerAgent} · live`
                : 'acp · live'
              : 'claude-code · replay'}
          </span>
          <IconButton
            variant="ghost"
            size="sm"
            icon={<Settings size={14} />}
            className={onSettings ? 'sidebar-settings-btn--active' : undefined}
            label={onSettings ? t('side.backToSession') : t('side.settings')}
            tooltip={onSettings ? t('side.backToSessionTooltip') : t('side.settingsTooltip')}
            clickAction={() => {
              navigate(onSettings ? 'main' : 'settings');
              onMobileClose();
            }}
          />
        </div>
      </div>

      {newSessionOpen && (
        <NewSessionDialog
          isOpen
          onOpenChange={setNewSessionOpen}
          onStarted={() => {
            exitSettings();
            onMobileClose();
          }}
          live={live}
          profiles={profiles}
        />
      )}
    </aside>
  );
}

/**
 * Saves a 临时直连's endpoint as an Agent 配置 (phase 4): the running
 * connection is deliberately NOT migrated — the 配置's seeded slot appears
 * ready for the next session, and the temporary one ends with its disconnect
 * as always. The name arrives from the save-as dialog (#160 — the former
 * window.prompt); returns false when storage rejects the write.
 */
function saveDirectAsProfile(url: string, cwd: string | null, name: string): boolean {
  const trimmedUrl = url.trim();
  const trimmedName = name.trim();
  if (!trimmedUrl || !trimmedName) return false;
  const workspace = cwdToWorkspace(cwd ?? '/');
  return saveProfiles([
    ...loadProfiles(),
    { id: newProfileId(), name: trimmedName, kind: 'websocket', url: trimmedUrl, workspace, mcpServerIds: [] },
  ]);
}

/** The save-as dialog's prefilled name: the endpoint's host:port. */
function endpointDefaultName(url: string): string {
  const trimmed = url.trim();
  try {
    return new URL(trimmed).host;
  } catch {
    return trimmed;
  }
}

/** Astryx StatusDot per lifecycle phase; 运行中 overlays a pulse. Phase →
 * pixels is mechanical lookup — precedence lives in the projection (#53). */
function SlotStatusDot({ phase, running }: { phase: ConnectionPhase; running: boolean }) {
  const { t } = useI18n();
  if (phase === 'connecting') {
    return <Spinner size="sm" />;
  }
  if (phase === 'error') {
    return <StatusDot variant="error" label={t('conn.error')} />;
  }
  if (phase === 'auth-required') {
    return <StatusDot variant="warning" label={t('conn.authRequired')} />;
  }
  if (isLinkUp(phase)) {
    return running
      ? <StatusDot variant="accent" isPulsing label={t('conn.running')} />
      : <StatusDot variant="success" label={t('conn.connected')} />;
  }
  return <StatusDot variant="neutral" label={t('conn.disconnected')} />;
}

/** 需要关注 reasons in user words — the projection carries the reasons,
 * only their phrasing lives here. */
const ATTENTION_LABELS: Record<AttentionReason, 'side.attention.unreadCompletion' | 'side.attention.pendingPermission' | 'side.attention.connectionError' | 'side.attention.authRequired'> = {
  'unread-completion': 'side.attention.unreadCompletion',
  'pending-permission': 'side.attention.pendingPermission',
  'connection-error': 'side.attention.connectionError',
  'auth-required': 'side.attention.authRequired',
};

/** One agent's section: header (status, indicators, hover actions), an
 * inline error recovery block when the connection failed, and the session
 * list (live or remembered). */
function ConnectionGroupRow({ connectionId, profile, isActiveConnection, live, onMobileClose, exitSettings }: {
  connectionId: string;
  profile: AgentProfile | null;
  isActiveConnection: boolean;
  live: LiveSessionFacade;
  onMobileClose(): void;
  exitSettings(): void;
}) {
  // Whole-slot subscription for the display facts; status meaning comes
  // from the lifecycle projection (#53). Only THIS group re-renders on stream.
  const slot = usePanda((s) => s.connections[connectionId]);
  const lifecycle = useConnectionLifecycle(connectionId);
  const activeSessionId = usePanda((s) => s.activeSessionId);
  const { t } = useI18n();
  // #160: the remove-connection confirm and the save-as-配置 name prompt
  // used to be window.confirm/window.prompt — native browser chrome that
  // breaks the Astryx surface (and the desktop shell).
  const removeAlert = useImperativeAlertDialog();
  const [saveAs, setSaveAs] = useState<{ url: string; cwd: string | null } | null>(null);
  const [saveAsName, setSaveAsName] = useState('');
  if (!slot || !lifecycle) return null;

  const { phase } = lifecycle;
  const connected = isLinkUp(phase);
  const offline = phase === 'disconnected';
  // The trailing 需要关注 dot speaks for session-level reasons only
  // (unread completion, pending permission). connection-error and
  // auth-required already show at the row head (SlotStatusDot error/
  // warning) — a background errored slot otherwise reads as two red dots
  // saying one thing (#150).
  const sessionAttention = lifecycle.attention.filter(
    (reason) => reason !== 'connection-error' && reason !== 'auth-required',
  );
  const attention = sessionAttention.length > 0;
  const title = profile?.name ?? slot.connection.url ?? connectionId;
  const isForegroundSession = (sessionId: string) => isActiveConnection && sessionId === activeSessionId;
  // Resume needs a retained session; seeded slots have none.
  const canResume = phase === 'error' && slot.connection.sessionId !== null;

  // Pure recency (#175) — no foreground pin: switching must not move rows,
  // the current session is recognized by its highlight.
  const ordered = orderedSessions(slot.sessions);

  return (
    <div className={`sidebar-group ${isActiveConnection ? 'sidebar-group--active' : ''}`}>
      <div className="sidebar-row">
        <button
          type="button"
          onClick={() => {
            live.foreground(connectionId);
            exitSettings();
            onMobileClose();
          }}
          title={slot.connection.url ?? title}
          className={`sidebar-connection-btn ${
            isActiveConnection ? 'sidebar-connection-btn--active' : ''
          } ${connected ? '' : 'sidebar-connection-btn--offline'}`}
        >
          <SlotStatusDot phase={phase} running={lifecycle.running} />
          <span className="truncate sidebar-row-title">{title}</span>
          {isDirectConnectionId(connectionId) && <span className="sidebar-temp-badge">{t('side.temp')}</span>}
          {slot.connection.agentName && (
            <span className="truncate sidebar-row-sub">{slot.connection.agentName}</span>
          )}
          <span className="sidebar-row-end">
            {/* 需要关注 is a *background* connection indicator (CONTEXT.md):
                the foreground slot's issues are in plain sight (permission
                card, the error block below). */}
            {attention && !isActiveConnection && (
              <StatusDot
                variant="error"
                label={t('side.needsAttention')}
                tooltip={t('side.attentionTooltip', { reasons: sessionAttention.map((reason) => t(ATTENTION_LABELS[reason])).join(' / ') })}
              />
            )}
          </span>
        </button>
        <div className="sidebar-hover-actions">
          {isDirectConnectionId(connectionId) && slot.connection.url && (
            <IconButton
              variant="ghost"
              size="sm"
              icon={<BookmarkPlus size={12} />}
              label={t('side.saveProfile')}
              tooltip={t('side.saveProfileTooltip')}
              clickAction={() => {
                setSaveAsName(endpointDefaultName(slot.connection.url!));
                setSaveAs({ url: slot.connection.url!, cwd: slot.connection.cwd });
              }}
            />
          )}
          {(connected || phase === 'connecting') && (
            <IconButton
              variant="ghost"
              size="sm"
              icon={<Unplug size={12} />}
              label={t('side.disconnect')}
              tooltip={isDirectConnectionId(connectionId) ? t('side.disconnectTemp') : t('side.disconnectSlot')}
              clickAction={() => live.disconnect(connectionId)}
            />
          )}
          {offline && profile && (
            <IconButton
              variant="ghost"
              size="sm"
              icon={<PlugZap size={12} />}
              label={t('side.connectProfile')}
              tooltip={t('side.connectProfileTooltip', { name: profile.name, url: profileEndpoint(profile) })}
              clickAction={() => live.connectProfile(profile)}
            />
          )}
          {(phase === 'error' || !offline) && (
            <IconButton
              variant="ghost"
              size="sm"
              icon={<Trash2 size={12} />}
              label={t('side.removeConnection')}
              tooltip={t('side.removeConnectionTooltip')}
              clickAction={() => {
                removeAlert.show({
                  title: t('side.removeConnection'),
                  description: t('side.removeConfirm', { title }),
                  actionLabel: t('side.removeConnection'),
                  actionVariant: 'destructive',
                  onAction: () => {
                    live.remove(connectionId);
                    removeAlert.hide();
                  },
                });
              }}
            />
          )}
        </div>
      </div>
      {phase === 'error' && lifecycle.error && (
        <div className="sidebar-conn-error">
          <p className="sidebar-conn-error-text" title={lifecycle.error}>
            {lifecycle.error}
          </p>
          <div className="sidebar-conn-error-actions">
            {canResume && (
              <Button
                variant="primary"
                size="sm"
                label={t('side.resume')}
                tooltip={t('side.resumeTooltip')}
                clickAction={() => live.reconnectForeground({ resume: true })}
              />
            )}
            <Button
              variant={canResume ? 'secondary' : 'primary'}
              size="sm"
              label={t('side.reconnect')}
              clickAction={() => live.reconnectForeground()}
            />
          </div>
        </div>
      )}
      {ordered.length > 0 && (
        <div className="sidebar-session-list">
          {ordered.map((entry) => {
            const foregroundSession = isForegroundSession(entry.sessionId);
            // Offline slots keep retained documents clickable (查看历史);
            // sessions never loaded locally stay inert until connected.
            const hasDoc = slot.docs[entry.sessionId] !== undefined;
            // Capability gating goes through the effective-capability
            // decision point (issue #22), never the raw declaration.
            const loadSession = effectiveCapability(
              'loadSession',
              slot.capabilities,
              PANDA_HOST_CAPABILITIES,
            );
            const canDelete = effectiveCapability('delete', slot.capabilities, PANDA_HOST_CAPABILITIES);
            const canSwitch = connected ? loadSession.available && !lifecycle.busy : hasDoc;
            const label = entry.title ?? `${workspaceLabel(entry.cwd)} · ${entry.sessionId.slice(-6)}`;
            const updated = formatRelativeTime(entry.updatedAt, t);
            return (
              <div key={entry.sessionId} className="sidebar-session">
                <button
                  disabled={foregroundSession || !canSwitch}
                  onClick={() => {
                    live.openSession(connectionId, entry.sessionId, entry.cwd);
                    exitSettings();
                    onMobileClose();
                  }}
                  title={
                    foregroundSession
                      ? undefined
                      : !canSwitch && connected && lifecycle.busy
                        ? t('side.disabled.busy')
                        : !connected && !hasDoc
                          ? t('side.disabled.offline')
                          : connected && !loadSession.available
                            ? loadSession.reason === 'unavailable-on-host'
                              ? t('side.disabled.host')
                              : t('side.disabled.agent')
                            : entry.cwd
                  }
                  className={`sidebar-session-btn ${
                    foregroundSession
                      ? 'sidebar-session-btn--foreground'
                      : canSwitch
                        ? ''
                        : 'sidebar-session-btn--disabled'
                  }`}
                >
                  <MessagesSquare size={12} className="sidebar-icon-faint" />
                  <span className="truncate">{label}</span>
                  {updated !== null && (
                    <span
                      className="sidebar-session-time"
                      title={entry.updatedAt ? new Date(entry.updatedAt).toLocaleString() : undefined}
                    >
                      {updated}
                    </span>
                  )}
                </button>
                {canDelete.available && connected && !foregroundSession && !lifecycle.busy && (
                  <span className="sidebar-session-delete">
                    <IconButton
                      variant="ghost"
                      size="sm"
                      icon={<Trash2 size={12} />}
                      label={t('side.deleteSession')}
                      tooltip={t('side.deleteSessionTooltip')}
                      clickAction={() => live.deleteSession(connectionId, entry.sessionId)}
                    />
                  </span>
                )}
              </div>
            );
          })}
        </div>
      )}
      {removeAlert.element}
      <Dialog
        isOpen={saveAs !== null}
        onOpenChange={(open) => {
          if (!open) setSaveAs(null);
        }}
        purpose="form"
        width={380}
      >
        <DialogHeader
          title={t('side.saveProfile')}
          subtitle={saveAs?.url}
          onOpenChange={() => setSaveAs(null)}
        />
        <LayoutContent>
          <TextInput
            label={t('side.profileNamePrompt')}
            value={saveAsName}
            onChange={setSaveAsName}
          />
          <div className="sidebar-save-as-actions">
            <Button
              variant="secondary"
              size="sm"
              label={t('settings.cancel')}
              clickAction={() => setSaveAs(null)}
            />
            <Button
              variant="primary"
              size="sm"
              label={t('settings.save')}
              isDisabled={saveAsName.trim().length === 0}
              clickAction={() => {
                if (saveAs && !saveDirectAsProfile(saveAs.url, saveAs.cwd, saveAsName)) {
                  notifyUser('error', t('settings.notice.saveFailed'));
                }
                setSaveAs(null);
              }}
            />
          </div>
        </LayoutContent>
      </Dialog>
    </div>
  );
}
