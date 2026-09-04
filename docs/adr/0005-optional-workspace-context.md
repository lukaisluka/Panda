# 工作区为可选的连接级上下文，不按会话记账

Panda 把「连接级必填的 cwd 字符串」抽象为可选的工作区（Agent 配置上的判别式联合：本机文件夹 | 无），v1 只落这两类，联合结构对 remote-repository / project / dataset 留扩展位。协议侧 `session/new.cwd` 仍必填：工作区为「无」时固定发送常量 `"/"`；会话显示从 agent 回报的目录派生（`"/"` → 无工作区，其他 → 文件夹名），客户端不维护每会话的工作区状态。依据与核实记录见 issue #23 triage（2026-09，协议行为核实于 @agentclientprotocol/sdk 1.4.0 与 deepagents-acp 0.0.11）。

核实事实（决策的直接依据）：

- 协议 schema 对 cwd 只校验「是字符串」，但字段必填、文档惯例为绝对路径；空串可过 schema，却会被把 cwd 当文件工具根的 agent（deepagents-acp 的 `agent_root_dir`）算错路径。
- deepagents-acp 的 session/load 要求 cwd 与创建时**逐字相等**——固定常量 `"/"` 跨重连天然满足；每连接合成值则需要额外持久化且易不一致。
- `session/list` 回传的每条会话必带 cwd，因此「从 agent 回报目录派生显示」零额外簿记，且外来会话（其他客户端用真实目录创建）自动显示正确；恢复会话照抄 agent 记录的目录即满足逐字相等。

**Considered**：

- 每会话客户端工作区记账（acp-components 的 SessionMeta = (cwd, agentId) 模型，issue 初稿方向）——被否决：Panda 会话已按连接归属（ADR 0002），记账引入对账合并成本，派生显示已覆盖全部场景。
- 空串 `""`、`~`、agent 侧 home 目录作占位——被否决：空串违背绝对路径惯例并破坏 agent 侧路径解析；`~` 不会被 Python 路径解析展开（按相对路径处理）；home 值客户端无从得知（协议不暴露 agent 环境信息）。
- 侧栏按工作区跨连接重组会话——被否决：workspace 中心世界观是架构结论文档 §5.4 明确不照搬的 coding-agent 模型。

**Consequences**：

- 真实工作目录恰为 `/` 的会话会显示为「无工作区」（接受的退化情形）。
- 未来 metadata-only 工作区类型若需专属显示，需扩展占位映射或引入客户端记忆——那是加类型时的已知成本，不在本决策内。
- 老 localStorage 数据（AgentProfile 必填 cwd 串）不做迁移，解析失败即弃（早期方案，维护者拍板）。
