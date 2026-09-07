import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Activity, ArrowLeft, Bot, Check, Copy, Pencil, Play, Plug, Plus, SlidersHorizontal, Trash2, WandSparkles } from 'lucide-react';
import { Button } from '@astryxdesign/core/Button';
import { useImperativeAlertDialog } from '@astryxdesign/core/AlertDialog';
import { CheckboxInput } from '@astryxdesign/core/CheckboxInput';
import { IconButton } from '@astryxdesign/core/IconButton';
import { Selector } from '@astryxdesign/core/Selector';
import { TextArea } from '@astryxdesign/core/TextArea';
import { TextInput } from '@astryxdesign/core/TextInput';
import {
  loadProfiles,
  newProfileId,
  profileEndpoint,
  saveProfiles,
  subscribeProfiles,
  type AgentProfile,
} from '../profiles';
import { hasStdioHost } from '../acp/transport/stdioHost';
import {
  loadMcpServers,
  newMcpServerId,
  saveMcpServers,
  subscribeMcpServers,
  type McpServerConfig,
} from '../mcpServers';
import { parseMcpConfigText, serializeMcpServers, type McpSkipReason, type McpTextFormat } from '../mcpText';
import { desktopHost, summarizeUserAgent } from '../diagnostics';
import { navigate } from '../routes';
import { isThemeId, loadThemeId, saveThemeId, subscribeTheme, THEMES, EXPOSED_THEME_IDS } from '../theme';
import { workspaceDisplay } from '../workspace';
import { LOCALES, saveLocale } from '../i18n';
import { t } from '../i18n';
import { useI18n } from '../i18n/context';
import { notifyUser } from '../userNotice';
import { copyDiagnosticsReport } from './ErrorBoundary';
import './SettingsPage.css';

/** The settings page's sections (#117) — the single source shared by the
 * sidebar's section nav and the main column's pages: same order, same
 * titles, same icons. One section shows at a time (macOS-Settings style) —
 * the settings content is shorter than one viewport of scroll, so a jump-to-
 * card nav produced almost no visible movement; a page swap always does.
 * Sparse neighbours are grouped (外观+语言 → 通用) so every page carries
 * real content. Dev tools live on the diagnostics page (dev-build-only, not
 * a destination users manage). */
export const SETTINGS_SECTIONS = [
  { id: 'general', titleKey: 'settings.general', descKey: 'settings.generalDesc', icon: SlidersHorizontal },
  { id: 'agents', titleKey: 'settings.profiles', descKey: 'settings.profilesDesc', icon: Bot },
  { id: 'mcp', titleKey: 'settings.mcp', descKey: 'settings.mcpDesc', icon: Plug },
  { id: 'diagnostics', titleKey: 'diag.cardTitle', descKey: 'diag.cardDesc', icon: Activity },
] as const;

export type SettingsSectionId = (typeof SETTINGS_SECTIONS)[number]['id'];

/** Settings-route sidebar nav (#115/#117): lists the sections; selection is
 * lifted state (MainScreen owns it, so it survives route flips), clicking
 * switches the main column's page. Rendered by the Sidebar in place of the
 * session list. The「返回会话」row (#119) closes the loop INSIDE the
 * settings-context sidebar — the exit lives where the user's eye already
 * is, not only in the main column's header. */
export function SettingsSideNav({ activeId, onSelect, onNavigate, onBack }: {
  activeId: SettingsSectionId;
  onSelect(id: SettingsSectionId): void;
  onNavigate(): void;
  onBack(): void;
}) {
  const { t } = useI18n();
  return (
    <div className="sidebar-settings-nav">
      <button
        type="button"
        className="sidebar-settings-back"
        onClick={() => {
          onBack();
          onNavigate();
        }}
      >
        <ArrowLeft size={14} />
        <span className="truncate">{t('side.backToSession')}</span>
      </button>
      <div className="sidebar-sessions-head">
        <span className="sidebar-label">{t('settings.title')}</span>
      </div>
      <nav className="sidebar-settings-list">
        {SETTINGS_SECTIONS.map((section) => (
          <button
            key={section.id}
            type="button"
            className={`sidebar-settings-item ${activeId === section.id ? 'sidebar-settings-item--active' : ''}`}
            onClick={() => {
              onSelect(section.id);
              onNavigate();
            }}
          >
            <section.icon size={14} />
            <span className="truncate">{t(section.titleKey)}</span>
          </button>
        ))}
      </nav>
    </div>
  );
}

/**
 * Settings content (`#/settings`, #111): renders INSIDE MainScreen's main
 * column — the sidebar/header chrome stays, this replaces only the session
 * stream. One section page at a time (#117); the keyed body abandons
 * in-flight forms on switch and replays the entrance fade. The page-level
 * header is gone (#140): the top bar carries the section's title and
 * description; the cards below start immediately.
 */
