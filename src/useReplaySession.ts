import { useCallback, useEffect, useRef } from 'react';
import { DEMO_CONNECTION_ID, connectionStorePort, foregroundSessionId, usePanda, type ConnectionStorePort } from './store';
import { ReplayDriver } from './replay/ReplayDriver';
import { DEMO_CONFIG_OPTIONS, DEMO_MODES, followUpScenario, longScenario, mainScenario } from './replay/fixtures';
import type { AcpConfigOption, AcpContentBlock, ElicitationResponse, PermissionOptionKind } from './protocol/types';
import type { ForegroundSessionController } from './session-controller';

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

export function useReplaySession(): ForegroundSessionController {
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
    });
  }
  const driver = driverRef.current;

  // The demo's mutable copy of the agent-side config state: set_config_option
  // responses are simulated by rewriting the current values here and folding
  // the whole list back (the live path folds the RPC response's list).
  const configRef = useRef<AcpConfigOption[]>(structuredClone(DEMO_CONFIG_OPTIONS));
  const resetConfig = () => {
    configRef.current = structuredClone(DEMO_CONFIG_OPTIONS);
    port.update({ sessionUpdate: 'config_options_initialized', options: configRef.current });
  };

  const mode = usePanda((s) => s.mode);

  useEffect(() => {
    if (mode !== 'demo') return;
    // Entering demo moves the foreground onto the replay slot; leaving must
    // hand it back — since phase 2 the hash (not a click) owns the switch,
    // and the live view would otherwise render the replay slot's leftover
    // document (plan dock, messages) as if it were a connection.
    const prevForeground = usePanda.getState().activeConnectionId;
    usePanda.getState().ensureConnection(DEMO_CONNECTION_ID);
    port.adoptSession(DEMO_SESSION_ID, 'demo');
    port.resetDocument();
    // The replay owns the session — connection state must not leak in. This
    // nulling is the design-sanctioned pointer divergence (#59): the UI
    // pointer stays 'demo' (set by adoptSession above) while the anchor is
    // cleared — the demo session is intentionally unanchored.
    port.setConnection({
      status: 'disconnected',
      url: null,
      agentName: null,
      protocolVersion: null,
      sessionId: null,
      availableAuthMethods: [],
      authedMethodId: null,
      error: null,
    });
    // The pseudo session/new result: modes arrive exactly where the live
    // driver puts them (after the session is adopted, before any update).
    port.update({ sessionUpdate: 'modes_initialized', modes: DEMO_MODES });
    resetConfig();
    driver.play(demoScenario());
    return () => {
      driver.cancel();
      if (usePanda.getState().activeConnectionId === DEMO_CONNECTION_ID) {
        // The pre-demo foreground may be gone (connection removed while the
        // replay ran); settle on nothing rather than on the replay slot.
        const target =
          prevForeground !== null && usePanda.getState().connections[prevForeground]
            ? prevForeground
            : null;
        usePanda.setState({
          activeConnectionId: target,
          // Single write channel (#59): the handed-back pointer mirrors the
          // restored foreground's anchor.
          activeSessionId: target !== null ? foregroundSessionId(usePanda.getState(), target) : null,
        });
      }
    };
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
   * The demo holds at most one pending elicitation, so the id needs no
   * routing — the driver settles whoever is waiting (the live path keys its
   * waiters by the wire elicitationId / Panda-local mint instead).
   */
  const resolveElicitation = useCallback(
    (_id: string, response: ElicitationResponse) => {
      driver.resolveElicitation(response);
    },
    [driver],
  );

  /** The demo's url-mode consent: the card already opened the window; this answers the RPC accept. */
  const openElicitationUrl = useCallback(
    (_id: string) => {
      driver.openElicitationUrl();
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

  /**
   * The demo's instant `session/set_config_option`: the response's full
   * updated list IS the confirmation — same shape the live path folds from
   * the resolved RPC.
   */
  const setConfigOption = useCallback(
    (configId: string, value: string | boolean) => {
      const next = configRef.current.map((option) => {
        if (option.id !== configId) return option;
        if (option.type === 'select' && typeof value === 'string') {
          return { ...option, currentValue: value };
        }
        if (option.type === 'boolean' && typeof value === 'boolean') {
          return { ...option, currentValue: value };
        }
        return option;
      });
      configRef.current = next;
      port.update({ sessionUpdate: 'config_options_update', options: next });
    },
    [port],
  );

  /** Restarts happen by re-entering the `#/demo` route (phase 2): leaving
   * flips the store to live mode and cancels this driver's effect cleanup;
   * coming back re-runs it and plays from the top. */

  return { send, resolvePermission, resolveElicitation, openElicitationUrl, setMode, setConfigOption };
}
