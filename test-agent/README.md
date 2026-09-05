# Panda 测试专用 ACP Agent

这个子项目用真实的 [deepagents](https://docs.langchain.com/oss/javascript/deepagents/overview)
(TypeScript)驱动 Panda 的集成测试。工具执行、文件修改与 diff、LangGraph interrupt
权限请求、流式消息和 SQLite checkpointer 都是真实链路;默认 LLM 是仓库内的确定性
剧本模型,因此离线、免费、可复现。

协议壳直接构建在官方 [`@agentclientprotocol/sdk`](https://www.npmjs.com/package/@agentclientprotocol/sdk)
上(Panda 客户端用同一个 SDK),ACP 契约镜像 Python 版 deepagents-acp 0.0.11:
能力声明、三档权限模式 + mode/model 会话配置、权限三选项(approve/reject/always)、
会话标题、`session/load` 回放。不用 npm 的 deepagents-acp(0.1.29):它的会话在
进程内存里,跨子进程 `session/load` 直接失败;权限请求后从不 resume 图;也不支持
会话配置选项。

## 安装与启动

需要 Node >= 22.5(`node:sqlite`)。它是 pnpm workspace 成员,在仓库根目录:

```sh
pnpm install
pnpm --filter panda-test-agent serve
```

服务默认监听 `ws://127.0.0.1:8766/acp`。启动时会把 `seed/` 复制到
`sandbox/`,保证每次剧本都从同一份文件开始;需要保留上次改动时加
`--keep-sandbox`。

在 Panda 侧新建或直接填写 Agent 配置:

- 地址:`ws://localhost:8766/acp`
- 工作目录:任意绝对路径(测试 agent 出于可复现性会固定使用自己的沙箱)

裸 stdio 模式用于验证桥之外的 agent 路径,也可以供支持 ACP stdio 的编辑器使用:

```sh
pnpm --filter panda-test-agent stdio
```

stdio 的 stdout 只承载逐行 JSON-RPC,日志全部写到 stderr。

## 默认剧本

第一轮会依次:

1. 用 `write_todos` 建立三步计划;
2. 读取 `/auth.ts`;
3. 把 `validateSession(session) == false` 改为显式取反并发送真实 diff;
4. 执行 `cat auth.ts` 验证落盘;
5. 流式输出包含 Markdown 和 TypeScript 代码块的总结。

默认 `ask_before_edits` 模式会为计划、编辑和命令执行发起权限请求。第二轮起返回
固定短回复,用于测试追加消息和滚动。也可以通过 ACP 会话配置切到
`accept_edits` 或 `accept_everything`。

会话的首条文本消息会被压缩为最多 48 个字符的标题,并通过 ACP 的
`session_info_update` 推送给 Panda。这个标题不额外调用模型,因此不会增加等待时间
或真实模型费用;SQLite 持久化会话在 `session/load` 后也会重新推送它。

## 切换 OpenAI 兼容真实模型

复制环境变量模板:

```sh
cp test-agent/.env.example test-agent/.env
```

编辑 `.env` 中的 `PANDA_TEST_AGENT_REAL_MODELS`。它是 JSON 数组,每项必须包含
`value`、`name`、`model`、`base_url` 和 `api_key`;可选的请求参数为
`temperature`、`top_p`、`reasoning_effort`、`streaming` 与 `extra_body`,会映射为
`ChatOpenAI` 的对应字段(`reasoning: {effort}`、`modelKwargs`,字段名映射有单测
钉住——传错名会被上游静默丢弃)。设置 `PANDA_TEST_AGENT_DEFAULT_MODEL` 为某项的
`value`,可让新会话默认使用该真实模型;未设置时仍默认 `fake:scripted`。配置有误
或默认模型不存在时会直接启动失败,不会静默回退假模型。

集成测试会明确屏蔽开发者本机的 `.env` 真实模型配置,以保持离线、免费且可复现。

## 集成测试

```sh
pnpm --filter panda-test-agent test     # 子项目单测
pnpm exec vitest run src/acp/LiveAcpClient.e2e.test.ts   # e2e(仓库根)
pnpm test
```

e2e 测试会在动态端口启动服务,使用临时沙箱和临时 SQLite 状态目录,走真实
WebSocket 完成握手、能力协商、模式切换、权限批准、真实文件修改、取消与后续存活
检查。test-agent 未安装依赖(没有 `test-agent/node_modules`)时,该测试组自动
跳过;也可设置 `PANDA_TEST_AGENT_E2E=skip` 显式跳过。

## 已知限制

只声明并实现 `session/load`,没有 `session/list`、`session/resume` 和
`session/delete`。Panda 会根据能力协商隐藏对应会话管理入口;这些 UI/客户端路径
继续由 `scripts/mock-acp-server.mjs` 和现有单元测试覆盖。确定性剧本不是智能模型,
这是保障回归稳定性的刻意设计。

deepagents 的 JS 工具循环聚合输出模型消息(没有 token 级流式),协议壳按词合成
增量 chunk,保持 Panda 的增量渲染路径真实工作。