export function SettingsPage({ section }: { section: SettingsSectionId }) {
  const { t } = useI18n();
  const [profiles, setProfiles] = useState<AgentProfile[]>(() => loadProfiles());
  useEffect(() => subscribeProfiles(setProfiles), []);

  return (
    <div className="settings-page">
      <div className="settings-body" key={section}>
        {section === 'general' && <GeneralSection />}
        {section === 'agents' && <AgentsSection profiles={profiles} />}
        {section === 'mcp' && <McpSection />}
        {section === 'diagnostics' && <DiagnosticsSection />}
        <p className="settings-colophon">{t('settings.colophon')}</p>
      </div>
    </div>
  );
}

/** One setting per row (Codex-style, #138): title + description on the left,
 * the control on the right; a hairline separates consecutive rows. The card
 * supplies the group title above; this is the row inside it. */
function SettingsRow({ title, description, children }: {
  title: string;
  description?: string;
  children?: ReactNode;
}) {
  return (
    <div className="settings-row">
      <div className="settings-row-text">
        <span className="settings-row-title">{title}</span>
        {description && <span className="settings-row-desc">{description}</span>}
      </div>
      {children && <div className="settings-row-control">{children}</div>}
    </div>
  );
}

/** 通用: theme + language — one card, one row each; the row titles carry
 * what the old per-card descriptions explained. */
function GeneralSection() {
  const { t } = useI18n();
  return (
    <section className="settings-card">
      <h2 className="settings-group-title">{t('settings.appearanceGroup')}</h2>
      <SettingsRow title={t('settings.themeRow')} description={t('settings.themeRowDesc')}>
        <ThemeSwatches />
      </SettingsRow>
      <SettingsRow title={t('settings.language')} description={t('settings.languageRowDesc')}>
        <LanguageChips />
      </SettingsRow>
    </section>
  );
}

/** Diagnostics (#105, #138): environment rows make the page carry real
 * content in production builds (version/host/locale/UA are already known to
 * the client), and the copy action sits on its own row instead of floating
 * alone in the page header. Dev tools ride below (dev-build-only). */
function DiagnosticsSection() {
  const { t, locale } = useI18n();
  const [copy, setCopy] = useState<'idle' | 'ok' | 'fail'>('idle');
  return (
    <>
      <section className="settings-card">
        <h2 className="settings-group-title">{t('settings.envGroup')}</h2>
        <SettingsRow title={t('settings.versionRow')}>
          <span className="settings-row-value">{__APP_VERSION__}</span>
        </SettingsRow>
        <SettingsRow title={t('settings.hostRow')}>
          <span className="settings-row-value">
            {desktopHost() ? t('settings.hostDesktop') : t('settings.hostBrowser')}
          </span>
        </SettingsRow>
        <SettingsRow title={t('settings.language')}>
          <span className="settings-row-value">{locale === 'en' ? 'English' : '中文'}</span>
        </SettingsRow>
        <SettingsRow title={t('settings.userAgentRow')}>
          <span className="settings-row-value">{summarizeUserAgent(navigator.userAgent)}</span>
        </SettingsRow>
      </section>
      <section className="settings-card">
        <h2 className="settings-group-title">{t('settings.reportGroup')}</h2>
        <SettingsRow title={t('diag.copyDiagnostics')} description={t('settings.reportRowDesc')}>
          <Button
            variant="secondary"
            size="sm"
            label={
              copy === 'ok'
                ? `✓ ${t('diag.copied')}`
                : copy === 'fail'
                  ? `✗ ${t('diag.copyFailed')}`
                  : t('diag.copyDiagnostics')
            }
            icon={<Copy size={12} />}
            clickAction={() => void copyDiagnosticsReport().then(setCopy)}
            tooltip={t('diag.cardDesc')}
          />
        </SettingsRow>
      </section>
      {import.meta.env.DEV && (
        <section className="settings-card settings-card--muted">
          <h2 className="settings-group-title">{t('settings.dev')}</h2>
          <SettingsRow title={t('settings.demoReplay')} description={t('settings.devRowDesc')}>
            <Button
              variant="secondary"
              size="sm"
              label={t('settings.demoReplay')}
              icon={<Play size={12} />}
              clickAction={() => navigate('demo')}
              tooltip={t('settings.demoReplayTooltip')}
            />
          </SettingsRow>
        </section>
      )}
    </>
  );
}

/** Theme swatch row: each chip renders inside its own theme's scope, so the
 * color dot resolves that theme's real --color-accent — the preview needs no
 * per-theme color table. */
