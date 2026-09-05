import { useEffect, useState } from 'react';
import { ArrowLeft, Bot, Check, Palette, Pencil, Play, Plus, Terminal, Trash2 } from 'lucide-react';
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
import { navigate } from '../routes';
import { isThemeId, loadThemeId, saveThemeId, subscribeTheme, THEMES, EXPOSED_THEME_IDS } from '../theme';
import { workspaceDisplay } from '../workspace';
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
  const [profiles, setProfiles] = useState<AgentProfile[]>(() => loadProfiles());
  useEffect(() => subscribeProfiles(setProfiles), []);

  return (
    <div className="settings-page">
      <header className="settings-header">
        <IconButton
          variant="ghost"
          icon={<ArrowLeft size={16} />}
          label="返回"
          tooltip="回到会话界面"
          clickAction={() => navigate('main')}
        />
        <h1 className="settings-title">设置</h1>
      </header>

      <div className="settings-body">
        <section className="settings-card">
          <div className="settings-card-head">
            <span className="settings-card-icon" aria-hidden>
              <Palette size={14} />
            </span>
            <h2 className="settings-card-title">外观</h2>
          </div>
          <p className="settings-card-desc">主题影响整个界面的配色,随时切换,自动记住选择。</p>
          <ThemeSwatches />
        </section>

        <ProfileCard profiles={profiles} />

        {import.meta.env.DEV && (
          <section className="settings-card settings-card--muted">
            <div className="settings-card-head">
            <span className="settings-card-icon" aria-hidden>
              <Terminal size={14} />
            </span>
            <h2 className="settings-card-title">开发者</h2>
              <div className="settings-card-actions">
                <Button
                  variant="secondary"
                  size="sm"
                  label="Demo 回放"
                  icon={<Play size={12} />}
                  clickAction={() => navigate('demo')}
                  tooltip="打开 #/demo 剧本回放(不连真实 agent);重新进入即从头重放"
                />
              </div>
            </div>
            <p className="settings-card-desc">仅开发构建可见的内部工具。</p>
          </section>
        )}

        <p className="settings-colophon">Panda — 连接任意 ACP agent 的纯协议客户端</p>
      </div>
    </div>
  );
}

/** Theme swatch row: each chip renders inside its own theme's scope, so the
 * color dot resolves that theme's real --color-accent — the preview needs no
 * per-theme color table. */
function ThemeSwatches() {
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
      {exposed.length <= 1 && <span className="settings-theme-more">更多主题将陆续开放</span>}
    </div>
  );
}

/** The Agent 配置 card: header with the create action, the description, and
 * the avatar-row list (a row swaps for the edit form in place). */
function ProfileCard({ profiles }: { profiles: AgentProfile[] }) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  return (
    <section className="settings-card">
      <div className="settings-card-head">
        <span className="settings-card-icon" aria-hidden>
          <Bot size={15} />
        </span>
        <h2 className="settings-card-title">Agent 配置</h2>
        {!creating && (
          <div className="settings-card-actions">
            <Button
              variant="secondary"
              size="sm"
              label="新增配置"
              icon={<Plus size={12} />}
              clickAction={() => {
                setEditingId(null);
                setCreating(true);
              }}
            />
          </div>
        )}
      </div>
      <p className="settings-card-desc">
        保存 agent 的端点地址与默认工作区,新建会话时直接选用。
      </p>

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
          <p className="settings-profile-empty-title">还没有 Agent 配置</p>
          <p className="settings-profile-empty-desc">新增一条,之后新建会话时就能直接选这个 agent。</p>
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
                    label="编辑配置"
                    tooltip="编辑名称、端点地址或默认工作区"
                    clickAction={() => {
                      setCreating(false);
                      setEditingId(profile.id);
                    }}
                  />
                  <IconButton
                    variant="ghost"
                    size="sm"
                    icon={<Trash2 size={12} />}
                    label="删除配置"
                    tooltip="删除这条配置(不影响该端点已记忆的会话)"
                    clickAction={() => {
                      if (window.confirm(`删除配置「${profile.name}」?该端点已记忆的会话不受影响。`)) {
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

/** Shape the form edits — name/url/workspace (path rides on the workspace). */
export type ProfileDraft = { name: string; url: string; workspace: { kind: string; path: string } };

/** Field-level validation, shared by unit tests: every key names a field the
 * form must block saving on. */
export function profileDraftErrors(draft: ProfileDraft): Partial<Record<'name' | 'url' | 'path', string>> {
  const errors: Partial<Record<'name' | 'url' | 'path', string>> = {};
  if (!draft.name.trim()) errors.name = '配置名称不能为空';
  if (!draft.url.trim()) errors.url = '端点地址不能为空';
  if (draft.workspace.kind === 'local-directory' && !draft.workspace.path.trim()) errors.path = '本机文件夹需要路径';
  return errors;
}

function ProfileForm({ initial, onSave, onCancel }: {
  initial?: AgentProfile;
  onSave(profile: AgentProfile): void;
  onCancel(): void;
}) {
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
        label="配置名称"
        value={draft.name}
        onChange={(name) => set({ name })}
        placeholder="如:test-agent"
        status={statusOf('name')}
        hasAutoFocus={!initial}
      />
      <TextInput
        label="端点地址"
        value={draft.url}
        onChange={(url) => set({ url })}
        placeholder="ws://host:port/acp"
        status={statusOf('url')}
      />
      <div className="settings-form-row">
        <div className="settings-form-kind">
          <Selector
            label="默认工作区"
            value={draft.workspace.kind}
            onChange={(kind) =>
              set({ workspace: kind === 'none' ? { kind: 'none', path: '' } : { kind: 'local-directory', path: draft.workspace.path } })
            }
            options={[
              { value: 'local-directory', label: '本机文件夹' },
              { value: 'none', label: '无工作区' },
            ]}
            labelTooltip="新建会话时默认使用的 agent 侧工作上下文(ADR 0005)"
          />
        </div>
        {draft.workspace.kind === 'local-directory' && (
          <div className="settings-form-path">
            <TextInput
              label="工作区路径"
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
      {initial && <p className="settings-card-desc">端点与工作区的修改在下一次连接时生效。</p>}
      <div className="settings-form-actions">
        <Button variant="primary" size="sm" label={initial ? '保存' : '创建'} clickAction={submit} />
        <Button variant="ghost" size="sm" label="取消" clickAction={onCancel} />
      </div>
    </div>
  );
}
