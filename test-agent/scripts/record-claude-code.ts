/**
 * Records the real Claude Code ACP adapter's wire traffic into replayable
 * JSON fixtures for Panda's contract tests (#154).
 *
 * Layer 1 of the claude-code test plan: one manual, paid run against
 * `npx @agentclientprotocol/claude-agent-acp` captures the true third-party
 * message shapes (initialize capabilities, a permission-gated edit turn,
 * session/list pagination, session/load replay, session/delete). Panda then
 * replays these bytes in CI forever after — protocol drift from adapter
 * upgrades shows up as a fixture diff.
 *
 * Usage (needs a logged-in `claude` CLI; spends a few cents of real tokens):
 *
 *   pnpm --filter panda-test-agent record:claude-code
 *
 * Output: test-agent/fixtures/claude-code/*.json (checked into the repo).
 * The agent package version is pinned in AGENT_PKG so re-records are
 * reproducible; bump it deliberately and review the fixture diff.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const AGENT_PKG = '@agentclientprotocol/claude-agent-acp@0.75.1';
const HERE = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(HERE, '..', 'fixtures', 'claude-code');
/** Recording sandbox: fixed path so fixtures carry no per-run noise. */
const CWD = '/tmp/panda-cc-record';

/** Raw wire JSON — fixtures store exactly what the adapter sent. */
type Wire = Record<string, unknown>;

type Pending = { resolve: (msg: Wire) => void; reject: (err: Error) => void };

class AcpRecorder {
  private child: ChildProcess;
  private buffer = '';
  private nextId = 1;
  private pending = new Map<number, Pending>();
  /** Server-initiated requests (permission/elicitation), in arrival order. */
  serverRequests: Wire[] = [];
  private serverRequestHandlers: { match: (msg: Wire) => boolean; respond: (msg: Wire) => Wire }[] = [];

  constructor() {
    const claudePath = spawnSync('zsh', ['-lc', 'command -v claude'], { encoding: 'utf8' }).stdout.trim();
    if (!claudePath) {
      throw new Error('`claude` CLI not found on PATH — log in first (claude /login)');
    }
    // Through a login shell: a bare `npx` spawn hung inside `npm exec`
    // (corepack resolution) in this environment; the shell's npx resolves
    // the cached install instantly.
    this.child = spawn('zsh', ['-lc', `exec npx -y ${AGENT_PKG}`], {
      env: {
        ...process.env,
        // Without this the adapter's own `claude` lookup can fail (spawn
        // error -88 observed on macOS) even though the CLI works in a shell.
        CLAUDE_CODE_EXECUTABLE: claudePath,
      },
      stdio: ['pipe', 'pipe', 'inherit'],
    });
    this.child.stdout!.setEncoding('utf8');
    this.child.stdout!.on('data', (chunk: string) => this.onChunk(chunk));
    this.child.on('exit', (code) => {
      for (const p of this.pending.values()) {
        p.reject(new Error(`agent exited (code ${code}) with ${this.pending.size} request(s) outstanding`));
      }
      this.pending.clear();
    });
  }

  private onChunk(chunk: string): void {
    this.buffer += chunk;
    let nl: number;
    while ((nl = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, nl).trim();
      this.buffer = this.buffer.slice(nl + 1);
      if (!line) continue;
      let msg: Wire;
      try {
        msg = JSON.parse(line) as Wire;
      } catch {
        continue; // non-JSON chatter (banner text) — not protocol
      }
      this.dispatch(msg);
    }
  }

  private dispatch(msg: Wire): void {
    if (typeof msg.id === 'number' && (msg.result !== undefined || msg.error !== undefined)) {
      // A response to one of our requests.
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      p.resolve(msg);
      return;
    }
    if (typeof msg.method === 'string' && typeof msg.id === 'number') {
      // A server-initiated request (permission, elicitation, ...).
      this.serverRequests.push(msg);
      const handler = this.serverRequestHandlers.find((h) => h.match(msg));
      if (!handler) {
        throw new Error(`unhandled server request: ${JSON.stringify(msg).slice(0, 200)}`);
      }
      const response = handler.respond(msg);
      this.send(response);
      return;
    }
    // A notification (session/update, session/info_update, ...) — recorded
    // by the caller through onNotification.
    this.notificationSink?.(msg);
  }

  private notificationSink: ((msg: Wire) => void) | null = null;

  /** Collects notifications until `until` turns true. */
  async notifications(until: () => boolean): Promise<Wire[]> {
    const collected: Wire[] = [];
    this.notificationSink = (msg) => collected.push(msg);
    while (!until()) await this.tick();
    this.notificationSink = null;
    return collected;
  }

  onServerRequest(match: (msg: Wire) => boolean, respond: (msg: Wire) => Wire): void {
    this.serverRequestHandlers.push({ match, respond });
  }

