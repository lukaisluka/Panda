import { beforeEach, describe, expect, it, vi } from 'vitest';

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
 * A controllable fake of the SDK ws-client stream surface WebSocketTransport
 * observes: the `closed` promises its close/error handlers hang off, plus
 * the cancel/abort teardown disconnect() calls.
 */
function stageFakeStream() {
  let resolveRead!: () => void;
  let rejectRead!: (err: unknown) => void;
  let resolveWrite!: () => void;
  let rejectWrite!: (err: unknown) => void;
  const stream = {
    readable: {
      closed: new Promise<void>((res, rej) => {
        resolveRead = res;
        rejectRead = rej;
      }),
      cancel: vi.fn(async () => {}),
    },
    writable: {
      closed: new Promise<void>((res, rej) => {
        resolveWrite = res;
        rejectWrite = rej;
      }),
      abort: vi.fn(async () => {}),
    },
    settleRead: (err?: unknown) => (err === undefined ? resolveRead() : rejectRead(err)),
    settleWrite: (err?: unknown) => (err === undefined ? resolveWrite() : rejectWrite(err)),
  };
  return stream;
}

type FakeStream = ReturnType<typeof stageFakeStream>;

describe('WebSocketTransport (issue #20)', () => {
  /** The stream the wrapper hands out for the next good-url connect. */
  let staged: FakeStream | null;

  beforeEach(() => {
    createBrowserWebSocketStream.mockClear();
    staged = null;
    // ONE implementation for the whole file, branching on the url: vitest 4
    // misattributes a caught throw when a throwing implementation REPLACES a
    // previously-successful one on a module mock — never replace it here.
    createBrowserWebSocketStream.mockImplementation((url: string) => {
      if (url === BAD_URL) throw new Error('Invalid URL');
      if (!staged) throw new Error('test bug: no fake stream staged before connect');
      return staged;
    });
  });

  it('connect() resolves the wrapper stream for the configured url', async () => {
    const stream = stageFakeStream();
    staged = stream;
    const transport = new WebSocketTransport('ws://127.0.0.1:8766/acp');

    await expect(transport.connect()).resolves.toBe(stream);
    expect(createBrowserWebSocketStream).toHaveBeenCalledWith('ws://127.0.0.1:8766/acp');
  });

  it('reports a synchronous wrapper failure (invalid url) as a rejected connect', async () => {
    await expect(new WebSocketTransport(BAD_URL).connect()).rejects.toThrow('Invalid URL');
  });

  it('refuses a second connect on one instance, loudly — even after disconnect (P2)', async () => {
    staged = stageFakeStream();
    const transport = new WebSocketTransport('ws://x');
    await transport.connect();
    transport.disconnect();
    // The once-guard must survive its own teardown: a silent reopen would
    // leave the new connection's close/error observation dead (settled).
    await expect(transport.connect()).rejects.toThrow('called twice');
  });

  it('fires onClose exactly once on a clean stream close (first settlement wins)', async () => {
    const stream = stageFakeStream();
    staged = stream;
    const transport = new WebSocketTransport('ws://x');
    const closed = vi.fn();
    transport.onClose(closed);
    await transport.connect();

    // Either side settling cleanly closes the transport; the second is inert.
    stream.settleRead();
    stream.settleWrite();
    await Promise.resolve();

    expect(closed).toHaveBeenCalledTimes(1);
  });

  it('fires onError with the stream error and never onClose; non-Error rejections are wrapped', async () => {
    const stream = stageFakeStream();
    staged = stream;
    const transport = new WebSocketTransport('ws://x');
    const closed = vi.fn();
    const errored = vi.fn();
    transport.onClose(closed);
    transport.onError(errored);
    await transport.connect();

    stream.settleRead('socket hung up');
    stream.settleWrite(); // a later clean settle must not flip the outcome
    await Promise.resolve();

    expect(errored).toHaveBeenCalledTimes(1);
    expect(errored.mock.calls[0]![0]).toBeInstanceOf(Error);
    expect(errored.mock.calls[0]![0].message).toBe('socket hung up');
    expect(closed).not.toHaveBeenCalled();
  });

  it('wraps a DOM-Event-like rejection as "WebSocket <type>", not "[object Event]"', async () => {
    const stream = stageFakeStream();
    staged = stream;
    const transport = new WebSocketTransport('ws://x');
    const errored = vi.fn();
    transport.onError(errored);
    await transport.connect();

    // Browser sockets reject `closed` with the raw error Event.
    stream.settleRead({ type: 'error' });
    await Promise.resolve();

    expect(errored.mock.calls[0]![0].message).toBe('WebSocket error');
  });

  it('unsubscribed handlers are not fired', async () => {
    const stream = stageFakeStream();
    staged = stream;
    const transport = new WebSocketTransport('ws://x');
    const closed = vi.fn();
    const unsubscribe = transport.onClose(closed);
    await transport.connect();

    unsubscribe();
    stream.settleRead();
    await Promise.resolve();

    expect(closed).not.toHaveBeenCalled();
  });

  it('disconnect() tears both stream sides down, fires onClose, and is idempotent', async () => {
    const stream = stageFakeStream();
    staged = stream;
    const transport = new WebSocketTransport('ws://x');
    const closed = vi.fn();
    transport.onClose(closed);
    await transport.connect();

    transport.disconnect();
    transport.disconnect(); // second call must be a no-op, not a throw

    expect(stream.readable.cancel).toHaveBeenCalledTimes(1);
    expect(stream.writable.abort).toHaveBeenCalledTimes(1);
    // Deliberate teardown is a closure like any other (interface contract).
    stream.settleRead();
    await Promise.resolve();
    expect(closed).toHaveBeenCalledTimes(1);
  });

  it('disconnect() before connect() is a safe no-op', () => {
    expect(() => new WebSocketTransport('ws://x').disconnect()).not.toThrow();
  });
});
