import { useCallback, useEffect, useRef } from 'react';
import { usePanda } from './store';
import { ReplayDriver } from './replay/ReplayDriver';
import { followUpScenario, longScenario, mainScenario } from './replay/fixtures';
import type { PermissionOptionKind } from './protocol/types';

/** `?demo=long` streams a 120-turn session instead — the virtualization calibration sample. */
const demoScenario = () =>
  typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('demo') === 'long'
    ? longScenario()
    : mainScenario();

/**
 * Phase 0 session driver: wires the replay driver into the store exactly the
 * way the live ACP client is wired (handlers -> store actions). It owns the
 * session while `mode === 'demo'`; connecting to a real ACP service switches
 * the store to live mode and this driver stands down.
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

  const mode = usePanda((s) => s.mode);

  useEffect(() => {
    if (mode !== 'demo') return;
    const store = usePanda.getState();
    store.resetDocument();
    // The replay owns the session — connection state must not leak in.
    store.setConnection({
      status: 'disconnected',
      url: null,
      agentName: null,
      protocolVersion: null,
      sessionId: null,
      error: null,
    });
    driver.play(demoScenario());
    return () => driver.cancel();
  }, [driver, mode]);

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

  /** Restarts the scripted scenario; from live mode it first switches back to demo. */
  const replayDemo = useCallback(() => {
    const store = usePanda.getState();
    if (store.mode !== 'demo') {
      store.setMode('demo'); // the effect above takes it from here
      return;
    }
    store.resetDocument();
    driver.play(demoScenario());
  }, [driver]);

  return { send, resolvePermission, replayDemo };
}