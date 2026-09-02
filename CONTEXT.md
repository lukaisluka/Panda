# Panda

Panda 是一个 ACP（Agent Client Protocol）通用客户端：连接任意兼容 ACP 的 agent 服务，以消息流为核心体验。Panda 是纯协议客户端——从不拉起 agent 进程，只连接已在运行的服务。

## Language

### 连接与配置

**Agent 配置**:
用户保存的一条连接预设：名称 + WebSocket 地址 + 默认工作目录。同一时刻最多一条活跃连接，切换配置即换连接目标。
_Avoid_: endpoint、service、连接配置

**端点**:
Agent 配置中指向 ACP 服务的 WebSocket 地址。它只是配置的一个字段，永远不指代整条配置。
_Avoid_: 服务、server（用作配置整体时）

**自报名称**:
agent 在 `initialize` 响应中报告的自己的名字（`title ?? name`）。区别于用户为 Agent 配置起的名字。
_Avoid_: Agent 名（与配置名混淆时）

### 会话

**会话**:
与某个 agent 的一次对话，由 sessionId 标识，按端点记忆、与服务器列表合并。
_Avoid_: 对话、聊天