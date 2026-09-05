import { useEffect, useState } from 'react';
import { ArrowLeft, Bot, Check, Palette, Pencil, Play, Plug, Plus, Terminal, Trash2 } from 'lucide-react';
import { Button } from '@astryxdesign/core/Button';
import { IconButton } from '@astryxdesign/core/IconButton';
import { Selector } from '@astryxdesign/core/Selector';
import { TextInput } from '@astryxdesign/core/TextInput';
import {
  loadProfiles,
  newProfileId,
  saveProfiles,
  subscribeProfiles,
  updateProfileFields,
  type AgentProfile,
} from '../profiles';
import {
  loadMcpServers,
  newMcpServerId,
  saveMcpServers,
  subscribeMcpServers,
  type McpServerConfig,
} from '../mcpServers';
import { navigate } from '../routes';
import { isThemeId, loadThemeId, saveThemeId, subscribeTheme, THEMES, EXPOSED_THEME_IDS } from '../theme';
import { workspaceDisplay } from '../workspace';
import { Languages } from 'lucide-react';
import { LOCALES, saveLocale } from '../i18n';
import { t } from '../i18n';
import { useI18n } from '../i18n/context';
import './SettingsPage.css';

/**
 * Settings screen (`#/settings`, IA refactor phase 1; redesigned phase 5):
 * the product home for connection-asset management. Carded sections on a
 * centered column — appearance (theme swatches), Agent 配置 CRUD (avatar
 * rows), and a dev-only tools card. Edits to url/workspace apply on the next
 * connect; deleting a profile never touches the endpoint's remembered
 * sessions.
 */
export function SettingsPage() {
  const { t } = useI18n();
  const [profiles, setProfiles] = useState<AgentProfile[]>(() => loadProfiles());
  useEffect(() => subscribeProfiles(setProfiles), []);

  return (
    <div className="settings-page">
      <header className="settings-header">
        <IconButton
          variant="ghost"
          icon={<ArrowLeft size={16} />}
          label={t('settings.back')}
          tooltip={t('settings.backTooltip')}
          clickAction={() => navigate('main')}
        />
        <h1 className="settings-title">{t('settings.title')}</h1>
      </header>

      <div className="settings-body">
        <section className="settings-card">
          <div className="settings-card-head">
            <span className="settings-card-icon" aria-hidden>
              <Palette size={14} />
            </span>
            <h2 className="settings-card-title">{t('settings.appearance')}</h2>
          </div>
          <p className="settings-card-desc">{t('settings.appearanceDesc')}</p>
          <ThemeSwatches />
        </section>

        <section className="settings-card">
          <div className="settings-card-head">
            <span className="settings-card-icon" aria-hidden>
              <Languages size={14} />
            </span>
            <h2 className="settings-card-title">{t('settings.language')}</h2>
          </div>
          <p className="settings-card-desc">{t('settings.languageDesc')}</p>
          <LanguageChips />
        </section>

        <ProfileCard profiles={profiles} />

        <McpCard />

        {import.meta.env.DEV && (
          <section className="settings-card settings-card--muted">
            <div className="settings-card-head">
            <span className="settings-card-icon" aria-hidden>
              <Terminal size={14} />
            </span>
            <h2 className="settings-card-title">{t('settings.dev')}</h2>
              <div className="settings-card-actions">
                <Button
                  variant="secondary"
                  size="sm"
                  label={t('settings.demoReplay')}
                  icon={<Play size={12} />}
                  clickAction={() => navigate('demo')}
                  tooltip={t('settings.demoReplayTooltip')}
                />
              </div>
            </div>
            <p className="settings-card-desc">{t('settings.devDesc')}</p>
          </section>
        )}

        <p className="settings-colophon">{t('settings.colophon')}</p>
      </div>
    </div>
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

/** The Agent 配置 card: header with the create action, the description, and
 * the avatar-row list (a row swaps for the edit form in place). */
function ProfileCard({ profiles }: { profiles: AgentProfile[] }) {
  const { t } = useI18n();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  return (
    <section className="settings-card">
      <div className="settings-card-head">
        <span className="settings-card-icon" aria-hidden>
          <Bot size={15} />
        </span>
        <h2 className="settings-card-title">{t('settings.profiles')}</h2>
        {!creating && (
          <div className="settings-card-actions">
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
          </div>
        )}
      </div>
      <p className="settings-card-desc">{t('settings.profilesDesc')}</p>

      {creating ? (
        <ProfileForm
          onCancel={() => setCreating(false)}
          onSave={(profile) => {
            saveProfiles([...loadProfiles(), profile]);
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
                onSave={(fields) => {
                  updateProfileFields(profile.id, fields);
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
                    title={`${profile.url} · ${workspaceDisplay(profile.workspace)}`}
                  >
                    {profile.url} · {workspaceDisplay(profile.workspace)}
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
                      if (window.confirm(t('settings.deleteProfileConfirm', { name: profile.name }))) {
                        saveProfiles(loadProfiles().filter((entry) => entry.id !== profile.id));
                        if (editingId === profile.id) setEditingId(null);
                      }
                    }}
                  />
                </div>
              </div>
            ),
          )}
        </div>
      )}
    </section>
  );
}

/** The MCP 服务器 card (issue #71): the v1 execution surface — configured
 * servers ride every session/new · session/load to the agent. Same in-place
 * edit pattern as the Agent 配置 card. */
function McpCard() {
  const { t } = useI18n();
  const [servers, setServers] = useState<McpServerConfig[]>(() => loadMcpServers());
  useEffect(() => subscribeMcpServers(setServers), []);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  return (
    <section className="settings-card">
      <div className="settings-card-head">
        <span className="settings-card-icon" aria-hidden>
          <Plug size={15} />
        </span>
        <h2 className="settings-card-title">{t('settings.mcp')}</h2>
        {!creating && (
          <div className="settings-card-actions">
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
      <p className="settings-card-desc">{t('settings.mcpDesc')}</p>

      {creating ? (
        <McpForm
          onCancel={() => setCreating(false)}
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
                      if (window.confirm(t('settings.deleteMcpConfirm', { name: server.name }))) {
                        saveMcpServers(loadMcpServers().filter((entry) => entry.id !== server.id));
                        if (editingId === server.id) setEditingId(null);
                      }
                    }}
                  />
                </div>
              </div>
            ),
          )}
        </div>
      )}
    </section>
  );
}

