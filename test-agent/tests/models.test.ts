import { describe, expect, it } from 'vitest';
import { buildModelRegistry, FAKE_MODEL_ID } from '../src/models';

const MODEL_VALUE = 'zhipu:glm-5.3-flash';

const REAL_MODELS_ENV = JSON.stringify([
  {
    value: MODEL_VALUE,
    name: 'GLM-5.3-Flash',
    model: 'glm-5.3-flash',
    base_url: 'https://open.bigmodel.cn/api/paas/v4',
    api_key: 'test-key',
    temperature: 1,
    top_p: 0.95,
    reasoning_effort: 'max',
    streaming: true,
    extra_body: {
      thinking: { type: 'enabled', clear_thinking: false },
      tool_stream: true,
    },
  },
]);

describe('buildModelRegistry', () => {
  it('真实模型可作为显式默认,请求参数完整透传', async () => {
    const registry = await buildModelRegistry({
      PANDA_TEST_AGENT_REAL_MODELS: REAL_MODELS_ENV,
      PANDA_TEST_AGENT_DEFAULT_MODEL: MODEL_VALUE,
    });

    expect(registry.modelsList[0]!.value).toBe(MODEL_VALUE);
    const model = registry.instances.get(MODEL_VALUE) as unknown as Record<string, unknown>;
    expect(model.temperature).toBe(1);
    expect(model.topP).toBe(0.95);
    // reasoning_effort → reasoning: { effort };extra_body → modelKwargs。
    // 这两个字段传错名会被 @langchain/openai 静默丢弃,必须钉住真实落点。
    expect(model.reasoning).toEqual({ effort: 'max' });
    expect(model.streaming).toBe(true);
    expect(model.modelKwargs).toEqual({
      thinking: { type: 'enabled', clear_thinking: false },
      tool_stream: true,
    });
  });

  it('未注册的默认模型直接报错,不静默回退剧本模型', async () => {
    await expect(
      buildModelRegistry({
        PANDA_TEST_AGENT_REAL_MODELS: '',
        PANDA_TEST_AGENT_DEFAULT_MODEL: 'missing:model',
      }),
    ).rejects.toThrow('PANDA_TEST_AGENT_DEFAULT_MODEL');
  });

  it('未配置真实模型时注册表只含剧本模型', async () => {
    const registry = await buildModelRegistry({ PANDA_TEST_AGENT_REAL_MODELS: '' });
    expect(registry.modelsList.map((m) => m.value)).toEqual([FAKE_MODEL_ID]);
  });
});
