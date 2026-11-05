import type { ProviderId } from '../../shared/types.js'

export type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image'; mimeType: string; dataBase64: string }

export type LlmMessage =
  | { role: 'system' | 'user'; content: string | ContentPart[] }
  | { role: 'assistant'; content: string; toolCalls?: ToolCall[] }
  | { role: 'tool'; toolCallId: string; name: string; content: string }

export interface ToolCall {
  id: string
  name: string
  arguments: string
  /** Gemini требует имя функции в ответе, храним как есть */
  args?: Record<string, unknown>
}

export interface ToolSpec {
  name: string
  description: string
  parameters: Record<string, unknown>
}

export interface ChatRequest {
  model: string
  messages: LlmMessage[]
  tools?: ToolSpec[]
  temperature?: number
  maxTokens?: number
  signal?: AbortSignal
  /** вызывается по мере генерации текста */
  onText?: (delta: string) => void
}

export interface ChatResult {
  text: string
  toolCalls: ToolCall[]
  finishReason?: string
  usage?: { inputTokens?: number; outputTokens?: number }
  raw?: unknown
}

export interface LlmAdapter {
  readonly provider: ProviderId
  streamChat(req: ChatRequest, apiKey: string, baseUrl: string): Promise<ChatResult>
  listModels?(apiKey: string, baseUrl: string): Promise<string[]>
  test(apiKey: string, baseUrl: string, model: string): Promise<void>
}

export class LlmError extends Error {
  constructor(
    message: string,
    readonly code: 'auth' | 'quota' | 'rate_limit' | 'model' | 'network' | 'bad_request' | 'unsupported' | 'unknown',
    readonly status?: number,
  ) {
    super(message)
    this.name = 'LlmError'
  }
}
