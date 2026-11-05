import type { ModelInfo, ProviderConnection, ProviderId } from '../../shared/types.js'
import { LlmError, type ChatRequest, type ChatResult, type LlmAdapter } from './types.js'
import { adapterFor } from './adapters.js'
import { modelInfo, presetFor, PROVIDERS } from './presets.js'
import { secrets } from '../security/secrets.js'
import type { Db } from '../db/index.js'

interface ConnectionMeta {
  provider: ProviderId
  model: string
  baseUrl: string
  lastTestedAt?: number
  lastTestOk?: boolean
  lastTestError?: string
  updatedAt: number
}

const SECRET_PREFIX = 'llm:'

export class ProviderManager {
  private meta: ConnectionMeta | null = null

  constructor(private readonly db: Db) {
    this.loadMeta()
  }

  private loadMeta() {
    const row = this.db.get<{ value: string }>(`SELECT value FROM kv WHERE key = 'llm.connection'`)
    if (!row) return
    try {
      this.meta = JSON.parse(row.value) as ConnectionMeta
    } catch {
      this.meta = null
    }
  }

  private saveMeta(meta: ConnectionMeta | null) {
    this.meta = meta
    if (!meta) {
      this.db.run(`DELETE FROM kv WHERE key = 'llm.connection'`)
      return
    }
    this.db.run(
      `INSERT INTO kv(key, value) VALUES('llm.connection', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      JSON.stringify(meta),
    )
  }

  get presets() {
    return PROVIDERS
  }

  connection(): ProviderConnection | null {
    if (!this.meta) return null
    const m = this.meta
    return {
      provider: m.provider,
      model: m.model,
      baseUrl: m.baseUrl,
      hasKey: secrets().has(SECRET_PREFIX + m.provider),
      keyHint: secrets().hint(SECRET_PREFIX + m.provider),
      lastTestedAt: m.lastTestedAt,
      lastTestOk: m.lastTestOk,
      lastTestError: m.lastTestError,
      updatedAt: m.updatedAt,
    }
  }

  isConfigured(): boolean {
    return Boolean(this.meta && this.apiKey())
  }

  activeModelInfo(): ModelInfo | null {
    if (!this.meta) return null
    return modelInfo(this.meta.provider, this.meta.model)
  }

  apiKey(provider?: ProviderId): string | null {
    const p = provider ?? this.meta?.provider
    if (!p) return null
    return secrets().get(SECRET_PREFIX + p)
  }

  private adapter(provider: ProviderId): LlmAdapter {
    return adapterFor(provider)
  }

  baseUrlFor(provider: ProviderId, custom?: string) {
    const preset = presetFor(provider)
    return (custom && custom.trim()) || preset.baseUrl
  }

  async saveConnection(input: {
    provider: ProviderId
    model: string
    apiKey?: string
    baseUrl?: string
  }): Promise<ProviderConnection> {
    const provider = input.provider
    presetFor(provider)
    const apiKey = input.apiKey?.trim()
    if (apiKey) {
      secrets().set(SECRET_PREFIX + provider, apiKey)
    } else if (!secrets().has(SECRET_PREFIX + provider)) {
      throw new LlmError('Введите API-ключ — без него подключение невозможно.', 'auth')
    }
    const meta: ConnectionMeta = {
      provider,
      model: input.model,
      baseUrl: this.baseUrlFor(provider, input.baseUrl),
      updatedAt: Date.now(),
    }
    this.saveMeta(meta)
    return this.connection()!
  }

  async testConnection(input?: { provider?: ProviderId; model?: string; apiKey?: string; baseUrl?: string }): Promise<{
    ok: boolean
    models?: string[]
    error?: string
  }> {
    const provider = input?.provider ?? this.meta?.provider
    if (!provider) return { ok: false, error: 'Провайдер не выбран.' }
    const model = input?.model ?? this.meta?.model ?? presetFor(provider).models[0]?.id ?? 'default'
    const apiKey = input?.apiKey?.trim() || this.apiKey(provider)
    if (!apiKey) return { ok: false, error: 'Не указан API-ключ.' }
    const baseUrl = this.baseUrlFor(provider, input?.baseUrl ?? this.meta?.baseUrl)
    const adapter = this.adapter(provider)
    try {
      await adapter.test(apiKey, baseUrl, model)
    } catch (e) {
      const err = e as Error
      if (this.meta && this.meta.provider === provider) {
        this.saveMeta({ ...this.meta, lastTestedAt: Date.now(), lastTestOk: false, lastTestError: err.message })
      }
      return { ok: false, error: err.message }
    }
    let models: string[] | undefined
    try {
      models = adapter.listModels ? await adapter.listModels(apiKey, baseUrl) : undefined
    } catch {
      /* листинг моделей не критичен */
    }
    if (this.meta && this.meta.provider === provider) {
      this.saveMeta({ ...this.meta, lastTestedAt: Date.now(), lastTestOk: true, lastTestError: undefined })
    }
    return { ok: true, models }
  }

  async listModels(provider: ProviderId, baseUrl?: string): Promise<string[]> {
    const apiKey = this.apiKey(provider)
    if (!apiKey) throw new LlmError('Сначала сохраните API-ключ для этого провайдера.', 'auth')
    const adapter = this.adapter(provider)
    if (!adapter.listModels) return presetFor(provider).models.map((m) => m.id)
    return adapter.listModels(apiKey, this.baseUrlFor(provider, baseUrl))
  }

  async chat(req: ChatRequest): Promise<ChatResult> {
    if (!this.meta) throw new LlmError('AI не подключён. Нажмите «Подключить AI / API» и добавьте ключ.', 'auth')
    const apiKey = this.apiKey()
    if (!apiKey) throw new LlmError('API-ключ не найден. Откройте настройки и добавьте ключ заново.', 'auth')
    const meta = this.meta
    const adapter = this.adapter(meta.provider)
    const run = (withTools: boolean) =>
      adapter.streamChat(
        { ...req, tools: withTools ? req.tools : undefined, model: req.model || meta.model },
        apiKey,
        meta.baseUrl,
      )
    try {
      return await run(true)
    } catch (e) {
      const err = e as LlmError
      const mentionsTools = /tool|function|tools/i.test(err.message)
      if (req.tools?.length && err.code === 'bad_request' && mentionsTools) {
        // Модель не поддерживает function calling — продолжаем без инструментов.
        return await run(false)
      }
      throw e
    }
  }

  supportsVision(): boolean {
    const info = this.activeModelInfo()
    return Boolean(info?.supportsVision)
  }

  supportsTools(): boolean {
    const info = this.activeModelInfo()
    return Boolean(info?.supportsTools)
  }

  disconnect() {
    const provider = this.meta?.provider
    if (provider) secrets().delete(SECRET_PREFIX + provider)
    this.saveMeta(null)
  }
}
