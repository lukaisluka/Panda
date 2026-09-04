import type { Stream } from '@agentclientprotocol/sdk';
import type { WebSocketConstructor } from '@agentclientprotocol/sdk/experimental/ws-client';
import { createBrowserWebSocketStream } from '../browserWebSocketStream';
import type { AcpTransport } from './AcpTransport';

/**
 * Browser WebSocket transport: wraps `createBrowserWebSocketStream` (the SDK
 * ws-client with Panda's no-subprotocol handshake) behind `AcpTransport`
 * (issue #20).
 *
 * Closure observation (the #20 review's fail-fast check found this the hard
 * way): the SDK stream's `readable` is a bare WHATWG ReadableStream, which has
 * no `closed` property — only readers do, and stealing a reader would starve
 * the SDK's own consumption. The genuinely observable signals are the
 * underlying WebSocket's `close`/`error` events, so the transport injects an
 * instrumented constructor and observes the socket directly.
 */
export class WebSocketTransport implements AcpTransport {
  private readonly url: string;
  private stream: ReturnType<typeof createBrowserWebSocketStream> | null = null;
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
    const stream = createBrowserWebSocketStream(this.url, {
      WebSocket: this.observedWebSocketConstructor(),
    });
    this.stream = stream;
    return stream;
  }

  disconnect(): void {
    // The SDK connection usually tore the streams down already (its close()
    // owns the socket); cancelling here is the safety net for owners that
    // skipped it. Rejections mean "already closed" — the closure itself is
    // observed via the socket's close event, never swallowed silently.
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

  /**
   * A constructor the SDK instantiates instead of the native WebSocket; every
   * instance it builds is wired straight into this transport's settlement.
   * A function-returning-object under `new` (instead of a subclass) so the
   * native WebSocket is only touched when a connect actually runs.
   */
  private observedWebSocketConstructor(): WebSocketConstructor {
    const settle = this.settle.bind(this);
    return function ObservedWebSocket(
      this: unknown,
      url: string | URL,
      protocols?: string | string[],
      _options?: { headers?: Record<string, string> },
    ) {
      const NativeWebSocket = globalThis.WebSocket;
      if (typeof NativeWebSocket !== 'function') {
        // Same failure the SDK itself would raise a moment later; reported
        // here so the transport's own contract fails under its own name.
        throw new Error('[panda/acp] WebSocketTransport requires globalThis.WebSocket');
      }
      // Browser WebSockets cannot carry custom headers (the SDK documents
      // them as Node-only), so only url/protocols are forwarded natively.
      const socket = new NativeWebSocket(url, protocols);
      observeSocket(socket, settle);
      return socket;
    } as unknown as WebSocketConstructor;
  }

  /** Routes the socket's first close/error event to the registered handlers. */
  private settle(err: unknown): void {
    if (this.settled) return;
    this.settled = true;
    if (err === undefined) {
      for (const handler of this.closeHandlers) handler();
    } else {
      const error = toError(err);
      for (const handler of this.errorHandlers) handler(error);
    }
  }
}

type ObservableSocket = {
  addEventListener?: (type: string, listener: (event: unknown) => void) => void;
};

/** Attaches the transport's settlement to one socket's lifecycle events. */
function observeSocket(socket: ObservableSocket, settle: (err?: unknown) => void): void {
  if (typeof socket.addEventListener !== 'function') {
    // Not silent, but not fatal: the SDK connection layer observes closure
    // through its own stream consumption; the transport's handlers are the
    // supplementary signal and only this transport loses them.
    console.warn('[panda/acp] transport socket has no addEventListener — close/error handlers inert for this connection');
    return;
  }
  socket.addEventListener('close', () => settle(undefined));
  socket.addEventListener('error', (event) => settle(event));
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
