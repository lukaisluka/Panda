# 绕过 SDK 的 session/update 严格校验，保全未知协议数据

日期：2026-09-02 ｜ 关联：issue #14、`docs/panda-acp-architecture-conclusion.md` §4.1（Unsupported ≠ Dropped）

## 背景

Panda 的核心主张是「Universal ACP Client」：未知协议数据必须保留在文档中（归属制保存），后续 UI 才可能升级支持。但 `@agentclientprotocol/sdk`（v1.4.0）在数据到达 Panda 之前就把校验失败的通知丢掉了：

1. `ClientApp` 构造函数无条件注册静态 handler `client-session-update-router`，它先于一切应用 handler 运行，对每条 `session/update` 通知做严格 `zSessionNotification.parse`（15 变体的封闭 zod union）；
2. 解析抛错时，连接层（`processIncomingMessage` 的 catch）对通知只 `console.error` 后吞掉——连接存活，消息永久丢失。

因此「未知的 `sessionUpdate` kind（未来协议版本、厂商扩展）」根本到不了 Panda 的 wire 层，归属制保存在最需要它的前向兼容场景失效。

## 决策

连接建立前做两件事（均收敛在 `src/acp/wire.ts`）：

1. **移除严格 router**：`removeSdkStrictSessionUpdateRouter(app)` 从 ClientApp 私有 `builder.handlers` 中过滤掉 `describe() === 'client-session-update-router'` 的 handler。该 router 只供给 SDK 的 `ActiveSession`/attach 辅助 API（`connection.agent.session(...)`），Panda 只用裸 `session/*` 请求，移除无功能损失。
2. **宽容解析器**：以公开的三参重载 `onNotification(method, parser, handler)` 注册 `parseSessionNotification`——结构合法（`sessionId` string + `update.sessionUpdate` string）即原样透传，kind 解释只在 `toAcpUpdates` 一处发生；结构非法则抛错，由 SDK 以 `console.error`（含原始消息）记录后丢弃，连接存活。

已知取舍：已知 kind 失去字段级 zod 校验。畸形已知 kind 会在 `toAcpUpdates` 内抛 TypeError，结果仍是「响亮丢弃 + 连接存活」，只是堆栈来自 Panda 而非 zod。

## 风险与守卫

私有 API 依赖（`builder`/`handlers` 字段名与 describe 字符串）在 SDK 升级时可能失效。守卫：移除失败（形状缺失或过滤无命中）时 `console.error` 明示「未知 kind 将被 SDK 丢弃」，连接照常工作——降级而非崩溃；`wire.test.ts` 对两条降级路径各有单测。

**Considered**：包装 Stream 旁路观察（不碰私有 API，但引入第二摄入缝隙与乱序风险）；接受 SDK 限制并仅在文档记录（放弃 issue #14 的核心目标）。均被否决。

**Consequences**：

- 升级 `@agentclientprotocol/sdk` 后必须跑 `src/acp/wire.test.ts` 的 router 移除测试；若内部结构变化，先修守卫路径再合入。
- 若 SDK 未来提供官方的宽容校验开关或导出 zod schema，应立即回退本 ADR 的私有 API 依赖，仅保留 `parseSessionNotification`。
