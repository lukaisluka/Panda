"""确定性剧本:测试 agent 每一轮、每一步要"说"和"做"什么。

剧本由两个下标定位:
- 用户轮次 = 对话里 HumanMessage 的个数(第 1 轮播放完整故事,之后是简短回复)
- 步骤     = 最后一条 HumanMessage 之后已出现的 AIMessage 个数
  (LangGraph 一轮里模型可能被多次调用:每次工具循环都是一次模型调用)

故事线与 `src/replay/fixtures.ts` 的 mainScenario 呼应:重构 auth 校验。
"""

from __future__ import annotations

from dataclasses import dataclass, field


@dataclass(frozen=True, slots=True)
class ToolCall:
    """剧本步骤中的一个工具调用(deepagents 内置工具)。"""

    name: str
    args: dict


@dataclass(frozen=True, slots=True)
class Step:
    """一次模型调用要返回的内容:思考块、工具调用与正文可以共存。

    `reasoning` 映射为 ACP 的 agent_thought_chunk,`text` 映射为
    agent_message_chunk,`tool_calls` 驱动工具卡/计划/diff 等 update。
    """

    reasoning: str | None = None
    text: str | None = None
    tool_calls: list[ToolCall] = field(default_factory=list)


# 与 seed/auth.ts 精确对应:edit_file 的 old_string 必须在沙箱文件里唯一命中。
_EDIT_OLD = "  if (validateSession(session) == false) {"
_EDIT_NEW = "  if (!validateSession(session)) {"

# deepagents 0.7.12 的 backend 使用以 `/` 为根的虚拟路径(由 LocalShellBackend
# 映射到沙箱目录),因此剧本里的 file_path 都写成规范的虚拟绝对路径。
_AUTH = "/auth.ts"

_TURN_1: list[Step] = [
    Step(
        reasoning=(
            "用户要重构 auth 校验。我先列个计划,再读实现、做最小改动,"
            "最后用一条命令验证,避免一次改太多。"
        ),
        tool_calls=[
            ToolCall(
                name="write_todos",
                args={
                    "todos": [
                        {"content": "通读 auth.ts 现有校验逻辑", "status": "completed"},
                        {"content": "收紧 authorize 的布尔判断", "status": "in_progress"},
                        {"content": "用命令验证改动后的文件", "status": "pending"},
                    ]
                },
            )
        ],
    ),
    Step(
        reasoning="先读一下 auth.ts 的现状,确认要改的位置。",
        tool_calls=[ToolCall(name="read_file", args={"file_path": _AUTH})],
    ),
    Step(
        reasoning="找到了,`validateSession(...) == false` 是多余的宽松比较,改成显式取反。",
        tool_calls=[
            ToolCall(
                name="edit_file",
                args={
                    "file_path": _AUTH,
                    "old_string": _EDIT_OLD,
                    "new_string": _EDIT_NEW,
                },
            )
        ],
    ),
    Step(
        reasoning="改动完成,跑一条命令确认最终文件内容。",
        tool_calls=[ToolCall(name="execute", args={"command": "cat auth.ts"})],
    ),
    Step(
        reasoning="改动验证过了,总结一下。",
        text=(
            "重构完成。`authorize` 里的布尔判断从宽松比较改成了显式取反,行为不变、可读性更好。\n\n"
            "```ts\n"
            f"{_EDIT_NEW}\n"
            "```\n\n"
            "**验证**:`cat auth.ts` 已确认改动落盘。测试 agent 的剧本到此播放完毕,"
            "你可以继续发消息测试追加消息的渲染,或切换到真实模型。"
        )
    ),
]

# 第 2 轮起:固定短回复,压测追加消息/多轮布局。
_FOLLOW_UP: list[Step] = [
    Step(
        reasoning="这是后续轮次,回一段固定文字即可。",
        text=(
            "收到。完整故事只在每轮剧本的第 1 轮播放,之后每轮都回复这段固定文字,"
            "便于验证**追加消息**与滚动行为。需要不可预测的输出时,请切换到真实模型。"
        ),
    )
]

# 步骤用尽时的兜底(正常情况下 _FOLLOW_UP 一步就结束,这里防御性保留)。
_FALLBACK: list[Step] = [
    Step(text="本轮剧本步骤已播完,这是兜底回复。")
]


def scripted_step(user_turn: int, step: int) -> Step:
    """返回第 user_turn 轮(1 起)第 step 步(0 起)的剧本内容。"""
    turn_script = _TURN_1 if user_turn <= 1 else _FOLLOW_UP
    if step < len(turn_script):
        return turn_script[step]
    return _FALLBACK[0]