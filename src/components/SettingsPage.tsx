import { useEffect, useState } from 'react';
import { ArrowLeft, Pencil, Plus, Trash2 } from 'lucide-react';
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
 * Settings screen (`#/settings`, IA refactor phase 1): the product home for
 * connection-asset management. The sidebar keeps sessions only — profile
 * CRUD (add/rename/edit endpoint & default workspace/delete) and the theme
 * picker live here. Edits to url/workspace apply on the next connect (same
 * semantics as the connect-time write-back); deleting a profile never
 * touches the endpoint's remembered sessions.
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
        <section className="settings-section">
          <h2 className="settings-section-title">外观</h2>
          <ThemeRow />
        </section>

        <section className="settings-section">
          <h2 className="settings-section-title">Agent 配置</h2>
          <p className="settings-hint">
            配置保存 agent 的端点地址与默认工作区;新建会话时直接选用。端点与工作区的修改在下次连接时生效,删除配置不影响该端点已记忆的会话。
          </p>
          <ProfileList profiles={profiles} />
        </section>
      </div>
    </div>
  );
}

function ThemeRow() {
  const [themeId, setThemeId] = useState(loadThemeId);
  useEffect(() => subscribeTheme(setThemeId), []);
  const exposed = THEMES.filter((choice) => EXPOSED_THEME_IDS.includes(choice.id));
  // Same contract as the old sidebar picker: hidden while a single theme is
  // exposed — a one-option selector is noise.
  if (exposed.length <= 1) return <p className="settings-hint">主题选择器将在更多主题开放后出现。</p>;
  return (
    <div className="settings-theme-row">
      <Selector
        label="主题"
        value={themeId}
        onChange={(value) => {
          if (isThemeId(value)) saveThemeId(value);
        }}
        options={exposed.map((choice) => ({ value: choice.id, label: choice.label }))}
        labelTooltip="主题:Astryx 官方主题(7 个),随时切换,自动记住选择"
      />
    </div>
  );
}

function ProfileList({ profiles }: { profiles: AgentProfile[] }) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  if (creating) {
    return (
      <ProfileForm
        onCancel={() => setCreating(false)}
        onSave={(profile) => {
          saveProfiles([...loadProfiles(), profile]);
          setCreating(false);
        }}
      />
    );
  }

  return (
    <div className="settings-profile-list">
      <div className="settings-profile-toolbar">
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
      {profiles.length === 0 && (
        <p className="settings-hint">还没有配置 — 新增一条,之后新建会话时就能直接选这个 agent。</p>
      )}
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
            <div className="settings-profile-main">
              <span className="settings-profile-name truncate">{profile.name}</span>
              <span className="settings-profile-meta truncate" title={`${profile.url} · ${workspaceDisplay(profile.workspace)}`}>
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
      {initial && <p className="settings-hint">端点与工作区的修改在下一次连接时生效。</p>}
      <div className="settings-form-actions">
        <Button variant="primary" size="sm" label={initial ? '保存' : '创建'} clickAction={submit} />
        <Button variant="ghost" size="sm" label="取消" clickAction={onCancel} />
      </div>
    </div>
  );
}
