<div align="center">
  <img src="branding/clean/concept-retro-badge.png" alt="Panda" width="180" />
  <h1>Panda</h1>
  <p><strong>给 agent 开发者的现成客户端:你的 agent 说 ACP,Panda 就是它的界面。</strong></p>
  <p>
    <a href="https://github.com/lukaisluka/Panda/actions/workflows/ci.yml"><img src="https://github.com/lukaisluka/Panda/actions/workflows/ci.yml/badge.svg" alt="CI" /></a>
    <a href="https://github.com/lukaisluka/Panda/releases"><img src="https://img.shields.io/github/v/release/lukaisluka/Panda" alt="Release" /></a>
    <a href="LICENSE"><img src="https://img.shields.io/badge/license-Apache--2.0-blue" alt="License" /></a>
  </p>
  <p>
    <img src="branding/clean/series-retro-hello.png" alt="Say hello" width="88" />
    <img src="branding/clean/series-retro-reading.png" alt="Reading" width="88" />
    <img src="branding/clean/series-retro-tea.png" alt="Tea break" width="88" />
    <img src="branding/clean/series-retro-sleep.png" alt="Idle" width="88" />
  </p>
  <p><em><a href="README.md">English</a> · 简体中文</em></p>
  <p><img src="docs/assets/demo.gif" alt="Panda demo:一段脚本化的 agent 会话——流式回复、工具调用卡片、行内权限卡后的代码 diff、测试与用量收尾" /></p>
</div>

