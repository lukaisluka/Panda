import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowUp, Paperclip, SlidersHorizontal, Square, X } from 'lucide-react';
import { IconButton } from '@astryxdesign/core/IconButton';
import {
  buildPromptContent,
  classifyAttachments,
  fileToAttachment,
  type ImageAttachment,
} from '../attachments';
import { draftForKey, useComposerDrafts } from '../composerDrafts';
import type {
  AcpAvailableCommand,
  AcpConfigOption,
  AcpContentBlock,
  AcpSessionModeState,
} from '../protocol/types';
import {
  commandCompletion,
  commandKeyAction,
  matchCommands,
  wrapIndex,
} from '../commands';
import { ConfigPanelCard } from './ConfigPanel';
import { usePopoverDismiss } from './usePopoverDismiss';
import { ContentColumn } from './ContentColumn';
import { ModePicker } from './ModePicker';
import './Composer.css';
import { useI18n } from '../i18n/context';

/**
 * True while a keydown belongs to an IME composition (bug hunt #2). Enter
 * during composition confirms the candidate — Safari/WKWebView (the desktop
 * shell) dispatches it BEFORE `compositionend`, Firefox after; both must be
 * ignored, or the raw pinyin ("nihao") gets submitted and the composer is
 * cleared mid-composition. keyCode 229 is the legacy marker some engines
 * set on every composition keydown.
 */
export function isImeComposition(e: { isComposing?: boolean; keyCode?: number }): boolean {
  return e.isComposing === true || e.keyCode === 229;
}

/**
 * The composer's image-hint decision (#214): a verdict ('available' /
 * 'unavailable') only when the foreground agent's capabilities are
 * negotiated; `undefined` (no agent, still connecting) renders no hint at
 * all — the misleading "this agent does not declare image input" line used
 * to greet a first run with zero agents.
 */
export function imageHintState(canAttachImages: boolean | undefined): 'available' | 'unavailable' | null {
  if (canAttachImages === undefined) return null;
  return canAttachImages ? 'available' : 'unavailable';
}