function ThemeSwatches() {
  const { t } = useI18n();
  const [themeId, setThemeId] = useState(loadThemeId);
  useEffect(() => subscribeTheme(setThemeId), []);
  const exposed = THEMES.filter((choice) => EXPOSED_THEME_IDS.includes(choice.id));
  return (
    <div className="settings-theme-swatches">
      {exposed.map((choice) => {
        const selected = choice.id === themeId;
        return (
          <button
            key={choice.id}
            type="button"
            className={`settings-theme-swatch ${selected ? 'settings-theme-swatch--active' : ''}`}
            aria-pressed={selected}
            onClick={() => {
              if (isThemeId(choice.id)) saveThemeId(choice.id);
            }}
          >
            <span className="settings-theme-dot-scope" data-astryx-theme={choice.id}>
              <span className="settings-theme-dot" />
              {selected && <Check size={11} className="settings-theme-check" />}
            </span>
            <span className="settings-theme-name">{choice.label}</span>
          </button>
        );
      })}
      {exposed.length <= 1 && <span className="settings-theme-more">{t('settings.themeMore')}</span>}
    </div>
  );
}

/** Language picker (#91): same chip row as the theme swatches. Option labels
 * are each locale's own endonym (English / 中文) — never translated. Switching
 * goes through saveLocale so storage stays the single source of truth and
 * non-React t() callers move with the provider. */
function LanguageChips() {
  const { locale } = useI18n();
  const next = (id: string) => {
    if (id === 'en' || id === 'zh') saveLocale(id);
  };
  return (
    <div className="settings-theme-swatches">
      {LOCALES.map((id) => {
        const selected = id === locale;
        return (
          <button
            key={id}
            type="button"
            className={`settings-theme-swatch ${selected ? 'settings-theme-swatch--active' : ''}`}
            aria-pressed={selected}
            onClick={() => next(id)}
          >
            <span className="settings-theme-name">{id === 'en' ? 'English' : '中文'}</span>
            {selected && <Check size={11} className="settings-theme-check" />}
          </button>
        );
      })}
    </div>
  );
}

/** The Agent 配置 page (#117, #140): the top bar carries the section title;
 * the card's group head carries the create action (Codex puts page actions
 * on the group head, right-aligned) — hidden while creating. The card's body
 * is the avatar-row list (a row swaps for the edit form in place). */
function AgentsSection({ profiles }: { profiles: AgentProfile[] }) {
  const { t } = useI18n();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  // #160: destructive confirm used to be window.confirm.
  const deleteAlert = useImperativeAlertDialog();

  return (
    <section className="settings-card">
      <div className="settings-group-head">
        <h2 className="settings-group-title">{t('settings.profilesGroup')}</h2>
        {!creating && (
          <Button
            variant="secondary"
            size="sm"
            label={t('settings.addProfile')}
            icon={<Plus size={12} />}
            clickAction={() => {
              setEditingId(null);
              setCreating(true);
            }}
          />
        )}
      </div>
      {creating ? (
        <ProfileForm
          onCancel={() => setCreating(false)}
          onSave={(profile) => {
            if (!saveProfiles([...loadProfiles(), profile])) notifyUser('error', t('settings.notice.saveFailed'));
            setCreating(false);
          }}
        />
      ) : profiles.length === 0 ? (
        <div className="settings-profile-empty">
          <Bot size={22} className="settings-profile-empty-icon" />
          <p className="settings-profile-empty-title">{t('settings.noProfiles')}</p>
          <p className="settings-profile-empty-desc">{t('settings.noProfilesDesc')}</p>
        </div>
      ) : (
        <div className="settings-profile-list">
          {profiles.map((profile) =>
            editingId === profile.id ? (
              <ProfileForm
                key={profile.id}
                initial={profile}
                onCancel={() => setEditingId(null)}
                onSave={(next) => {
                  // Full replace, not updateProfileFields: the form may switch
                  // the endpoint kind (websocket ↔ stdio), which the
                  // same-kind write-back API deliberately refuses (#121).
                  if (
                    !saveProfiles(loadProfiles().map((entry) => (entry.id === profile.id ? next : entry)))
                  ) {
                    notifyUser('error', t('settings.notice.saveFailed'));
                  }
                  setEditingId(null);
                }}
              />
            ) : (
              <div key={profile.id} className="settings-profile-row">
                <span className="settings-profile-avatar" aria-hidden>
                  {profile.name.trim().slice(0, 1).toUpperCase() || '?'}
                </span>
                <div className="settings-profile-main">
                  <span className="settings-profile-name truncate">{profile.name}</span>
                  <span
                    className="settings-profile-meta truncate"
                    title={`${profileEndpoint(profile)} · ${workspaceDisplay(profile.workspace)}`}
                  >
                    {profileEndpoint(profile)} · {workspaceDisplay(profile.workspace)}
                  </span>
                </div>
                <div className="settings-profile-actions">
                  <IconButton
                    variant="ghost"
                    size="sm"
                    icon={<Pencil size={12} />}
                    label={t('settings.editProfile')}
                    tooltip={t('settings.editProfileTooltip')}
                    clickAction={() => {
                      setCreating(false);
                      setEditingId(profile.id);
                    }}
                  />
                  <IconButton
                    variant="ghost"
                    size="sm"
                    icon={<Trash2 size={12} />}
                    label={t('settings.deleteProfile')}
                    tooltip={t('settings.deleteProfileTooltip')}
                    clickAction={() => {
                      deleteAlert.show({
                        title: t('settings.deleteProfile'),
                        description: t('settings.deleteProfileConfirm', { name: profile.name }),
                        actionLabel: t('settings.deleteProfile'),
                        actionVariant: 'destructive',
                        onAction: () => {
                          if (!saveProfiles(loadProfiles().filter((entry) => entry.id !== profile.id))) {
                            notifyUser('error', t('settings.notice.saveFailed'));
                          }
                          if (editingId === profile.id) setEditingId(null);
                          deleteAlert.hide();
                        },
                      });
                    }}
                  />
                </div>
              </div>
            ),
          )}
        </div>
      )}
      {deleteAlert.element}
    </section>
  );
}

