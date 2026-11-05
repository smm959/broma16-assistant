import type { ProviderId } from '../../shared/types.js'
import type { LlmAdapter } from './types.js'
import { LlmError } from './types.js'
import { AnthropicAdapter } from './providers/anthropic.js'
import { GeminiAdapter } from './providers/gemini.js'
import { OpenAiCompatibleAdapter } from './providers/openai.js'

/** Единая фабрика адаптеров: используется и основным провайдером, и vision-сервисом. */
export function adapterFor(provider: ProviderId): LlmAdapter {
  switch (provider) {
    case 'openai':
      return new OpenAiCompatibleAdapter('openai')
    case 'deepseek':
      return new OpenAiCompatibleAdapter('deepseek')
    case 'compatible':
      return new OpenAiCompatibleAdapter('compatible')
    case 'anthropic':
      return new AnthropicAdapter()
    case 'gemini':
      return new GeminiAdapter()
    default:
      throw new LlmError(`Провайдер ${provider} пока не поддерживается.`, 'unsupported')
  }
}

export const VISION_PROVIDERS: ProviderId[] = ['openai', 'anthropic', 'gemini', 'compatible']
