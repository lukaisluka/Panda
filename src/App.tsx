import { Sidebar } from './components/Sidebar';
import { MessageStream } from './components/MessageStream';
import { StatusBar } from './components/StatusBar';
import { Composer } from './components/Composer';
import { usePanda } from './store';
import { useReplaySession } from './useReplaySession';
import { useLiveSession } from './useLiveSession';

export default function App() {
  const mode = usePanda((s) => s.mode);
  const doc = usePanda((s) => s.doc);
  const permission = usePanda((s) => s.permission);
  const connection = usePanda((s) => s.connection);
  const sessions = usePanda((s) => s.sessions);
  const capabilities = usePanda((s) => s.capabilities);

  const demo = useReplaySession();
  const live = useLiveSession();
  const liveActive = mode === 'live';
  const connected = connection.status === 'connected';

  const send = liveActive ? live.send : demo.send;
  const resolvePermission = liveActive ? live.resolvePermission : demo.resolvePermission;

  const busy = doc.status !== 'idle';
  const composerDisabled = liveActive ? !connected || busy : busy;
  const hint = !liveActive
    ? doc.status === 'requires_action'
      ? '等待批准中…'
      : doc.status === 'running'
        ? 'Panda 正在工作…'
        : undefined
    : connection.status === 'connecting'
      ? '连接中…'
      : connection.status === 'error'
        ? '连接失败 — 在侧栏重连并恢复，或重新连接'
        : !connected
          ? '未连接 ACP 服务 — 在侧栏连接'
          : busy
            ? 'Panda 正在工作…'
            : undefined;

  const activeSession = liveActive
    ? sessions.find((entry) => entry.sessionId === connection.sessionId)
    : undefined;
  const headerTitle = !liveActive
    ? '重构 auth 校验'
    : (activeSession?.title ?? connection.agentName ?? 'Live 会话');
  const headerMeta = liveActive ? (connection.url ?? 'acp') : 'acp://claude-code · demo replay';

  return (
    <div className="flex h-screen">
      <Sidebar
        mode={mode}
        connection={connection}
        capabilities={capabilities}
        sessions={sessions}
        busy={busy}
        onConnect={live.connect}
        onDisconnect={live.disconnect}
        onNewSession={live.newSession}
        onLoadSession={live.loadSession}
        onDeleteSession={live.deleteSession}
        onReplayDemo={demo.replayDemo}
      />
      <main className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-14 shrink-0 items-center justify-between border-b border-border px-6">
          <span className="text-[13px] font-medium">{headerTitle}</span>
          <span className="font-mono text-[11px] text-faint">{headerMeta}</span>
        </header>
        <MessageStream
          doc={doc}
          permission={permission}
          onResolvePermission={resolvePermission}
        />
        <StatusBar doc={doc} connection={connection} mode={mode} />
        <Composer
          onSend={send}
          disabled={composerDisabled}
          hint={hint}
          canAttachImages={!liveActive || capabilities.image}
          canStop={liveActive && connected && doc.status === 'running'}
          onStop={live.cancel}
        />
      </main>
    </div>
  );
}
