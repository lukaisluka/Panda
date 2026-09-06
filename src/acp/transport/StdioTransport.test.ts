import { describe, expect, it, vi } from 'vitest';
import { StdioTransport, type StdioChildProcess, type StdioSpawn } from './StdioTransport';
import { createStdioTransportFactory } from './StdioTransport';
import { setStdioTransportFactory } from './stdioHost';

const encoder = new TextEncoder();

/** In-memory byte pipe standing in for a spawned child (the test seam). */
class FakeChild implements StdioChildProcess {
  readonly written: string[] = [];
  readonly kill = vi.fn(async () => {});
  private stdoutHandlers: Array<(chunk: Uint8Array) => void> = [];
  private exitHandlers: Array<(code: number | null) => void> = [];

  write = vi.fn(async (data: string): Promise<void> => {
    this.written.push(data);
  });
  onStdoutChunk(handler: (chunk: Uint8Array) => void): void {
    this.stdoutHandlers.push(handler);
  }
  onExit(handler: (code: number | null) => void): void {
    this.exitHandlers.push(handler);
  }

  /** Test drivers: feed stdout bytes / exit the child. */
  feed(text: string): void {
    for (const handler of this.stdoutHandlers) handler(encoder.encode(text));
  }
  exit(code: number | null): void {
    for (const handler of this.exitHandlers) handler(code);
  }
}

const spawnOk = (): { spawn: StdioSpawn; child: FakeChild } => {
  const child = new FakeChild();
  return { spawn: vi.fn(async () => child), child };
};

const config = { program: 'node', args: ['agent.js'], cwd: '/w' };

describe('StdioTransport', () => {
  it('frames stdout lines into protocol messages and writes newline JSON', async () => {
    const { spawn, child } = spawnOk();
    const transport = new StdioTransport(config, spawn);
    const stream = await transport.connect();

    child.feed('{"id":1,"result":{"ok":true}}\n{"id":2');
    child.feed(',"result":{"ok":false}}\n');
    const reader = stream.readable.getReader();
    await expect(reader.read()).resolves.toEqual({ done: false, value: { id: 1, result: { ok: true } } });
    await expect(reader.read()).resolves.toEqual({ done: false, value: { id: 2, result: { ok: false } } });

    const writer = stream.writable.getWriter();
    await writer.write({ method: 'ping', id: 7 } as never);
    expect(child.written).toEqual(['{"method":"ping","id":7}\n']);
  });

  it('drops non-JSON stdout lines with a warning instead of corrupting the stream', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { spawn, child } = spawnOk();
    const transport = new StdioTransport(config, spawn);
    const stream = await transport.connect();

    child.feed('some library banner\n{"id":1}\n');
    const reader = stream.readable.getReader();
    await expect(reader.read()).resolves.toEqual({ done: false, value: { id: 1 } });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('non-JSON stdout line'));
    warn.mockRestore();
  });

  it('rejects connect() on spawn failure and reports onError', async () => {
    const failure = new Error('ENOENT: node');
    const spawn: StdioSpawn = vi.fn(async () => {
      throw failure;
    });
    const transport = new StdioTransport(config, spawn);
    const errors: Error[] = [];
    transport.onError((err) => errors.push(err));
    await expect(transport.connect()).rejects.toBe(failure);
    expect(errors).toEqual([failure]);
  });

  it('child exit closes the readable and fires onClose exactly once', async () => {
    const { spawn, child } = spawnOk();
    const transport = new StdioTransport(config, spawn);
    const stream = await transport.connect();
    const closes: number[] = [];
    transport.onClose(() => closes.push(1));

    child.exit(0);
    child.exit(1); // a second exit event must not double-settle
    await expect(stream.readable.getReader().read()).resolves.toEqual({ done: true });
    expect(closes).toHaveLength(1);
  });

  it('warns about an unterminated tail line when the child dies mid-write', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { spawn, child } = spawnOk();
    const transport = new StdioTransport(config, spawn);
    await transport.connect();

    child.feed('{"partial');
    child.exit(null);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('unterminated stdout line'));
    warn.mockRestore();
  });

  it('fails loudly on a second connect and kill()s the child on disconnect', async () => {
    const { spawn, child } = spawnOk();
    const transport = new StdioTransport(config, spawn);
    await transport.connect();
    await expect(transport.connect()).rejects.toThrow('called twice');

    transport.disconnect();
    expect(child.kill).toHaveBeenCalledTimes(1);
  });

  it('kills the child when the consumer cancels the readable', async () => {
    const { spawn, child } = spawnOk();
    const transport = new StdioTransport(config, spawn);
    const stream = await transport.connect();

    await stream.readable.cancel();
    await vi.waitFor(() => expect(child.kill).toHaveBeenCalledTimes(1));
  });

  it('createStdioTransportFactory adapts a spawn into the stdioHost factory', async () => {
    const { spawn, child } = spawnOk();
    setStdioTransportFactory(createStdioTransportFactory(spawn));
    try {
      const { getStdioTransportFactory } = await import('./stdioHost');
      const factory = getStdioTransportFactory()!;
      const transport = factory({ program: 'node', args: ['x.js'], cwd: '/c' });
      await transport.connect();
      expect(spawn).toHaveBeenCalledWith({ program: 'node', args: ['x.js'], cwd: '/c' });
      expect(child.written.length).toBe(0); // nothing written until the SDK speaks
    } finally {
      setStdioTransportFactory(null);
    }
  });
});
