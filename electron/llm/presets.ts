import type { ModelInfo, ProviderId, ProviderPreset } from '../../shared/types.js'

export const PROVIDERS: ProviderPreset[] = [
  {
    id: 'deepseek',
    name: 'DeepSeek',
    description: 'Приоритетный провайдер. DeepSeek Chat и reasoning-модель DeepSeek Reasoner. Оплата в юанях/долларах, API совместим с OpenAI.',
    baseUrl: 'https://api.deepseek.com/v1',
    docsUrl: 'https://platform.deepseek.com/api_keys',
    keyPlaceholder: 'sk-…',
    models: [
      { id: 'deepseek-chat', label: 'DeepSeek Chat (V3)', supportsTools: true, supportsVision: false, kind: 'chat', contextWindow: 131072 },
      { id: 'deepseek-reasoner', label: 'DeepSeek Reasoner (R1)', supportsTools: false, supportsVision: false, kind: 'reasoning', contextWindow: 131072 },
    ],
  },
  {
    id: 'openai',
    name: 'OpenAI',
    description: 'GPT-модели OpenAI. Поддержка инструментов, изображений и reasoning-моделей.',
    baseUrl: 'https://api.openai.com/v1',
    docsUrl: 'https://platform.openai.com/api-keys',
    keyPlaceholder: 'sk-…',
    models: [
      { id: 'gpt-4.1', label: 'GPT-4.1', supportsTools: true, supportsVision: true, kind: 'chat', contextWindow: 1047576 },
      { id: 'gpt-4.1-mini', label: 'GPT-4.1 mini', supportsTools: true, supportsVision: true, kind: 'chat', contextWindow: 1047576 },
      { id: 'gpt-4o', label: 'GPT-4o', supportsTools: true, supportsVision: true, kind: 'chat', contextWindow: 128000 },
      { id: 'gpt-4o-mini', label: 'GPT-4o mini', supportsTools: true, supportsVision: true, kind: 'chat', contextWindow: 128000 },
      { id: 'o4-mini', label: 'o4-mini (reasoning)', supportsTools: true, supportsVision: true, kind: 'reasoning', contextWindow: 200000 },
      { id: 'o3', label: 'o3 (reasoning)', supportsTools: true, supportsVision: true, kind: 'reasoning', contextWindow: 200000 },
    ],
  },
  {
    id: 'anthropic',
    name: 'Anthropic',
    description: 'Claude — сильная модель для длинных документов, писем и аккуратных формулировок.',
    baseUrl: 'https://api.anthropic.com/v1',
    docsUrl: 'https://console.anthropic.com/settings/keys',
    keyPlaceholder: 'sk-ant-…',
    models: [
      { id: 'claude-sonnet-4-20250514', label: 'Claude Sonnet 4', supportsTools: true, supportsVision: true, kind: 'chat', contextWindow: 200000 },
      { id: 'claude-opus-4-20250514', label: 'Claude Opus 4', supportsTools: true, supportsVision: true, kind: 'chat', contextWindow: 200000 },
      { id: 'claude-3-7-sonnet-latest', label: 'Claude 3.7 Sonnet', supportsTools: true, supportsVision: true, kind: 'chat', contextWindow: 200000 },
      { id: 'claude-3-5-haiku-latest', label: 'Claude 3.5 Haiku', supportsTools: true, supportsVision: true, kind: 'chat', contextWindow: 200000 },
    ],
  },
  {
    id: 'gemini',
    name: 'Google Gemini',
    description: 'Gemini 2.5 Pro / Flash. Отличная работа с изображениями и длинным контекстом.',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    docsUrl: 'https://aistudio.google.com/app/apikey',
    keyPlaceholder: 'AIza…',
    models: [
      { id: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro', supportsTools: true, supportsVision: true, kind: 'chat', contextWindow: 1048576 },
      { id: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash', supportsTools: true, supportsVision: true, kind: 'chat', contextWindow: 1048576 },
      { id: 'gemini-2.0-flash', label: 'Gemini 2.0 Flash', supportsTools: true, supportsVision: true, kind: 'chat', contextWindow: 1048576 },
    ],
  },
  {
    id: 'compatible',
    name: 'OpenAI-compatible',
    description: 'Любой совместимый endpoint: OpenRouter, Groq, Together, LM Studio, Ollama, локальные модели.',
    baseUrl: 'https://openrouter.ai/api/v1',
    docsUrl: 'https://openrouter.ai/keys',
    keyPlaceholder: 'ключ провайдера (или пусто для локального сервера)',
    customBaseUrl: true,
    models: [
      { id: 'openai/gpt-4.1', label: 'OpenRouter: GPT-4.1', supportsTools: true, supportsVision: true, kind: 'chat' },
      { id: 'anthropic/claude-sonnet-4', label: 'OpenRouter: Claude Sonnet 4', supportsTools: true, supportsVision: true, kind: 'chat' },
      { id: 'deepseek/deepseek-r1', label: 'OpenRouter: DeepSeek R1', supportsTools: false, supportsVision: false, kind: 'reasoning' },
      { id: 'llama3.1', label: 'Ollama: llama3.1', supportsTools: true, supportsVision: false, kind: 'chat' },
    ],
  },
]

export function presetFor(id: ProviderId): ProviderPreset {
  const preset = PROVIDERS.find((p) => p.id === id)
  if (!preset) throw new Error(`Неизвестный провайдер: ${id}`)
  return preset
}

export function modelInfo(provider: ProviderId, modelId: string): ModelInfo {
  const preset = presetFor(provider)
  return (
    preset.models.find((m) => m.id === modelId) ?? {
      id: modelId,
      label: modelId,
      supportsTools: true,
      supportsVision: false,
      kind: 'chat',
    }
  )
}

export function providerLabel(id: ProviderId) {
  return presetFor(id).name
}
