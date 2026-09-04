/**
 * React/zustand seam for the projections (issue #24): components consume
 * these hooks instead of deriving render models from store state in their own
 * bodies — the red line of ADR 0006. Pure functions live beside them in this
 * directory so they stay unit-testable without React.
 */

import { useMemo } from 'react';
import { useActiveConnection, useActiveDoc, useActiveSwitching, usePanda } from '../store';
import { projectMessageStream, type FlatItem } from './messageStream';
import { statusHint } from './statusHint';

/** The virtualized stream's item list; item identities survive unrelated churn. */
export function useMessageStreamItems(): FlatItem[] {
  const doc = useActiveDoc();
  return useMemo(() => projectMessageStream(doc), [doc]);
}

/** The composer's status hint line. */
export function useStatusHint(): string | undefined {
  const mode = usePanda((s) => s.mode);
  const docStatus = useActiveDoc().status;
  const { status, error } = useActiveConnection();
  const switching = useActiveSwitching() !== null;
  return useMemo(
    () => statusHint({ mode, docStatus, connection: { status, error }, switching }),
    [mode, docStatus, status, error, switching],
  );
}
