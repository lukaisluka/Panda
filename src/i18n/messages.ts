/**
 * The message dictionary (#91): every UI-chrome string Panda renders, keyed
 * `<domain>.<name>` with one entry per locale. en is the source of truth —
 * zh entries may lag (translate() falls back to en when the zh slot is
 * missing), but an entirely missing KEY is a programming error and warns in
 * the console.
 *
 * Scope (issue #91): chrome only — buttons, labels, badges, placeholders,
 * hints, notices, and error strings that reach the UI. NOT translated: agent
 * output (messages, tool results, diffs), demo replay fixtures, user input,
 * docs, and code comments (this file's zh column is the only place those
 * strings leave the components).
 *
 * Interpolation: `{name}` placeholders, filled by t(key, { name: value }).
 */
export const messages = {
  // ---- shell / app frame ----
  'app.closeNav': { en: 'Close navigation', zh: '关闭导航' },
  'app.openNav': { en: 'Open navigation', zh: '打开导航' },
  'app.liveSessionTitle': { en: 'Live session', zh: 'Live 会话' },
  'app.demoHeaderTitle': { en: 'Refactor auth validation', zh: '重构 auth 校验' },

  // ---- shared connection states (StatusDot labels etc.) ----
  'conn.connected': { en: 'Connected', zh: '已连接' },
  'conn.error': { en: 'Connection error', zh: '连接错误' },
  'conn.authRequired': { en: 'Sign-in required', zh: '需要登录' },
  'conn.disconnected': { en: 'Not connected', zh: '未连接' },
  'conn.running': { en: 'Running', zh: '运行中' },

  // ---- StatusBar ----
  'status.connecting': { en: 'Connecting…', zh: '连接中…' },
  'status.switching': { en: 'Switching session…', zh: '切换会话中…' },
  'status.authenticated': { en: 'Authenticated', zh: '已认证' },
  'status.authenticatedVia': { en: 'Authenticated via “{name}”', zh: '已通过「{name}」认证' },
  'status.authenticate': { en: 'Authenticate', zh: '认证' },
  'status.authenticateVia': { en: 'Authenticate via “{name}”', zh: '通过「{name}」认证' },
  'status.awaitingApproval': { en: 'Awaiting your approval', zh: '等待你的批准' },
  'status.working': { en: 'Working…', zh: 'Working…' },
  'status.ready': { en: 'Ready', zh: 'Ready' },

  // ---- Composer ----
  'composer.placeholder': { en: 'Message Panda…', zh: '给 Panda 发消息…' },
  'composer.commands': { en: 'Slash commands', zh: '斜杠命令' },
  'composer.paramHint': { en: 'Input: {hint}', zh: '参数:{hint}' },
  'composer.removeAttachment': { en: 'Remove {name}', zh: '移除 {name}' },
  'composer.attach': { en: 'Add image', zh: '添加图片' },
  'composer.attachUnavailable': { en: 'This agent does not declare image input', zh: '当前 agent 未声明图片输入能力' },
  'composer.attachDisabled': { en: 'Cannot add images right now', zh: '当前不可添加图片' },
  'composer.settings': { en: 'Session settings', zh: '会话设置' },
  'composer.settingsDisabled': { en: 'Cannot change settings right now', zh: '当前不可调整设置' },
  'composer.stop': { en: 'Stop', zh: '停止' },
  'composer.send': { en: 'Send', zh: '发送' },
  'composer.readImageFailed': { en: 'Failed to read image: {message}', zh: '读取图片失败:{message}' },
  'composer.hintImages': {
    en: 'Enter to send, Shift+Enter for a new line · paste or pick images',
    zh: 'Enter 发送,Shift+Enter 换行 · 可粘贴或选择图片',
  },

  // ---- attachments ----
  'attach.oversize': { en: '>5MB, will not be sent', zh: '>5MB,不会发送' },
  'attach.tooMany': { en: 'Up to {n} images, will not be sent', zh: '最多 {n} 张,不会发送' },
  'attach.notImage': { en: 'Not an image file: {name}', zh: '不是图片文件: {name}' },
  'attach.pastedName': { en: 'Pasted image', zh: '粘贴的图片' },

  // ---- MessageStream ----
  'stream.compacting': { en: 'Compacting context…', zh: '正在压缩上下文…' },
  'stream.jumpToLatest': { en: 'Jump to latest', zh: '回到最新' },
  'stream.compacted': { en: 'Context compacted', zh: '上下文已压缩' },
  'stream.compactFailed': { en: 'Context compaction failed', zh: '上下文压缩失败' },
  'stream.compactFailedReason': { en: 'Context compaction failed: {error}', zh: '上下文压缩失败:{error}' },

  // ---- PermissionCard ----
  'perm.title': { en: 'Agent requests approval', zh: 'Agent 请求批准' },
  'perm.unknownOption': { en: '{name} (unknown option type)', zh: '{name}(未知选项类型)' },
  'perm.deniedByPolicy': { en: 'Denied by policy', zh: '已由策略拒绝' },
  'perm.autoAnswered': { en: 'Auto-answered {kind} (not by you)', zh: '已代答 {kind}(非用户决定)' },
  'perm.autoCancelled': {
    en: 'The agent offered no reject option; auto-answered cancelled (not by you)',
    zh: 'agent 未提供拒绝选项,已代答 cancelled(非用户决定)',
  },
  'perm.byPriorChoice': { en: "Auto-answered from this session's earlier choices", zh: '按本会话既往选择代答' },
  'perm.autoRejected': {
    en: 'You chose “reject always” for this action earlier this session; auto-rejected',
    zh: '你本会话曾对同一操作选择 reject_always,已自动拒绝',
  },
  'perm.autoAllowed': {
    en: 'You chose “allow always” for this action earlier this session; auto-allowed',
    zh: '你本会话曾对同一操作选择 allow_always,已自动放行',
  },
  'perm.allowOnce': { en: 'Allow', zh: '允许' },
  'perm.allowAlways': { en: 'Always allow', zh: '始终允许' },
  'perm.rejectOnce': { en: 'Reject', zh: '拒绝' },
  'perm.rejectAlways': { en: 'Always reject', zh: '始终拒绝' },
  'perm.approved': { en: 'Approved', zh: '已批准' },
  'perm.rejected': { en: 'Rejected', zh: '已拒绝' },

  // ---- ElicitationCard / ElicitationUrlCard ----
  'elicit.title': { en: 'Agent request', zh: 'Agent 请求信息' },
  'elicit.reject': { en: 'Decline', zh: '拒绝' },
  'elicit.submit': { en: 'Submit', zh: '提交' },
  'elicit.required': { en: 'Required', zh: '必填' },
  'elicit.unsupported': {
    en: 'Unsupported field type ({type}); this field cannot be filled in',
    zh: '暂不支持的字段类型({type}),此项不可填写',
  },
  'elicit.placeholderInteger': { en: 'Integer', zh: '整数' },
  'elicit.placeholderNumber': { en: 'Number', zh: '数字' },
  'elicit.done': { en: 'Done', zh: '已完成' },
  'elicit.submitted': { en: 'Submitted ({n} fields)', zh: '已提交({n} 项)' },
  'elicit.declined': { en: 'Declined', zh: '已拒绝' },
  'elicit.cancelled': { en: 'Cancelled (not by you)', zh: '已取消(非用户决定)' },
  'elicit.url.title': { en: 'External authorization', zh: '外部授权' },
  'elicit.url.opened': { en: 'Link opened; waiting for the external flow to finish…', zh: '链接已打开,等待外部流程完成…' },
  'elicit.url.gateTitle': { en: 'Agent request (external authorization)', zh: 'Agent 请求信息(外部授权)' },
  'elicit.url.punycode': {
    en: 'Domain contains Punycode (xn--) — beware of look-alike sites',
    zh: '域名含 Punycode(xn--),谨防仿冒站点',
  },
  'elicit.url.insecure': { en: 'Link is not HTTPS; transport is unprotected', zh: '链接不是 HTTPS,传输不受保护' },
  'elicit.url.unparseable': { en: 'Link could not be parsed; opening disabled', zh: '链接无法解析,已禁用打开' },
  'elicit.url.desc': {
    en: 'Clicking opens the link in a new browser tab; authorization completes on the external page.',
    zh: '点击后将在你的浏览器新标签页打开,授权在外部页面完成。',
  },
  'elicit.url.open': { en: 'Open link', zh: '打开链接' },

  // ---- ToolCallCard / DiffView ----
  'tool.awaitApproval': { en: 'Awaiting approval', zh: '等待批准' },
  'tool.queued': { en: 'Queued', zh: '排队中' },
  'tool.queuedTooltip': {
    en: 'Another tool in this batch is awaiting approval; approvals resume the whole batch — approving runs this call immediately',
    zh: '同批工具里有一个在等审批;审批是按整批一起恢复的,批准后这张卡立即执行',
  },
  'tool.running': { en: 'Running', zh: '执行中' },
  'tool.unsupportedBlock': { en: 'Unsupported content block ({type})', zh: '未支持的内容块({type})' },
  'tool.waitingApproval': { en: 'Waiting for approval…', zh: '等待批准后执行…' },
  'tool.waitingOutput': { en: 'Waiting for output…', zh: '等待输出…' },
  'tool.rawJson': { en: 'Raw JSON', zh: '原始 JSON' },
  'diff.copyPatch': { en: 'Copy patch', zh: '复制补丁' },
  'diff.fold': { en: '⋯ {n} unchanged lines', zh: '⋯ {n} 行未变更' },

  // ---- small blocks ----
  'clamp.collapse': { en: 'Collapse', zh: '收起' },
  'clamp.expand': { en: 'Expand all', zh: '展开全部' },
  'code.copy': { en: 'Copy code', zh: '复制代码' },
  'config.title': { en: 'Session settings', zh: '会话设置' },
  'mode.menu': { en: 'Session mode', zh: '会话模式' },
  'plan.dock': { en: 'Session plan', zh: '会话计划' },
  'plan.title': { en: 'Plan', zh: '计划' },
  'unsupported.event': { en: 'Not-yet-supported ACP event · {kind}', zh: '暂不支持的 ACP 事件 · {kind}' },
  'turn.cancelled': { en: 'Cancelled', zh: '已取消' },
  'turn.refusal': { en: 'The model refused this request', zh: '模型拒绝了本次请求' },
  'turn.maxTokens': { en: 'Output hit the length limit (max_tokens)', zh: '输出达到长度上限(max_tokens)' },
  'turn.maxTurnRequests': { en: 'Hit the per-turn request limit (max_turn_requests)', zh: '达到单回合请求上限(max_turn_requests)' },

  // ---- AuthGate ----
  'auth.gateTitle': { en: 'This agent requires sign-in', zh: '此 agent 需要登录' },
  'auth.noMethods': {
    en: 'The agent provided no browser-usable sign-in method',
    zh: 'agent 未提供浏览器可用的登录方式',
  },

  // ---- NewSessionDialog ----
  'nsd.title': { en: 'New session', zh: '新建会话' },
  'nsd.subtitle': { en: 'Choose an agent to talk to', zh: '选择要对话的 agent' },
  'nsd.empty': {
    en: 'No agent profiles yet — add one in Settings, or use a custom address below for a temporary direct connection.',
    zh: '还没有 Agent 配置 — 在设置页添加,或用下方自定义地址临时直连。',
  },
  'nsd.newIn': { en: 'New session in {name}', zh: '在 {name} 中新建会话' },
  'nsd.connect': {
    en: 'Connect to {name} ({url}) — starts a new session once connected',
    zh: '连接 {name}({url})— 连接成功即进入新会话',
  },
  'nsd.custom': { en: 'Custom address', zh: '自定义地址' },
  'nsd.customHint': { en: 'Temporary direct connection; not saved as a profile.', zh: '临时直连,不保存为配置。' },
  'nsd.endpoint': { en: 'Endpoint', zh: '端点地址' },
  'nsd.workspace': { en: 'Workspace', zh: '工作区' },
  'nsd.localDir': { en: 'Local directory', zh: '本机文件夹' },
  'nsd.noWorkspace': { en: 'No workspace', zh: '无工作区' },
  'nsd.workspaceTooltip': {
    en: 'Workspace: the agent-side working context for a new session (ADR 0005)',
    zh: '工作区:新会话在 agent 侧的工作上下文(ADR 0005)',
  },
  'nsd.workspacePath': { en: 'Workspace path', zh: '工作区路径' },
  'nsd.connectStart': { en: 'Connect & start', zh: '连接并开始' },
  'nsd.endpointRequired': { en: 'Endpoint is required', zh: '端点地址不能为空' },
  'nsd.pathRequired': { en: 'A local directory needs a path', zh: '本机文件夹需要路径' },

  // ---- Sidebar ----
  'side.newSession': { en: 'New session', zh: '新建会话' },
  'side.newSessionTooltip': {
    en: 'Pick an agent to start a new session (or use a custom address for a temporary direct connection)',
    zh: '选择 agent 开始新会话(可临时直连自定义地址)',
  },
  'side.noAgents': {
    en: 'No agents yet — add one with “Add agent” below, or use + above for a temporary direct connection',
    zh: '还没有 agent — 用下方「添加 agent」添加配置,或点上方 + 临时直连',
  },
  'side.addAgent': { en: 'Add agent', zh: '添加 agent' },
  'side.settings': { en: 'Settings', zh: '设置' },
  'side.settingsTooltip': { en: 'Settings: agent profiles, theme', zh: '设置:Agent 配置、主题' },
  'side.profileNamePrompt': { en: 'Profile name', zh: '配置名称' },
  'side.temp': { en: 'Temp', zh: '临时' },
  'side.needsAttention': { en: 'Needs attention', zh: '需要关注' },
  'side.attentionTooltip': { en: 'Needs attention: {reasons}', zh: '需要关注:{reasons}' },
  'side.saveProfile': { en: 'Save as profile', zh: '存为配置' },
  'side.saveProfileTooltip': {
    en: 'Save the current endpoint & workspace as an agent profile (the connection stays up)',
    zh: '把当前端点与工作区保存为 Agent 配置(连接不打断)',
  },
  'side.disconnect': { en: 'Disconnect', zh: '断开连接' },
  'side.disconnectTemp': {
    en: 'Disconnect (this temporary direct connection ends here)',
    zh: '断开(临时直连到此结束)',
  },
  'side.disconnectSlot': {
    en: 'Disconnect (keeps the session slot; it can reconnect)',
    zh: '断开(保留会话槽,可重连)',
  },
  'side.connectProfile': { en: 'Connect', zh: '连接此配置' },
  'side.connectProfileTooltip': { en: 'Connect {name} ({url})', zh: '连接 {name}({url})' },
  'side.removeConnection': { en: 'Remove connection', zh: '移除连接' },
  'side.removeConnectionTooltip': {
    en: 'Remove (disconnect and clear this connection’s local session documents)',
    zh: '移除(断开并清除该连接的本地会话文档)',
  },
  'side.removeConfirm': {
    en: 'Remove connection “{title}”? Its local session records will be cleared (the endpoint’s remembered session list stays).',
    zh: '移除连接「{title}」?其本地会话记录将被清除(按端点记忆的会话列表保留)。',
  },
  'side.resume': { en: 'Reconnect & resume', zh: '重连并恢复会话' },
  'side.resumeTooltip': {
    en: 'Prefers resume to keep the current conversation; falls back to session/load when the agent does not support it',
    zh: '优先 resume 保留当前对话;agent 不支持时用 session/load 重建历史',
  },
  'side.reconnect': { en: 'Reconnect', zh: '重连' },
  'side.disabled.busy': { en: 'Wait for the current turn or switch to finish', zh: '等待当前回合或切换完成' },
  'side.disabled.offline': { en: 'Connect to view/switch this session', zh: '连接后可查看/切换该会话' },
  'side.disabled.host': { en: 'The host does not support session replay', zh: '宿主暂不支持会话回放' },
  'side.disabled.agent': {
    en: 'The agent does not support history replay (session/load)',
    zh: 'agent 不支持历史回放(session/load)',
  },
  'side.deleteSession': { en: 'Delete session', zh: '删除会话' },
  'side.deleteSessionTooltip': { en: 'Delete session (session/delete)', zh: '删除会话(session/delete)' },
  'side.attention.unreadCompletion': { en: 'Unread completion', zh: '未读完成' },
  'side.attention.pendingPermission': { en: 'Permission pending', zh: '权限待处理' },
  'side.attention.connectionError': { en: 'Connection error', zh: '连接错误' },
  'side.attention.authRequired': { en: 'Sign-in required', zh: '需要登录' },

  // ---- SettingsPage ----
  'settings.back': { en: 'Back', zh: '返回' },
  'settings.backTooltip': { en: 'Back to the session view', zh: '回到会话界面' },
  'settings.title': { en: 'Settings', zh: '设置' },
  'settings.appearance': { en: 'Appearance', zh: '外观' },
  'settings.appearanceDesc': {
    en: 'The theme colors the whole interface — switch anytime, the choice is remembered.',
    zh: '主题影响整个界面的配色,随时切换,自动记住选择。',
  },
  'settings.themeMore': { en: 'More themes coming soon', zh: '更多主题将陆续开放' },
  'settings.language': { en: 'Language', zh: '语言' },
  'settings.languageDesc': {
    en: 'Interface language — switches instantly and is remembered.',
    zh: '界面语言,即时切换并自动记住。',
  },
  'settings.locale.en': { en: 'English', zh: 'English' },
  'settings.locale.zh': { en: '中文', zh: '中文' },
  'settings.profiles': { en: 'Agent profiles', zh: 'Agent 配置' },
  'settings.addProfile': { en: 'Add profile', zh: '新增配置' },
  'settings.profilesDesc': {
    en: 'Save agent endpoints and default workspaces to pick directly when starting a session.',
    zh: '保存 agent 的端点地址与默认工作区,新建会话时直接选用。',
  },
  'settings.noProfiles': { en: 'No agent profiles yet', zh: '还没有 Agent 配置' },
  'settings.noProfilesDesc': {
    en: 'Add one and it becomes directly selectable when starting a session.',
    zh: '新增一条,之后新建会话时就能直接选这个 agent。',
  },
  'settings.editProfile': { en: 'Edit profile', zh: '编辑配置' },
  'settings.editProfileTooltip': {
    en: 'Edit the name, endpoint, or default workspace',
    zh: '编辑名称、端点地址或默认工作区',
  },
  'settings.deleteProfile': { en: 'Delete profile', zh: '删除配置' },
  'settings.deleteProfileTooltip': {
    en: 'Delete this profile (the endpoint’s remembered sessions are untouched)',
    zh: '删除这条配置(不影响该端点已记忆的会话)',
  },
  'settings.deleteProfileConfirm': {
    en: 'Delete profile “{name}”? The endpoint’s remembered sessions are unaffected.',
    zh: '删除配置「{name}」?该端点已记忆的会话不受影响。',
  },
  'settings.mcp': { en: 'MCP servers', zh: 'MCP 服务器' },
  'settings.addMcp': { en: 'Add server', zh: '新增服务器' },
  'settings.mcpDesc': {
    en: 'Configured tool servers ride every session/new · session/load to the agent, which connects and obtains their tools; stdio commands run on the agent’s host. Changes apply to the next session.',
    zh: '配置的工具服务会随每个新建/载入的会话下发给 agent,由 agent 侧连接并取得工具;stdio 命令在 agent 所在主机上执行。修改对下一个会话生效。',
  },
  'settings.noMcp': { en: 'No MCP servers yet', zh: '还没有 MCP 服务器' },
  'settings.noMcpDesc': {
    en: 'Add one and the agent can use the tools it provides in sessions.',
    zh: '新增一条,agent 就能在会话里用到它提供的工具。',
  },
  'settings.editMcp': { en: 'Edit server', zh: '编辑服务器' },
  'settings.editMcpTooltip': { en: 'Edit the name, type, or launch parameters', zh: '编辑名称、类型或启动参数' },
  'settings.deleteMcp': { en: 'Delete server', zh: '删除服务器' },
  'settings.deleteMcpTooltip': {
    en: 'Delete this MCP server config (existing sessions are untouched)',
    zh: '删除这条 MCP 服务器配置(不影响已建立的会话)',
  },
  'settings.deleteMcpConfirm': { en: 'Delete MCP server “{name}”?', zh: '删除 MCP 服务器「{name}」?' },
  'settings.serverName': { en: 'Server name', zh: '服务器名称' },
  'settings.serverNamePlaceholder': { en: 'e.g. filesystem', zh: '如:filesystem' },
  'settings.type': { en: 'Type', zh: '类型' },
  'settings.typeStdio': { en: 'stdio (command on the agent host)', zh: 'stdio(agent 主机命令)' },
  'settings.typeHttp': { en: 'HTTP (Streamable)', zh: 'HTTP(Streamable)' },
  'settings.typeSse': { en: 'SSE', zh: 'SSE' },
  'settings.typeTooltip': {
    en: 'stdio spawns a process on the agent host; HTTP/SSE is dialed by the agent',
    zh: 'stdio 由 agent 所在主机拉起进程;HTTP/SSE 由 agent 侧按 URL 拨号',
  },
  'settings.command': { en: 'Command', zh: '命令' },
  'settings.commandPlaceholder': {
    en: 'e.g. npx -y @modelcontextprotocol/server-filesystem',
    zh: '如:npx -y @modelcontextprotocol/server-filesystem',
  },
  'settings.args': { en: 'Arguments (space-separated)', zh: '参数(空格分隔)' },
  'settings.argsPlaceholder': { en: 'e.g. /path/to/dir --another', zh: '如:/path/to/dir --another' },
  'settings.mcpEditNote': {
    en: 'Changes apply to the next session/new or session/load.',
    zh: '修改在下一个新建/载入的会话生效。',
  },
  'settings.save': { en: 'Save', zh: '保存' },
  'settings.create': { en: 'Create', zh: '创建' },
  'settings.cancel': { en: 'Cancel', zh: '取消' },
  'settings.profileName': { en: 'Profile name', zh: '配置名称' },
  'settings.profileNamePlaceholder': { en: 'e.g. test-agent', zh: '如:test-agent' },
  'settings.endpoint': { en: 'Endpoint', zh: '端点地址' },
  'settings.defaultWorkspace': { en: 'Default workspace', zh: '默认工作区' },
  'settings.workspaceTooltip': {
    en: 'The agent-side working context used by default for new sessions (ADR 0005)',
    zh: '新建会话时默认使用的 agent 侧工作上下文(ADR 0005)',
  },
  'settings.editNote': {
    en: 'Endpoint and workspace changes apply on the next connection.',
    zh: '端点与工作区的修改在下一次连接时生效。',
  },
  'settings.nameRequired': { en: 'Profile name is required', zh: '配置名称不能为空' },
  'settings.endpointRequired': { en: 'Endpoint is required', zh: '端点地址不能为空' },
  'settings.pathRequired': { en: 'A local directory needs a path', zh: '本机文件夹需要路径' },
  'settings.mcpNameRequired': { en: 'Server name is required', zh: '服务器名称不能为空' },
  'settings.mcpCommandRequired': { en: 'stdio type needs an executable command', zh: 'stdio 类型需要可执行命令' },
  'settings.mcpUrlRequired': { en: 'A URL is required', zh: '需要一个 URL' },
  'settings.dev': { en: 'Developer', zh: '开发者' },
  'settings.demoReplay': { en: 'Demo replay', zh: 'Demo 回放' },
  'settings.demoReplayTooltip': {
    en: 'Open the #/demo scripted replay (no real agent); re-entering replays from the start',
    zh: '打开 #/demo 剧本回放(不连真实 agent);重新进入即从头重放',
  },
  'settings.devDesc': { en: 'Internal tools, visible only in dev builds.', zh: '仅开发构建可见的内部工具。' },
  'settings.colophon': {
    en: 'Panda — a pure-protocol client for any ACP agent',
    zh: 'Panda — 连接任意 ACP agent 的纯协议客户端',
  },

  // ---- workspace ----
  'workspace.none': { en: 'No workspace', zh: '无工作区' },

  // ---- lifecycle projection (busy line / hints) ----
  'lifecycle.awaitingApproval': { en: 'Awaiting approval…', zh: '等待批准中…' },
  'lifecycle.working': { en: 'Panda is working…', zh: 'Panda 正在工作…' },
  'lifecycle.connecting': { en: 'Connecting…', zh: '连接中…' },
  'lifecycle.connectFailed': {
    en: 'Connection failed — reconnect & resume from the sidebar, or connect again',
    zh: '连接失败 — 在侧栏重连并恢复,或重新连接',
  },
  'lifecycle.authRequired': {
    en: 'Sign-in required — pick a login method above',
    zh: '需要登录 — 在上方选择登录方式',
  },
  'lifecycle.disconnected': {
    en: 'Not connected to an ACP service — connect from the sidebar',
    zh: '未连接 ACP 服务 — 在侧栏连接',
  },
  'lifecycle.switching': { en: 'Switching session…', zh: '切换会话中…' },

  // ---- live connection driver ----
  'live.switchFailed': { en: 'Session switch failed: {reason}', zh: '切换会话失败: {reason}' },

  // ---- ACP client errors (surface via connection.error) ----
  'acp.timeout': { en: '{method} timed out after {s}s', zh: '{method} 超过 {s}s 未应答' },
  'acp.disconnected': { en: 'The connection to the server was closed', zh: '与服务器的连接已断开' },
  'acp.protocolMismatch': {
    en: 'the agent negotiated protocol v{agent}, but Panda currently supports only v{ours}',
    zh: 'agent 协商了协议 v{agent},Panda 目前只支持 v{ours}',
  },
  'acp.authNoMethods': {
    en: 'The agent requires authentication but provided no browser-usable login method',
    zh: 'agent 要求认证,但没有提供浏览器可用的登录方式',
  },
  'acp.connectFailed': { en: 'Connection failed: {error}', zh: '连接失败: {error}' },
  'acp.newSessionFailed': { en: 'New session failed: {error}', zh: '新建会话失败: {error}' },
  'acp.loginFailed': { en: 'Sign-in failed: {error}', zh: '登录失败: {error}' },
  'acp.deleteSessionFailed': { en: 'Session deletion failed: {error}', zh: '删除会话失败: {error}' },
  'acp.imageHostUnsupported': { en: 'the host does not support this capability', zh: '宿主不支持该能力' },
  'acp.imagePolicyBlocked': { en: 'policy blocks this capability', zh: '策略已禁止该能力' },
  'acp.imageNotDeclared': {
    en: 'the agent did not declare promptCapabilities.image',
    zh: 'agent 未声明 promptCapabilities.image',
  },
  'acp.imageRejected': { en: '{cause} — refusing to send images', zh: '{cause},拒绝发送图片' },
  'acp.superseded': { en: 'The connection was replaced by a newer one', zh: '连接已被更新的连接替换' },

  // ---- wire ----
  'wire.unnamedTool': { en: 'Unnamed action', zh: '未命名操作' },
} as const;

export type MessageKey = keyof typeof messages;
