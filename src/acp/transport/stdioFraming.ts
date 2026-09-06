/**
 * NDJSON framing for the stdio transport (issue #123): bytes in → JSON-RPC
 * message objects out, message objects in → `JSON.stringify + '\n'` out.
 *
 * Why not the SDK's `ndJsonStream`: it answers an unparseable line with a
 * JSON-RPC parse-error response, which pollutes the protocol stream the
 * moment any ill-behaved library prints noise to the child's stdout. The
 * WS↔stdio bridge (test-agent/src/serve.ts) made the opposite call — drop the
 * line, warn — and production stdio follows the bridge (a dropped line is
 * diagnosable via the warning; a bogus parse-error response is protocol
 * corruption). The SDK's own `LineBuffer` is not part of the package's
 * exports, so the line splitting lives here.
 */

/** Incrementally splits an outbound byte stream into newline-terminated
 * lines. Decoding is streaming (TextDecoder in stream mode), so a chunk
 * boundary inside a multi-byte UTF-8 sequence is stitched across pushes. */
export class LineAssembler {
  private pending = '';
  private readonly decoder = new TextDecoder('utf-8');

  /** Feeds one stdout chunk; returns every line it completed (without its
   * trailing newline). A partial tail is retained until its line completes. */
  push(chunk: Uint8Array): string[] {
    this.pending += this.decoder.decode(chunk, { stream: true });
    const lines = this.pending.split('\n');
    this.pending = lines.pop() ?? '';
    return lines.map((line) => line.trim()).filter((line) => line.length > 0);
  }

  /**
   * Ends the stream. Returns null — a trailing UNTERMINATED line is dropped
   * by design: a child that died mid-write cannot be trusted to have written
   * a complete JSON-RPC message, and half a message on the wire is worse than
   * none. The caller warns so the drop is diagnosable.
   */
  flush(): string | null {
    const tail = (this.pending + this.decoder.decode()).trim();
    this.pending = '';
    return tail.length > 0 ? tail : null;
  }
}

export type ParsedLine = { ok: true; value: unknown } | { ok: false; raw: string };

/** Parses one completed line as JSON; non-objects (numbers, strings) parse
 * fine and are the caller's to reject — the ACP wire only carries objects. */
export function tryParseJsonLine(line: string): ParsedLine {
  try {
    return { ok: true, value: JSON.parse(line) };
  } catch {
    return { ok: false, raw: line };
  }
}

/** Serializes one outgoing message for the child's stdin: one JSON object per
 * line, newline-terminated. */
export function encodeMessage(message: unknown): string {
  return `${JSON.stringify(message)}\n`;
}
