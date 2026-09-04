import { useRef, useState } from 'react';
import { ArrowUp, Paperclip, Square, X } from 'lucide-react';
import { IconButton } from '@astryxdesign/core/IconButton';
import {
  buildPromptContent,
  classifyAttachments,
  fileToAttachment,
  type ImageAttachment,
} from '../attachments';
import type { AcpAvailableCommand, AcpContentBlock, AcpSessionModeState } from '../protocol/types';
import {
  commandCompletion,
  commandKeyAction,
  matchCommands,
  wrapIndex,
} from '../commands';
import { ContentColumn } from './ContentColumn';
import { ModePicker } from './ModePicker';
import './Composer.css';

export function Composer({ onSend, disabled, hint, canAttachImages, canStop, onStop, modes, onSetMode, commands }: {
  onSend: (content: AcpContentBlock[]) => void;
  disabled: boolean;
  hint?: string;
  canAttachImages: boolean;
  /** True while a live turn runs — the send button becomes a stop button. */
  canStop?: boolean;
  onStop?: () => void;
  /** Session modes from the document; null hides the picker entirely. */
  modes: AcpSessionModeState | null;
  onSetMode: (modeId: string) => void;
  /** Agent-advertised slash commands; drives the `/` autocomplete panel. */
  commands: AcpAvailableCommand[];
}) {
  const [value, setValue] = useState('');
  const [attachments, setAttachments] = useState<ImageAttachment[]>([]);
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  const [commandIndex, setCommandIndex] = useState(0);
  const [commandsDismissed, setCommandsDismissed] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const promptContent = buildPromptContent(attachments, value);
  const canSend = promptContent.length > 0 && !disabled;
  const stopping = canStop === true && onStop !== undefined;
  const attachmentDisabled = disabled || !canAttachImages;
  // Panel visibility derives from the text (open only while typing the
  // command name); Escape suppresses it until the input changes again.
  const commandItems = commandsDismissed || disabled ? null : matchCommands(commands, value);

  const completeCommand = (command: AcpAvailableCommand) => {
    // The trailing space starts the argument; the panel closes itself
    // because the value no longer matches /^\/\S*$/.
    setValue(commandCompletion(command));
  };

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
    if (commandItems) {
      const action = commandKeyAction(e);
      if (action) {
        e.preventDefault();
        if (action.type === 'complete') {
          const command = commandItems[commandIndex];
          if (command) completeCommand(command);
        } else if (action.type === 'move') {
          setCommandIndex(wrapIndex(commandIndex, action.delta, commandItems.length));
        } else {
          setCommandsDismissed(true);
        }
        return;
      }
    }
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
    <ContentColumn className="composer-column">
        <div
          className={`composer-card ${disabled ? 'composer-card--disabled' : ''}`}
        >
          {commandItems && (
            <div className="composer-commands" role="listbox" aria-label="斜杠命令">
              {commandItems.map((command, index) => (
                <button
                  key={command.name}
                  type="button"
                  role="option"
                  aria-selected={index === commandIndex}
                  className={`composer-command ${index === commandIndex ? 'composer-command--active' : ''}`}
                  // mousedown (not click): completes before the textarea loses
                  // focus, so typing can continue in the argument right away.
                  onMouseDown={(e) => {
                    e.preventDefault();
                    completeCommand(command);
                  }}
                  onMouseEnter={() => setCommandIndex(index)}
                >
                  <span className="composer-command-name">/{command.name}</span>
                  <span className="composer-command-desc">{command.description}</span>
                </button>
              ))}
              {commandItems[commandIndex]?.inputHint && (
                <div className="composer-commands-hint">
                  参数:{commandItems[commandIndex].inputHint}
                </div>
              )}
            </div>
          )}
          {classified.length > 0 && (
            <div className="composer-attachments">
              {classified.map((item) => (
                <div
                  key={item.id}
                  className={`composer-tile ${item.error ? 'composer-tile--error' : ''}`}
                >
                  <div
                    className={`composer-thumb ${item.error ? 'composer-thumb--error' : ''}`}
                  >
                    <img
                      src={`data:${item.mimeType};base64,${item.data}`}
                      alt={item.name}
                      className="composer-thumb-img"
                    />
                    <button
                      type="button"
                      onClick={() =>
                        setAttachments((current) => current.filter((entry) => entry.id !== item.id))
                      }
                      className="composer-remove"
                      aria-label={`移除 ${item.name}`}
                    >
                      <X size={12} />
                    </button>
                  </div>
                  {item.error && (
                    <p className="composer-tile-error">
                      {item.error}
                    </p>
                  )}
                </div>
              ))}
            </div>
          )}
          <div className="composer-row">
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              multiple
              className="composer-file-input"
              onChange={(e) => {
                void addFiles(Array.from(e.target.files ?? []));
                e.target.value = '';
              }}
            />
            <textarea
              rows={1}
              value={value}
              disabled={disabled}
              placeholder={hint ?? '给 Panda 发消息…'}
              onChange={(e) => {
                setValue(e.target.value);
                setCommandIndex(0);
                setCommandsDismissed(false);
              }}
              onKeyDown={handleKeyDown}
              onPaste={handlePaste}
              className="focus-outline-none composer-input"
            />
          </div>
          <div className="composer-footer">
            <div className="composer-footer-lead">
              <IconButton
                variant="ghost"
                size="sm"
                icon={<Paperclip size={16} />}
                label="添加图片"
                isDisabled={attachmentDisabled}
                tooltip={
                  !canAttachImages
                    ? '当前 agent 未声明图片输入能力'
                    : disabled
                      ? '当前不可添加图片'
                      : '添加图片'
                }
                clickAction={() => fileInputRef.current?.click()}
              />
              {modes && <ModePicker modes={modes} onSetMode={onSetMode} />}
            </div>
            {stopping ? (
              <IconButton
                variant="destructive"
                size="sm"
                icon={<Square size={11} strokeWidth={3} />}
                label="停止"
                clickAction={() => onStop?.()}
              />
            ) : (
              <IconButton
                variant="primary"
                size="sm"
                icon={<ArrowUp size={16} strokeWidth={2.5} />}
                label="发送"
                isDisabled={!canSend}
                clickAction={submit}
              />
            )}
          </div>
        </div>
        {attachmentError ? (
          <p className="composer-hint composer-hint--danger">{attachmentError}</p>
        ) : !canAttachImages ? (
          <p className="composer-hint composer-hint--faint">当前 agent 未声明图片输入能力</p>
        ) : (
          <p className="composer-hint composer-hint--faint">
            Enter 发送，Shift+Enter 换行 · 可粘贴或选择图片
          </p>
        )}
    </ContentColumn>
  );
}
