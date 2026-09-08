# 定位:agent 开发者的现成 UI

取代 ADR 0003 中引述的「Universal ACP Client」产品主张（该 ADR 原文作为历史记录不改写，其中的技术决策——未知协议数据归属制保存——仍然有效）。2026-09-08 维护者拍板：

- **核心用户是「自己开发 agent、但不想开发 UI 前端」的开发者。** 对外叙事的第一人称对象是 agent 开发者：你实现 ACP（接入门槛是三个请求 + 一个通知，见 `docs/agent-quickstart.md`），Panda 就是现成的客户端界面。
- **现成 agent（Claude Code、Gemini CLI 等）是顺带支持，不是卖点主角。** Claude Code 由真实流量契约测试钉死（#154），作为兼容性基线保留；对外物料不以其打头。
- **桌面 stdio 直连是 agent 开发者的日常工具台**（本机迭代自己的 agent），不是「现成 agent 启动器」。

**Considered**：以「一个客户端连所有现成 coding agent」为叙事主轴——放弃。该赛道拥挤（各家官方 GUI/TUI 已在位），而 Panda 的差异化（协议完备、无账号无遥测无后端、界面完成度）对「有 agent 没 UI」的人群才是刚需。

**Consequences**：

- 对外门面按此口径对齐：README 双语（#206）、quickstart（#207）、首屏空态（#208）、OG 卡与 meta（#229）、repo topics 与 description、demo 回放文案（#232）。
- 桌面内置预设（Claude Code/Codex）降级为可选样例，不做默认集成；面向 agent 开发者的 stdio 体验优先（#202）。
- 既有 ADR 与 CHANGELOG 的历史原文不改写；本 ADR 是定位主张的现行事实源。