export function Composer({ onSend, disabled, inputLocked, hint, canAttachImages, canStop, onStop, modes, onSetMode, commands, configOptions, onSetConfigOption, sessionKey }: {
  onSend: (content: AcpContentBlock[]) => void;
  /** Sends and popovers are closed (turn running, link down, switching). */
  disabled: boolean;
  /** The text field itself is closed — everything but awaiting-approval
   * (#216): while a permission waits the composer stays writable so the
   * next message can be drafted, sending is still held back by disabled. */
  inputLocked: boolean;
  hint?: string;
  /**
   * Image attachment verdict for the foreground agent (#214): true/false
   * only once capabilities are negotiated; `undefined` = no agent connected
   * (or still connecting) — the attach stays inert and NO hint renders,
   * because a nonexistent agent cannot "fail to declare" anything.
   */
  canAttachImages: boolean | undefined;
  /** True while a live turn runs — the send button becomes a stop button. */
  canStop?: boolean;
  onStop?: () => void;
  /** Session modes from the document; null hides the picker entirely. */
  modes: AcpSessionModeState | null;
  onSetMode: (modeId: string) => void;
  /** Agent-advertised slash commands; drives the `/` autocomplete panel. */
  commands: AcpAvailableCommand[];
  /** Agent-advertised session config options; null/[] hides the settings entry. */
  configOptions: AcpConfigOption[] | null;
  onSetConfigOption: (configId: string, value: string | boolean) => void;
  /** Foreground session identity (bug hunt #15): text, attachments and
   * errors live in the per-session draft store under this key, so drafts
   * never cross sessions. */
  sessionKey: string;
}) {
  const { t } = useI18n();
  const draft = useComposerDrafts((s) => draftForKey(s, sessionKey));
  const { value, attachments, attachmentError } = draft;
  const setDraft = (patch: Partial<{ value: string; attachments: ImageAttachment[]; attachmentError: string | null }>) =>
    useComposerDrafts.getState().setDraft(sessionKey, patch);
  // Function-form attachment update reads through the store (not the render
  // closure) — addFiles resolves asynchronously, where `draft` may be stale.
  const setAttachments = (update: (current: ImageAttachment[]) => ImageAttachment[]) => {
    const current = useComposerDrafts.getState().drafts[sessionKey]?.attachments ?? [];
    useComposerDrafts.getState().setDraft(sessionKey, { attachments: update(current) });
  };
  const [commandIndex, setCommandIndex] = useState(0);
  const [commandsDismissed, setCommandsDismissed] = useState(false);
  const [configOpen, setConfigOpen] = useState(false);
  // #215: the settings card is a popover anchored like the mode menu —
  // Escape / outside pointerdown close it via the shared dismiss hook.
  const closeConfig = useCallback(() => setConfigOpen(false), []);
  const configAnchorRef = usePopoverDismiss(configOpen, closeConfig);
  // #215: an open panel whose controls just went disabled (turn running,
  // link down) is dead UI hanging over the stream — collapse it; and a
  // session switch re-targets the whole composer, so the panel can't stay
  // open across it.
  useEffect(() => {
    if (configOpen && disabled) closeConfig();
  }, [configOpen, disabled, closeConfig]);
  useEffect(closeConfig, [sessionKey]);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const promptContent = buildPromptContent(attachments, value);
  const canSend = promptContent.length > 0 && !disabled;
  const stopping = canStop === true && onStop !== undefined;
  const attachmentDisabled = inputLocked || !canAttachImages;
  // Panel visibility derives from the text (open only while typing the
  // command name); Escape suppresses it until the input changes again.
  const commandItems = commandsDismissed || inputLocked ? null : matchCommands(commands, value);
  const hasConfigOptions = configOptions !== null && configOptions.length > 0;

  const completeCommand = (command: AcpAvailableCommand) => {
    // The trailing space starts the argument; the panel closes itself
    // because the value no longer matches /^\/\S*$/.
    setDraft({ value: commandCompletion(command) });
  };

  const submit = () => {
    if (!canSend) return;
    onSend(promptContent);
    useComposerDrafts.getState().clearDraft(sessionKey);
  };

  const addFiles = async (files: File[]) => {
    if (!canAttachImages || files.length === 0) return;
    setDraft({ attachmentError: null });
    try {
      const added = await Promise.all(files.map(fileToAttachment));
      setAttachments((current) => [...current, ...added]);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error('[panda/composer] failed to read image attachment', err);
      setDraft({ attachmentError: t('composer.readImageFailed', { message }) });
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (isImeComposition(e.nativeEvent)) return;
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
            <div className="composer-commands" role="listbox" aria-label={t('composer.commands')}>
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
                  {t('composer.paramHint', { hint: commandItems[commandIndex].inputHint })}
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
                      aria-label={t('composer.removeAttachment', { name: item.name })}
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
              disabled={inputLocked}
              placeholder={hint ?? t('composer.placeholder')}
              onChange={(e) => {
                setDraft({ value: e.target.value });
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
                label={t('composer.attach')}
                isDisabled={attachmentDisabled}
                tooltip={
                  canAttachImages === false
                    ? t('composer.attachUnavailable')
                    : disabled
                      ? t('composer.attachDisabled')
                      : t('composer.attach')
                }
                clickAction={() => fileInputRef.current?.click()}
              />
              {modes && <ModePicker modes={modes} onSetMode={onSetMode} />}
              {hasConfigOptions && (
                <div className="composer-config-anchor" ref={configAnchorRef}>
                  {configOpen && (
                    <ConfigPanelCard options={configOptions} disabled={disabled} onSetOption={onSetConfigOption} />
                  )}
                  <IconButton
                    variant={configOpen ? 'secondary' : 'ghost'}
                    size="sm"
                    icon={<SlidersHorizontal size={16} />}
                    label={t('composer.settings')}
                    isDisabled={disabled}
                    tooltip={disabled ? t('composer.settingsDisabled') : t('composer.settings')}
                    clickAction={() => setConfigOpen((v) => !v)}
                  />
                </div>
              )}
            </div>
            {stopping ? (
              <IconButton
                variant="destructive"
                size="sm"
                icon={<Square size={11} strokeWidth={3} />}
                label={t('composer.stop')}
                clickAction={() => onStop?.()}
              />
            ) : (
              <IconButton
                variant="primary"
                size="sm"
                icon={<ArrowUp size={16} strokeWidth={2.5} />}
                label={t('composer.send')}
                isDisabled={!canSend}
                clickAction={submit}
              />
            )}
          </div>
        </div>
        {attachmentError ? (
          <p className="composer-hint composer-hint--danger">{attachmentError}</p>
        ) : imageHintState(canAttachImages) === 'unavailable' ? (
          <p className="composer-hint composer-hint--muted">{t('composer.attachUnavailable')}</p>
        ) : imageHintState(canAttachImages) === 'available' ? (
          <p className="composer-hint composer-hint--muted">{t('composer.hintImages')}</p>
        ) : null}
    </ContentColumn>
  );
}
