import { readFileSync } from 'node:fs'
import { extname } from 'node:path'
import type { Db } from '../db/index.js'
import type { ProviderId } from '../../shared/types.js'
import { secrets } from '../security/secrets.js'
import { adapterFor } from './adapters.js'
import { presetFor } from './presets.js'
import { LlmError } from './types.js'

export interface VisionConfig {
  provider: ProviderId
  model: string
  baseUrl?: string
  updatedAt: number
}

const KV_KEY = 'llm.vision'
const SECRET_PREFIX = 'llm:vision:'
const MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp',
}

const PROMPT = `Ты — визуальный ассистент музыкального менеджера. Опиши изображение по-русски, кратко и по делу:
1) что это: обложка релиза, скриншот кабинета/статистики, фото артиста, документ или иное;
2) весь видимый текст дословно (для скриншотов важны заголовки, названия полей, ошибки, даты, числа, UPC/ISRC, названия релизов);
3) если это обложка — стиль, цвета, композиция, читаемость названия и артиста, что можно улучшить для стриминговых площадок;
4) если скриншот — что за страница, какие действия доступны, на что жалуется интерфейс.
Не выдумывай того, чего не видно. Если текст нечитаем — так и скажи.`

/** Отдельная модель для картинок: основной чат может быть текстовым (DeepSeek), а vision — Gemini/OpenAI/Claude. */
export class VisionService {
  constructor(private readonly db: Db) {}

  config(): VisionConfig | null {
    const row = this.db.get<{ value: string }>(`SELECT value FROM kv WHERE key = ?`, KV_KEY)
    if (!row) return null
    try {
      const parsed = JSON.parse(row.value) as VisionConfig
      return parsed.provider && parsed.model ? parsed : null
    } catch {
      return null
    }
  }

  /** Ключ: отдельный для vision, иначе переиспользуем ключ этого провайдера из основного подключения. */
  private key(provider: ProviderId): string | null {
    return secrets().get(SECRET_PREFIX + provider) ?? secrets().get('llm:' + provider)
  }

  hasKey(provider: ProviderId): boolean {
    return Boolean(this.key(provider))
  }

  hint(provider: ProviderId): string | undefined {
    return secrets().hint(SECRET_PREFIX + provider) ?? secrets().hint('llm:' + provider)
  }

  save(input: { provider: ProviderId; model: string; apiKey?: string; baseUrl?: string }): VisionConfig {
    if (!input.provider || !input.model?.trim()) throw new Error('Выберите провайдера и модель для изображений.')
    presetFor(input.provider)
    if (input.apiKey?.trim()) secrets().set(SECRET_PREFIX + input.provider, input.apiKey.trim())
    const cfg: VisionConfig = {
      provider: input.provider,
      model: input.model.trim(),
      baseUrl: input.baseUrl?.trim() || undefined,
      updatedAt: Date.now(),
    }
    this.db.run(
      `INSERT INTO kv(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      KV_KEY,
      JSON.stringify(cfg),
    )
    return cfg
  }

  clear() {
    const cfg = this.config()
    if (cfg) secrets().delete(SECRET_PREFIX + cfg.provider)
    this.db.run(`DELETE FROM kv WHERE key = ?`, KV_KEY)
  }

  async describeImage(path: string, mimeType: string, hint?: string): Promise<string> {
    const cfg = this.config()
    if (!cfg) throw new LlmError('Модель для анализа изображений не подключена.', 'auth')
    const key = this.key(cfg.provider)
    if (!key) throw new LlmError(`Для vision-модели ${presetFor(cfg.provider).name} не сохранён ключ.`, 'auth')
    const base64 = readFileSync(path).toString('base64')
    const mime = mimeType || MIME[extname(path).toLowerCase()] || 'image/png'
    const instruction = hint
      ? `${PROMPT}\n\nЗапрос пользователя, на который нужно обратить внимание: ${hint.slice(0, 600)}`
      : PROMPT
    const res = await adapterFor(cfg.provider).streamChat(
      {
        model: cfg.model,
        maxTokens: 1200,
        temperature: 0.2,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: instruction },
              { type: 'image', mimeType: mime, dataBase64: base64 },
            ],
          },
        ],
      },
      key,
      cfg.baseUrl || presetFor(cfg.provider).baseUrl,
    )
    const text = res.text?.trim()
    if (!text) throw new LlmError('Vision-модель вернула пустое описание.', 'unknown')
    return text
  }

  async test(): Promise<{ ok: boolean; error?: string; sample?: string }> {
    const cfg = this.config()
    if (!cfg) return { ok: false, error: 'Сначала сохраните провайдера и модель.' }
    const key = this.key(cfg.provider)
    if (!key) return { ok: false, error: 'Не найден API-ключ для выбранного провайдера.' }
    try {
      // 1×1 пиксель — достаточно, чтобы проверить поддержку изображений и ключ.
      const png =
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
      const res = await adapterFor(cfg.provider).streamChat(
        {
          model: cfg.model,
          maxTokens: 20,
          messages: [
            {
              role: 'user',
              content: [
                { type: 'text', text: 'Что на картинке? Ответь одним словом.' },
                { type: 'image', mimeType: 'image/png', dataBase64: png },
              ],
            },
          ],
        },
        key,
        cfg.baseUrl || presetFor(cfg.provider).baseUrl,
      )
      return { ok: true, sample: res.text.slice(0, 120) }
    } catch (e) {
      return { ok: false, error: (e as Error).message }
    }
  }
}
