/**
 * 模型注册表:默认剧本模型 + 可选的真实 LLM(OpenAI 兼容端点)。
 *
 * 真实模型从环境变量 `PANDA_TEST_AGENT_REAL_MODELS` 读取(JSON 数组),例如:
 *
 *     PANDA_TEST_AGENT_REAL_MODELS='[
 *       {"value": "openai-compat:glm", "name": "GLM", "model": "glm",
 *        "base_url": "https://open.bigmodel.cn/api/paas/v4", "api_key": "..."}
 *     ]'
 *
 * 配置了真实模型但未安装 `@langchain/openai` 时直接报错退出(fail-fast),
 * 不做静默降级——否则用户以为在测真实模型,实际测的还是剧本。
 */

import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { ScriptedChatModel } from './scriptedModel';

export interface RealModelConfig {
  value: string;
  name: string;
  model: string;
  base_url: string;
  api_key: string;
  temperature?: number;
  top_p?: number;
  reasoning_effort?: string;
  streaming?: boolean;
  extra_body?: Record<string, unknown>;
}

export interface ModelRegistry {
  /** ACP session/new 的 models 声明(value/name/description)。 */
  modelsList: { value: string; name: string; description?: string }[];
  /** value → 模型实例。 */
  instances: Map<string, BaseChatModel>;
}

export const FAKE_MODEL_ID = 'fake:scripted';
const REAL_MODELS_ENV = 'PANDA_TEST_AGENT_REAL_MODELS';
const DEFAULT_MODEL_ENV = 'PANDA_TEST_AGENT_DEFAULT_MODEL';
const REQUIRED_FIELDS = ['value', 'name', 'model', 'base_url', 'api_key'] as const;
const OPTIONAL_CHAT_FIELDS = ['temperature', 'top_p', 'reasoning_effort', 'streaming', 'extra_body'] as const;

/** 解析并校验真实模型配置;未配置时返回空列表,配置错误时抛异常。 */
export function loadRealModelConfigs(env: NodeJS.ProcessEnv): RealModelConfig[] {
  const raw = (env[REAL_MODELS_ENV] ?? '').trim();
  if (!raw) {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`${REAL_MODELS_ENV} 不是合法 JSON: ${String(error)}`);
  }
  if (!Array.isArray(parsed)) {
    throw new Error(`${REAL_MODELS_ENV} 必须是 JSON 数组,实际是 ${typeof parsed}`);
  }

  const configs: RealModelConfig[] = [];
  parsed.forEach((entry: unknown, i: number) => {
    if (typeof entry !== 'object' || entry === null) {
      throw new Error(`${REAL_MODELS_ENV}[${i}] 必须是对象,实际是 ${typeof entry}`);
    }
    const record = entry as Record<string, unknown>;
    const unknownFields = Object.keys(record).filter(
      (key) => !REQUIRED_FIELDS.includes(key as (typeof REQUIRED_FIELDS)[number]) && !OPTIONAL_CHAT_FIELDS.includes(key as (typeof OPTIONAL_CHAT_FIELDS)[number]),
    );
    if (unknownFields.length > 0) {
      throw new Error(`${REAL_MODELS_ENV}[${i}] 包含不支持的字段: ${unknownFields.sort().join(', ')}`);
    }
    const missing = REQUIRED_FIELDS.filter((field) => !record[field]);
    if (missing.length > 0) {
      throw new Error(`${REAL_MODELS_ENV}[${i}] 缺少必填字段: ${missing.join(', ')}`);
    }
    const config: RealModelConfig = {
      value: String(record.value),
      name: String(record.name),
      model: String(record.model),
      base_url: String(record.base_url),
      api_key: String(record.api_key),
    };
    for (const field of ['temperature', 'top_p'] as const) {
      if (record[field] !== undefined) {
        const value = record[field];
        if (typeof value !== 'number' || Number.isNaN(value)) {
          throw new Error(`${REAL_MODELS_ENV}[${i}].${field} 必须是数字`);
        }
        config[field] = value;
      }
    }
    if (record.reasoning_effort !== undefined) {
      if (typeof record.reasoning_effort !== 'string' || !record.reasoning_effort) {
        throw new Error(`${REAL_MODELS_ENV}[${i}].reasoning_effort 必须是非空字符串`);
      }
      config.reasoning_effort = record.reasoning_effort;
    }
    if (record.streaming !== undefined) {
      if (typeof record.streaming !== 'boolean') {
        throw new Error(`${REAL_MODELS_ENV}[${i}].streaming 必须是布尔值`);
      }
      config.streaming = record.streaming;
    }
    if (record.extra_body !== undefined) {
      if (typeof record.extra_body !== 'object' || record.extra_body === null || Array.isArray(record.extra_body)) {
        throw new Error(`${REAL_MODELS_ENV}[${i}].extra_body 必须是对象`);
      }
      config.extra_body = record.extra_body as Record<string, unknown>;
    }
    configs.push(config);
  });
  return configs;
}

