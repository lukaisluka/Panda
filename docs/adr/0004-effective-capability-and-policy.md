# 有效能力三元合成，权限策略类型级禁止自动放行

日期：2026-09-04 ｜ 关联：issue #22、`docs/panda-acp-architecture-conclusion.md` §5.3、[ACP v2 迁移指南](https://agentclientprotocol.com/protocol/v2/migration)

## 背景

现状 capability 只做功能门控：agent 在 `initialize` 声明的五个布尔被直接信任，UI 据此隐藏不支持的操作；宿主授权维度不存在——「agent 声明能做」≠「Panda 宿主放行」。acp-components 也没有这层可借鉴，且它未设 permission handler 时**自动放行第一个选项**，是必须引以为戒的反面默认（Panda 现状是挂起等用户，已是正确基线）。

宿主能力分片的词汇来源需要裁决：acp-components 的 Platform 分片（fs / terminal / process / secret）中，fs 与 terminal 是 ACP v1 的可选客户端执行面，**v2 草案已整体移除**（理由：少数 IDE 之外实现不一致 + 双执行路径；替代为客户端经 `mcpServers` 提供 MCP server、terminal 转为 agent 自有的纯展示面）；process 与 secret 从来不是协议概念。

## 决策

1. **有效能力 = 三元合成**：Agent 声明 × 宿主能力 × 策略 → 唯一判定点，UI 与执行路径共同消费。判定结果为布尔 + 原因码（agent 不支持 / 宿主缺失 / 被策略阻止）。
2. **策略输出枚举只有 `ask | deny`，不存在 `allow`**——默认策略恒为 `ask`（交用户决定）。自动放行在类型层面不可表达，而非靠约定禁止；未来需要「代用户放行」是显式的、单独评审的类型扩展。
3. **宿主能力词汇锚定 ACP v2 存活的客户端面**（permission / sessionUpdate / mcp / elicitation），fs / terminal / process / secret 不入库。Panda 若未来向 agent 暴露文件/执行工具，v2 正道是客户端 MCP server，随 `mcp` 分片立项。

**Considered**：策略输出含 `allow` 但默认不用——自动放行只差一次配置失误，被否决；宿主分片沿用 acp-components 词汇——为协议已删除或根本不存在的面建模，被否决；本 issue 同时建请求级与能力级策略——能力级无真实分片可判，组合公式留位即可，被否决。

**Consequences**：v1 生命周期内 agent 调 `fs/*` / `terminal/*` 仍收到 method-not-found（现状不变）；策略判 `deny` 的权限请求以「策略拒绝」终态卡留在会话文档（拒绝可追溯，用户不会只看到 agent 无故停住）；`blocked-by-policy` 原因码预留、本 issue 不产生。