开发 agent 的人常常不想开发界面——而一个像样的会话前端是一整套工程:流式渲染、工具调用卡片、diff 高亮、权限审批、计划与用量、会话管理与断线恢复。这些 Panda 都做好了:**你的 agent 实现 [ACP(Agent Client Protocol)](https://agentclientprotocol.com),就立刻拥有这条精心打磨的消息流**。Panda 不是 IDE 插件,是一个独立的会话应用;没有捆绑运行时,没有账号与后端,连接与数据都在你手里。

- **零前端**——接入 ACP 最小集,消息流全套现成
- **多 agent 并行**——每份配置一条连接,后台连接继续接收更新、需要关注时提醒
- **无账号、无遥测、无后端**——纯协议客户端,不落任何对话内容,数据全在 agent 侧

## 给你的 agent 一个 UI

接入门槛比想象低。用官方 SDK(`@agentclientprotocol/sdk`)实现:

- **三个请求**:`initialize`(握手)、`session/new`(建会话)、`session/prompt`(回合)
- **一个通知出口**:回合中推 `session/update`——最低限度推 `agent_message_chunk` 文本块

就这些。此后每多一点能力,界面就多亮一块:推 `tool_call` 得到带 diff 的工具卡,发 `session/request_permission` 得到审批卡,发 `plan` 得到计划坞,推 `usage_update` 得到用量条……不做的能力可见降级,绝不挡接入。

十分钟从零写一个这样的 agent 并接上 Panda,见[接入快速上手](docs/agent-quickstart.md);完整的接入门槛、按体验损失排序的推荐项与超时预算,见 [ACP agent 接入契约](docs/acp-agent-requirements.md)(两文均中英双语);全量参考实现见 [test-agent/](test-agent/README.md)。连接自己的 agent:桌面版 stdio 直连最顺([使用指南](docs/user-guide.md));网页版走 WebSocket([桥接指南](docs/acp-stdio-to-websocket.md))。

## 获取 Panda

按场景取用——连自己开发的 stdio agent 用桌面版;零安装先看界面用网页版(内置脚本化 [demo](https://lukaisluka.github.io/Panda/#/demo),不需要任何 agent):

- **网页版(零安装)**——<https://lukaisluka.github.io/Panda/> 在任何现代浏览器里直接用。指向一个 ACP-over-WebSocket 端点,消息流即刻上线。
- **桌面版(macOS / Windows)— beta**——从 [GitHub Releases](https://github.com/lukaisluka/Panda/releases) 下载。桌面壳可用——与网页版同一套界面与协议栈,另加 stdio 直连 agent——但尚未经过专门的组织化发布测试,以 beta 对待;日常使用推荐网页版:
  - macOS:`Panda_<ver>_aarch64.dmg`
  - Windows:`Panda_<ver>_x64-setup.exe`(安装版),或 `Panda_<ver>_x64-portable.zip`(免安装;两者是同一个应用——用户数据留在各平台的用户数据目录,不随 exe 走)

  注意:直连 stdio agent 需要桌面版([指南](docs/user-guide.md))。Windows 需要 WebView2(Windows 11 预装,较新的 Windows 10 亦自带;缺失时安装器会自动下载)。产物**未签名**:Windows 的 SmartScreen 提示属预期;macOS 首次打开可能报「"Panda" 已损坏,无法打开」——并非真损坏,这是 Gatekeeper 拦截无签名下载的文案,清掉隔离属性即可打开:

  ```bash
  xattr -cr /Applications/Panda.app
  ```
- **从源码运行**——见[开发](#开发)。

## 功能

以下全部对任何接入的 agent 开箱即用——这是 Panda 交付的前端,不是你的待办:

- **实时对话**——流式消息、工具调用卡片、计划、用量与成本,随到达实时渲染
- **行内权限卡片**——Allow / Reject 直接应答挂起的 `session/request_permission` RPC;停止按钮发送 `session/cancel`,并按规范自动取消挂起的权限
- **会话与历史**——浏览历史会话(`session/list`)、以重放历史的方式切换(`session/load`)、实时更新的会话标题
- **保存的 Agent 配置(并行连接)**——每条配置一份名称、端点与默认工作区,连接时的改动会写回;多条配置同时在线,后台连接继续接收更新并在需要关注时提醒
- **断线恢复**——意外断开保留对话内容,并提供「重连并恢复」(`session/resume`,回退到 `session/load` 重放);全部按能力门控,降级可见
- **精细 diff**——Shiki 语法高亮,加上词级的变更片段高亮
- **双向图片**——agent 声明能力后可粘贴或选择图片发送;用户/agent 消息、思考块与工具结果里的图片都会渲染
- **长会话**——虚拟化消息列表,流式增长时自动跟随底部,只在用户真正滚动时脱离
- **桌面版直连 stdio agent**——在本机拉起一条 ACP agent 命令,通过其管道以 NDJSON 对话,生命周期全程托管
- **脚本化 demo 回放**——同一套界面由脚本化 agent 驱动,无需后端:<https://lukaisluka.github.io/Panda/#/demo>(`?demo=long` 播放 80 轮长会话)

## 顺带支持现成 agent

不开发自己的 agent 也能用:Claude Code、Gemini CLI、Codex、Cursor、Goose、Copilot 等 40+ 主流 coding agent 都说 ACP,或可经 bridge 暴露。

- **Claude Code——已验证**:CI 以录制的真实 Claude Code 流量做契约回放测试(#154),协议覆盖有回归保障。
- **其余——应当兼容,未逐一实测**:遇到问题欢迎开 issue。

连接现成 agent 的路径见[使用指南](docs/user-guide.md)与[桥接指南](docs/acp-stdio-to-websocket.md)。

## 工作原理

ACP 是事件流,而界面需要的是文档。一层纯归约把 `session/update` 通知折叠成稳定的 `SessionDocument`;React 只渲染这份文档,协议版本差异在组件之下被吸收。会话驱动——live 客户端与脚本回放——喂给同一套 store action,所以离线 demo 走的正是真实连接的代码路径。浏览器里的 Panda 是**纯协议客户端**(从不拉起 agent 进程);桌面壳只增加一个宿主能力——stdio 进程面。

## 文档

- [ACP agent 接入契约](docs/acp-agent-requirements.md)([英文版](docs/acp-agent-requirements.en.md))——接入 Panda 的最低必须集、体验损失分级与超时预算,面向 agent 实现者
- [接入快速上手](docs/agent-quickstart.md)([英文版](docs/agent-quickstart.en.md))——从零写最小 ACP agent 并接上 Panda 的十分钟教程,面向 agent 开发者
- [使用指南](docs/user-guide.md)——快速上手、连接 agent、界面指南、能力矩阵、故障排查与 FAQ
- [stdio agent 桥接 WebSocket](docs/acp-stdio-to-websocket.md)([英文版](docs/acp-stdio-to-websocket.en.md))——把 stdio agent 接到网页版的桥接配方:帧映射、wss/TLS 与安全红线,面向自托管用户
- [CHANGELOG](CHANGELOG.md)(英文)
- [架构决策记录](docs/adr/)——重要决策及其背景与被否决的备选
- [desktop/README.md](desktop/README.md)(英文)——桌面壳:开发、验收 harness、产物
- [test-agent/README.md](test-agent/README.md)——集成测试用的确定性 deepagents ACP agent

## 品牌

复古徽章熊猫是这个项目的视觉身份。定稿素材在 `branding/clean/`(无水印):主徽章加四张状态插画——hello / reading / tea / sleep。各素材的去处:

- `src/assets/brand/`——应用内可用导出:`panda-badge.png`(侧栏 logo)、`panda-sleep.png`(崩溃页);其余留给将来的空态/加载态
- `public/favicon.png` + `public/apple-touch-icon.png`——网页图标,在 `index.html` 里声明
- `public/og-image.png`——社交预览合成图(`index.html` 的 og/twitter 卡片);GitHub 仓库 Settings 里的 *Social preview* 用同一张图(需手动上传)
- `desktop/icon-source.png`——桌面图标源;用 `pnpm --dir desktop exec tauri icon icon-source.png` 重新生成 `desktop/src-tauri/icons/`

## 开发

需要 Node 24+、pnpm 11,以及(仅桌面壳需要)Rust 工具链。

```sh
pnpm install
pnpm dev           # http://127.0.0.1:5173 —— #/demo 即脚本化回放
pnpm typecheck     # tsc --noEmit
pnpm test          # vitest —— test-agent 依赖已装时含 live-agent e2e
pnpm build         # typecheck + vite build
```

仓库是 pnpm workspace:根 package 是网页应用,`test-agent/` 是集成测试用的确定性 ACP agent,`desktop/` 是 Tauri v2 壳(`pnpm desktop:dev` / `pnpm desktop:build`——见 [desktop/README.md](desktop/README.md))。领域术语表在 [CONTEXT.md](CONTEXT.md);UI 设计契约在 [DESIGN.md](DESIGN.md)。

## 路线图

- **之后**——桌面产物的代码签名与自动更新;ACP v2
- v1 有意不做:*terminal* 工具内容——替 agent 执行命令不是聊天客户端会声明的能力;Panda 跳过此类块并告警

## 许可证

Apache-2.0