/** The MCP 服务器 page (issue #71, #117, #140, #142, #144): the v1 execution
 * surface — configured servers ride every session/new · session/load to the
 * agent. The group head only offers Add server; the JSON/YAML text view is
 * an input mode of the create/edit form, not a list-level action (#144).
 * Same in-place edit pattern as the Agent 配置 page. */
function McpSection() {
  const { t } = useI18n();
  const [servers, setServers] = useState<McpServerConfig[]>(() => loadMcpServers());
  useEffect(() => subscribeMcpServers(setServers), []);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [textView, setTextView] = useState(false);
  // #160: destructive confirm used to be window.confirm.
  const deleteAlert = useImperativeAlertDialog();
  const enterTextView = () => {
    setCreating(false);
    setEditingId(null);
    setTextView(true);
  };

  return (
    <section className="settings-card">
      <div className="settings-group-head">
        <h2 className="settings-group-title">{t('settings.mcpGroup')}</h2>
        {!creating && editingId === null && !textView && (
          <div className="settings-group-actions">
            <Button
              variant="secondary"
              size="sm"
              label={t('settings.addMcp')}
              icon={<Plus size={12} />}
              clickAction={() => {
                setEditingId(null);
                setCreating(true);
              }}
            />
          </div>
        )}
      </div>
      {textView ? (
        <McpTextEditor servers={servers} onDone={() => setTextView(false)} />
      ) : creating ? (
        <McpForm
          onCancel={() => setCreating(false)}
          onTextConfig={enterTextView}
          onSave={(server) => {
            saveMcpServers([...loadMcpServers(), server]);
            setCreating(false);
          }}
        />
      ) : servers.length === 0 ? (
        <div className="settings-profile-empty">
          <Plug size={22} className="settings-profile-empty-icon" />
          <p className="settings-profile-empty-title">{t('settings.noMcp')}</p>
          <p className="settings-profile-empty-desc">{t('settings.noMcpDesc')}</p>
        </div>
      ) : (
        <div className="settings-profile-list">
          {servers.map((server) =>
            editingId === server.id ? (
              <McpForm
                key={server.id}
                initial={server}
                onCancel={() => setEditingId(null)}
                onTextConfig={enterTextView}
                onSave={(fields) => {
                  saveMcpServers(loadMcpServers().map((entry) => (entry.id === server.id ? fields : entry)));
                  setEditingId(null);
                }}
              />
            ) : (
              <div key={server.id} className="settings-profile-row">
                <span className="settings-profile-avatar" aria-hidden>
                  <Plug size={13} />
                </span>
                <div className="settings-profile-main">
                  <span className="settings-profile-name truncate">{server.name}</span>
                  <span
                    className="settings-profile-meta truncate"
                    title={mcpServerSummary(server)}
                  >
                    {mcpServerSummary(server)}
                  </span>
                </div>
                <div className="settings-profile-actions">
                  <IconButton
                    variant="ghost"
                    size="sm"
                    icon={<Pencil size={12} />}
                    label={t('settings.editMcp')}
                    tooltip={t('settings.editMcpTooltip')}
                    clickAction={() => {
                      setCreating(false);
                      setEditingId(server.id);
                    }}
                  />
                  <IconButton
                    variant="ghost"
                    size="sm"
                    icon={<Trash2 size={12} />}
                    label={t('settings.deleteMcp')}
                    tooltip={t('settings.deleteMcpTooltip')}
                    clickAction={() => {
                      // #148: the whitelist references servers by id — say who
                      // loses this server before it goes away.
                      const users = loadProfiles().filter((profile) => profile.mcpServerIds.includes(server.id)).length;
                      const message = users > 0
                        ? t('settings.deleteMcpConfirmUsed', { name: server.name, n: String(users) })
                        : t('settings.deleteMcpConfirm', { name: server.name });
                      deleteAlert.show({
                        title: t('settings.deleteMcp'),
                        description: message,
                        actionLabel: t('settings.deleteMcp'),
                        actionVariant: 'destructive',
                        onAction: () => {
                          saveMcpServers(loadMcpServers().filter((entry) => entry.id !== server.id));
                          if (editingId === server.id) setEditingId(null);
                          deleteAlert.hide();
                        },
                      });
                    }}
                  />
                </div>
              </div>
            ),
          )}
        </div>
      )}
      {deleteAlert.element}
    </section>
  );
}

