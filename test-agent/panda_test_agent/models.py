"""模型注册表:默认剧本模型 + 可选的真实 LLM(OpenAI 兼容端点)。

真实模型从环境变量 `PANDA_TEST_AGENT_REAL_MODELS` 读取(JSON 数组),例如:

    PANDA_TEST_AGENT_REAL_MODELS='[
      {"value": "openai-compat:glm", "name": "GLM", "model": "glm",
       "base_url": "https://open.bigmodel.cn/api/paas/v4", "api_key": "..."}
    ]'

配置了真实模型但未安装 `langchain-openai` 时直接报错退出(fail-fast),
不做静默降级——否则用户以为在测真实模型,实际测的还是剧本。
"""

from __future__ import annotations

import json
import os
from typing import TYPE_CHECKING, Any

from langchain_core.language_models.chat_models import BaseChatModel

from panda_test_agent.scripted_model import ScriptedChatModel

if TYPE_CHECKING:
    from collections.abc import Sequence

FAKE_MODEL_ID = "fake:scripted"
_REAL_MODELS_ENV = "PANDA_TEST_AGENT_REAL_MODELS"
_REQUIRED_FIELDS = ("value", "name", "model", "base_url", "api_key")


def _load_real_model_configs() -> list[dict[str, str]]:
    """解析并校验真实模型配置;未配置时返回空列表,配置错误时抛异常。"""
    raw = os.environ.get(_REAL_MODELS_ENV, "").strip()
    if not raw:
        return []
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError as e:
        raise ValueError(f"{_REAL_MODELS_ENV} 不是合法 JSON: {e}") from e
    if not isinstance(parsed, list):
        raise ValueError(f"{_REAL_MODELS_ENV} 必须是 JSON 数组,实际是 {type(parsed).__name__}")

    configs: list[dict[str, str]] = []
    for i, entry in enumerate(parsed):
        if not isinstance(entry, dict):
            raise ValueError(f"{_REAL_MODELS_ENV}[{i}] 必须是对象,实际是 {type(entry).__name__}")
        missing = [f for f in _REQUIRED_FIELDS if not entry.get(f)]
        if missing:
            raise ValueError(f"{_REAL_MODELS_ENV}[{i}] 缺少必填字段: {', '.join(missing)}")
        configs.append({f: str(entry[f]) for f in _REQUIRED_FIELDS})
    return configs


def _make_openai_compat_model(cfg: dict[str, str]) -> BaseChatModel:
    try:
        from langchain_openai import ChatOpenAI
    except ImportError as e:
        raise ImportError(
            "配置了真实模型但没有 langchain-openai,请运行 "
            "`uv sync --group real-llm`(或安装 langchain-openai)后重试。"
        ) from e
    return ChatOpenAI(
        model=cfg["model"],
        base_url=cfg["base_url"],
        api_key=cfg["api_key"],
    )


def build_model_registry() -> tuple[list[dict[str, str]], dict[str, BaseChatModel]]:
    """返回 (ACP models 列表, 值→模型实例 的注册表)。

    剧本模型永远排在第一位:deepagents-acp 把 models[0] 当作新会话的默认模型。
    """
    models_list: list[dict[str, str]] = [
        {
            "value": FAKE_MODEL_ID,
            "name": "Scripted Test Model",
            "description": "确定性剧本模型(离线、免费、可复现)",
        }
    ]
    registry: dict[str, BaseChatModel] = {FAKE_MODEL_ID: ScriptedChatModel()}
    for cfg in _load_real_model_configs():
        if cfg["value"] in registry:
            raise ValueError(f"模型 value 重复: {cfg['value']!r}")
        models_list.append({"value": cfg["value"], "name": cfg["name"]})
        registry[cfg["value"]] = _make_openai_compat_model(cfg)
    return models_list, registry
