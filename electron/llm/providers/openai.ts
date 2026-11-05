import type { ChatRequest, ChatResult, ContentPart, LlmAdapter, LlmMessage, ToolCall } from '../types.js'
import { LlmError } from '../types.js'
import { friendlyHttpError, httpJson, readSse } from '../http.js'

function toWireMessages(messages: LlmMessage[]) {
  const out: any[] = []
  for (const m of messages) {
    if (m.role === 'assistant') {
      const msg: any = { role: 'assistant', content: m.content || null }
      if (m.toolCalls?.length) {
        msg.tool_calls = m.toolCalls.map((t) => ({
          id: t.id,
          type: 'function',
          function: { name: t.name, arguments: t.arguments || '{}' },
        }))
        if (!m.content) msg.content = null
      }
      out.push(msg)
      continue
    }
    if (m.role === 'tool') {
      out.push({ role: 'tool', tool_call_id: m.toolCallId, content: m.content })
      continue
    }
    if (typeof m.content === 'string') {
      out.push({ role: m.role, content: m.content })
    } else {
      out.push({
        role: m.role,
        content: m.content.map((part: ContentPart) =>
          part.type === 'text'
            ? { type: 'text', text: part.text }
            : { type: 'image_url', image_url: { url: `data:${part.mimeType};base64,${part.dataBase64}` } },
        ),
      })
    }
  }
  return out
}

export class OpenAiCompatibleAdapter implements LlmAdapter {
  constructor(readonly provider: 'openai' | 'deepseek' | 'compatible') {}

  async streamChat(req: ChatRequest, apiKey: string, baseUrl: string): Promise<ChatResult> {
    const url = `${baseUrl.replace(/\/$/, '')}/chat/completions`
    const reasoning = /^o\d|^gpt-5|reasoner|thinking/i.test(req.model)
    const body: any = {
      model: req.model,
      messages: toWireMessages(req.messages),
      stream: true,
    }
    if (!reasoning) body.temperature = req.temperature ?? 0.4
    if (req.maxTokens) {
      if (/^o\d|^gpt-5/i.test(req.model)) body.max_completion_tokens = req.maxTokens
      else body.max_tokens = req.maxTokens
    }
    if (req.tools?.length) {
      body.tools = req.tools.map((t) => ({
        type: 'function',
        function: { name: t.name, description: t.description, parameters: t.parameters },
      }))
      body.tool_choice = 'auto'
    }

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
        ...(this.provider === 'compatible'
          ? { 'HTTP-Referer': 'https://broma16.com', 'X-Title': 'Broma 16 Assistant' }
          : {}),
      },
      body: JSON.stringify(body),
      signal: req.signal,
    })

    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw friendlyHttpError(res.status, text, this.provider === 'deepseek' ? 'DeepSeek' : this.provider === 'openai' ? 'OpenAI' : 'провайдер')
    }
    if (!res.headers.get('content-type')?.includes('text/event-stream')) {
      // Некоторые local-провайдеры игнорируют stream
      const json = await res.json().catch(() => null)
      const choice = json?.choices?.[0]
      if (!choice) throw new LlmError('Провайдер вернул неожиданный ответ.', 'unknown')
      const text: string = choice.message?.content ?? ''
      if (text) req.onText?.(text)
      const calls: ToolCall[] = (choice.message?.tool_calls ?? []).map((c: any) => ({
        id: c.id,
        name: c.function.name,
        arguments: c.function.arguments || '{}',
      }))
      return { text, toolCalls: calls, finishReason: choice.finish_reason, usage: { inputTokens: json.usage?.prompt_tokens, outputTokens: json.usage?.completion_tokens } }
    }

    let text = ''
    let finishReason: string | undefined
    let usage: ChatResult['usage']
    const calls: { id: string; name: string; arguments: string }[] = []

    await readSse(res, (_event, data) => {
      if (!data || data === '[DONE]') return
      let json: any
      try {
        json = JSON.parse(data)
      } catch {
        return
      }
      if (json.usage) usage = { inputTokens: json.usage.prompt_tokens, outputTokens: json.usage.completion_tokens }
      const choice = json.choices?.[0]
      if (!choice) return
      const delta = choice.delta ?? {}
      if (typeof delta.content === 'string' && delta.content) {
        text += delta.content
        req.onText?.(delta.content)
      }
      if (Array.isArray(delta.tool_calls)) {
        for (const tc of delta.tool_calls) {
          const i = tc.index ?? 0
          calls[i] ??= { id: '', name: '', arguments: '' }
          if (tc.id) calls[i]!.id = tc.id
          if (tc.function?.name) calls[i]!.name += tc.function.name
          if (tc.function?.arguments) calls[i]!.arguments += tc.function.arguments
        }
      }
      if (choice.finish_reason) finishReason = choice.finish_reason
    })

    return {
      text,
      toolCalls: calls
        .filter((c) => c.name)
        .map((c, i) => ({ id: c.id || `call_${i}_${Date.now()}`, name: c.name, arguments: c.arguments || '{}' })),
      finishReason,
      usage,
    }
  }

  async listModels(apiKey: string, baseUrl: string): Promise<string[]> {
    const { ok, json, status, text } = await httpJson(`${baseUrl.replace(/\/$/, '')}/models`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    })
    if (!ok) throw friendlyHttpError(status, text, this.provider)
    return (json?.data ?? []).map((m: any) => m.id).filter(Boolean)
  }

  async test(apiKey: string, baseUrl: string, model: string): Promise<void> {
    const { ok, status, text, json } = await httpJson(`${baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model, messages: [{ role: 'user', content: 'ping' }], max_tokens: 1, stream: false }),
    }, 45_000)
    if (!ok) throw friendlyHttpError(status, text, this.provider)
    if (!json?.choices) throw new LlmError('Провайдер ответил, но формат ответа не похож на OpenAI API.', 'bad_request')
  }
}
