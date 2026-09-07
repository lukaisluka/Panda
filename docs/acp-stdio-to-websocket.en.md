# Bridging a stdio agent to WebSocket: web integration guide

For developers and self-hosters who want to use an existing stdio ACP agent with the Panda web app. Most agents in the ACP ecosystem are stdio-only (claude-agent-acp, gemini-cli, and friends), while the web app is a pure WebSocket client — it never spawns processes and only connects to services that are already running. This guide covers the standard seam between the two: a dumb bridge of a few dozen lines. As of writing, ACP has no officially blessed bridge tool (the proxy mechanism is still a proposal), and generic tools tend to hit the framing trap in §1, so this guide gives the recipe directly.

Desktop users don't need this: the desktop shell has its own stdio process plane — just configure the command (see the [user guide (Chinese)](user-guide.md)).

> Chinese version: [acp-stdio-to-websocket.md](acp-stdio-to-websocket.md). The Chinese version is the source of truth; keep both in sync.

- The protocol contract (method surface, capability declarations, timeout budgets) lives in the [ACP agent integration contract (Chinese)](acp-agent-requirements.md). The bridge sits below the transport layer and never parses the protocol; protocol correctness is entirely the agent's job.
- Reference implementation: [`test-agent/src/serve.ts`](../test-agent/src/serve.ts) — the repo's production-grade bridge (non-JSON line filtering, graceful shutdown, orphan reaping). The minimal version in §3 is carved from it.
- Source of truth for the client-side WebSocket conventions: [`src/acp/browserWebSocketStream.ts`](../src/acp/browserWebSocketStream.ts).

## 0. The bridge's three jobs

One WebSocket connection = one stdio agent child process; the bridge is a dumb relay:

| # | Job | Essence |
| --- | --- | --- |
| 1 | Frame → line | Append `\n` to each incoming text frame and write it to the child's stdin |
| 2 | Line → frame | Split the child's stdout by line; emit one text frame per complete line |
| 3 | Lifecycle | Connection closed → terminate the child; child exited → close the connection |

Everything else (protocol parsing, session management) is not the bridge's job — the only exception is the security requirements in §5.

## 1. Frame mapping: byte piping is not enough

The two wire forms frame messages differently: stdio is **line-delimited** (one JSON-RPC message per line), WebSocket is **frame-is-message** (exactly one message per text frame). Forwarding the child's stdout as an opaque byte stream is wrong:

- One TCP read cycle can yield "one and a half" messages: byte piping splits a message across two frames or glues two messages into one;
- The client `JSON.parse`s each frame as a whole; glued and split frames both fail to parse, and the connection is torn down with an error.

So job #2 in the §0 table must be done explicitly: buffer stdout, split on `\n`, send one frame per complete line. Two practical details the reference implementation handles:

- **Filter non-JSON lines**: some dependencies misbehave and print logs to stdout. Filter by "does it `JSON.parse`" and log what you drop — one bad line must not corrupt the protocol stream.
- **Forward stderr as-is**: the child's stderr is not a protocol channel; pass it through to the bridge's own terminal to stay observable.

## 2. Connection and handshake conventions

- **Subprotocol**: Panda explicitly connects with an **empty subprotocol**. The bridge must not require a subprotocol, or the browser rejects the upgrade handshake outright — a successful upgrade thrown away.
- **Path**: ACP does not constrain the path; `ws://host:port/acp` or any path works.
- **Message size limit**: raise the per-frame limit (the reference implementation uses 16 MiB) — tool-call `rawOutput` can be large, and default limits truncate on big turns.
- **One connection carries many sessions**: session switches (`session/resume` / `session/load`) happen inside the same connection; the bridge needs to understand nothing, just stay up.

## 3. Minimal bridge implementation

Prerequisites: Node ≥ 18 and `ws` v8 (`npm install ws`). Save as `bridge.mjs`:

```js
// Usage: node bridge.mjs <command> [args...]
// Example: node bridge.mjs npx -y @agentclientprotocol/claude-agent-acp
import { spawn } from 'node:child_process';
import { WebSocketServer } from 'ws';

const [command, ...args] = process.argv.slice(2);
if (!command) {
  console.error('usage: node bridge.mjs <command> [args...]');
  process.exit(1);
}

const HOST = '127.0.0.1'; // localhost only by default, see §5
const wss = new WebSocketServer({ host: HOST, port: 8765, maxPayload: 16 * 1024 * 1024 });

wss.on('connection', (socket) => {
  const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'inherit'] }); // stderr passthrough
  log(`connection in: started ${command} (pid ${child.pid})`);

  socket.on('message', (data, isBinary) => {
    if (!isBinary && child.stdin && !child.stdin.destroyed) {
      child.stdin.write(`${data.toString('utf8')}\n`); // frame → line
    }
  });

  let buffer = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    let nl;
    while ((nl = buffer.indexOf('\n')) !== -1) { // line → frame
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      if (isJson(line)) socket.send(line);
      else log(`dropping non-JSON stdout line: ${line.slice(0, 200)}`);
    }
  });

  socket.once('close', () => child.kill());
  child.once('exit', (code) => socket.close(code === 0 ? 1000 : 1011, 'agent process exited'));
});

function isJson(text) {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}
function log(message) {
  process.stderr.write(`[${new Date().toISOString()}] bridge: ${message}\n`);
}
```

Run it, then enter `ws://127.0.0.1:8765/acp` in the web app's connect form. The first request the client sends after connecting is `initialize` — from that point on, everything belongs to the [integration contract (Chinese)](acp-agent-requirements.md).

This is the teaching-grade minimum: no graceful shutdown (SIGTERM before SIGKILL), no orphan reaping at shutdown. For production use, follow (or reuse) [`test-agent/src/serve.ts`](../test-agent/src/serve.ts).

## 4. wss: when you need it and how to set it up

There is exactly one rule: **a page opened over `https://` is forbidden from making `ws://` connections** (mixed-content blocking), so it must use `wss://`. Local development (`http://localhost`, or any `http://` page) is fine with `ws://`; the official GitHub Pages deployment of the web app is HTTPS and can only reach `wss://` endpoints.

The bridge itself doesn't need to speak TLS — the cheapest path is terminating TLS at a reverse proxy while the bridge keeps speaking plain ws:

**Caddy** (automatic certificates, WebSocket proxying out of the box):

```text
agent.example.com {
    reverse_proxy 127.0.0.1:8765
}
```

**nginx** (Upgrade handling must be explicit):

```text
location / {
    proxy_pass http://127.0.0.1:8765;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
}
```

Then enter `wss://agent.example.com/acp` in the connect form. Note that **wss only addresses eavesdropping and tampering; it is not authentication** — anyone who has the address can still connect. See the next section.

## 5. Security red lines

A stdio agent is a locally trusted process, which usually means **arbitrary command execution**; bridging it onto a network opens that capability to whoever can reach the listener. Four rules:

1. **Bind `127.0.0.1` by default** (the §3 minimal version does). Before listening on `0.0.0.0`, confirm you actually need to.
2. **Prefer tunnels over open listeners for remote access**: `ssh -L 8765:127.0.0.1:8765`, or a private network like Tailscale, keeps the agent endpoint invisible to the public internet.
3. **When you must expose it, authenticate at the bridge or the proxy** — and know the protocol reality: **browser WebSockets cannot carry custom headers** (no `Authorization`), so a token can only travel via URL query (e.g. `wss://…/acp?token=…`; Panda's address field accepts URLs with query strings as-is, and the bridge validates on connect) or via an IP allowlist at the proxy.
4. **Use a real certificate for TLS**: the browser offers no "proceed anyway" escape hatch for a failed WebSocket handshake. A self-signed certificate only works if you first visit `https://host:port` and manually accept the exception; a Let's Encrypt certificate (Caddy's default) or a tunnel is less grief.

## 6. The generic-tool trap

Using an off-the-shelf generic WebSocket tool (websocat, wscat, and the like) as the bridge is tempting. Before choosing one, confirm a single thing: **does it map each line of the child's stdout to its own WebSocket message** (and vice versa)? Byte-piping relays hit the §1 trap — gluing and splitting within TCP read cycles makes the client disconnect on JSON parse failures. If the tool has no line-framing mode, go back to the §3 script.

## 7. Verification

- Fastest end-to-end check: start the bridge → enter the address in the connect form → after connecting, the sidebar should show the agent's name (from `initialize`'s `agentInfo`); send a message and watch the streamed reply.
- For a known-good endpoint to compare against, the repo's test agent runs behind a bridge of the same shape: `pnpm --filter panda-test-agent serve` (default `ws://127.0.0.1:8766/acp`).