  private async tick(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }

  request(method: string, params: Wire, timeoutMs = 120_000): Promise<Wire> {
    const id = this.nextId++;
    const message: Wire = { jsonrpc: '2.0', id, method, params };
    return new Promise<Wire>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (msg) => {
          clearTimeout(timer);
          resolve(msg);
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        },
      });
      this.send(message);
    });
  }

  notify(method: string, params: Wire): void {
    this.send({ jsonrpc: '2.0', method, params });
  }

  private send(message: Wire): void {
    this.child.stdin!.write(JSON.stringify(message) + '\n');
  }

  close(): void {
    this.child.kill('SIGTERM');
  }
}

function writeFixture(name: string, value: unknown): void {
  const path = join(OUT_DIR, name);
  writeFileSync(path, JSON.stringify(value, null, 2) + '\n');
  console.info(`  wrote ${name}`);
}

async function main(): Promise<void> {
  rmSync(OUT_DIR, { recursive: true, force: true });
  mkdirSync(OUT_DIR, { recursive: true });
  rmSync(CWD, { recursive: true, force: true });
  mkdirSync(CWD, { recursive: true });
  writeFileSync(join(CWD, 'greeting.txt'), 'hello from panda probe\n');

  const rec = new AcpRecorder();
  // A permission request from the adapter is answered with its own first
  // option — the REQUEST shape is the fixture; our reply just unblocks it.
  rec.onServerRequest(
    (msg) => msg.method === 'session/request_permission',
    (msg) => {
      const options = ((msg.params as { options?: { optionId?: string }[] }) ?? {}).options ?? [];
      const chosen = options[0]?.optionId ?? '';
      return { jsonrpc: '2.0', id: msg.id as number, result: { outcome: { kind: 'selected', optionId: chosen } } };
    },
  );

  try {
    console.info('[1/6] initialize …');
    const initialize = await rec.request('initialize', {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
    });
    writeFixture('01-initialize.json', initialize);

    console.info('[2/6] session/new …');
    const newSession = await rec.request('session/new', { cwd: CWD, mcpServers: [] });
    if (newSession.error) throw new Error(`session/new failed: ${JSON.stringify(newSession.error)}`);
    writeFixture('02-session-new.json', newSession);
    const sessionId = (newSession.result as { sessionId: string }).sessionId;

    console.info('[3/6] session/prompt (real edit turn) …');
    let turnDone = false;
    const done = rec.notifications(() => turnDone);
    // Deliberately a pure file-edit turn: it completes without permission
    // pauses (a shell-command variant stalled the adapter's non-interactive
    // permission bootstrap in recording runs). The permission REQUEST shape
    // stays uncovered here on purpose — opt-in e2e can capture it live.
    const turnPromise = rec.request('session/prompt', {
      sessionId,
      prompt: [{ type: 'text', text: 'Read greeting.txt, then append the character ! to the end of the file. Reply with one short sentence.' }],
    }, 180_000);
    // A stopped prompt response is the turn's end; updates keep flowing in
    // parallel, so await the response then drain the recorded notifications.
    const turn = await turnPromise;
    if (turn.error) throw new Error(`session/prompt failed: ${JSON.stringify(turn.error)}`);
    turnDone = true;
    const updates = await done;
    writeFixture('03-turn.json', { promptResponse: turn, updates });

    console.info('[4/6] session/list …');
    const list = await rec.request('session/list', { cursor: null });
    writeFixture('04-session-list.json', list);

    console.info('[5/6] session/load (resume replay) …');
    let loadDone = false;
    const loadNotifications = rec.notifications(() => loadDone);
    const load = await rec.request('session/load', { sessionId, cwd: CWD, mcpServers: [] });
    if (load.error) throw new Error(`session/load failed: ${JSON.stringify(load.error)}`);
    loadDone = true;
    const replayed = await loadNotifications;
    writeFixture('05-session-load.json', { loadResponse: load, replayedUpdates: replayed });

    console.info('[6/6] session/delete …');
    const del = await rec.request('session/delete', { sessionId });
    writeFixture('06-session-delete.json', del);

    const claudeVersion = spawnSync('zsh', ['-lc', 'claude --version'], { encoding: 'utf8' }).stdout.trim();
    writeFixture('00-meta.json', {
      agentPackage: AGENT_PKG,
      claudeCli: claudeVersion,
      recordedAt: new Date().toISOString(),
      note: 'Recorded from a live adapter run; shapes are the contract, ids/paths/timestamps are per-run.',
    });
    console.info('recording complete →', OUT_DIR);
  } finally {
    rec.close();
  }
}

main().catch((err) => {
  console.error('[record-claude-code] FAILED:', err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
