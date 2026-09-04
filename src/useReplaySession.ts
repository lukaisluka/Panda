import { useCallback, useEffect, useRef } from 'react';
import { DEMO_CONNECTION_ID, connectionStorePort, usePanda, type ConnectionStorePort } from './store';
import { ReplayDriver } from './replay/ReplayDriver';
import { DEMO_MODES, followUpScenario, longScenario, mainScenario } from './replay/fixtures';
import type { AcpContentBlock, PermissionOptionKind } from './protocol/types';

/** `?demo=long` streams an 80-turn session instead — the virtualization calibration sample. */
const demoScenario = () =>
  typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('demo') === 'long'
    ? longScenario()
    : mainScenario();

/**
 * Phase 0 session driver: wires the replay driver into the store exactly the
 * way the live ACP client is wired (handlers -> store actions). It owns the
 * session while `mode === 'demo'`; connecting to a real ACP service switches
 * the store to live mode and this driver stands down. Live connections keep
 * running in the background while demo mode is active (issue #21: demo only
 * switches what the UI renders, never touches a connection).
 */
/** The demo pseudo-connection slot; its document dies with the slot, not with mode switches. */
const DEMO_SESSION_ID = 'demo';

export function useReplaySession() {
  // Connection-scoped store port: handlers never touch global fields (#16).
  const portRef = useRef<ConnectionStorePort | null>(null);
  if (portRef.current === null) portRef.current = connectionStorePort(DEMO_CONNECTION_ID);
  const port = portRef.current;
  // Lazily created once; a stable reference so the autoplay effect below
  // doesn't restart on every render.
  const driverRef = useRef<ReplayDriver | null>(null);
  if (driverRef.current === null) {
    driverRef.current = new ReplayDriver({
      onUpdate: (update) => port.update(update),
      onStatus: (status) => port.setStatus(status),
    });
  }
  const driver = driverRef.current;

  const mode = usePanda((s) => s.mode);

  useEffect(() => {
    if (mode !== 'demo') return;
    usePanda.getState().ensureConnection(DEMO_CONNECTION_ID);
    port.adoptSession(DEMO_SESSION_ID, 'demo');
    port.resetDocument();
    // The replay owns the session — connection state must not leak in.
    port.setConnection({
      status: 'disconnected',
      url: null,
      agentName: null,
      protocolVersion: null,
      sessionId: null,
      error: null,
    });
    // The pseudo session/new result: modes arrive exactly where the live
    // driver puts them (after the session is adopted, before any update).
    port.update({ sessionUpdate: 'modes_initialized', modes: DEMO_MODES });
    driver.play(demoScenario());
    return () => driver.cancel();
  }, [driver, mode, port]);

  const send = useCallback(
    (content: AcpContentBlock[]) => {
      if (content.length === 0) return;
      driver.play(followUpScenario(content));
    },
    [driver],
  );

  const resolvePermission = useCallback(
    (_toolCallId: string, kind: PermissionOptionKind) => {
      driver.resolvePermission(kind);
    },
    [driver],
  );

  /**
   * The demo's instant `session/set_mode`: there is no RPC to confirm, so the
   * mode_changed event IS the confirmation — same shape the live path emits
   * on the resolved RPC.
   */
  const setMode = useCallback(
    (modeId: string) => {
      port.update({ sessionUpdate: 'mode_changed', modeId });
    },
    [port],
  );

  /** Restarts the scripted scenario; from live mode it first switches back to demo. */
  const replayDemo = useCallback(() => {
    if (usePanda.getState().mode !== 'demo') {
      usePanda.getState().setMode('demo'); // the effect above takes it from here
      return;
    }
    port.resetDocument();
    port.update({ sessionUpdate: 'modes_initialized', modes: DEMO_MODES });
    driver.play(demoScenario());
  }, [driver, port]);

  return { send, resolvePermission, setMode, replayDemo };
}
