import { useState } from 'react';
import { ArrowUp, Square } from 'lucide-react';

export function Composer({ onSend, disabled, hint, canStop, onStop }: {
  onSend: (text: string) => void;
  disabled: boolean;
  hint?: string;
  /** True while a live turn runs — the send button becomes a stop button. */
  canStop?: boolean;
  onStop?: () => void;
}) {
  const [value, setValue] = useState('');
  const canSend = value.trim().length > 0 && !disabled;
  const stopping = canStop === true && onStop !== undefined;

  const submit = () => {
    if (!canSend) return;
    onSend(value);
    setValue('');
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  };

  return (
    <div className="px-6 pb-4">
      <div className="mx-auto max-w-3xl">
        <div
          className={`flex items-end gap-2 rounded-2xl border bg-surface px-4 py-3 transition-colors ${
            disabled
              ? 'border-border opacity-60'
              : 'border-border focus-within:border-accent/40'
          }`}
        >
          <textarea
            rows={1}
            value={value}
            disabled={disabled}
            placeholder={hint ?? '给 Panda 发消息…'}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={handleKeyDown}
            className="max-h-40 flex-1 resize-none bg-transparent text-[14px] leading-6 outline-none placeholder:text-faint"
          />
          {stopping ? (
            <button
              onClick={onStop}
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-danger text-bg transition-colors hover:brightness-110"
              aria-label="停止"
            >
              <Square size={11} strokeWidth={3} />
            </button>
          ) : (
            <button
              onClick={submit}
              disabled={!canSend}
              className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full transition-colors ${
                canSend
                  ? 'bg-accent text-bg hover:brightness-110'
                  : 'bg-raised text-faint'
              }`}
              aria-label="发送"
            >
              <ArrowUp size={16} strokeWidth={2.5} />
            </button>
          )}
        </div>
        <p className="mt-2 text-center text-[11px] text-faint">
          Enter 发送，Shift+Enter 换行
        </p>
      </div>
    </div>
  );
}