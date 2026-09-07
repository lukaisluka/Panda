import { Channel, invoke } from '@tauri-apps/api/core';
import {
  createStdioTransportFactory,
  type StdioChildProcess,
  type StdioSpawn,
} from '../acp/transport/StdioTransport';
import { setStdioTransportFactory } from '../acp/transport/stdioHost';

/**
 * Desktop host boot (issue #125), loaded lazily by main.tsx when
 * `__TAURI_INTERNALS__` is present — this module (and with it
 * `@tauri-apps/api`) lives in its own chunk, so the browser bundle never
 * carries it. Its whole job: adapt the shell's process-plane IPC
 * (stdio_spawn / stdio_write / stdio_kill + a Channel of base64 chunks) into
 * the `StdioSpawn` seam and register the factory that opens stdio
 * connections (PR #123's transport does the rest).
 */

/** Mirror of the Rust StdioEvent enum (desktop/src-tauri/src/main.rs). */
type StdioEvent =
  | { type: 'stdout'; data: string }
  | { type: 'stderr'; data: string }
  | { type: 'exit'; code: number | null };

/** base64 → bytes; chunk boundaries survive (Rust encodes whole chunks). */
function decodeBase64(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/**
 * The spawn seam over Tauri IPC. Events can beat the subscriber: the child
 * may write (or die) before StdioTransport registers its handlers, so chunks
 * arriving early are buffered and flushed on first subscription — ordering
 * within the stream is preserved either way.
 */
function tauriStdioSpawn(): StdioSpawn {
  return ({ program, args, cwd }) => {
    const stdoutHandlers: Array<(chunk: Uint8Array) => void> = [];
    const exitHandlers: Array<(code: number | null) => void> = [];
    let stdoutSink: ((chunk: Uint8Array) => void) | null = null;
    let exitSink: ((code: number | null) => void) | null = null;
    const earlyChunks: Uint8Array[] = [];
    let earlyExit: { delivered: boolean; code: number | null } | null = null;

    const channel = new Channel<StdioEvent>();
    channel.onmessage = (event) => {
      switch (event.type) {
        case 'stdout': {
          const chunk = decodeBase64(event.data);
          if (stdoutSink) stdoutSink(chunk);
          else earlyChunks.push(chunk);
          return;
        }
        case 'stderr':
          // Agent logs stay observable: the packaged app has no console to
          // inherit stderr into, so it surfaces here (devtools ring included).
          console.info('[agent:stderr]', new TextDecoder().decode(decodeBase64(event.data)));
          return;
        case 'exit': {
          if (exitSink) exitSink(event.code);
          else earlyExit = { delivered: false, code: event.code };
          return;
        }
      }
    };

    return (async () => {
      const id = await invoke<number>('stdio_spawn', { program, args, cwd, onEvent: channel });
      const child: StdioChildProcess = {
        write: (data) => invoke('stdio_write', { id, data }),
        onStdoutChunk: (handler) => {
          stdoutHandlers.push(handler);
          if (!stdoutSink) {
            stdoutSink = handler;
            for (const chunk of earlyChunks.splice(0)) handler(chunk);
          }
        },
        onExit: (handler) => {
          exitHandlers.push(handler);
          if (!exitSink) {
            exitSink = handler;
            if (earlyExit && !earlyExit.delivered) {
              earlyExit.delivered = true;
              handler(earlyExit.code);
            }
          }
        },
        kill: async () => {
          try {
            await invoke('stdio_kill', { id });
          } catch (err) {
            // The transport's contract: kill never throws. Unknown id is a
            // benign race (process already exited); anything else stays loud.
            console.warn(`[panda/desktop] stdio_kill(${id}) failed`, err);
          }
        },
      };
      return child;
    })();
  };
}

/** Registers the desktop host's stdio capability. Idempotent by effect. */
export function bootDesktop(): void {
  setStdioTransportFactory(createStdioTransportFactory(tauriStdioSpawn()));
  console.info('[panda/desktop] stdio transport factory registered (desktop host)');
}
