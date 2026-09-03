import type { Stream } from '@agentclientprotocol/sdk';
import type { AcpTransport } from './AcpTransport';

/**
 * Wraps an already-existing `Stream` as an `AcpTransport` (issue #20). This
 * is the test seam (in-memory stream pairs) and the future stdio shape (a
 * child's stdio IS a stream) — teardown stays with the stream's owner, so
 * `disconnect()` deliberately does nothing.
 */
export class StreamTransport implements AcpTransport {
  private readonly stream: Stream;
  private connected = false;

  constructor(stream: Stream) {
    this.stream = stream;
  }

  async connect(): Promise<Stream> {
    if (this.connected) {
      throw new Error('[panda/acp] StreamTransport.connect called twice on one instance');
    }
    this.connected = true;
    return this.stream;
  }

  disconnect(): void {
    // No-op by design: the constructor's caller owns the stream's teardown.
  }
}
