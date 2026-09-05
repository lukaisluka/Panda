/**
 * Connection lifecycle projection (#53, arch candidates 2+3): the single
 * interpretation of connection status. Every consumer (StatusBar, sidebar
 * slot dot, new-session dialog, composer gates, auth-gate branch) maps a
 * ConnectionPhase to visuals by mechanical lookup — precedence lives only
 * here, pixels stay in components (ADR 0006's meaning-vs-pixels split).
 *
 * statusHint's precedence chain is absorbed verbatim: the hint is now an
 * output field, its copy unchanged — a move, not a rewrite.
 */

import type { SessionStatus } from '../protocol/types';
import { t } from '../i18n';
import type { ConnectionInfo, ConnectionState, ConnectionStatus, SessionMode } from '../store';

/** 需要关注 sources (CONTEXT.md): reasons ride along instead of being
 * folded away — the tooltip can say which one fired. `auth-required` keeps
 * the pre-projection behaviour (auth_required lit the dot too). */
export type AttentionReason = 'unread-completion' | 'pending-permission' | 'connection-error' | 'auth-required';

/**
 * The semantic phase of a connection. Total precedence, highest first:
 * connecting > error > auth-required > disconnected > switching-session >
 * connected-degraded > connected. The last three all mean the link is up
 * (session operations possible) — see {@link isLinkUp}.
 */
export type ConnectionPhase =
  | 'connecting'
  | 'error'
  | 'auth-required'
  | 'disconnected'
  /** Connected with a transactional session switch in flight. */
  | 'switching-session'
  /** Connected with a non-fatal error (e.g. a failed switch, issue #17). */
  | 'connected-degraded'
  | 'connected';

export function connectionPhase(status: ConnectionStatus, error: string | null, switching: boolean): ConnectionPhase {
  if (status === 'connecting') return 'connecting';
  if (status === 'error') return 'error';
  if (status === 'auth_required') return 'auth-required';
  if (status !== 'connected') return 'disconnected';
  if (switching) return 'switching-session';
  if (error) return 'connected-degraded';
  return 'connected';
}

/** True while session operations are possible on the link (the three
 * connected phases); false while connecting/broken/absent. */
export function isLinkUp(phase: ConnectionPhase): boolean {
  return phase === 'connected' || phase === 'connected-degraded' || phase === 'switching-session';
}

/** The per-connection projection the sidebar consumes (one slot, all its
 * documents aggregated — 运行中 is any document mid-turn, 每连接单 pending turn). */
export type ConnectionLifecycle = {
  phase: ConnectionPhase;
  /** Failure / non-fatal reason text; null when none. */
  error: string | null;
  /** 运行中: any of the connection's documents is mid-turn. */
  running: boolean;
  /** Connection-level busy: a transactional switch or a running turn —
   * the states in which session switching/creating is refused. */
  busy: boolean;
  /** 需要关注 reasons; empty = nothing asks for attention. */
  attention: AttentionReason[];
};

function hasPendingPermission(slot: ConnectionState): boolean {
  return Object.values(slot.docs).some((doc) =>
    Object.values(doc.permissions).some((permission) => permission.status === 'pending'),
  );
}

function isConnectionRunning(slot: ConnectionState): boolean {
  return Object.values(slot.docs).some((doc) => doc.status === 'running');
}

/** Derived, never stored: the document, connection status and unread flag
 * stay the single sources of truth. */
export function connectionLifecycle(slot: ConnectionState): ConnectionLifecycle {
  const running = isConnectionRunning(slot);
  const attention: AttentionReason[] = [];
  if (slot.unreadCompletion) attention.push('unread-completion');
  if (hasPendingPermission(slot)) attention.push('pending-permission');
  if (slot.connection.status === 'error') attention.push('connection-error');
  if (slot.connection.status === 'auth_required') attention.push('auth-required');
  return {
    phase: connectionPhase(slot.connection.status, slot.connection.error, slot.switching !== null),
    error: slot.connection.error,
    running,
    busy: slot.switching !== null || running,
    attention,
  };
}

/** The fact slices the foreground projection is derived from. */
export type ForegroundLifecycleInput = {
  mode: SessionMode;
  docStatus: SessionStatus;
  connection: Pick<ConnectionInfo, 'status' | 'error'>;
  switching: boolean;
};

/** The foreground session's projection: what the composer, status bar and
 * auth-gate branch consume. */
export type ForegroundLifecycle = {
  phase: ConnectionPhase;
  /** Failure / non-fatal reason text; null when none. */
  error: string | null;
  /** The foreground document's turn status, a fact passed through — the
   * turn's interpretation (Working/等待批准/Ready) is pixels. */
  docStatus: SessionStatus;
  /** Foreground busy: mid-turn or a switch in flight. */
  busy: boolean;
  /** The composer is closed to input. */
  composerDisabled: boolean;
  /** Stop is offered while a turn runs on a healthy live link. */
  canStop: boolean;
  /** The status line under the composer. */
  hint: string | undefined;
};

function hintFor(mode: SessionMode, phase: ConnectionPhase, error: string | null, docStatus: SessionStatus): string | undefined {
  if (mode !== 'live') {
    if (docStatus === 'requires_action') return t('lifecycle.awaitingApproval');
    if (docStatus === 'running') return t('lifecycle.working');
    return undefined;
  }
  switch (phase) {
    case 'connecting':
      return t('lifecycle.connecting');
    case 'error':
      return t('lifecycle.connectFailed');
    case 'auth-required':
      return t('lifecycle.authRequired');
    case 'disconnected':
      return t('lifecycle.disconnected');
    case 'switching-session':
      return t('lifecycle.switching');
    case 'connected-degraded':
      return error ?? undefined;
    case 'connected':
      if (docStatus !== 'idle') return t('lifecycle.working');
      return undefined;
  }
}

export function foregroundLifecycle({
  mode,
  docStatus,
  connection,
  switching,
}: ForegroundLifecycleInput): ForegroundLifecycle {
  const phase = connectionPhase(connection.status, connection.error, switching);
  const busy = docStatus !== 'idle' || switching;
  return {
    phase,
    error: connection.error,
    docStatus,
    busy,
    composerDisabled: mode === 'live' ? !isLinkUp(phase) || busy : busy,
    canStop: mode === 'live' && isLinkUp(phase) && docStatus === 'running',
    hint: hintFor(mode, phase, connection.error, docStatus),
  };
}
