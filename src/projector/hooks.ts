/**
 * React/zustand seam for the projections (issue #24): components consume
 * these hooks instead of deriving render models from store state in their own
 * bodies — the red line of ADR 0006. Pure functions live beside them in this
 * directory so they stay unit-testable without React.
 *
 * Reference stability (ADR 0006): each hook projects inside useMemo keyed on
 * its fact slices, so an unchanged slice keeps the output's identity —
 * downstream memos don't degrade on unrelated churn.
 */

import { useMemo } from 'react';
import { useActiveConnection, useActiveDoc, useActiveSwitching, usePanda } from '../store';
import type { ForegroundSessionController } from '../session-controller';
import { modeStateFromConfigOptions } from '../protocol/modes';
import { projectMessageStream, type FlatItem } from './messageStream';
import { connectionLifecycle, connectionPhase, foregroundLifecycle, mainView, type ConnectionLifecycle, type ForegroundLifecycle, type MainView } from './connectionLifecycle';

/** The virtualized stream's item list; item identities survive unrelated churn. */
export function useMessageStreamItems(): FlatItem[] {
  const doc = useActiveDoc();
  return useMemo(() => projectMessageStream(doc), [doc]);
}

/**
 * The mode picker's view and write channel. protocol/v1 session-config-options:
 * a client with config options SHOULD use them exclusively and ignore
 * `modes` — when the agent models its mode selector as a config option, the
 * picker derives from it and writes go through set_config_option (one
 * full-list response refreshes both views). Replay sessions carry no config
 * options and fall through to doc.modes + setMode.
 */
export function useSessionModes(controller: ForegroundSessionController) {
  const doc = useActiveDoc();
  return useMemo(() => {
    const derived = modeStateFromConfigOptions(doc.configOptions);
    return {
      modes: derived ?? doc.modes,
      onSetMode: derived
        ? (modeId: string) => controller.setConfigOption('mode', modeId)
        : controller.setMode,
    };
  }, [doc.configOptions, doc.modes, controller]);
}

/** The foreground session's lifecycle: phase, composer gates, hint. */
export function useForegroundLifecycle(): ForegroundLifecycle {
  const mode = usePanda((s) => s.mode);
  const docStatus = useActiveDoc().status;
  const { status, error } = useActiveConnection();
  const switching = useActiveSwitching() !== null;
  return useMemo(
    () => foregroundLifecycle({ mode, docStatus, connection: { status, error }, switching }),
    [mode, docStatus, status, error, switching],
  );
}

/** One connection slot's lifecycle (sidebar dot, busy, 需要关注). Null while
 * the slot does not exist (removed mid-render). */
export function useConnectionLifecycle(connectionId: string): ConnectionLifecycle | null {
  const slot = usePanda((s) => s.connections[connectionId]);
  return useMemo(() => (slot ? connectionLifecycle(slot) : null), [slot]);
}

/** Which surface owns the content column: auth gate, first-run onboarding
 * (#200), or the message stream. Onboarding is pointer-decided (#218): a
 * retained document stays readable after a clean disconnect. */
export function useMainView(): MainView {
  const mode = usePanda((s) => s.mode);
  const connection = useActiveConnection();
  const switching = useActiveSwitching() !== null;
  const activeSessionId = usePanda((s) => s.activeSessionId);
  return useMemo(
    () =>
      mainView({
        mode,
        phase: connectionPhase(connection.status, connection.error, switching),
        authElicitation: connection.authElicitation,
        activeSessionId,
      }),
    [mode, connection, switching, activeSessionId],
  );
}
