# Agent 配置采用单活跃连接

> **2026-09 更新**：本文「多连接并行明确排除」的条款已被 [ADR 0002](0002-multi-agent-parallel-connections.md) 取代；其余结论（配置档案库形态、会话历史按端点记忆、与配置条目解耦）继续有效。

Phase 3 的「multi-agent configuration」有两个可行解读：配置档案库（保存多条 Agent 配置、一键切换，同一时刻仅一条活跃连接）与多连接并行（同时连多个 agent、多会话并行）。我们选择配置档案库：现有 store 是全局单例（`connection` / `doc` / `sessions` 各一份），per-endpoint 会话隔离已天然支持「切换」，而多连接需要把 store 按配置分键重构，其成本远超「保存与切换便利」这一核心产品价值。

**Considered**：多连接并行——明确排除出 Phase 3；若将来立项，以新 ADR 取代本决策。

**Consequences**：同一时刻只能与一个 agent 对话；会话历史按端点（url）记忆，与配置条目解耦——改配置的地址即换服务，旧会话通过改回地址找回。