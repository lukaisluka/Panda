import type { AnyMessage, Stream } from '@agentclientprotocol/sdk';
import type { AcpTransport } from './AcpTransport';
import { encodeMessage, LineAssembler, tryParseJsonLine } from './stdioFraming';
import type { StdioAgentConfig, StdioTransportFactory } from './stdioHost';

/**
 * A spawned stdio agent child, as the host sees it (issue #123). This is the
 * injection seam: the desktop host implements it over its process API
 * (Tauri commands), tests implement it over in-memory byte pipes, and this
 * module stays transport-pure — it knows NDJSON framing and lifecycle, not
 * process APIs.
 *
 * Contract: `onStdoutChunk`/`onExit` may be called at any time after the
 * spawn promise resolves (including during a pending `write`), `onExit` fires
 * exactly once, and `kill` is idempotent and resolves once the child is gone
 * (graceful first — SIGTERM, then SIGKILL after a grace period — is the
 * implementation's responsibility, mirroring test-agent's serve bridge).
 */
export interface StdioChildProcess {
  /** Writes one complete payload to the child's stdin. */
  write(data: string): Promise<void>;
  /** Raw stdout bytes; chunk boundaries carry no framing meaning. */
  onStdoutChunk(handler: (chunk: Uint8Array) => void): void;
  /** Process exit, exactly once; code null = terminated or unknown. */
  onExit(handler: (code: number | null) => void): void;
  /** Tears the child down; resolves once it is gone. Never throws. */
  kill(): Promise<void>;
}

/** Spawns one stdio agent child; rejection = connect failure. */
export type StdioSpawn = (config: StdioAgentConfig) => Promise<StdioChildProcess>;

/**
 * stdio ACP transport (issue #123): spawns the agent child and frames the
 * protocol over its stdin/stdout (NDJSON — see stdioFraming for why the
 * framing is ours and non-JSON lines are dropped, not answered). Lifecycle
 * mirrors WebSocketTransport: one instance serves exactly one connection
 * attempt, spawn failures reject `connect()` (the client reports them as
 * connect failures), the child's exit settles `onClose`, and `disconnect()`
 * kills the child.
 */
export class StdioTransport implements AcpTransport {
  private readonly config: StdioAgentConfig;
  private readonly spawn: StdioSpawn;
  private connected = false;
  private settled = false;
  private child: StdioChildProcess | null = null;
  private readController: ReadableStreamDefaultController<unknown> | null = null;
  private readonly assembler = new LineAssembler();
  private readonly closeHandlers = new Set<() => void>();
  private readonly errorHandlers = new Set<(err: Error) => void>();

  constructor(config: StdioAgentConfig, spawn: StdioSpawn) {
    this.config = config;
    this.spawn = spawn;
  }

  async connect(): Promise<Stream> {
    if (this.connected) {
      throw new Error('[panda/acp] StdioTransport.connect called twice on one instance');
    }
    this.connected = true;
    let child: StdioChildProcess;
    try {
      child = await this.spawn(this.config);
    } catch (err) {
      // A failed spawn is a failed open — same timing slot as an invalid
      // WebSocket URL rejecting in WebSocketTransport.connect.
      this.settle(toError(err));
      throw err;
    }
    this.child = child;
    child.onStdoutChunk((chunk) => {
      for (const line of this.assembler.push(chunk)) this.enqueueLine(line);
    });
    child.onExit((code) => {
      // A trailing unterminated line cannot be trusted (see LineAssembler);
      // surface it so the drop is diagnosable instead of silent.
      const tail = this.assembler.flush();
      if (tail) {
        console.warn(`[panda/acp:stdio] child exited with an unterminated stdout line (dropped): ${tail.slice(0, 200)}`);
      }
      try {
        this.readController?.close();
      } catch {
        // Already closed (consumer cancelled first) — the close is settled.
      }
      console.info(`[panda/acp:stdio] agent process exited with code ${code ?? 'null'}`);
      this.settle(undefined);
    });

    return {
      readable: new ReadableStream<AnyMessage>({
        start: (controller) => {
          this.readController = controller;
        },
        // The consumer cancelling the readable means the SDK connection is
        // done with the child — mutual teardown, like the serve bridge.
        cancel: () => {
          void this.killChild('readable cancelled');
        },
      }),
      writable: new WritableStream<AnyMessage>({
        write: async (message) => {
          try {
            await child.write(encodeMessage(message));
          } catch (err) {
            // A broken stdin is a broken connection — settle as an error and
            // let the writer's promise reject so the SDK sees it too.
            this.settle(toError(err));
            throw err;
          }
        },
      }),
    };
  }

  disconnect(): void {
    void this.killChild('disconnect');
    try {
      this.readController?.close();
    } catch {
      // Already closed by the exit path — nothing to do.
    }
  }

  onClose(handler: () => void): () => void {
    this.closeHandlers.add(handler);
    return () => this.closeHandlers.delete(handler);
  }

  onError(handler: (err: Error) => void): () => void {
    this.errorHandlers.add(handler);
    return () => this.errorHandlers.delete(handler);
  }

  /** One completed stdout line → the protocol stream (non-JSON dropped). */
  private enqueueLine(line: string): void {
    const parsed = tryParseJsonLine(line);
    if (!parsed.ok) {
      // The bridge's policy (serve.ts): some libraries print noise to stdout;
      // warn and drop rather than corrupt the protocol stream.
      console.warn(`[panda/acp:stdio] dropping non-JSON stdout line: ${line.slice(0, 200)}`);
      return;
    }
    try {
      // Wire-shape validation is the SDK connection's job (same stance as
      // the WS client, which enqueues JSON.parse output unvalidated).
      this.readController?.enqueue(parsed.value as AnyMessage);
    } catch (err) {
      console.warn('[panda/acp:stdio] enqueue after the stream closed — line dropped', err);
    }
  }

  private async killChild(where: string): Promise<void> {
    const child = this.child;
    if (!child) return;
    try {
      await child.kill();
    } catch (err) {
      console.warn(`[panda/acp:stdio] kill failed during ${where}`, err);
    }
  }

  /** First settlement wins: one close-or-error event per connection. */
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

/** Adapts a spawn capability into the factory stdioHost registers (issue
 * #121's seam): the desktop host calls this once at boot. */
export function createStdioTransportFactory(spawn: StdioSpawn): StdioTransportFactory {
  return (config) => new StdioTransport(config, spawn);
}

function toError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err));
}