/** One-line summary for the row meta: transport plus its address. */
export function mcpServerSummary(server: McpServerConfig): string {
  return server.type === 'stdio'
    ? `stdio · ${server.command}${server.args.trim() ? ` ${server.args.trim()}` : ''}`
    : `${server.type} · ${server.url}`;
}

/** The MCP text view (#142): the whole config as one editable JSON/YAML
 * document. Entering seeds the text from the current list; format switching
 * and formatting round-trip through the parser (normalize → serialize), so
 * the editor's canonical shape is Panda's own. Saving REPLACES the whole
 * list — the button states the count; skip/dropped details stay visible
 * instead of vanishing into a toast. Pasting dialects from other clients
 * (Claude/Cursor/VS Code/…) parses tolerantly — see mcpText.ts. */
function McpTextEditor({ servers, onDone }: {
  servers: McpServerConfig[];
  onDone(): void;
}) {
  const { t } = useI18n();
  const [format, setFormat] = useState<McpTextFormat>('json');
  const [text, setText] = useState(() => serializeMcpServers(servers, 'json').text);
  // The last settled content: entering, a successful save, or an explicit
  // settle after a save-with-warnings. Leaving with edits past this asks.
  const baseline = useRef(text);
  const parsed = useMemo(() => parseMcpConfigText(text), [text]);
  const dirty = text !== baseline.current;
  // #160: the dirty-leave confirm used to be window.confirm.
  const dirtyAlert = useImperativeAlertDialog();

  const reserialize = (target: McpTextFormat) => {
    if (parsed.error !== null) return;
    setText(serializeMcpServers(parsed.servers, target).text);
    setFormat(target);
  };

  const leave = () => {
    if (!dirty) {
      onDone();
      return;
    }
    dirtyAlert.show({
      title: t('settings.mcpDirtyTitle'),
      description: t('settings.mcpDirtyConfirm'),
      actionLabel: t('settings.mcpDirtyLeave'),
      actionVariant: 'destructive',
      onAction: () => {
        dirtyAlert.hide();
        onDone();
      },
    });
  };

  const save = () => {
    if (parsed.error !== null) return;
    saveMcpServers(parsed.servers);
    // With warnings (skipped/renamed/dropped) stay here and show the
    // details; otherwise the edit is done.
    if (parsed.skipped.length > 0 || parsed.renames.length > 0 || parsed.droppedFields.length > 0) {
      baseline.current = text;
      return;
    }
    onDone();
  };

  const skipReasonKey: Record<McpSkipReason, string> = {
    'missing-name': t('settings.mcpSkipMissingName'),
    'invalid-entry': t('settings.mcpSkipInvalid'),
    'missing-command': t('settings.mcpSkipMissingCommand'),
    'missing-url': t('settings.mcpSkipMissingUrl'),
    'unsupported-type': t('settings.mcpSkipUnsupportedType'),
  };

  return (
    <div className="settings-mcp-editor">
      <div className="settings-mcp-toolbar">
        <div className="settings-mcp-format" role="group" aria-label={t('settings.mcpFormatLabel')}>
          {(['json', 'yaml'] as const).map((choice) => (
            <button
              key={choice}
              type="button"
              className={`settings-mcp-format-item ${format === choice ? 'settings-mcp-format-item--active' : ''}`}
              aria-pressed={format === choice}
              disabled={parsed.error !== null}
              onClick={() => reserialize(choice)}
            >
              {choice.toUpperCase()}
            </button>
          ))}
        </div>
        <IconButton
          variant="ghost"
          size="sm"
          icon={<WandSparkles size={12} />}
          label={t('settings.mcpFormatBtn')}
          tooltip={t('settings.mcpFormatBtn')}
          isDisabled={parsed.error !== null}
          clickAction={() => reserialize(format)}
        />
        <div className="settings-mcp-toolbar-actions">
          <Button variant="ghost" size="sm" label={t('settings.cancel')} clickAction={leave} />
          <Button
            variant="primary"
            size="sm"
            label={t('settings.mcpSaveCount', { n: String(parsed.servers.length) })}
            isDisabled={parsed.error !== null}
            clickAction={save}
          />
        </div>
      </div>
      <TextArea
        label={t('settings.mcpModeText')}
        isLabelHidden
        value={text}
        onChange={(value) => setText(value)}
        rows={14}
        placeholder={'{\n  "mcpServers": {\n    "filesystem": { "command": "npx", "args": ["-y", "…"] }\n  }\n}'}
        status={parsed.error !== null
          ? { type: 'error', message: `${t('settings.mcpParseError')}: ${parsed.error}` }
          : undefined}
      />
      {(parsed.skipped.length > 0 || parsed.droppedFields.length > 0 || parsed.hasPlaceholders || parsed.renames.length > 0) && (
        <div className="settings-mcp-notes">
          {parsed.skipped.length > 0 && (
            <ul className="settings-mcp-skip-list">
              {parsed.skipped.map((entry) => (
                <li key={`${entry.name}:${entry.reason}`}>
                  <span className="settings-mcp-skip-name">{entry.name}</span>
                  <span>{skipReasonKey[entry.reason]}</span>
                </li>
              ))}
            </ul>
          )}
          {parsed.droppedFields.length > 0 && (
            <p>{t('settings.mcpDroppedFields', { fields: parsed.droppedFields.join(', ') })}</p>
          )}
          {parsed.hasPlaceholders && <p>{t('settings.mcpPlaceholders')}</p>}
          {parsed.renames.length > 0 && (
            <p>{t('settings.mcpRenamed', {
              names: parsed.renames.map((r) => `${r.from} → ${r.to}`).join(', '),
            })}</p>
          )}
        </div>
      )}
      {dirtyAlert.element}
    </div>
  );
}

