import type { Stream } from '@agentclientprotocol/sdk';

/**
 * The named transport seam (issue #20), aligned with acp-components'
 * 4-member interface (docs/panda-acp-architecture-conclusion.md §5.2):
 * `LiveAcpClient` consumes this interface, callers inject an instance —
 * nothing above this seam knows which transport carried the protocol.
 *
 * Implementations: `WebSocketTransport` (browser WS via the SDK's
 * ws-client), `StreamTransport` (wraps an existing Stream — the test seam
 * and the future stdio shape). stdio / Tauri IPC / HTTP implementations are
 * deliberately out of scope until their hosts exist.
 */
export interface AcpTransport {
  /**
   * Opens the transport. Resolves with the ACP `Stream` to hand to the
   * client. Rejection timing is implementation-dependent: a transport that
   * cannot even begin (invalid URL, failed spawn) rejects here; one that
   * opens and dies mid-handshake (refused socket) may resolve first and
   * fail through the stream — the client reports both as connect failures.
   * One instance serves exactly one connection attempt (a failed attempt
   * counts): a second `connect()` must fail loudly rather than silently
   * reopen.
   */
  connect(): Promise<Stream>;
  /**
   * Tears the transport down. Idempotent and safe before `connect()`
   * resolves — the owner calls it on every cleanup path.
   */
  disconnect(): void;
  /**
   * Observes transport closure (deliberate or remote), at most once per
   * connection. Returns an unsubscribe function. Optional: minimal
   * implementations may omit it. Handlers registered after the transport
   * settled are not replayed.
   */
  onClose?(handler: () => void): () => void;
  /**
   * Observes transport failure (rejected stream, socket error), at most
   * once per connection — first settlement wins over `onClose`. Returns an
   * unsubscribe function. Optional; handlers are not replayed.
   */
  onError?(handler: (err: Error) => void): () => void;
}
