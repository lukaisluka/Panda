"""确定性剧本模型:按 (用户轮次, 步骤) 查剧本表返回固定响应。

deepagents-acp 通过模型的流式 `tool_call_chunks` 驱动工具卡/计划/diff 等
update(见其 `_process_tool_call_chunks`),因此 `_stream` 必须实现,并让
`AIMessageChunk` 从 `tool_calls` 自动物化 `tool_call_chunks`。思考块使用
官方测试确认的格式:`content=[{"type": "reasoning", "reasoning": ...}]`,
会被映射为 ACP 的 `agent_thought_chunk`。

模型完全无内部状态:每次调用的返回值只由收到的消息列表决定
(HumanMessage 个数 = 用户轮次,其后 AIMessage 个数 = 步骤序号),
因此同一剧本永远得到同一结果,适合回归断言。
"""

from __future__ import annotations

import json
import re
from typing import TYPE_CHECKING, Any

from langchain_core.language_models.chat_models import BaseChatModel
from langchain_core.messages import AIMessage, AIMessageChunk, BaseMessage, HumanMessage
from langchain_core.outputs import ChatGeneration, ChatGenerationChunk, ChatResult

from panda_test_agent.scenarios import Step, ToolCall, scripted_step

if TYPE_CHECKING:
    from collections.abc import Callable, Iterator, Sequence

    from langchain_core.callbacks import CallbackManagerForLLMRun
    from langchain_core.runnables import Runnable
    from langchain_core.tools import BaseTool

# 中文没有空格,按单字流出才像真实模型的增量输出;非中文字符按词流出
_WORD_RE = re.compile(r"[\u4e00-\u9fff]|[^\u4e00-\u9fff\s]+\s*")


def _locate(messages: Sequence[BaseMessage]) -> tuple[int, int]:
    """从消息列表算出 (用户轮次, 本轮步骤序号)。

    HumanMessage 个数即轮次(系统消息不计);最后一条 HumanMessage 之后
    已出现的 AIMessage 个数即步骤序号——LangGraph 的工具循环每转一圈
    会追加一条 AIMessage,下一次模型调用就能看到它。

    用 isinstance 而不是 `.type` 判定:langchain-core 1.x 里
    AIMessageChunk 的 type 是 "AIMessageChunk" 而非 "ai",而 chunk 恰是
    流式路径里模型实际收到的消息类型(AIMessageChunk 是 AIMessage 子类)。
    """
    user_turn = sum(1 for message in messages if isinstance(message, HumanMessage))
    step = 0
    for message in reversed(messages):
        if isinstance(message, HumanMessage):
            break
        if isinstance(message, AIMessage):
            step += 1
    return user_turn, step


def _tool_calls_payload(
    tool_calls: Sequence[ToolCall], *, turn: int, step_index: int
) -> list[dict[str, Any]]:
    """直接构造 tool_call_chunks:显式给出 index,避免多工具调用共用 None 下标。"""
    return [
        {
            "name": call.name,
            "args": json.dumps(call.args, ensure_ascii=False),
            "id": f"call_t{turn}s{step_index}c{i}",
            "index": i,
            "type": "tool_call_chunk",
        }
        for i, call in enumerate(tool_calls)
    ]


def _split_words(text: str) -> list[str]:
    return _WORD_RE.findall(text)


class ScriptedChatModel(BaseChatModel):
    """播放 `scenarios.py` 剧本的假模型,是本测试 agent 的默认大脑。"""

    @property
    def _llm_type(self) -> str:
        return "scripted-test-model"

    def bind_tools(
        self,
        tools: Sequence[dict[str, Any] | type | Callable | BaseTool],
        *,
        tool_choice: str | None = None,
        **kwargs: Any,
    ) -> Runnable:  # type: ignore[type-arg]
        """deepagents 装配时会 bind_tools;剧本模型忽略工具清单,返回自身。"""
        return self

    def _build_step_message(self, step: Step, *, turn: int, step_index: int) -> AIMessage:
        content: Any = [] if step.reasoning else (step.text or "")
        if step.reasoning:
            content.append({"type": "reasoning", "reasoning": step.reasoning})
            if step.text:
                content.append({"type": "text", "text": step.text})
        return AIMessage(
            content=content,
            tool_calls=[
                {
                    "name": call.name,
                    "args": call.args,
                    "id": f"call_t{turn}s{step_index}c{i}",
                    "type": "tool_call",
                }
                for i, call in enumerate(step.tool_calls)
            ],
        )

    def _generate(
        self,
        messages: list[BaseMessage],
        stop: list[str] | None = None,
        run_manager: CallbackManagerForLLMRun | None = None,
        **kwargs: Any,
    ) -> ChatResult:
        turn, step_index = _locate(messages)
        step = scripted_step(turn, step_index)
        message = self._build_step_message(step, turn=turn, step_index=step_index)
        return ChatResult(generations=[ChatGeneration(message=message)])

    def _stream(
        self,
        messages: list[BaseMessage],
        stop: list[str] | None = None,
        run_manager: CallbackManagerForLLMRun | None = None,
        **kwargs: Any,
    ) -> Iterator[ChatGenerationChunk]:
        turn, step_index = _locate(messages)
        step = scripted_step(turn, step_index)

        def emit(chunk_message: AIMessageChunk, token: str = "") -> ChatGenerationChunk:
            chunk = ChatGenerationChunk(message=chunk_message)
            if run_manager:
                run_manager.on_llm_new_token(token, chunk=chunk)
            return chunk

        chunks: list[ChatGenerationChunk] = []
        if step.reasoning:
            # 逐词流出思考块,让 agent_thought_chunk 的增量渲染路径真实工作。
            for piece in _split_words(step.reasoning):
                chunks.append(
                    emit(AIMessageChunk(content=[{"type": "reasoning", "reasoning": piece}]), piece)
                )
        if step.tool_calls:
            payload = _tool_calls_payload(step.tool_calls, turn=turn, step_index=step_index)
            # tool_call_chunks 整条一次发出,deepagents-acp 据此发出工具卡 start update
            chunks.append(emit(AIMessageChunk(content="", tool_call_chunks=payload)))
        if step.text:
            for piece in _split_words(step.text):
                chunks.append(emit(AIMessageChunk(content=piece), piece))

        if not chunks:
            return

        # 标记流的最后一个 chunk,提示调用方本条消息到此结束
        # (与 deepagents-acp 官方假模型的做法一致)。
        last_message = chunks[-1].message
        if isinstance(last_message, AIMessageChunk) and not last_message.additional_kwargs:
            last_message.chunk_position = "last"

        yield from chunks
