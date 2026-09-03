import { useState } from 'react';
import { Menu } from 'lucide-react';
import { Sidebar } from './components/Sidebar';
import { MessageStream } from './components/MessageStream';
import { StatusBar } from './components/StatusBar';
import { Composer } from './components/Composer';
import {
  useActiveCapabilities,
  useActiveConnection,
  useActiveDoc,
  useActivePermission,
  useActiveSessions,
  usePanda,
} from './store';
import { useReplaySession } from './useReplaySession';
import { useLiveSession } from './useLiveSession';

export default function App() {
  const [mobileNavigationOpen, setMobileNavigationOpen] = useState(false);
  const mode = usePanda((s) => s.mode);
  const doc = useActiveDoc();
  const permission = useActivePermission();
  const connection = useActiveConnection();
  const sessions = useActiveSessions();
  const capabilities = useActiveCapabilities();

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
    <div className="flex h-screen overflow-hidden">
      {mobileNavigationOpen && (
        <button
          type="button"
          className="fixed inset-0 z-20 bg-bg/70 md:hidden"
          aria-label="关闭导航"
          onClick={() => setMobileNavigationOpen(false)}
        />
      )}
      <Sidebar
        mode={mode}
        connection={connection}
        capabilities={capabilities}
        sessions={sessions}
        busy={busy}
        onConnect={live.connect}
        onSelectProfile={live.selectProfile}
        onDisconnect={live.disconnect}
        onNewSession={live.newSession}
        onLoadSession={live.loadSession}
        onDeleteSession={live.deleteSession}
        onReplayDemo={demo.replayDemo}
        mobileOpen={mobileNavigationOpen}
        onMobileClose={() => setMobileNavigationOpen(false)}
      />
      <main className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-14 shrink-0 items-center justify-between gap-3 border-b border-border px-3 sm:px-6">
          <div className="flex min-w-0 items-center gap-2">
            <button
              type="button"
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-muted transition-colors hover:bg-raised hover:text-fg md:hidden"
              aria-label="打开导航"
              onClick={() => setMobileNavigationOpen(true)}
            >
              <Menu size={18} />
            </button>
            <span className="truncate text-[13px] font-medium">{headerTitle}</span>
          </div>
          <span className="hidden shrink-0 font-mono text-[11px] text-faint md:block">{headerMeta}</span>
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
