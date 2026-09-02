import { createWebSocketStream } from '@agentclientprotocol/sdk/experimental/ws-client';

/**
 * Creates the browser ACP transport without requesting a WebSocket subprotocol.
 *
 * Passing `undefined` as the native WebSocket constructor's second argument is
 * observable in Chromium as a non-empty `Sec-WebSocket-Protocol` request. The
 * ACP bridge does not negotiate a subprotocol, so Chromium rejects an otherwise
 * successful upgrade. An explicit empty list preserves the intended no-protocol
 * handshake across browser and Node WebSocket implementations.
 */
export function createBrowserWebSocketStream(serverUrl: string) {
  return createWebSocketStream(serverUrl, { protocols: [] });
}
