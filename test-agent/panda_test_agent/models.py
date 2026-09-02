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
_DEFAULT_MODEL_ENV = "PANDA_TEST_AGENT_DEFAULT_MODEL"
_OPTIONAL_CHAT_FIELDS = ("temperature", "top_p", "reasoning_effort", "streaming", "extra_body")


def _load_real_model_configs() -> list[dict[str, Any]]:
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

    configs: list[dict[str, Any]] = []
    for i, entry in enumerate(parsed):
        if not isinstance(entry, dict):
            raise ValueError(f"{_REAL_MODELS_ENV}[{i}] 必须是对象,实际是 {type(entry).__name__}")
        unknown = set(entry).difference((*_REQUIRED_FIELDS, *_OPTIONAL_CHAT_FIELDS))
        if unknown:
            raise ValueError(f"{_REAL_MODELS_ENV}[{i}] 包含不支持的字段: {', '.join(sorted(unknown))}")
        missing = [f for f in _REQUIRED_FIELDS if not entry.get(f)]
        if missing:
            raise ValueError(f"{_REAL_MODELS_ENV}[{i}] 缺少必填字段: {', '.join(missing)}")
        config: dict[str, Any] = {f: str(entry[f]) for f in _REQUIRED_FIELDS}
        for field in ("temperature", "top_p"):
            if field in entry:
                value = entry[field]
                if isinstance(value, bool) or not isinstance(value, (int, float)):
                    raise ValueError(f"{_REAL_MODELS_ENV}[{i}].{field} 必须是数字")
                config[field] = value
        if "reasoning_effort" in entry:
            value = entry["reasoning_effort"]
            if not isinstance(value, str) or not value:
                raise ValueError(f"{_REAL_MODELS_ENV}[{i}].reasoning_effort 必须是非空字符串")
            config["reasoning_effort"] = value
        if "streaming" in entry:
            value = entry["streaming"]
            if not isinstance(value, bool):
                raise ValueError(f"{_REAL_MODELS_ENV}[{i}].streaming 必须是布尔值")
            config["streaming"] = value
        if "extra_body" in entry:
            value = entry["extra_body"]
            if not isinstance(value, dict):
                raise ValueError(f"{_REAL_MODELS_ENV}[{i}].extra_body 必须是对象")
            config["extra_body"] = value
        configs.append(config)
    return configs


def _make_openai_compat_model(cfg: dict[str, Any]) -> BaseChatModel:
    try:
        from langchain_openai import ChatOpenAI
    except ImportError as e:
        raise ImportError(
            "配置了真实模型但没有 langchain-openai,请运行 "
            "`uv sync --group real-llm`(或安装 langchain-openai)后重试。"
        ) from e
    chat_options: dict[str, Any] = {
        "model": cfg["model"],
        "base_url": cfg["base_url"],
        "api_key": cfg["api_key"],
    }
    chat_options.update({field: cfg[field] for field in _OPTIONAL_CHAT_FIELDS if field in cfg})
    return ChatOpenAI(**chat_options)


def build_model_registry() -> tuple[list[dict[str, str]], dict[str, BaseChatModel]]:
    """返回 (ACP models 列表, 值→模型实例 的注册表)。

    默认剧本模型排在第一位;设置 PANDA_TEST_AGENT_DEFAULT_MODEL 后,指定模型
    会移到第一位,成为新会话的显式默认模型。
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

    default_model = os.environ.get(_DEFAULT_MODEL_ENV, "").strip()
    if default_model:
        if default_model not in registry:
            raise ValueError(
                f"{_DEFAULT_MODEL_ENV}={default_model!r} 未注册,可用模型: {sorted(registry)}"
            )
        models_list.sort(key=lambda model: model["value"] != default_model)
    return models_list, registry
