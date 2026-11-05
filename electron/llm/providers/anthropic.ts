import type { ChatRequest, ChatResult, ContentPart, LlmAdapter, LlmMessage, ToolCall } from '../types.js'
import { LlmError } from '../types.js'
import { friendlyHttpError, httpJson, readSse } from '../http.js'

function toAnthropicMessages(messages: LlmMessage[]): { system?: string; messages: any[] } {
  const systemParts: string[] = []
  const out: any[] = []

  for (const m of messages) {
    if (m.role === 'system') {
      systemParts.push(typeof m.content === 'string' ? m.content : m.content.map((p) => (p.type === 'text' ? p.text : '')).join('\n'))
      continue
    }
    if (m.role === 'tool') {
      const block = { type: 'tool_result', tool_use_id: m.toolCallId, content: m.content }
      const last = out[out.length - 1]
      if (last && last.role === 'user' && Array.isArray(last.content) && last.content[0]?.type === 'tool_result') {
        last.content.push(block)
      } else {
        out.push({ role: 'user', content: [block] })
      }
      continue
    }
    if (m.role === 'assistant') {
      const content: any[] = []
      if (m.content) content.push({ type: 'text', text: m.content })
      for (const tc of m.toolCalls ?? []) {
        let input: unknown = {}
        try {
          input = JSON.parse(tc.arguments || '{}')
        } catch {
          input = {}
        }
        content.push({ type: 'tool_use', id: tc.id, name: tc.name, input })
      }
      out.push({ role: 'assistant', content: content.length ? content : [{ type: 'text', text: '…' }] })
      continue
    }
    const content =
      typeof m.content === 'string'
        ? m.content
        : m.content.map((part: ContentPart) =>
            part.type === 'text'
              ? { type: 'text', text: part.text }
              : {
                  type: 'image',
                  source: { type: 'base64', media_type: part.mimeType, data: part.dataBase64 },
                },
          )
    out.push({ role: 'user', content })
  }

  return { system: systemParts.join('\n\n') || undefined, messages: out }
}

export class AnthropicAdapter implements LlmAdapter {
  readonly provider = 'anthropic' as const

  async streamChat(req: ChatRequest, apiKey: string, baseUrl: string): Promise<ChatResult> {
    const { system, messages } = toAnthropicMessages(req.messages)
    const body: any = {
      model: req.model,
      max_tokens: req.maxTokens ?? 4096,
      messages,
      stream: true,
      temperature: req.temperature ?? 0.4,
    }
    if (system) body.system = system
    if (req.tools?.length) {
      body.tools = req.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters }))
    }

    const res = await fetch(`${baseUrl.replace(/\/$/, '')}/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(body),
      signal: req.signal,
    })

    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw friendlyHttpError(res.status, text, 'Anthropic')
    }

    let text = ''
    const blocks: { index: number; id: string; name: string; json: string }[] = []
    let stopReason: string | undefined
    const usage: ChatResult['usage'] = {}

    await readSse(res, (event, data) => {
      if (!data) return
      let json: any
      try {
        json = JSON.parse(data)
      } catch {
        return
      }
      switch (event ?? json.type) {
        case 'message_start':
          usage.inputTokens = json.message?.usage?.input_tokens
          break
        case 'content_block_start': {
          const block = json.content_block
          if (block?.type === 'tool_use') {
            blocks[json.index] = { index: json.index, id: block.id, name: block.name, json: '' }
          }
          break
        }
        case 'content_block_delta': {
          const delta = json.delta
          if (delta?.type === 'text_delta' && delta.text) {
            text += delta.text
            req.onText?.(delta.text)
          }
          if (delta?.type === 'input_json_delta') {
            const b = blocks[json.index]
            if (b) b.json += delta.partial_json ?? ''
          }
          break
        }
        case 'message_delta':
          stopReason = json.delta?.stop_reason ?? stopReason
          if (json.usage?.output_tokens) usage.outputTokens = json.usage.output_tokens
          break
      }
    })

    const toolCalls: ToolCall[] = blocks
      .filter(Boolean)
      .map((b) => ({ id: b.id, name: b.name, arguments: b.json || '{}' }))

    return { text, toolCalls, finishReason: stopReason, usage }
  }

  async listModels(apiKey: string, baseUrl: string): Promise<string[]> {
    const { ok, json, status, text } = await httpJson(`${baseUrl.replace(/\/$/, '')}/models?limit=100`, {
      headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    })
    if (!ok) throw friendlyHttpError(status, text, 'Anthropic')
    return (json?.data ?? []).map((m: any) => m.id).filter(Boolean)
  }

  async test(apiKey: string, baseUrl: string, model: string): Promise<void> {
    const { ok, status, text, json } = await httpJson(`${baseUrl.replace(/\/$/, '')}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model, max_tokens: 1, messages: [{ role: 'user', content: 'ping' }] }),
    }, 45_000)
    if (!ok) throw friendlyHttpError(status, text, 'Anthropic')
    if (!json?.content) throw new LlmError('Anthropic вернул неожиданный формат ответа.', 'bad_request')
  }
}
