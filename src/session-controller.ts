import type { AcpContentBlock, ElicitationResponse, PermissionOptionKind } from './protocol/types';

/**
 * The session-level operations the foreground session admits (#51): the
 * shape both session drivers expose, so MainScreen picks once instead of
 * hand-ternarying members. The live driver (useLiveSession) implements it
 * as part of its wider facade; the demo replay (useReplaySession)
 * implements it 1:1 — two adapters make the seam real, this interface is
 * its name. Members are handed down to components individually; the
 * controller is a pick, not a prop.
 */
export interface ForegroundSessionController {
  /** Send one user turn's content blocks. */
  send: (content: AcpContentBlock[]) => void;
  /** Answer a pending permission request for a tool call. */
  resolvePermission: (toolCallId: string, kind: PermissionOptionKind) => void;
  /** Answer the pending elicitation. */
  resolveElicitation: (id: string, response: ElicitationResponse) => void;
  /** Consent to the pending url-mode elicitation (opens outside Panda). */
  openElicitationUrl: (id: string) => void;
  /** `session/set_mode` on the foreground session. */
  setMode: (modeId: string) => void;
  /** `session/set_config_option` on the foreground session. */
  setConfigOption: (configId: string, value: string | boolean) => void;
}
