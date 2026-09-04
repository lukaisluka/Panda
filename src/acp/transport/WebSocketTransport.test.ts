import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { createBrowserWebSocketStream } = vi.hoisted(() => ({
  createBrowserWebSocketStream: vi.fn(),
}));

vi.mock('../browserWebSocketStream', () => ({ createBrowserWebSocketStream }));

import { WebSocketTransport } from './WebSocketTransport';

/**
 * Urls with this prefix make the (single) wrapper implementation throw
 * synchronously — what the real wrapper does on an invalid WebSocket url.
 */
const BAD_URL = '::not a url';

/**
 * A controllable fake of what the transport really observes: the SDK hands it
 * a `WebSocket` constructor, and closure rides the socket's close/error
 * events (the SDK stream's readable is a bare ReadableStream — no `closed`
 * promise exists to hang off). The fake native constructor returns a socket
 * whose listeners the test can fire; the fake stream keeps the cancel/abort
 * teardown surface.
 */
function stageFakeConnection() {
  const socketListeners = new Map<string, Array<(event: unknown) => void>>();
  const socket = {
    addEventListener: vi.fn((type: string, listener: (event: unknown) => void) => {
      const list = socketListeners.get(type) ?? [];
      list.push(listener);
      socketListeners.set(type, list);
    }),
    close: vi.fn(),
  };
  const stream = {
    readable: { cancel: vi.fn(async () => {}) },
    writable: { abort: vi.fn(async () => {}) },
  };
  return {
    socket,
    stream,
    fire: (type: 'close' | 'error', event?: unknown) => {
      for (const listener of socketListeners.get(type) ?? []) listener(event);
    },
  };
}

type FakeConnection = ReturnType<typeof stageFakeConnection>;

type WebSocketSlot = { WebSocket?: unknown };

describe('WebSocketTransport (issue #20)', () => {
  /** The socket+stream the wrapper hands out for the next good-url connect. */
  let staged: FakeConnection | null = null;
  let originalWebSocket: unknown;

  beforeEach(() => {
    createBrowserWebSocketStream.mockClear();
    staged = null;
    originalWebSocket = (globalThis as WebSocketSlot).WebSocket;
    // Node ≥22 ships a real global WebSocket — swap it so every test controls
    // the socket the transport wires its close/error listeners onto.
    (globalThis as WebSocketSlot).WebSocket = function FakeNativeWebSocket(
      this: unknown,
      _url: string | URL,
      _protocols?: string | string[],
    ) {
      if (!staged) throw new Error('test bug: no fake connection staged before connect');
      return staged.socket;
    };
    // ONE implementation for the whole file, branching on the url: vitest 4
    // misattributes a caught throw when a throwing implementation REPLACES a
    // previously-successful one on a module mock — never replace it here.
    createBrowserWebSocketStream.mockImplementation(
      (url: string, options?: { WebSocket?: new (url: string, protocols?: string[]) => unknown }) => {
        if (url === BAD_URL) throw new Error('Invalid URL');
        if (!options?.WebSocket) throw new Error('test bug: wrapper called without an observed constructor');
        // The SDK instantiates the injected constructor — running the
        // transport's socket wiring — and returns its stream.
        new options.WebSocket(url, []);
        return staged ? staged.stream : undefined;
      },
    );
  });

  afterEach(() => {
    (globalThis as WebSocketSlot).WebSocket = originalWebSocket;
  });

  it('connect() resolves the wrapper stream for the configured url', async () => {
    staged = stageFakeConnection();
    const transport = new WebSocketTransport('ws://127.0.0.1:8766/acp');

    await expect(transport.connect()).resolves.toBe(staged.stream);
    expect(createBrowserWebSocketStream).toHaveBeenCalledWith(
      'ws://127.0.0.1:8766/acp',
      expect.objectContaining({ WebSocket: expect.any(Function) }),
    );
  });

  it('reports a synchronous wrapper failure (invalid url) as a rejected connect', async () => {
    await expect(new WebSocketTransport(BAD_URL).connect()).rejects.toThrow('Invalid URL');
  });

  it('refuses a second connect on one instance, loudly — even after disconnect (P2)', async () => {
    staged = stageFakeConnection();
    const transport = new WebSocketTransport('ws://x');
    await transport.connect();
    transport.disconnect();
    // The once-guard must survive its own teardown: a silent reopen would
    // leave the new connection's close/error observation dead (settled).
    await expect(transport.connect()).rejects.toThrow('called twice');
  });

  it('requires a native WebSocket — the observed constructor fails under its own name', async () => {
    staged = stageFakeConnection(); // the mock must reach the constructor call
    delete (globalThis as WebSocketSlot).WebSocket;
    await expect(new WebSocketTransport('ws://x').connect()).rejects.toThrow(
      'requires globalThis.WebSocket',
    );
  });

  it('fires onClose exactly once on a clean socket close (first settlement wins)', async () => {
    staged = stageFakeConnection();
    const transport = new WebSocketTransport('ws://x');
    const closed = vi.fn();
    transport.onClose(closed);
    await transport.connect();

    staged.fire('close');
    staged.fire('close'); // a second event is inert
    await Promise.resolve();

    expect(closed).toHaveBeenCalledTimes(1);
  });

  it('fires onError with the socket error and never onClose; non-Error events are wrapped', async () => {
    staged = stageFakeConnection();
    const transport = new WebSocketTransport('ws://x');
    const closed = vi.fn();
    const errored = vi.fn();
    transport.onClose(closed);
    transport.onError(errored);
    await transport.connect();

    staged.fire('error', 'socket hung up');
    staged.fire('close'); // the close that usually follows must not flip the outcome
    await Promise.resolve();

    expect(errored).toHaveBeenCalledTimes(1);
    expect(errored.mock.calls[0]![0]).toBeInstanceOf(Error);
    expect(errored.mock.calls[0]![0].message).toBe('socket hung up');
    expect(closed).not.toHaveBeenCalled();
  });

  it('wraps a DOM-Event-like socket error as "WebSocket <type>", not "[object Event]"', async () => {
    staged = stageFakeConnection();
    const transport = new WebSocketTransport('ws://x');
    const errored = vi.fn();
    transport.onError(errored);
    await transport.connect();

    staged.fire('error', { type: 'error' });
    await Promise.resolve();

    expect(errored.mock.calls[0]![0].message).toBe('WebSocket error');
  });

  it('unsubscribed handlers are not fired', async () => {
    staged = stageFakeConnection();
    const transport = new WebSocketTransport('ws://x');
    const closed = vi.fn();
    const unsubscribe = transport.onClose(closed);
    await transport.connect();

    unsubscribe();
    staged.fire('close');
    await Promise.resolve();

    expect(closed).not.toHaveBeenCalled();
  });

  it('disconnect() tears both stream sides down; a later socket close is inert', async () => {
    staged = stageFakeConnection();
    const transport = new WebSocketTransport('ws://x');
    const closed = vi.fn();
    transport.onClose(closed);
    await transport.connect();

    transport.disconnect();
    transport.disconnect(); // second call must be a no-op, not a throw

    expect(staged.stream.readable.cancel).toHaveBeenCalledTimes(1);
    expect(staged.stream.writable.abort).toHaveBeenCalledTimes(1);
    // Deliberate teardown settles the transport once (interface contract);
    // the socket close that follows the cancel must not double-fire.
    staged.fire('close');
    await Promise.resolve();
    expect(closed).toHaveBeenCalledTimes(1);
  });

  it('disconnect() before connect() is a safe no-op', () => {
    expect(() => new WebSocketTransport('ws://x').disconnect()).not.toThrow();
  });
});
