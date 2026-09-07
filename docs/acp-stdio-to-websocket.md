# 把 stdio agent 桥接到 WebSocket:网页版接入指南

面向想让 Panda 网页版用上现有 stdio ACP agent 的开发者与自托管用户。ACP 生态里的 agent 绝大多数只有 stdio 形态(claude-agent-acp、gemini-cli 等皆然),而网页版是纯 WebSocket 客户端——从不拉起进程,只连接已在运行的服务。本文给出两者之间的标准衔接:一个几十行的哑桥。截至撰写,ACP 官方尚未提供钦定的桥工具(proxy 机制仍在提案阶段),通用工具又常踩 §1 的成帧坑,因此这里直接给配方。

桌面版用户不需要本文:桌面壳自带 stdio 进程平面,直接配置命令即可(见[使用指南](user-guide.md))。

> 英文版:[acp-stdio-to-websocket.en.md](acp-stdio-to-websocket.en.md)。中文版为事实源,两版需同步更新。

- 协议契约(方法面、能力声明、超时预算)另见 [ACP agent 接入契约](acp-agent-requirements.md)。桥在传输层之下,不解析协议;协议正确性完全由 agent 自己负责。
- 参考实现:[`test-agent/src/serve.ts`](../test-agent/src/serve.ts)——仓库自带的生产级桥(非 JSON 行过滤、优雅关闭、孤儿回收),§3 的最小版由它裁剪而来。
- 客户端 WebSocket 侧约定的事实源:[`src/acp/browserWebSocketStream.ts`](../src/acp/browserWebSocketStream.ts)。

## 0. 桥要做的三件事

一条 WebSocket 连接 = 一个 stdio agent 子进程,桥只做哑转发:

| # | 事项 | 要点 |
| --- | --- | --- |
| 1 | 帧 → 行 | 每收到一个文本帧,补 `\n` 后写入子进程 stdin |
| 2 | 行 → 帧 | 子进程 stdout 按行拆分,每凑满一行发一个文本帧 |
| 3 | 生命周期 | 连接断开 → 终止子进程;子进程退出 → 关闭连接 |

三件之外(协议解析、会话管理)都不是桥的职责——唯一的例外是 §5 的安全要求。

## 1. 帧映射:不能字节直通

两种线上形态的成帧规则不同:stdio 是**行分隔**(每行一条 JSON-RPC 消息),WebSocket 是**帧即消息**(每个文本帧恰好一条)。把子进程 stdout 当字节流原样转发是错的:

- 一个 TCP 读周期可能读出「一条半」消息:字节直通会把一条消息拆进两帧、或把两条拼进一帧;
- 客户端对每个帧整体做 `JSON.parse`,拼帧与拆帧都会解析失败,连接随即报错拆除。

所以 §0 表里的第 2 件事必须显式做:在 stdout 上维护缓冲区、按 `\n` 切分,每凑满一行发一帧。另外两个实务细节,参考实现都处理了:

- **过滤非 JSON 行**:有些依赖库不守规矩往 stdout print 日志。按「能否 `JSON.parse`」过滤并记录,别让一条坏行破坏协议流。
- **stderr 原样透传**:子进程的 stderr 不是协议通道,透传到桥自己的终端,保持可观测。

## 2. 连接与握手约定

- **子协议**:Panda 显式以**空 subprotocol** 建立 WebSocket 连接。桥不得强制要求 subprotocol,否则浏览器会直接拒绝升级握手——一次本可成功的升级被报废。
- **路径**:ACP 不限定路径,`ws://host:port/acp` 或任意路径均可。
- **消息上限**:建议放大单帧上限(参考实现取 16 MiB)——工具卡的 `rawOutput` 可能相当大,默认上限容易在大回合上截断。
- **一条连接承载多个会话**:会话切换(`session/resume` / `session/load`)发生在同一条连接内,桥无须理解,只要别断。

## 3. 最小桥实现

前置:Node ≥ 18 与 `ws` v8(`npm install ws`)。存为 `bridge.mjs`:

