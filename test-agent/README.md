# Panda 测试专用 ACP Agent

这个子项目用真实的 [deepagents](https://docs.langchain.com/oss/python/deepagents/overview)
和 [deepagents-acp](https://github.com/langchain-ai/deepagents/tree/main/libs/acp)
驱动 Panda 的集成测试。工具执行、文件修改与 diff、LangGraph interrupt 权限请求、
流式消息和 SQLite checkpointer 都是真实链路；默认 LLM 是仓库内的确定性剧本模型，
因此离线、免费、可复现。

## 安装与启动

需要 Python 3.11+ 和 [uv](https://docs.astral.sh/uv/)。在仓库根目录运行：

```sh
uv sync --project test-agent
uv run --project test-agent python -m panda_test_agent serve
```

服务默认监听 `ws://127.0.0.1:8766/acp`。启动时会把 `seed/` 复制到
`sandbox/`，保证每次剧本都从同一份文件开始；需要保留上次改动时加
`--keep-sandbox`。

在 Panda 侧新建或直接填写 Agent 配置：

- 地址：`ws://localhost:8766/acp`
- 工作目录：任意绝对路径（测试 agent 出于可复现性会固定使用自己的沙箱）

裸 stdio 模式用于验证桥之外的 agent 路径，也可以供支持 ACP stdio 的编辑器使用：

```sh
uv run --project test-agent python -m panda_test_agent stdio
```

stdio 的 stdout 只承载逐行 JSON-RPC，日志全部写到 stderr。

## 默认剧本

第一轮会依次：

1. 用 `write_todos` 建立三步计划；
2. 读取 `/auth.ts`；
3. 把 `validateSession(session) == false` 改为显式取反并发送真实 diff；
4. 执行 `cat auth.ts` 验证落盘；
5. 流式输出包含 Markdown 和 TypeScript 代码块的总结。

默认 `ask_before_edits` 模式会为计划、编辑和命令执行发起权限请求。第二轮起返回
固定短回复，用于测试追加消息和滚动。也可以通过 ACP 会话配置切到
`accept_edits` 或 `accept_everything`。

## 切换 OpenAI 兼容真实模型

复制环境变量模板并安装可选依赖：

```sh
cp test-agent/.env.example test-agent/.env
uv sync --project test-agent --group real-llm
```

编辑 `.env` 中的 `PANDA_TEST_AGENT_REAL_MODELS`。它是 JSON 数组，每项必须包含
`value`、`name`、`model`、`base_url` 和 `api_key`。启动后，真实模型会和
`fake:scripted` 一起出现在 ACP 模型配置中。配置有误或缺少 `langchain-openai`
会直接启动失败，不会静默退回假模型。

## 集成测试

```sh
pnpm exec vitest run src/acp/LiveAcpClient.e2e.test.ts
pnpm test
```

e2e 测试会在动态端口启动服务，使用临时沙箱和临时 SQLite 状态目录，走真实
WebSocket 完成握手、能力协商、模式切换、权限批准、真实文件修改、取消与后续存活
检查。机器上没有 `uv` 时，该测试组自动跳过；也可设置
`PANDA_TEST_AGENT_E2E=skip` 显式跳过。

## 已知限制

deepagents-acp 0.0.11 只声明 `session/load`，没有实现
`session/list`、`session/resume` 和 `session/delete`。Panda 会根据能力协商隐藏对应
会话管理入口；这些 UI/客户端路径继续由 `scripts/mock-acp-server.mjs` 和现有单元测试
覆盖。确定性剧本不是智能模型，这是保障回归稳定性的刻意设计。

依赖组合固定为 `deepagents==0.7.12`、`deepagents-acp==0.0.11` 和
`agent-client-protocol==0.10.1`。后者不能直接升级到 0.12+，因为旧版
deepagents-acp 仍从其顶层导入已经移除的协议辅助函数。
