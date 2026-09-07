/**
 * User-facing notice bus (#160): the seam between non-React modules
 * (LiveAcpClient, liveConnections) and the toast layer. Failure paths there
 * used to be console-only — the user clicked, nothing answered. Publishing
 * here is for operation-level failures only ("switch rejected", "list fetch
 * failed"); connection-level failures keep their existing error card /
 * status-bar surface and must NOT double-toast.
 *
 * The bus is deliberately tiny: fire-and-forget, no queue, no dedupe. A
 * notice is transient (the toast owns its lifetime); nothing here is a
 * source of truth.
 */

export type UserNoticeKind = 'error' | 'info';

export interface UserNotice {
  id: number;
  kind: UserNoticeKind;
  /** Pre-rendered, localized text — the publisher already resolved t(). */
  message: string;
}

type Listener = (notice: UserNotice) => void;

const listeners = new Set<Listener>();
let nextId = 1;

/** Publishes one notice; with no subscriber (e.g. unit tests) it is a no-op. */
export function notifyUser(kind: UserNoticeKind, message: string): void {
  if (listeners.size === 0) return;
  const notice: UserNotice = { id: nextId++, kind, message };
  for (const listener of listeners) listener(notice);
}

export function subscribeUserNotices(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
