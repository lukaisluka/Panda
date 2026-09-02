import { useRef, useState } from 'react';
import { ArrowUp, Paperclip, Square, X } from 'lucide-react';
import {
  buildPromptContent,
  classifyAttachments,
  fileToAttachment,
  type ImageAttachment,
} from '../attachments';
import type { AcpContentBlock } from '../protocol/types';

export function Composer({ onSend, disabled, hint, canAttachImages, canStop, onStop }: {
  onSend: (content: AcpContentBlock[]) => void;
  disabled: boolean;
  hint?: string;
  canAttachImages: boolean;
  /** True while a live turn runs — the send button becomes a stop button. */
  canStop?: boolean;
  onStop?: () => void;
}) {
  const [value, setValue] = useState('');
  const [attachments, setAttachments] = useState<ImageAttachment[]>([]);
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const promptContent = buildPromptContent(attachments, value);
  const canSend = promptContent.length > 0 && !disabled;
  const stopping = canStop === true && onStop !== undefined;
  const attachmentDisabled = disabled || !canAttachImages;

  const submit = () => {
    if (!canSend) return;
    onSend(promptContent);
    setValue('');
    setAttachments([]);
    setAttachmentError(null);
  };

  const addFiles = async (files: File[]) => {
    if (!canAttachImages || files.length === 0) return;
    setAttachmentError(null);
    try {
      const added = await Promise.all(files.map(fileToAttachment));
      setAttachments((current) => [...current, ...added]);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error('[panda/composer] failed to read image attachment', err);
      setAttachmentError(`读取图片失败：${message}`);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  };

  const handlePaste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    if (!canAttachImages) return;
    const images = Array.from(e.clipboardData.files).filter((file) =>
      file.type.startsWith('image/'),
    );
    if (images.length === 0) return;
    e.preventDefault();
    void addFiles(images);
  };

  const classified = classifyAttachments(attachments);

  return (
    <div className="px-6 pb-4">
      <div className="mx-auto max-w-3xl">
        <div
          className={`rounded-2xl border bg-surface px-4 py-3 transition-colors ${
            disabled
              ? 'border-border opacity-60'
              : 'border-border focus-within:border-accent/40'
          }`}
        >
          {classified.length > 0 && (
            <div className="mb-3 flex flex-wrap gap-2">
              {classified.map((item) => (
                <div
                  key={item.id}
                  className={`shrink-0 ${item.error ? 'w-28' : 'w-14'}`}
                >
                  <div
                    className={`relative mx-auto flex h-14 w-14 items-center justify-center rounded-lg border bg-raised p-1 ${
                      item.error ? 'border-danger/70' : 'border-border'
                    }`}
                  >
                    <img
                      src={`data:${item.mimeType};base64,${item.data}`}
                      alt={item.name}
                      className="h-full w-full rounded object-cover"
                    />
                    <button
                      type="button"
                      onClick={() =>
                        setAttachments((current) => current.filter((entry) => entry.id !== item.id))
                      }
                      className="absolute -right-1.5 -top-1.5 flex h-5 w-5 items-center justify-center rounded-full border border-border bg-surface text-muted hover:text-text"
                      aria-label={`移除 ${item.name}`}
                    >
                      <X size={12} />
                    </button>
                  </div>
                  {item.error && (
                    <p className="mt-1 text-center text-[10px] leading-3 text-danger">
                      {item.error}
                    </p>
                  )}
                </div>
              ))}
            </div>
          )}
          <div className="flex items-end gap-2">
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              multiple
              className="hidden"
              onChange={(e) => {
                void addFiles(Array.from(e.target.files ?? []));
                e.target.value = '';
              }}
            />
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              disabled={attachmentDisabled}
              title={
                !canAttachImages
                  ? '当前 agent 未声明图片输入能力'
                  : disabled
                    ? '当前不可添加图片'
                    : '添加图片'
              }
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-faint transition-colors enabled:hover:bg-raised enabled:hover:text-muted disabled:cursor-not-allowed disabled:opacity-40"
              aria-label="添加图片"
            >
              <Paperclip size={16} />
            </button>
            <textarea
              rows={1}
              value={value}
              disabled={disabled}
              placeholder={hint ?? '给 Panda 发消息…'}
              onChange={(e) => setValue(e.target.value)}
              onKeyDown={handleKeyDown}
              onPaste={handlePaste}
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
        </div>
        {attachmentError ? (
          <p className="mt-2 text-center text-[11px] text-danger">{attachmentError}</p>
        ) : !canAttachImages ? (
          <p className="mt-2 text-center text-[11px] text-faint">当前 agent 未声明图片输入能力</p>
        ) : (
          <p className="mt-2 text-center text-[11px] text-faint">
            Enter 发送，Shift+Enter 换行 · 可粘贴或选择图片
          </p>
        )}
      </div>
    </div>
  );
}
