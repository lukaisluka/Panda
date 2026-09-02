import json

import pytest

from panda_test_agent.models import build_model_registry


def test_real_model_can_be_the_explicit_default_with_request_options(monkeypatch):
    model_value = "zhipu:glm-5.3-flash"
    monkeypatch.setenv(
        "PANDA_TEST_AGENT_REAL_MODELS",
        json.dumps(
            [
                {
                    "value": model_value,
                    "name": "GLM-5.3-Flash",
                    "model": "glm-5.3-flash",
                    "base_url": "https://open.bigmodel.cn/api/paas/v4",
                    "api_key": "test-key",
                    "temperature": 1,
                    "top_p": 0.95,
                    "reasoning_effort": "max",
                    "streaming": True,
                    "extra_body": {
                        "thinking": {"type": "enabled", "clear_thinking": False},
                        "tool_stream": True,
                    },
                }
            ]
        ),
    )
    monkeypatch.setenv("PANDA_TEST_AGENT_DEFAULT_MODEL", model_value)

    models, registry = build_model_registry()

    assert models[0]["value"] == model_value
    model = registry[model_value]
    assert model.temperature == 1
    assert model.top_p == 0.95
    assert model.reasoning_effort == "max"
    assert model.streaming is True
    assert model.extra_body == {
        "thinking": {"type": "enabled", "clear_thinking": False},
        "tool_stream": True,
    }


def test_unknown_default_model_fails_fast(monkeypatch):
    monkeypatch.delenv("PANDA_TEST_AGENT_REAL_MODELS", raising=False)
    monkeypatch.setenv("PANDA_TEST_AGENT_DEFAULT_MODEL", "missing:model")

    with pytest.raises(ValueError, match="PANDA_TEST_AGENT_DEFAULT_MODEL"):
        build_model_registry()
