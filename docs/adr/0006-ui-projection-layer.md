# 投影层收拢派生，SessionDocument 保留为事实层（不重塑）

#24 的三层显式化按「先归拢」路线落地（2026-09 triage 对齐）：`SessionDocument`（turns/blocks、权限、用量、raw 归属）保留为 domain state——其形状本就按协议到达顺序组织，是事实而非排版；新建 `projector/` 收拢散落在组件里的派生计算（列表摊平、权限挂载、状态文案），统一测试。不按 issue 箭头图的字面路线把事实层重塑为按 messageId/toolCallId 存放的索引。

投影契约（两条硬性）：

- **输入是若干事实切片的组合**：会话文档 + 连接状态 + 模式。连接状态在 store 里本是 domain 事实，状态文案（「连接中…」「Panda 正在工作中…」）因此可整体搬进投影。
- **引用稳定**：投影对未变化条目保持引用相等（结构共享），单测锁死。reducer 保 block 身份 → projector 保输出身份传递，memo 与虚拟化才不退化；值相等不够，组件层没有便宜的补救。

核实事实（决策的直接依据）：

- `src/protocol/types.ts` 自述 SessionDocument 为 "rendering model the UI consumes"——中途态证词；验收「domain 类型名/字段名无 UI 词汇」经查已满足，重塑无此侧收益。
- #22 的 `effectiveCapabilities`（纯函数 + zustand selector）已开派生层先例，本决策是先例的推广。
- 现存派生逻辑散落三处：MessageStream 的 `flatten`/`findStreamingBlock`/`attachPermission`、App 的 `attachedPermissions` memo、App 的状态文案 if-else 链。

**Considered**：

- 路线 B（事实层重塑为 message/tool 索引，turns/blocks 降为投影输出）——被否决：reducer 与 #14 raw 归属、#15 echo 合并全部搬家，与 issue 自述的「不强推大爆炸、存量渐进」矛盾；更纯的事实层目前没有具体场景逼着要，且投影输入接口稳定后将来再走 B，成本不高于现在，A 不堵死 B。

**Consequences**：

- `types.ts` 头部「rendering model」注释需同步改写为事实层口径（#24 实施项）。
- 架构结论文档 §7 的箭头图按目标语义理解：物理上 turns/blocks 留在 domain，「UI Projection」指 projector/ 派生层。
- 叶子卡片组件继续 import `Block`/`ToolCallState` 等 domain 类型是**有意为之**——组件红线是禁「算」不禁「碰」（体内不得有派生逻辑，import 类型不算违规）；包装层留给路线 B 的终态。防止后来者把这种看似越层的 import 当违规「修复」。
- StatusBar 的 usage/状态派生暂不迁移（渐进策略，首个实施切片只收拢消息流摊平、权限卡组装、状态文案三处）。