/** One-line summary for the row meta: transport plus its address. */
export function mcpServerSummary(server: McpServerConfig): string {
  return server.type === 'stdio'
    ? `stdio · ${server.command}${server.args.trim() ? ` ${server.args.trim()}` : ''}`
    : `${server.type} · ${server.url}`;
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

function McpForm({ initial, onSave, onCancel }: {
  initial?: McpServerConfig;
  onSave(server: McpServerConfig): void;
  onCancel(): void;
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

/** Shape the form edits — name/url/workspace (path rides on the workspace). */
export type ProfileDraft = { name: string; url: string; workspace: { kind: string; path: string } };/** Field-level validation, shared by unit tests: every key names a field the
 * form must block saving on. */
export function profileDraftErrors(draft: ProfileDraft): Partial<Record<'name' | 'url' | 'path', string>> {
  const errors: Partial<Record<'name' | 'url' | 'path', string>> = {};
  if (!draft.name.trim()) errors.name = t('settings.nameRequired');
  if (!draft.url.trim()) errors.url = t('settings.endpointRequired');
  if (draft.workspace.kind === 'local-directory' && !draft.workspace.path.trim()) errors.path = t('settings.pathRequired');
  return errors;
}

function ProfileForm({ initial, onSave, onCancel }: {
  initial?: AgentProfile;
  onSave(profile: AgentProfile): void;
  onCancel(): void;
}) {
  const { t } = useI18n();
  const [draft, setDraft] = useState<ProfileDraft>(() => ({
    name: initial?.name ?? '',
    url: initial?.url ?? '',
    workspace: {
      kind: initial?.workspace.kind === 'none' ? 'none' : 'local-directory',
      path: initial?.workspace.kind === 'local-directory' ? initial.workspace.path : '',
    },
  }));
  const [showErrors, setShowErrors] = useState(false);
  const errors = profileDraftErrors(draft);
  // Astryx TextInput surfaces errors through its status object; they appear
  // only after a rejected submit, never while the user is still typing.
  const statusOf = (field: 'name' | 'url' | 'path') =>
    showErrors && errors[field] ? { type: 'error' as const, message: errors[field] } : undefined;

  const set = (patch: Partial<ProfileDraft>) => setDraft((prev) => ({ ...prev, ...patch }));
  const submit = () => {
    if (Object.keys(errors).length > 0) {
      setShowErrors(true);
      return;
    }
    onSave({
      id: initial?.id ?? newProfileId(),
      name: draft.name.trim(),
      url: draft.url.trim(),
      workspace:
        draft.workspace.kind === 'none'
          ? { kind: 'none' }
          : { kind: 'local-directory', path: draft.workspace.path.trim() },
    });
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
      <TextInput
        label={t('settings.endpoint')}
        value={draft.url}
        onChange={(url) => set({ url })}
        placeholder="ws://host:port/acp"
        status={statusOf('url')}
      />
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
      {initial && <p className="settings-card-desc">{t('settings.editNote')}</p>}
      <div className="settings-form-actions">
        <Button variant="primary" size="sm" label={initial ? t('settings.save') : t('settings.create')} clickAction={submit} />
        <Button variant="ghost" size="sm" label={t('settings.cancel')} clickAction={onCancel} />
      </div>
    </div>
  );
}
