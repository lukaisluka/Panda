import type { Stream } from '@agentclientprotocol/sdk';
import { createBrowserWebSocketStream } from '../browserWebSocketStream';
import type { AcpTransport } from './AcpTransport';

/**
 * Browser WebSocket transport: wraps `createBrowserWebSocketStream` (the SDK
 * ws-client with Panda's no-subprotocol handshake) behind `AcpTransport`
 * (issue #20). The WebSocket's lifecycle belongs to the SDK stream — close
 * and error are observed through the stream's `closed` promises, without
 * stealing reads from the connection that consumes it.
 */
export class WebSocketTransport implements AcpTransport {
  private readonly url: string;
  private stream: Stream | null = null;
  /** One instance, one connection attempt — EVER, including failed ones. */
  private connected = false;
  /** First settlement wins: one close-or-error event per connection. */
  private settled = false;
  private readonly closeHandlers = new Set<() => void>();
  private readonly errorHandlers = new Set<(err: Error) => void>();

  constructor(url: string) {
    this.url = url;
  }

  async connect(): Promise<Stream> {
    if (this.connected) {
      // Never silently reopen: a second attempt would detach the caller's
      // close/error observers from the live socket (the interface's MUST).
      throw new Error('[panda/acp] WebSocketTransport.connect called twice on one instance');
    }
    this.connected = true;
    // Async is the seam, not the work: the SDK builds the stream synchronously
    // (an invalid URL throws here and rejects this promise — the client
    // reports it as a connect failure); future transports genuinely await.
    const stream = createBrowserWebSocketStream(this.url);
    this.stream = stream;
    this.observe(stream);
    return stream;
  }

  disconnect(): void {
    // The SDK connection usually tore the streams down already (its close()
    // owns the socket); cancelling here is the safety net for owners that
    // skipped it. Rejections mean "already closed" — the closure itself is
    // observed via onClose, never swallowed silently.
    const stream = this.stream;
    this.stream = null;
    void stream?.readable.cancel().catch(() => {});
    void stream?.writable.abort().catch(() => {});
  }

  onClose(handler: () => void): () => void {
    this.closeHandlers.add(handler);
    return () => this.closeHandlers.delete(handler);
  }

  onError(handler: (err: Error) => void): () => void {
    this.errorHandlers.add(handler);
    return () => this.errorHandlers.delete(handler);
  }

  /** Wires the stream's settlement promises to the close/error handlers. */
  private observe(stream: Stream): void {
    // `closed` is a standard web-streams property the runtime exposes, but
    // TS 7's DOM lib types Readable/WritableStream without it — read it
    // structurally instead of pinning the project to a lib workaround.
    const settled = (side: object, name: string): Promise<unknown> => {
      const closed = (side as { closed?: Promise<unknown> }).closed;
      // Fail fast, never invent a phantom close: without a `closed` promise
      // this transport cannot honor its close/error contract at all.
      if (!closed) {
        throw new Error(`[panda/acp] transport stream ${name} has no closed promise — closure not observable`);
      }
      return closed;
    };
    const settle = (err: unknown) => {
      if (this.settled) return;
      this.settled = true;
      if (err === undefined) {
        for (const handler of this.closeHandlers) handler();
      } else {
        const error = toError(err);
        for (const handler of this.errorHandlers) handler(error);
      }
    };
    settled(stream.readable, 'readable').then(
      () => settle(undefined),
      (err: unknown) => settle(err),
    );
    settled(stream.writable, 'writable').then(
      () => settle(undefined),
      (err: unknown) => settle(err),
    );
  }
}

/**
 * Human-readable error for any rejected value — browser WebSocket failures
 * reject with a raw Event (stringifies to "[object Event]"); same treatment
 * as LiveAcpClient.describeError.
 */
function toError(err: unknown): Error {
  if (err instanceof Error) return err;
  if (typeof err === 'object' && err !== null) {
    const type = (err as { type?: unknown }).type;
    if (typeof type === 'string') return new Error(`WebSocket ${type}`);
  }
  return new Error(String(err));
}