/** Shape the MCP form edits. */
export type McpDraft = {
  name: string;
  type: 'stdio' | 'http' | 'sse';
  command: string;
  args: string;
  url: string;
};

/** Field-level validation, shared by unit tests: every key names a field the
 * form must block saving on. */
export function mcpDraftErrors(draft: McpDraft): Partial<Record<'name' | 'command' | 'url', string>> {
  const errors: Partial<Record<'name' | 'command' | 'url', string>> = {};
  if (!draft.name.trim()) errors.name = t('settings.mcpNameRequired');
  if (draft.type === 'stdio' && !draft.command.trim()) errors.command = t('settings.mcpCommandRequired');
  if ((draft.type === 'http' || draft.type === 'sse') && !draft.url.trim()) errors.url = t('settings.mcpUrlRequired');
  return errors;
}

function McpForm({ initial, onSave, onCancel, onTextConfig }: {
  initial?: McpServerConfig;
  onSave(server: McpServerConfig): void;
  onCancel(): void;
  onTextConfig?(): void;
}) {
  const { t } = useI18n();
  const [draft, setDraft] = useState<McpDraft>(() => ({
    name: initial?.name ?? '',
    type: initial?.type ?? 'stdio',
    command: initial?.type === 'stdio' ? initial.command : '',
    args: initial?.type === 'stdio' ? initial.args : '',
    url: initial && initial.type !== 'stdio' ? initial.url : '',
  }));
  const [showErrors, setShowErrors] = useState(false);
  const errors = mcpDraftErrors(draft);
  const statusOf = (field: 'name' | 'command' | 'url') =>
    showErrors && errors[field] ? { type: 'error' as const, message: errors[field] } : undefined;

  const set = (patch: Partial<McpDraft>) => setDraft((prev) => ({ ...prev, ...patch }));
  const submit = () => {
    if (Object.keys(errors).length > 0) {
      setShowErrors(true);
      return;
    }
    onSave(
      draft.type === 'stdio'
        ? { id: initial?.id ?? newMcpServerId(), name: draft.name.trim(), type: 'stdio', command: draft.command.trim(), args: draft.args.trim() }
        : { id: initial?.id ?? newMcpServerId(), name: draft.name.trim(), type: draft.type, url: draft.url.trim() },
    );
  };

  return (
    <div className="settings-profile-form">
      {onTextConfig && (
        <div className="settings-mcp-format" role="group" aria-label={t('settings.mcpModeLabel')}>
          <button type="button" className="settings-mcp-format-item settings-mcp-format-item--active" aria-pressed="true">
            {t('settings.mcpModeForm')}
          </button>
          <button type="button" className="settings-mcp-format-item" aria-pressed="false" onClick={onTextConfig}>
            {t('settings.mcpModeText')}
          </button>
        </div>
      )}
      <TextInput
        label={t('settings.serverName')}
        value={draft.name}
        onChange={(name) => set({ name })}
        placeholder={t('settings.serverNamePlaceholder')}
        status={statusOf('name')}
        hasAutoFocus={!initial}
      />
      <Selector
        label={t('settings.type')}
        value={draft.type}
        onChange={(type) => set({ type: type === 'http' || type === 'sse' ? type : 'stdio' })}
        options={[
          { value: 'stdio', label: t('settings.typeStdio') },
          { value: 'http', label: t('settings.typeHttp') },
          { value: 'sse', label: t('settings.typeSse') },
        ]}
        labelTooltip={t('settings.typeTooltip')}
      />
      {draft.type === 'stdio' ? (
        <>
          <TextInput
            label={t('settings.command')}
            value={draft.command}
            onChange={(command) => set({ command })}
            placeholder={t('settings.commandPlaceholder')}
            status={statusOf('command')}
          />
          <TextInput
            label={t('settings.args')}
            value={draft.args}
            onChange={(args) => set({ args })}
            placeholder={t('settings.argsPlaceholder')}
          />
        </>
      ) : (
        <TextInput
          label="URL"
          value={draft.url}
          onChange={(url) => set({ url })}
          placeholder="https://mcp.example.com/mcp"
          status={statusOf('url')}
        />
      )}
      {initial && <p className="settings-card-desc">{t('settings.mcpEditNote')}</p>}
      <div className="settings-form-actions">
        <Button variant="primary" size="sm" label={initial ? t('settings.save') : t('settings.create')} clickAction={submit} />
        <Button variant="ghost" size="sm" label={t('settings.cancel')} clickAction={onCancel} />
      </div>
    </div>
  );
}