```js
// 用法:node bridge.mjs <command> [args...]
// 例:node bridge.mjs npx -y @agentclientprotocol/claude-agent-acp
import { spawn } from 'node:child_process';
import { WebSocketServer } from 'ws';

const [command, ...args] = process.argv.slice(2);
if (!command) {
  console.error('用法: node bridge.mjs <command> [args...]');
  process.exit(1);
}

const HOST = '127.0.0.1'; // 默认只绑本机,见 §5
const wss = new WebSocketServer({ host: HOST, port: 8765, maxPayload: 16 * 1024 * 1024 });

wss.on('connection', (socket) => {
  const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'inherit'] }); // stderr 透传
  log(`连接进入:${command}(pid ${child.pid})已启动`);

  // 子进程死亡后在途帧的写入会异步触发 EPIPE;stdin 不挂 error handler
  // 的话,unhandled 'error' event 会炸掉整个桥进程,连坐其它健康连接。
  child.stdin.on('error', (err) => {
    if (err.code !== 'EPIPE') log(`stdin 写入失败:${err}`);
  });

  socket.on('message', (data, isBinary) => {
    if (!isBinary && child.stdin && !child.stdin.destroyed) {
      child.stdin.write(`${data.toString('utf8')}\n`); // 帧 → 行
    }
  });

  let buffer = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    let nl;
    while ((nl = buffer.indexOf('\n')) !== -1) { // 行 → 帧
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      if (isJson(line)) socket.send(line);
      else log(`丢弃子进程的非 JSON stdout 行: ${line.slice(0, 200)}`);
    }
  });

  socket.once('close', () => child.kill());
  child.once('exit', (code) => socket.close(code === 0 ? 1000 : 1011, 'agent 进程退出'));
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

跑起来后,在网页版连接表单填 `ws://127.0.0.1:8765/acp` 即可。建连后客户端发出的第一个请求是 `initialize`——到这一步,剩下的事全部属于[接入契约](acp-agent-requirements.md)的范围。

这是教学用最小版:没有优雅关闭(SIGTERM 先礼后兵)、没有关停时的孤儿回收。生产用法直接参照(或复用)[`test-agent/src/serve.ts`](../test-agent/src/serve.ts)。

## 4. wss:什么时候需要,怎么配

判定规则只有一条:**页面经 `https://` 打开时,浏览器禁止它发起 `ws://` 连接**(混合内容拦截),必须用 `wss://`。本地开发(`http://localhost` 或 `http://` 打开的页面)用 `ws://` 即可;官方部署在 GitHub Pages 上的网页版是 HTTPS,只能连 `wss://` 端点。

桥自身不需要懂 TLS——最省事的路径是让反向代理终止 TLS,桥照旧只说 ws:

**Caddy**(自动申请证书,WebSocket 反代开箱即用):

```text
agent.example.com {
    reverse_proxy 127.0.0.1:8765
}
```

**nginx**(需要显式处理 Upgrade):

```text
location / {
    proxy_pass http://127.0.0.1:8765;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
}
```

之后在连接表单填 `wss://agent.example.com/acp`。注意 **wss 只解决窃听与篡改,不构成鉴权**——任何拿到地址的人依然能连,见下一节。

## 5. 安全红线

stdio agent 是本机可信进程,通常意味着**任意命令执行**;桥把它接到网络,等于把这个能力按监听范围开放出去。四条规则:

1. **默认只绑 `127.0.0.1`**(§3 的最小版就是这么写的)。监听 `0.0.0.0` 之前,先确认是否真的需要。
2. **远程访问优先走隧道,不开监听**:`ssh -L 8765:127.0.0.1:8765` 或 Tailscale 这类私有组网,让 agent 端点对公网不可见。
3. **必须暴露时,鉴权做在桥或反代层**,且要知道一个协议现实:**浏览器 WebSocket 不能携带自定义 header**——`Authorization` 之类的都带不了,token 只能走 URL query(如 `wss://…/acp?token=…`;Panda 的地址栏原样接受带 query 的 URL,桥在连接建立时校验),或用反代层的 IP 白名单。
4. **TLS 用正规证书**:浏览器对 WebSocket 握手失败没有「点一下继续」的逃生口。自签证书要先把 `https://host:port` 在浏览器里手动接受一次例外才可能生效;直接用 Let's Encrypt(Caddy 默认)或干脆走隧道更省心。

## 6. 通用工具的陷阱

用现成的通用 WebSocket 工具(websocat、wscat 之类)做桥很诱人。选用前必须确认一件事:**它是否把子进程 stdout 的每一行映射为独立的 WebSocket 消息**(以及反向)。字节直通型的转发会踩 §1 的坑——TCP 读周期内的拼接与拆分让客户端因 JSON 解析失败断连。工具若没有行成帧模式,回到 §3 的脚本。

## 7. 验证

- 最快的端到端验证:起桥 → 连接表单填地址 → 建连后侧栏应显示 agent 名称(来自 `initialize` 的 `agentInfo`),再发一条消息看流式回复。
- 需要对照端点时,仓库自带的测试 agent 就跑在同一形态的桥上:`pnpm --filter panda-test-agent serve`(默认 `ws://127.0.0.1:8766/acp`)。