async function makeOpenAiCompatModel(config: RealModelConfig): Promise<BaseChatModel> {
  let ChatOpenAI: unknown;
  try {
    ({ ChatOpenAI } = await import('@langchain/openai'));
  } catch (error) {
    throw new Error(
      '配置了真实模型但没有 @langchain/openai,请在 test-agent 里安装后重试' +
        `(\`pnpm --filter panda-test-agent add @langchain/openai\`)。原始错误: ${String(error)}`,
    );
  }
  const options: Record<string, unknown> = {
    model: config.model,
    configuration: { baseURL: config.base_url, apiKey: config.api_key },
    temperature: config.temperature,
    topP: config.top_p,
    streaming: config.streaming,
  };
  if (config.reasoning_effort) {
    // JS 版字段名是 reasoning: { effort }(@langchain/openai 没有 reasoningEffort
    // 构造字段——传错名会被静默丢弃,已在单测里钉住)
    options.reasoning = { effort: config.reasoning_effort };
  }
  if (config.extra_body) {
    options.modelKwargs = config.extra_body;
  }
  for (const key of Object.keys(options)) {
    if (options[key] === undefined) {
      delete options[key];
    }
  }
  return new (ChatOpenAI as new (options: Record<string, unknown>) => BaseChatModel)(options);
}

/**
 * 构建模型注册表。默认剧本模型排在第一位;设置
 * PANDA_TEST_AGENT_DEFAULT_MODEL 后,指定模型会移到第一位,
 * 成为新会话的显式默认模型。
 */
export async function buildModelRegistry(env: NodeJS.ProcessEnv): Promise<ModelRegistry> {
  const modelsList: ModelRegistry['modelsList'] = [
    {
      value: FAKE_MODEL_ID,
      name: 'Scripted Test Model',
      description: '确定性剧本模型(离线、免费、可复现)',
    },
  ];
  const instances = new Map<string, BaseChatModel>([[FAKE_MODEL_ID, new ScriptedChatModel()]]);

  for (const config of loadRealModelConfigs(env)) {
    if (instances.has(config.value)) {
      throw new Error(`模型 value 重复: ${config.value}`);
    }
    modelsList.push({ value: config.value, name: config.name });
    instances.set(config.value, await makeOpenAiCompatModel(config));
  }

  const defaultModel = (env[DEFAULT_MODEL_ENV] ?? '').trim();
  if (defaultModel) {
    if (!instances.has(defaultModel)) {
      throw new Error(
        `${DEFAULT_MODEL_ENV}=${defaultModel} 未注册,可用模型: ${[...instances.keys()].sort().join(', ')}`,
      );
    }
    modelsList.sort((a, b) => (a.value === defaultModel ? -1 : b.value === defaultModel ? 1 : 0));
  }
  return { modelsList, instances };
}
