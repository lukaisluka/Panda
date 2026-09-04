import { useMemo, useState } from 'react';
import { Menu } from 'lucide-react';
import { Sidebar } from './components/Sidebar';
import { MessageStream } from './components/MessageStream';
import { StatusBar } from './components/StatusBar';
import { Composer } from './components/Composer';
import type { AttachedPermission } from './components/PermissionCard';
import {
  useActiveCapabilities,
  useActiveConnection,
  useActiveDoc,
  useActiveSessions,
  useActiveSwitching,
  usePanda,
} from './store';
import { effectiveCapability, PANDA_HOST_CAPABILITIES } from './capabilities';
import { useReplaySession } from './useReplaySession';
import { useLiveSession } from './useLiveSession';

export default function App() {
  const [mobileNavigationOpen, setMobileNavigationOpen] = useState(false);
  const mode = usePanda((s) => s.mode);
  const doc = useActiveDoc();
  const connection = useActiveConnection();
  const sessions = useActiveSessions();
  const capabilities = useActiveCapabilities();
  const switching = useActiveSwitching();

  const demo = useReplaySession();
  const live = useLiveSession();
  const liveActive = mode === 'live';
  const connected = connection.status === 'connected';

  const send = liveActive ? live.send : demo.send;
  const resolvePermission = liveActive ? live.resolvePermission : demo.resolvePermission;
  // Permission cards, insertion-ordered (issue #18): pending ones, several at
  // once, each answered independently — plus policy-denied terminal records
  // (issue #22) that stay rendered. Memoized so the wrapper identities (a
  // MessageStream dep the memoized block views lean on) only change when a
  // permission does.
  const attachedPermissions = useMemo(
    () =>
      Object.values(doc.permissions).flatMap((permission): AttachedPermission[] => {
        if (permission.status === 'pending')
          return [{ state: 'pending', request: permission.request }];
        if (permission.response?.outcome === 'denied-by-policy')
          return [
            { state: 'denied', request: permission.request, response: permission.response },
          ];
        return [];
      }),
    [doc.permissions],
  );

  // A session switch in flight is busy too: the composer must not send into a
  // session that has not settled yet, and the sidebar locks other switches.
  const busy = doc.status !== 'idle' || switching !== null;
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
          : switching
            ? '切换会话中…'
            : connection.error
              ? connection.error
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
        live={live}
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
          permissions={attachedPermissions}
          onResolvePermission={resolvePermission}
        />
        <StatusBar
          doc={doc}
          connection={connection}
          mode={mode}
          switching={switching !== null}
        />
        <Composer
          onSend={send}
          disabled={composerDisabled}
          hint={hint}
          canAttachImages={
            !liveActive ||
            effectiveCapability('image', capabilities, PANDA_HOST_CAPABILITIES).available
          }
          canStop={liveActive && connected && doc.status === 'running'}
          onStop={live.cancel}
        />
      </main>
    </div>
  );
}
