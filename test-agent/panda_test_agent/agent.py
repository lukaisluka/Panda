"""把 deepagents 装配成 ACP agent(官方 deepagents-acp 的桥接)。

结构:`AgentServerACP`(deepagents-acp)包住一个按会话上下文构建的 deepagent;
backend 固定指向沙箱目录——测试 agent 忽略客户端传来的 cwd,保证剧本的
read/edit/execute 都落在种子重置过的沙箱里,结果可复现。
"""

from __future__ import annotations

from pathlib import Path
from typing import TYPE_CHECKING, Any

import aiosqlite
from acp.schema import SessionMode, SessionModeState
from deepagents import create_deep_agent
from deepagents.backends import CompositeBackend, LocalShellBackend, StateBackend
from langchain.agents.middleware import TodoListMiddleware
from langgraph.checkpoint.sqlite.aio import AsyncSqliteSaver

from deepagents_acp.server import AgentServerACP, AgentSessionContext

from panda_test_agent.models import FAKE_MODEL_ID, build_model_registry

if TYPE_CHECKING:
    from langchain_core.language_models.chat_models import BaseChatModel
    from langgraph.graph.state import CompiledStateGraph

# 与官方 demo 一致的三档模式;默认 ask_before_edits——测试 agent 的职责就是
# 把权限卡路径暴露出来,让 Panda 的 request_permission → resolve 流程可测。
INTERRUPT_CONFIGS: dict[str, dict[str, Any]] = {
    "ask_before_edits": {
        "edit_file": {"allowed_decisions": ["approve", "reject"]},
        "write_file": {"allowed_decisions": ["approve", "reject"]},
        "write_todos": {"allowed_decisions": ["approve", "reject"]},
        "execute": {"allowed_decisions": ["approve", "reject"]},
    },
    "accept_edits": {
        "write_todos": {"allowed_decisions": ["approve", "reject"]},
        "execute": {"allowed_decisions": ["approve", "reject"]},
    },
    "accept_everything": {},
}

MODES = SessionModeState(
    current_mode_id="ask_before_edits",
    available_modes=[
        SessionMode(
            id="ask_before_edits",
            name="Ask before edits",
            description="每一步写入/编辑/执行都要经过权限确认",
        ),
        SessionMode(
            id="accept_edits",
            name="Accept edits",
            description="自动接受文件改动,仅命令执行与计划需要确认",
        ),
        SessionMode(
            id="accept_everything",
            name="Accept everything",
            description="全自动,不请求任何权限",
        ),
    ],
)


async def _make_checkpointer(state_dir: Path) -> AsyncSqliteSaver:
    """SQLite checkpointer:会话状态跨连接、跨进程重启持久化。

    每条 WebSocket 连接对应一个 stdio 子进程(见 serve.py),进程内存里的
    checkpointer 无法支撑 reconnect 后的 session/load,必须落盘。deepagents-acp
    走 LangGraph 的 async 接口(aupdate_state/aget_state),同步的 SqliteSaver
    会直接 NotImplementedError,必须用 AsyncSqliteSaver(aiosqlite)。
    """
    state_dir.mkdir(parents=True, exist_ok=True)
    conn = await aiosqlite.connect(
        state_dir / "checkpoints.sqlite",
        # LangGraph 在事件循环线程里跨任务使用同一连接
        timeout=30.0,
    )
    await conn.execute("PRAGMA journal_mode=WAL")
    saver = AsyncSqliteSaver(conn)  # type: ignore[arg-type]
    await saver.setup()
    return saver


async def create_acp_agent(sandbox_dir: Path, state_dir: Path) -> AgentServerACP:
    """构建 ACP agent:模型清单来自注册表,文件/命令都落在 sandbox_dir。"""
    models_list, registry = build_model_registry()
    checkpointer = await _make_checkpointer(state_dir)

    def build_agent(context: AgentSessionContext) -> CompiledStateGraph:  # type: ignore[type-arg]
        model_id = context.model or FAKE_MODEL_ID
        model: BaseChatModel = registry.get(model_id)  # type: ignore[assignment]
        if model is None:
            # 不静默回退到剧本模型:客户端选了一个未注册的模型是配置错误,
            # 必须让会话创建显式失败,而不是悄悄换脑子。
            raise ValueError(
                f"未注册的模型: {context.model!r},可用模型: {sorted(registry)}"
            )
        mode_id = context.mode or MODES.current_mode_id
        interrupt_config = INTERRUPT_CONFIGS.get(mode_id)
        if interrupt_config is None:
            raise ValueError(
                f"未注册的模式: {mode_id!r},可用模式: {sorted(INTERRUPT_CONFIGS)}"
            )
        backend = CompositeBackend(
            default=LocalShellBackend(root_dir=str(sandbox_dir)),
            routes={"/memories/": StateBackend()},
        )
        return create_deep_agent(
            model=model,
            checkpointer=checkpointer,
            backend=backend,
            # deepagents 0.7.12 的默认工具集不含 write_todos。显式装配
            # TodoListMiddleware 才能让剧本的计划步骤真实执行并产生 plan update。
            middleware=[TodoListMiddleware()],
            interrupt_on=interrupt_config,
        )

    return AgentServerACP(
        agent=build_agent,
        modes=MODES,
        models=models_list,
        load_sessions=True,
    )
