import { useEffect, useState } from 'react';
import { IconButton } from '@astryxdesign/core/IconButton';
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
  useConnectionOrder,
  usePanda,
  type SessionMode,
} from '../store';
import { useConnectionLifecycle } from '../projector/hooks';
import { isLinkUp, type AttentionReason, type ConnectionPhase } from '../projector/connectionLifecycle';
import { isDirectConnectionId, reconcileProfileSlots } from '../liveConnections';
import { effectiveCapability, PANDA_HOST_CAPABILITIES } from '../capabilities';
import { useI18n } from '../i18n/context';
import { t } from '../i18n';
import type { AgentProfile } from '../profiles';
import { loadProfiles, newProfileId, saveProfiles, subscribeProfiles } from '../profiles';
import { navigate } from '../routes';
import { cwdToWorkspace, workspaceLabel } from '../workspace';
import type { LiveSessionFacade } from '../useLiveSession';
import { NewSessionDialog } from './NewSessionDialog';
import './Sidebar.css';

/**
 * Session-centered sidebar (IA refactor phase 3): every Agent 配置 renders as
 * a section — online ones with live sessions, offline ones as seeded
 * disconnected slots carrying the endpoint's remembered sessions (历史可见,
 * hover = 连接). Connection management lives in the settings page; the only
 * sidebar entry points are 新建会话 (picker dialog) and 添加 agent (settings).
 * 前台连接置顶, 其余按最近活动; each group row subscribes narrowly to its
 * own slot so a streaming connection only re-renders its own group.
 */
export function Sidebar({ mode, live, mobileOpen, onMobileClose }: {
  mode: SessionMode;
  live: LiveSessionFacade;
  mobileOpen: boolean;
  onMobileClose(): void;
}) {
  const { t } = useI18n();
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
        <span className="sidebar-logo">🐼</span>
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
            />
          ))}
          {liveMode && orderedIds.length === 0 && (
            <div className="sidebar-empty">{t('side.noAgents')}</div>
          )}
        </div>
      </div>

      <div className="sidebar-footer-block">
        <button
          type="button"
          className="sidebar-add-agent"
          onClick={() => {
            navigate('settings');
            onMobileClose();
          }}
        >
          <Plus size={13} />
          {t('side.addAgent')}
        </button>
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
            label={t('side.settings')}
            tooltip={t('side.settingsTooltip')}
            clickAction={() => {
              navigate('settings');
              onMobileClose();
            }}
          />
        </div>
      </div>

      {newSessionOpen && (
        <NewSessionDialog
          isOpen
          onOpenChange={setNewSessionOpen}
          onStarted={onMobileClose}
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
 * as always. Default name is the endpoint's host:port.
 */
function saveDirectAsProfile(url: string, cwd: string | null): void {
  const trimmedUrl = url.trim();
  if (!trimmedUrl) return;
  const workspace = cwdToWorkspace(cwd ?? '/');
  const defaultName = (() => {
    try {
      return new URL(trimmedUrl).host;
    } catch {
      return trimmedUrl;
    }
  })();
  const name = window.prompt(t('side.profileNamePrompt'), defaultName)?.trim();
  if (!name) return; // cancelled or left blank
  saveProfiles([...loadProfiles(), { id: newProfileId(), name, url: trimmedUrl, workspace }]);
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
function ConnectionGroupRow({ connectionId, profile, isActiveConnection, live, onMobileClose }: {
  connectionId: string;
  profile: AgentProfile | null;
  isActiveConnection: boolean;
  live: LiveSessionFacade;
  onMobileClose(): void;
}) {
  // Whole-slot subscription for the display facts; status meaning comes
  // from the lifecycle projection (#53). Only THIS group re-renders on stream.
  const slot = usePanda((s) => s.connections[connectionId]);
  const lifecycle = useConnectionLifecycle(connectionId);
  const activeSessionId = usePanda((s) => s.activeSessionId);
  const { t } = useI18n();
  if (!slot || !lifecycle) return null;

  const { phase } = lifecycle;
  const connected = isLinkUp(phase);
  const offline = phase === 'disconnected';
  const attention = lifecycle.attention.length > 0;
  const title = profile?.name ?? slot.connection.url ?? connectionId;
  const isForegroundSession = (sessionId: string) => isActiveConnection && sessionId === activeSessionId;
  // Resume needs a retained session; seeded slots have none.
  const canResume = phase === 'error' && slot.connection.sessionId !== null;

  const ordered = [...slot.sessions].sort((a, b) => {
    if (isForegroundSession(a.sessionId)) return -1;
    if (isForegroundSession(b.sessionId)) return 1;
    return (b.updatedAt ?? '').localeCompare(a.updatedAt ?? '');
  });

  return (
    <div className={`sidebar-group ${isActiveConnection ? 'sidebar-group--active' : ''}`}>
      <div className="sidebar-row">
        <button
          type="button"
          onClick={() => {
            live.foreground(connectionId);
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
                tooltip={t('side.attentionTooltip', { reasons: lifecycle.attention.map((reason) => t(ATTENTION_LABELS[reason])).join(' / ') })}
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
              clickAction={() => saveDirectAsProfile(slot.connection.url!, slot.connection.cwd)}
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
              tooltip={t('side.connectProfileTooltip', { name: profile.name, url: profile.url })}
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
                if (window.confirm(t('side.removeConfirm', { title }))) {
                  live.remove(connectionId);
                }
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
            return (
              <div key={entry.sessionId} className="sidebar-session">
                <button
                  disabled={foregroundSession || !canSwitch}
                  onClick={() => {
                    live.openSession(connectionId, entry.sessionId, entry.cwd);
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
    </div>
  );
}
