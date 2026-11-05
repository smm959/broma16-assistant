import type { ChatRequest, ChatResult, LlmAdapter, LlmMessage, ToolCall } from '../types.js'
import { LlmError } from '../types.js'
import { friendlyHttpError, httpJson, readSse } from '../http.js'

function sanitizeSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(sanitizeSchema)
  if (!schema || typeof schema !== 'object') return schema
  const blocked = new Set(['additionalProperties', '$schema', '$id', 'default', 'examples', 'title', 'const', 'propertyNames', 'patternProperties'])
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(schema as Record<string, unknown>)) {
    if (blocked.has(k)) continue
    out[k] = sanitizeSchema(v)
  }
  return out
}

function toContents(messages: LlmMessage[]): { systemInstruction?: any; contents: any[] } {
  const systemParts: string[] = []
  const contents: any[] = []

  for (const m of messages) {
    if (m.role === 'system') {
      systemParts.push(typeof m.content === 'string' ? m.content : m.content.filter((p) => p.type === 'text').map((p: any) => p.text).join('\n'))
      continue
    }
    if (m.role === 'tool') {
      const part = { functionResponse: { name: m.name, response: { result: m.content.slice(0, 20000) } } }
      const last = contents[contents.length - 1]
      if (last && last.role === 'user' && last.parts?.[0]?.functionResponse) last.parts.push(part)
      else contents.push({ role: 'user', parts: [part] })
      continue
    }
    if (m.role === 'assistant') {
      const parts: any[] = []
      if (m.content) parts.push({ text: m.content })
      for (const tc of m.toolCalls ?? []) {
        let args: unknown = {}
        try {
          args = JSON.parse(tc.arguments || '{}')
        } catch {
          args = {}
        }
        parts.push({ functionCall: { name: tc.name, args } })
      }
      contents.push({ role: 'model', parts: parts.length ? parts : [{ text: '…' }] })
      continue
    }
    const parts =
      typeof m.content === 'string'
        ? [{ text: m.content }]
        : m.content.map((p) =>
            p.type === 'text'
              ? { text: p.text }
              : { inlineData: { mimeType: p.mimeType, data: p.dataBase64 } },
          )
    contents.push({ role: 'user', parts })
  }

  return {
    systemInstruction: systemParts.length ? { parts: [{ text: systemParts.join('\n\n') }] } : undefined,
    contents,
  }
}

export class GeminiAdapter implements LlmAdapter {
  readonly provider = 'gemini' as const

  private url(baseUrl: string, model: string, method: string, apiKey: string) {
    return `${baseUrl.replace(/\/$/, '')}/models/${encodeURIComponent(model)}:${method}?key=${encodeURIComponent(apiKey)}`
  }

  async streamChat(req: ChatRequest, apiKey: string, baseUrl: string): Promise<ChatResult> {
    const { systemInstruction, contents } = toContents(req.messages)
    const body: any = {
      contents,
      generationConfig: { temperature: req.temperature ?? 0.4, maxOutputTokens: req.maxTokens ?? 4096 },
    }
    if (systemInstruction) body.systemInstruction = systemInstruction
    if (req.tools?.length) {
      body.tools = [
        {
          functionDeclarations: req.tools.map((t) => ({
            name: t.name,
            description: t.description,
            parameters: sanitizeSchema(t.parameters),
          })),
        },
      ]
    }

    const res = await fetch(this.url(baseUrl, req.model, 'streamGenerateContent', apiKey) + '&alt=sse', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: req.signal,
    })

    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw friendlyHttpError(res.status, text, 'Google Gemini')
    }

    let text = ''
    const calls: ToolCall[] = []
    const usage: ChatResult['usage'] = {}
    let finishReason: string | undefined

    await readSse(res, (_event, data) => {
      if (!data) return
      let json: any
      try {
        json = JSON.parse(data)
      } catch {
        return
      }
      if (json.usageMetadata) {
        usage.inputTokens = json.usageMetadata.promptTokenCount
        usage.outputTokens = json.usageMetadata.candidatesTokenCount
      }
      const cand = json.candidates?.[0]
      if (!cand) return
      if (cand.finishReason) finishReason = cand.finishReason
      for (const part of cand.content?.parts ?? []) {
        if (typeof part.text === 'string' && part.text) {
          text += part.text
          req.onText?.(part.text)
        }
        if (part.functionCall) {
          calls.push({
            id: `call_${calls.length}_${Math.random().toString(36).slice(2, 8)}`,
            name: part.functionCall.name,
            arguments: JSON.stringify(part.functionCall.args ?? {}),
          })
        }
      }
    })

    return { text, toolCalls: calls, finishReason, usage }
  }

  async listModels(apiKey: string, baseUrl: string): Promise<string[]> {
    const { ok, json, status, text } = await httpJson(
      `${baseUrl.replace(/\/$/, '')}/models?key=${encodeURIComponent(apiKey)}&pageSize=100`,
      {},
    )
    if (!ok) throw friendlyHttpError(status, text, 'Google Gemini')
    return (json?.models ?? [])
      .filter((m: any) => (m.supportedGenerationMethods ?? []).includes('generateContent'))
      .map((m: any) => String(m.name).replace(/^models\//, ''))
  }

  async test(apiKey: string, baseUrl: string, model: string): Promise<void> {
    const { ok, status, text, json } = await httpJson(
      `${baseUrl.replace(/\/$/, '')}/models/${encodeURIComponent(model)}?key=${encodeURIComponent(apiKey)}`,
      {},
      45_000,
    )
    if (!ok) throw friendlyHttpError(status, text, 'Google Gemini')
    if (!json?.name) throw new LlmError('Gemini вернул неожиданный ответ.', 'bad_request')
  }
}