/** Shape the form edits — name/type/endpoint/workspace/MCP whitelist (the
 * whitelist rides on the profile, #148). `type` picks which endpoint fields
 * are load-bearing (#121). */
export type ProfileDraft = {
  name: string;
  type: 'websocket' | 'stdio';
  url: string;
  command: string;
  args: string;
  workspace: { kind: string; path: string };
  mcpServerIds: string[];
};
/** Field-level validation, shared by unit tests: every key names a field the
 * form must block saving on. */
export function profileDraftErrors(draft: ProfileDraft): Partial<Record<'name' | 'url' | 'command' | 'path', string>> {
  const errors: Partial<Record<'name' | 'url' | 'command' | 'path', string>> = {};
  if (!draft.name.trim()) errors.name = t('settings.nameRequired');
  if (draft.type === 'websocket' && !draft.url.trim()) errors.url = t('settings.endpointRequired');
  if (draft.type === 'stdio' && !draft.command.trim()) errors.command = t('settings.commandRequired');
  if (draft.workspace.kind === 'local-directory' && !draft.workspace.path.trim()) errors.path = t('settings.pathRequired');
  return errors;
}

function ProfileForm({ initial, onSave, onCancel }: {
  initial?: AgentProfile;
  onSave(profile: AgentProfile): void;
  onCancel(): void;
}) {
  const { t } = useI18n();
  // stdio needs a host that can spawn a child process (#121): a browser host
  // disables the option. An existing stdio profile stays selectable so it can
  // be inspected/edited instead of trapping the form.
  const stdioAvailable = hasStdioHost();
  const [draft, setDraft] = useState<ProfileDraft>(() => ({
    name: initial?.name ?? '',
    type: initial?.kind ?? 'websocket',
    url: initial?.kind === 'websocket' ? initial.url : '',
    command: initial?.kind === 'stdio' ? initial.command : '',
    args: initial?.kind === 'stdio' ? initial.args : '',
    workspace: {
      kind: initial?.workspace.kind === 'none' ? 'none' : 'local-directory',
      path: initial?.workspace.kind === 'local-directory' ? initial.workspace.path : '',
    },
    mcpServerIds: initial?.mcpServerIds ?? [],
  }));
  // Server list for the whitelist picker: definitions live on the MCP page;
  // here they are just (id, summary) rows to check on or off.
  const [mcpServers, setMcpServers] = useState<McpServerConfig[]>(() => loadMcpServers());
  useEffect(() => subscribeMcpServers(setMcpServers), []);
  const [showErrors, setShowErrors] = useState(false);
  const errors = profileDraftErrors(draft);
  // Astryx TextInput surfaces errors through its status object; they appear
  // only after a rejected submit, never while the user is still typing.
  const statusOf = (field: 'name' | 'url' | 'command' | 'path') =>
    showErrors && errors[field] ? { type: 'error' as const, message: errors[field] } : undefined;

  const set = (patch: Partial<ProfileDraft>) => setDraft((prev) => ({ ...prev, ...patch }));
  const submit = () => {
    if (Object.keys(errors).length > 0) {
      setShowErrors(true);
      return;
    }
    const workspace =
      draft.workspace.kind === 'none'
        ? { kind: 'none' as const }
        : { kind: 'local-directory' as const, path: draft.workspace.path.trim() };
    onSave(
      draft.type === 'stdio'
        ? { id: initial?.id ?? newProfileId(), name: draft.name.trim(), kind: 'stdio', command: draft.command.trim(), args: draft.args.trim(), workspace, mcpServerIds: draft.mcpServerIds }
        : { id: initial?.id ?? newProfileId(), name: draft.name.trim(), kind: 'websocket', url: draft.url.trim(), workspace, mcpServerIds: draft.mcpServerIds },
    );
  };

  return (
    <div className="settings-profile-form">
      <TextInput
        label={t('settings.profileName')}
        value={draft.name}
        onChange={(name) => set({ name })}
        placeholder={t('settings.profileNamePlaceholder')}
        status={statusOf('name')}
        hasAutoFocus={!initial}
      />
      <Selector
        label={t('settings.profileType')}
        value={draft.type}
        onChange={(type) => set({ type: type === 'stdio' ? 'stdio' : 'websocket' })}
        options={[
          { value: 'websocket', label: t('settings.typeWebsocket') },
          {
            value: 'stdio',
            label: t('settings.typeStdio'),
            disabled: !stdioAvailable && draft.type !== 'stdio',
            description: stdioAvailable || draft.type === 'stdio' ? undefined : t('settings.stdioDesktopOnly'),
          },
        ]}
        labelTooltip={t('settings.profileTypeTooltip')}
      />
      {draft.type === 'websocket' ? (
        <TextInput
          label={t('settings.endpoint')}
          value={draft.url}
          onChange={(url) => set({ url })}
          placeholder="ws://host:port/acp"
          status={statusOf('url')}
        />
      ) : (
        <>
          <TextInput
            label={t('settings.command')}
            value={draft.command}
            onChange={(command) => set({ command })}
            placeholder={t('settings.agentCommandPlaceholder')}
            status={statusOf('command')}
          />
          <TextInput
            label={t('settings.args')}
            value={draft.args}
            onChange={(args) => set({ args })}
            placeholder={t('settings.argsPlaceholder')}
          />
        </>
      )}
      <div className="settings-form-row">
        <div className="settings-form-kind">
          <Selector
            label={t('settings.defaultWorkspace')}
            value={draft.workspace.kind}
            onChange={(kind) =>
              set({ workspace: kind === 'none' ? { kind: 'none', path: '' } : { kind: 'local-directory', path: draft.workspace.path } })
            }
            options={[
              { value: 'local-directory', label: t('nsd.localDir') },
              { value: 'none', label: t('nsd.noWorkspace') },
            ]}
            labelTooltip={t('settings.workspaceTooltip')}
          />
        </div>
        {draft.workspace.kind === 'local-directory' && (
          <div className="settings-form-path">
            <TextInput
              label={t('nsd.workspacePath')}
              isLabelHidden
              width="100%"
              value={draft.workspace.path}
              onChange={(path) => set({ workspace: { ...draft.workspace, path } })}
              placeholder="/absolute/path/on/the/agent"
              status={statusOf('path')}
            />
          </div>
        )}
      </div>
      <div className="settings-form-mcp">
        <div className="settings-form-mcp-head">
          <span className="settings-form-mcp-title">{t('settings.profileMcpGroup')}</span>
          <span className="settings-form-mcp-desc">{t('settings.profileMcpDesc')}</span>
        </div>
        {mcpServers.length === 0 ? (
          <p className="settings-form-mcp-empty">{t('settings.profileMcpEmpty')}</p>
        ) : (
          <ul className="settings-form-mcp-list">
            {mcpServers.map((server) => (
              <li key={server.id} className="settings-form-mcp-item">
                <CheckboxInput
                  label={server.name}
                  value={draft.mcpServerIds.includes(server.id)}
                  onChange={(checked) =>
                    set({
                      mcpServerIds: checked
                        ? [...draft.mcpServerIds, server.id]
                        : draft.mcpServerIds.filter((id) => id !== server.id),
                    })
                  }
                />
                <span className="settings-form-mcp-meta truncate" title={mcpServerSummary(server)}>
                  {mcpServerSummary(server)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
      {initial && <p className="settings-card-desc">{t('settings.editNote')}</p>}
      <div className="settings-form-actions">
        <Button variant="primary" size="sm" label={initial ? t('settings.save') : t('settings.create')} clickAction={submit} />
        <Button variant="ghost" size="sm" label={t('settings.cancel')} clickAction={onCancel} />
      </div>
    </div>
  );
}
