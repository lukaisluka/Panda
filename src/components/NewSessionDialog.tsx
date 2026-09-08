import { useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { ChevronDown, ChevronRight, PlugZap } from 'lucide-react';
import { Button } from '@astryxdesign/core/Button';
import { Dialog, DialogHeader } from '@astryxdesign/core/Dialog';
import { LayoutContent } from '@astryxdesign/core/Layout';
import { Selector } from '@astryxdesign/core/Selector';
import { Spinner } from '@astryxdesign/core/Spinner';
import { StatusDot } from '@astryxdesign/core/StatusDot';
import { TextInput } from '@astryxdesign/core/TextInput';
import { usePanda } from '../store';
import { connectionLifecycle, connectionPhase, isLinkUp, type ConnectionPhase } from '../projector/connectionLifecycle';
import { lastConnectionDefaults } from '../liveConnections';
import type { AgentProfile } from '../profiles';
import { profileEndpoint } from '../profiles';
import type { Workspace } from '../workspace';
import type { LiveSessionFacade } from '../useLiveSession';
import './NewSessionDialog.css';
import { useI18n } from '../i18n/context';
import { t } from '../i18n';

/**
 * New-session picker (IA refactor phase 3): the entry that used to be
 * "connect, then 新建会话 on the foreground connection" — choosing the agent
 * IS creating the session. Connected agents start a session/new right away;
 * connecting ones show their progress; the rest connect first (a successful
 * connect establishes a fresh session by itself). 自定义地址 starts a
 * temporary direct connection, never a saved 配置; with configured agents
 * it folds behind an advanced toggle (#157), in the agentless 空态 it stays
 * expanded as the only entry.
 */
export function NewSessionDialog({ isOpen, onOpenChange, onStarted, live, profiles, highlightProfileId }: {
  isOpen: boolean;
  onOpenChange(open: boolean): void;
  onStarted(): void;
  live: LiveSessionFacade;
  profiles: AgentProfile[];
  /** The row to suggest (#221): the settings page's post-create CTA
   * deep-links here with the freshly saved profile. Visual only — picking
   * stays the user's click. */
  highlightProfileId?: string | null;
}) {
  const { t } = useI18n();
  // Per-profile lifecycle phase, as flat arrays of primitives so the
  // selector's snapshot is shallow-stable (object values would re-create
  // every call and loop useSyncExternalStore). A connect in progress
  // updates its spinner the moment the slot settles. Status meaning comes
  // from the projection (#53) — this list only maps phase to pixels.
  const phases = usePanda(
    useShallow((s) =>
      profiles.map((profile) => {
        const slot = s.connections[profile.id];
        return slot
          ? connectionPhase(slot.connection.status, slot.connection.error, slot.switching !== null)
          : ('disconnected' as ConnectionPhase);
      }),
    ),
  );
  const cwds = usePanda(useShallow((s) => profiles.map((profile) => s.connections[profile.id]?.connection.cwd ?? null)));
  // Mid-turn busy per profile (bug hunt #3): creating a session while the
  // agent's turn runs would strand it — same guard as loadSession, surfaced
  // here as a disabled row. Flat primitives, same shallow-stability reason.
  const busys = usePanda(
    useShallow((s) =>
      profiles.map((profile) => {
        const slot = s.connections[profile.id];
        return slot ? connectionLifecycle(slot).busy : false;
      }),
    ),
  );

  const [customUrl, setCustomUrl] = useState(() => lastConnectionDefaults().url);
  const [customWorkspace, setCustomWorkspace] = useState<Workspace>(() => lastConnectionDefaults().workspace);
  const [showCustomErrors, setShowCustomErrors] = useState(false);
  // #157: with configured agents the custom form is an advanced aside —
  // collapsed behind a toggle; with none it is the only entry and stays
  // expanded as-is. The dialog is conditionally mounted (Sidebar), so every
  // open re-derives this default.
  const [customOpen, setCustomOpen] = useState(() => profiles.length === 0);
  const customErrors = customEndpointErrors({ url: customUrl, workspace: customWorkspace });
  // Astryx TextInput surfaces errors through its status object; they appear
  // only after a rejected submit, never while the user is still typing.
  const statusOf = (field: 'url' | 'path') =>
    showCustomErrors && customErrors[field] ? { type: 'error' as const, message: customErrors[field] } : undefined;

  const start = (action: () => void) => {
    action();
    onOpenChange(false);
    onStarted();
  };

  return (
    <Dialog isOpen={isOpen} onOpenChange={onOpenChange} purpose="form" width={440}>
      <DialogHeader title={t('nsd.title')} subtitle={t('nsd.subtitle')} onOpenChange={onOpenChange} />
      <LayoutContent>
        <div className="nsd-list">
          {profiles.length === 0 && (
            <p className="nsd-hint">{t('nsd.empty')}</p>
          )}
          {profiles.map((profile, index) => {
            const phase = phases[index] ?? 'disconnected';
            const cwd = cwds[index] ?? null;
            const action = nsdRowAction({ phase, cwd, busy: busys[index] ?? false });
            return (
              <button
                key={profile.id}
                type="button"
                className={`nsd-agent ${highlightProfileId === profile.id ? 'nsd-agent--suggested' : ''}`}
                disabled={action === 'blocked'}
                onClick={() =>
                  start(() =>
                    action === 'new'
                      ? live.newSession(cwd ?? '/', profile.id)
                      : live.connectProfile(profile),
                  )
                }
                title={
                  action === 'blocked'
                    ? t('nsd.busy')
                    : action === 'new'
                      ? t('nsd.newIn', { name: profile.name })
                      : t('nsd.connect', { name: profile.name, url: profileEndpoint(profile) })
                }
              >
                <span className="nsd-agent-status">
                  {phase === 'connecting' ? (
                    <Spinner size="sm" />
                  ) : isLinkUp(phase) ? (
                    <StatusDot variant="success" label={t('conn.connected')} />
                  ) : phase === 'error' ? (
                    <StatusDot variant="error" label={t('conn.error')} />
                  ) : phase === 'auth-required' ? (
                    <StatusDot variant="warning" label={t('conn.authRequired')} />
                  ) : (
                    <StatusDot variant="neutral" label={t('conn.disconnected')} />
                  )}
                </span>
                <span className="nsd-agent-main">
                  <span className="truncate nsd-agent-name">{profile.name}</span>
                  <span className="truncate nsd-agent-meta">{profileEndpoint(profile)}</span>
                </span>
                <ChevronRight size={14} className="nsd-agent-chevron" />
              </button>
            );
          })}
        </div>

        <div className="nsd-custom">
          {profiles.length > 0 ? (
            <button
              type="button"
              className="nsd-custom-toggle"
              aria-expanded={customOpen}
              onClick={() => setCustomOpen((open) => !open)}
            >
              <span className="nsd-custom-toggle-label">{t('nsd.customToggle')}</span>
              <ChevronDown
                size={13}
                className={`nsd-custom-toggle-chevron ${customOpen ? 'nsd-custom-toggle-chevron--open' : ''}`}
              />
            </button>
          ) : (
            <span className="nsd-custom-title">{t('nsd.custom')}</span>
          )}
          {(profiles.length === 0 || customOpen) && (
            <>
              <p className="nsd-hint">{t('nsd.customHint')}</p>
              <TextInput
                label={t('nsd.endpoint')}
                value={customUrl}
                onChange={setCustomUrl}
                placeholder="ws://host:port/acp"
                status={statusOf('url')}
              />
              <div className="nsd-custom-fields">
                <div className="nsd-custom-kind">
                  <Selector
                    label={t('nsd.workspace')}
                    isLabelHidden
                    value={customWorkspace.kind}
                    onChange={(kind) =>
                      setCustomWorkspace(kind === 'none' ? { kind: 'none' } : { kind: 'local-directory', path: '' })
                    }
                    options={[
                      { value: 'local-directory', label: t('nsd.localDir') },
                      { value: 'none', label: t('nsd.noWorkspace') },
                    ]}
                    labelTooltip={t('nsd.workspaceTooltip')}
                  />
                </div>
                {customWorkspace.kind === 'local-directory' && (
                  <div className="nsd-custom-path">
                    <TextInput
                      label={t('nsd.workspacePath')}
                      isLabelHidden
                      width="100%"
                      value={customWorkspace.path}
                      onChange={(path) => setCustomWorkspace({ kind: 'local-directory', path })}
                      placeholder="/absolute/path/on/the/agent"
                      status={statusOf('path')}
                    />
                  </div>
                )}
              </div>
              <Button
                variant="secondary"
                size="sm"
                width="100%"
                label={t('nsd.connectStart')}
                icon={<PlugZap size={12} />}
                clickAction={() => {
                  if (customErrors.url || customErrors.path) {
                    setShowCustomErrors(true);
                    return;
                  }
                  start(() =>
                    live.connectDirect(
                      customUrl.trim(),
                      customWorkspace.kind === 'local-directory'
                        ? { kind: 'local-directory', path: customWorkspace.path.trim() }
                        : customWorkspace,
                    ),
                  );
                }}
              />
            </>
          )}
        </div>
      </LayoutContent>
    </Dialog>
  );
}

/** Field-level validation for the custom-address form (unit-tested). */
export function customEndpointErrors(draft: { url: string; workspace: Workspace }): Partial<Record<'url' | 'path', string>> {
  const errors: Partial<Record<'url' | 'path', string>> = {};
  if (!draft.url.trim()) errors.url = t('nsd.endpointRequired');
  if (draft.workspace.kind === 'local-directory' && !draft.workspace.path.trim()) errors.path = t('nsd.pathRequired');
  return errors;
}

/**
 * What clicking one agent row does (unit-tested): `new` starts a session on
 * the named connection, `connect` dials it first, `blocked` refuses — a
 * mid-turn (or mid-switch) connection must not adopt a new session while
 * its current one is unsettled (bug hunt #3).
 */
export function nsdRowAction(input: {
  phase: ConnectionPhase;
  cwd: string | null;
  busy: boolean;
}): 'new' | 'connect' | 'blocked' {
  if (isLinkUp(input.phase) && input.cwd) return input.busy ? 'blocked' : 'new';
  return 'connect';
}
