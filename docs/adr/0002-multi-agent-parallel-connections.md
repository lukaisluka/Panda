# Agent 配置支持多连接并行

取代 ADR 0001 中「多连接并行明确排除」的决定：Panda 将支持同时维持多条 Agent 配置的活跃连接，各自持有独立会话；UI 仍是单一前台会话，其余连接在后台接收通知。

决策依据（2026-09 对 react-acp、acp-components 的源码核实，详见 `docs/panda-acp-architecture-conclusion.md`）：

- Panda 的 `LiveAcpClient` 本就是**实例级**的——一条连接 + 自有 pendingPrompt / pendingPermission + connection identity 校验，且接受注入的 Stream。多连接 = 多实例，客户端类无需改造；真正的阻碍是 store 的全局单例（`doc` / `connection` / `permission` / `sessions` 各一份）。
- acp-components 验证了该状态模型可行：`agents: Map`（多 agent 连接）+ 每会话独立 store + 全局 `activeSessionId`，`removeAgent` 时做孤儿会话清理。
- react-acp 验证了配套机制：按 session 隔离的状态仓库 + `selectionGeneration`（切换 latest-wins）+ 事务性 attach（快照 / 回滚）。

**Considered**：维持 ADR 0001 的单活跃连接——放弃并行后台会话与跨 agent 对照的产品价值；直接引入 `@acp-components/core` 换取现成多 agent 编排——被否决（0.1.0 无稳定 API 承诺、单维护者、workspace 绑死 cwd 的 coding-agent 世界观）。我们选择渐进路线：先在单连接模式下完成 store 按 (connectionId, sessionId) 分键、事务性会话切换与 selection generation（这些在单连接下同样修复真实缺陷），随后放开多连接。

**Consequences**：

- 「同一时刻只能与一个 agent 对话」不再成立；每条活跃连接一个 `LiveAcpClient` 实例，其 handlers 以连接作用域 dispatch，不再直写全局 store。
- 前置条件即架构结论文档的 P1 清单（分键 store、事务性切换、双 generation、权限集合、transport seam 命名化）。
- 会话列表持久化已按端点分键（`panda.sessions:<url>`），无需数据迁移。
- ADR 0001 的其余结论继续有效（会话历史按端点记忆、与配置条目解耦）。
