import { beforeEach, describe, expect, it, vi } from 'vitest';

const { createWebSocketStream } = vi.hoisted(() => ({
  createWebSocketStream: vi.fn(() => ({ readable: {}, writable: {} })),
}));

vi.mock('@agentclientprotocol/sdk/experimental/ws-client', () => ({
  createWebSocketStream,
}));

import { createBrowserWebSocketStream } from './browserWebSocketStream';

describe('createBrowserWebSocketStream', () => {
  beforeEach(() => createWebSocketStream.mockClear());

  it('omits the WebSocket subprotocol header by passing an empty protocol list', () => {
    createBrowserWebSocketStream('ws://127.0.0.1:8766/acp');

    expect(createWebSocketStream).toHaveBeenCalledWith('ws://127.0.0.1:8766/acp', {
      protocols: [],
    });
  });
});
