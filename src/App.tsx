import { Sidebar } from './components/Sidebar';
import { MessageStream } from './components/MessageStream';
import { StatusBar } from './components/StatusBar';
import { Composer } from './components/Composer';
import { usePanda } from './store';
import { useReplaySession } from './useReplaySession';

export default function App() {
  const { send, resolvePermission } = useReplaySession();
  const doc = usePanda((s) => s.doc);
  const permission = usePanda((s) => s.permission);

  const busy = doc.status !== 'idle';
  const hint =
    doc.status === 'requires_action'
      ? '等待批准中…'
      : doc.status === 'running'
        ? 'Panda 正在工作…'
        : undefined;

  return (
    <div className="flex h-screen">
      <Sidebar />
      <main className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-14 shrink-0 items-center justify-between border-b border-border px-6">
          <span className="text-[13px] font-medium">重构 auth 校验</span>
          <span className="font-mono text-[11px] text-faint">acp://claude-code · demo replay</span>
        </header>
        <MessageStream
          doc={doc}
          permission={permission}
          onResolvePermission={resolvePermission}
        />
        <StatusBar doc={doc} />
        <Composer onSend={send} disabled={busy} hint={hint} />
      </main>
    </div>
  );
}