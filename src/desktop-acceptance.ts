/**
 * Desktop-shell acceptance driver (dev-only companion to
 * desktop-acceptance.html, issue #125). See that file for the launch shape.
 *
 * Why a page at all: the WKWebView exposes no automation surface (no AX
 * tree, no remote debugging), so shell acceptance needs an in-page driver.
 * This one exercises exactly the code the shell adds — the boot module's
 * factory registration and the Tauri process plane behind it — through the
 * same call shape liveConnections uses, against a real test-agent child.
 * The UI layer above (profile form, session screen) is covered by the
 * browser test suite and needs no duplication here.
 */
import { LiveAcpClient, type LiveClientHandlers } from './acp/LiveAcpClient';
import type { AcpSessionUpdate, SessionStatus } from './protocol/types';
import {
  getStdioTransportFactory,
  type StdioAgentConfig,
} from './acp/transport/stdioHost';
import { bootDesktop } from './desktop/boot';

const REPORT_KEY = 'panda.acceptance';

const params = new URLSearchParams(location.search);
const agentDir = params.get('agent');
const sandbox = params.get('sandbox') ?? '/tmp/panda-desktop-accept';
const state = params.get('state') ?? '/tmp/panda-desktop-accept-state';

type Step = { name: string; status: 'pass' | 'fail'; detail?: string };

function report(finished: boolean, error: string | null, steps: Step[]): void {
  const payload = JSON.stringify({ finished, error, steps });
  try {
    localStorage.setItem(REPORT_KEY, payload);
  } catch {
    // Private-mode style failure would only cost the slow oracle; title still reports.
  }
  document.title = finished
    ? `panda-acceptance:${error ? 'FAILED' : 'PASSED'}`
    : `panda-acceptance:running(${steps.filter((s) => s.status === 'pass').length}/${steps.length})`;
}

const steps: Step[] = [];

function log(line: string): void {
  const pre = document.getElementById('log');
  if (pre) pre.textContent += line + '\n';
  console.info('[acceptance]', line);
}

function mark(name: string, detail?: string): void {
  steps.push({ name, status: 'pass', detail });
  log(`PASS ${name}${detail ? ` — ${detail}` : ''}`);
  report(false, null, steps);
}

function fail(name: string, detail: string): void {
  steps.push({ name, status: 'fail', detail });
  log(`FAIL ${name} — ${detail}`);
  report(true, `${name}: ${detail}`, steps);
}

function waitFor(predicate: () => boolean, timeoutMs: number, what: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (predicate()) return resolve();
      if (Date.now() > deadline) return reject(new Error(`waitFor timed out: ${what}`));
      setTimeout(tick, 50);
    };
    tick();
  });
}

async function run(): Promise<void> {
  report(false, null, steps);
  if (!agentDir) {
    fail('config', 'missing ?agent=<test-agent dir> query parameter');
    return;
  }
  log(`agent=${agentDir} sandbox=${sandbox} state=${state}`);

  // Step 1: the production boot registers the desktop factory.
  bootDesktop();
  const factory = getStdioTransportFactory();
  if (!factory) {
    fail('boot', 'no stdio transport factory after bootDesktop()');
    return;
  }
  mark('boot', 'factory registered (desktop host)');

  // Step 2: connect through the factory exactly as liveConnections does.
  const config: StdioAgentConfig = {
    program: 'pnpm',
    args: ['--dir', agentDir, 'stdio', '--sandbox-dir', sandbox, '--state-dir', state],
    // Rust sets current_dir(cwd); it must exist before the agent seeds the sandbox.
    cwd: '/tmp',
  };
  const transport = factory(config);
  let closed = false;
  transport.onClose?.(() => {
    closed = true;
  });

  const updates: AcpSessionUpdate[] = [];
  const statuses: SessionStatus[] = [];
  const sessionIds: string[] = [];
  const handlers: LiveClientHandlers = {
    onUpdate: (update) => {
      updates.push(update);
      if (update.sessionUpdate === 'status_changed') statuses.push(update.status);
    },
    onSessionModes: () => {},
    onSessionConfigOptions: () => {},
    onConnected: () => {},
    onSessionId: (sessionId) => sessionIds.push(sessionId),
    onDisconnected: () => {},
    onAuthChallenge: () => {},
    onAuthElicitation: () => {},
    onAuthMethods: () => {},
    onAuthenticated: () => {},
    onCapabilities: () => {},
    onSessions: () => {},
    onSessionInfo: () => {},
    onReplayStart: () => {},
    onSessionDeleted: () => {},
    onSessionSwitchStage: () => {},
    onSessionSwitchCommit: () => {},
    onSessionSwitchRollback: () => {},
  };
  const client = new LiveAcpClient(handlers);

  try {
    await client.connect(transport, '/tmp/project');
    mark('connect', 'initialize over stdio through the Tauri process plane');

    await client.newSession('/tmp/project');
    if (sessionIds.length === 0) throw new Error('no session id received');
    mark('newSession', `sessionId=${sessionIds[0]}`);

    // The scripted turn 1 runs edit_file/execute; accept_everything keeps the
    // run deterministic instead of waiting on permission-card approvals.
    await client.setMode('accept_everything');

    await client.send([{ type: 'text', text: '重构 auth 校验' }]);
    await waitFor(
      () => statuses.at(-1) === 'idle' && updates.some((u) => u.sessionUpdate === 'agent_message_chunk'),
      90_000,
      'turn completion (idle + at least one agent message)',
    );
    const text = updates
      .filter((u) => u.sessionUpdate === 'agent_message_chunk' && u.content.type === 'text')
      .map((u) => (u.sessionUpdate === 'agent_message_chunk' && u.content.type === 'text' ? u.content.text : ''))
      .join('');
    if (!text.includes('剧本到此播放完毕')) {
      throw new Error(`final message missing scripted ending; got: ${text.slice(-200)}`);
    }
    if (!updates.some((u) => u.sessionUpdate === 'tool_call')) {
      throw new Error('no tool_call update observed');
    }
    const kinds = [
      ...new Set(updates.filter((u) => u.sessionUpdate === 'tool_call').map((u) => (u.sessionUpdate === 'tool_call' ? (u.kind ?? 'unclassified') : ''))),
    ];
    mark('turn', `agent message + tool calls over stdio (tool kinds: ${kinds.join(',')})`);

    // Step 3: disconnect must kill the child (the orphan contract).
    client.disconnect();
    await waitFor(() => closed, 10_000, 'transport onClose after disconnect');
    mark('disconnect', 'transport closed — child killed, no orphan');
    report(true, null, steps);
    log('ACCEPTANCE PASSED');
  } catch (err) {
    fail('acceptance', err instanceof Error ? err.message : String(err));
    client.disconnect();
  }
}

void run();
