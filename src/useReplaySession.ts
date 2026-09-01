import { useCallback, useEffect, useRef } from 'react';
import { usePanda } from './store';
import { ReplayDriver } from './replay/ReplayDriver';
import { followUpScenario, mainScenario } from './replay/fixtures';
import type { PermissionOptionKind } from './protocol/types';

/**
 * Phase 0 session driver: wires the replay driver into the store exactly the
 * way a real ACP client will be wired in Phase 1 (handlers -> store actions).
 */
export function useReplaySession() {
  // Lazily created once; a stable reference so the autoplay effect below
  // doesn't restart on every render.
  const driverRef = useRef<ReplayDriver | null>(null);
  if (driverRef.current === null) {
    driverRef.current = new ReplayDriver({
      onUpdate: (update) => usePanda.getState().update(update),
      onStatus: (status) => usePanda.getState().setStatus(status),
      onPermission: (request) => usePanda.getState().setPermission(request),
    });
  }
  const driver = driverRef.current;

  useEffect(() => {
    driver.play(mainScenario());
    return () => driver.cancel();
  }, [driver]);

  const send = useCallback(
    (userText: string) => {
      const trimmed = userText.trim();
      if (!trimmed) return;
      driver.play(followUpScenario(trimmed));
    },
    [driver],
  );

  const resolvePermission = useCallback(
    (kind: PermissionOptionKind) => {
      usePanda.getState().setPermission(null);
      driver.resolvePermission(kind);
    },
    [driver],
  );

  return { send, resolvePermission };
}