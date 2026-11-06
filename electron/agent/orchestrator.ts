import { randomUUID } from 'node:crypto'
import type { Db } from '../db/index.js'
import type { ProviderManager } from '../llm/manager.js'
import type { LlmMessage, ToolCall } from '../llm/types.js'
import { LlmError } from '../llm/types.js'
import type { KnowledgeBase } from '../kb/index.js'
import type { EmailService } from '../email/index.js'
import type { BrowserAutomation } from '../browser/automation.js'
import type { FileService } from '../files/index.js'
import type { VisionService } from '../llm/vision.js'
import type {
  ActivityEvent,
  AttachmentRef,
  ChatMessage,
  Conversation,
  PendingAction,
  SourceRef,
} from '../../shared/types.js'
import { TOOLS, toolMap, type ToolContext, type ToolDef, type ToolResult } from './tools.js'
import { secrets } from '../security/secrets.js'
import { buildSystemPrompt, readSettings } from './prompt.js'

export interface AgentDeps {
  db: Db
  llm: ProviderManager
  kb: KnowledgeBase
  email: EmailService
  browser: BrowserAutomation
  files: FileService
  vision: VisionService
}

export interface AgentEvents {
  delta: (conversationId: string, messageId: string, text: string) => void
  message: (message: ChatMessage) => void
  activity: (event: ActivityEvent) => void
  action: (action: PendingAction) => void
  runtime: (state: { running: boolean; conversationId?: string; phase?: string; currentActivity?: string }) => void
  conversations: () => void
}

const TOOL_LABELS: Record<string, string> = {
  kb_search: 'Ищу в официальном FAQ Broma 16',
  kb_read: 'Читаю статью Help Center',
  kb_sync: 'Обновляю базу знаний Broma 16',
  contacts_lookup: 'Определяю нужный отдел Broma 16',
  releases_list: 'Проверяю данные релизов',
  release_save: 'Сохраняю данные релиза',
  email_search: 'Ищу письма в ящике',
  email_read: 'Читаю письмо',
  email_sync: 'Синхронизирую почту',
  email_send: 'Готовлю отправку письма',
  ticket_create: 'Создаю обращение',
  tickets_list: 'Проверяю историю обращений',
  followup_prepare: 'Готовлю повторное обращение',
  account_open: 'Открываю личный кабинет Broma 16',
  account_read: 'Проверяю данные в личном кабинете',
  account_click: 'Выполняю действие в кабинете',
  account_fill: 'Заполняю форму в кабинете',
  account_screenshot: 'Делаю скриншот кабинета',
  web_fetch: 'Проверяю информацию на сайте',
  web_search: 'Ищу информацию в интернете',
  memory_set: 'Запоминаю важные данные',
  memory_get: 'Проверяю память',
  file_read: 'Читаю документ',
  export_text: 'Сохраняю файл',
}

const MAX_STEPS = 120
const HISTORY_MESSAGES = 40
const TOOL_RESULT_LIMIT = 24_000

export class AgentOrchestrator {
  private running = new Set<string>()
  private controllers = new Map<string, AbortController>()
  private autoContinues = new Map<string, number>()
  private runStartedAt = new Map<string, number>()
  private activitySeq = 0

  constructor(
    private readonly deps: AgentDeps,
    private readonly events: AgentEvents,
  ) {}

  /* ------------------------------ диалоги ------------------------------ */

  listConversations(): Conversation[] {
    return this.deps.db
      .all<any>(`SELECT * FROM conversations ORDER BY pinned DESC, updated_at DESC LIMIT 100`)
      .map((r) => ({ id: r.id, title: r.title, createdAt: r.created_at, updatedAt: r.updated_at, pinned: Boolean(r.pinned) }))
  }

  ensureConversation(id?: string): Conversation {
    if (id) {
      const row = this.deps.db.get<any>(`SELECT * FROM conversations WHERE id = ?`, id)
      if (row) return { id: row.id, title: row.title, createdAt: row.created_at, updatedAt: row.updated_at, pinned: Boolean(row.pinned) }
    }
    const conv: Conversation = { id: `conv_${randomUUID().slice(0, 8)}`, title: 'Новый диалог', createdAt: Date.now(), updatedAt: Date.now() }
    this.deps.db.run(`INSERT INTO conversations (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)`, conv.id, conv.title, conv.createdAt, conv.updatedAt)
    this.events.conversations()
    return conv
  }

  renameConversation(id: string, title: string) {
    this.deps.db.run(`UPDATE conversations SET title = ?, updated_at = ? WHERE id = ?`, title.slice(0, 120), Date.now(), id)
    this.events.conversations()
  }

  deleteConversation(id: string) {
    this.deps.db.run(
      `DELETE FROM chat_attachments WHERE message_id IN (SELECT id FROM messages WHERE conversation_id = ?)`,
      id,
    )
    this.deps.db.run(`DELETE FROM conversations WHERE id = ?`, id)
    this.deps.db.run(`DELETE FROM messages WHERE conversation_id = ?`, id)
    this.deps.db.run(`DELETE FROM activity_events WHERE conversation_id = ?`, id)
    this.events.conversations()
  }

  messages(conversationId: string): ChatMessage[] {
    return this.deps.db
      .all<any>(`SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at LIMIT 500`, conversationId)
      .filter((r) => r.role !== 'tool')
      .filter((r) => r.role !== 'assistant' || String(r.content ?? '').trim())
      .map((r) => ({
        id: r.id,
        conversationId: r.conversation_id,
        role: r.role,
        content: r.content,
        createdAt: r.created_at,
        toolName: r.tool_name ?? undefined,
        error: r.error ?? undefined,
        sources: r.sources ? JSON.parse(r.sources) : undefined,
        attachments: this.attachmentsFor(r.id),
      }))
  }

  private attachmentsFor(messageId: string): AttachmentRef[] | undefined {
    const rows = this.deps.db.all<any>(`SELECT * FROM chat_attachments WHERE message_id = ?`, messageId)
    if (!rows.length) return undefined
    return rows.map((r) => ({
      id: r.id,
      filename: r.filename,
      mimeType: r.mime_type,
      size: r.size,
      kind: r.kind,
      path: r.path ?? undefined,
      extractedText: r.extracted_text ?? undefined,
    }))
  }

  activity(conversationId?: string): ActivityEvent[] {
    const rows = conversationId
      ? this.deps.db.all<any>(`SELECT * FROM activity_events WHERE conversation_id = ? ORDER BY created_at DESC LIMIT 200`, conversationId)
      : this.deps.db.all<any>(`SELECT * FROM activity_events ORDER BY created_at DESC LIMIT 200`)
    return rows.map((r) => ({
      id: r.id,
      conversationId: r.conversation_id ?? undefined,
      kind: r.kind,
      title: r.title,
      detail: r.detail ?? undefined,
      tool: r.tool ?? undefined,
      createdAt: r.created_at,
      durationMs: r.duration_ms ?? undefined,
    }))
  }

  private logActivity(conversationId: string | undefined, kind: ActivityEvent['kind'], title: string, opts: { detail?: string; tool?: string; durationMs?: number } = {}) {
    const event: ActivityEvent = {
      id: `act_${Date.now()}_${this.activitySeq++}`,
      conversationId,
      kind,
      title,
      detail: opts.detail,
      tool: opts.tool,
      createdAt: Date.now(),
      durationMs: opts.durationMs,
    }
    this.deps.db.run(
      `INSERT INTO activity_events (id, conversation_id, kind, title, detail, tool, created_at, duration_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      event.id, conversationId ?? null, kind, title, opts.detail ?? null, opts.tool ?? null, event.createdAt, opts.durationMs ?? null,
    )
    this.events.activity(event)
  }

  /* ------------------------------ сообщения ------------------------------ */

  async sendUserMessage(input: { conversationId?: string; text: string; attachments?: AttachmentRef[] }): Promise<{ conversationId: string; message: ChatMessage }> {
    const conv = this.ensureConversation(input.conversationId)
    this.autoContinues.delete(conv.id)
    this.runStartedAt.set(conv.id, Date.now())
    const msgId = `msg_${randomUUID().slice(0, 10)}`
    const createdAt = Date.now()
    this.deps.db.run(`INSERT INTO messages (id, conversation_id, role, content, created_at) VALUES (?, ?, 'user', ?, ?)`, msgId, conv.id, input.text, createdAt)
    for (const a of input.attachments ?? []) {
      this.deps.db.run(
        `INSERT INTO chat_attachments (id, message_id, filename, mime_type, size, kind, path, extracted_text, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        a.id, msgId, a.filename, a.mimeType, a.size, a.kind, a.path ?? null, a.extractedText ?? null, createdAt,
      )
    }
    if (conv.title === 'Новый диалог') {
      this.renameConversation(conv.id, input.text.slice(0, 60) || 'Новый диалог')
    }
    this.deps.db.run(`UPDATE conversations SET updated_at = ? WHERE id = ?`, createdAt, conv.id)
    const message: ChatMessage = {
      id: msgId, conversationId: conv.id, role: 'user', content: input.text, createdAt,
      attachments: input.attachments,
    }
    this.events.message(message)
    this.events.conversations()
    void this.run(conv.id)
    return { conversationId: conv.id, message }
  }

  stop(conversationId?: string) {
    if (conversationId) {
      this.controllers.get(conversationId)?.abort()
      return
    }
    for (const c of this.controllers.values()) c.abort()
  }

  isRunning(conversationId?: string) {
    return conversationId ? this.running.has(conversationId) : this.running.size > 0
  }

  /* -------------------------------- агент -------------------------------- */

  async run(conversationId: string): Promise<void> {
    if (this.running.has(conversationId)) return
    this.lastSources = []
    if (!this.deps.llm.isConfigured()) {
      this.postAssistant(conversationId, 'AI ещё не подключён. Нажмите «Подключить AI / API» в правом верхнем углу, выберите провайдера и вставьте ключ — после этого я смогу работать.', { error: 'no-provider' })
      return
    }
    this.running.add(conversationId)
    const controller = new AbortController()
    this.controllers.set(conversationId, controller)
    this.events.runtime({ running: true, conversationId, phase: 'thinking', currentActivity: 'Анализирую задачу' })
    this.logActivity(conversationId, 'thinking', 'Анализирую задачу и контекст')

    let finished = false
    try {
      for (let step = 0; step < MAX_STEPS; step++) {
        const messages = await this.buildHistory(conversationId)
        const system = buildSystemPrompt(
          this.deps.db,
          this.deps.kb.status(),
          { hasVision: this.deps.llm.supportsVision(), hasTools: this.deps.llm.supportsTools() },
          conversationId,
        )
        const streamId = `msg_${randomUUID().slice(0, 10)}`
        let streamed = ''
        this.events.runtime({ running: true, conversationId, phase: 'thinking', currentActivity: step === 0 ? 'Думаю над ответом' : 'Продолжаю работу' })

        let result
        try {
          result = await this.deps.llm.chat({
            model: this.deps.llm.connection()?.model ?? '',
            messages: [{ role: 'system', content: system }, ...messages],
            tools: this.deps.llm.supportsTools() ? TOOLS.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters })) : undefined,
            signal: controller.signal,
            onText: (delta) => {
              streamed += delta
              this.events.delta(conversationId, streamId, delta)
            },
          })
        } catch (e) {
          if (controller.signal.aborted) {
            this.postAssistant(conversationId, 'Остановлено. Продолжим, когда будете готовы.')
            return
          }
          const err = e as LlmError
          this.postAssistant(conversationId, this.formatError(err), { error: err.message })
          this.logActivity(conversationId, 'error', 'Ошибка при обращении к AI', { detail: err.message })
          return
        }

        const text = result.text || streamed
        const calls = result.toolCalls ?? []

        // Сохраняем сообщение ассистента (с tool calls, если есть)
        if (text.trim() || calls.length) {
          const sourcesJson = this.lastSources.length ? JSON.stringify(this.lastSources) : null
          this.deps.db.run(
            `INSERT INTO messages (id, conversation_id, role, content, created_at, tool_calls, sources) VALUES (?, ?, 'assistant', ?, ?, ?, ?)`,
            streamId, conversationId, text, Date.now(), calls.length ? JSON.stringify(calls) : null, sourcesJson,
          )
          this.events.message({
            id: streamId, conversationId, role: 'assistant', content: text, createdAt: Date.now(),
            sources: this.lastSources,
          })
          this.deps.db.run(`UPDATE conversations SET updated_at = ? WHERE id = ?`, Date.now(), conversationId)
        }

        if (!calls.length) {
          finished = true
          break
        }

        let stopped = false
        for (let i = 0; i < calls.length; i++) {
          const call = calls[i]!
          const def = toolMap().get(call.name)
          const args = parseArgs(call.arguments)

          if (!def) {
            this.saveToolResult(conversationId, call, `Неизвестный инструмент: ${call.name}`)
            continue
          }

          if (stopped) {
            this.saveToolResult(conversationId, call, 'Не выполнено: ожидает подтверждения предыдущего действия.')
            continue
          }

          const risk = typeof def.risk === 'function' ? def.risk(args) : def.risk
          if (risk === 'confirm') {
            const action = this.createPendingAction(conversationId, def, args, call)
            this.saveToolResult(conversationId, call, `ОЖИДАЕТ ПОДТВЕРЖДЕНИЯ ПОЛЬЗОВАТЕЛЯ: ${def.title?.(args) ?? def.name}. Ответ пользователю будет дан после его решения.`, action.id)
            stopped = true
            this.logActivity(conversationId, 'approval', 'Жду подтверждения действия', { detail: action.title, tool: def.name })
            continue
          }

          const started = Date.now()
          this.logActivity(conversationId, 'tool', TOOL_LABELS[call.name] ?? `Выполняю ${call.name}`, { tool: call.name })
          try {
            const res = await this.runTool(def, args, this.toolContext(conversationId))
            this.lastSources = res.sources ?? []
            const content = res.content.length > TOOL_RESULT_LIMIT ? res.content.slice(0, TOOL_RESULT_LIMIT) + '\n…[обрезано]' : res.content
            this.saveToolResult(conversationId, call, content)
            this.logActivity(conversationId, 'success', this.resultSummary(call.name, res.content), {
              tool: call.name,
              detail: res.content.slice(0, 400),
              durationMs: Date.now() - started,
            })
            if (res.sources?.length) {
              this.logActivity(conversationId, 'source', 'Найден официальный источник', {
                detail: res.sources.map((s) => s.title).join('; ').slice(0, 300),
                tool: call.name,
              })
            }
          } catch (e) {
            const message = (e as Error).message
            this.saveToolResult(conversationId, call, `ОШИБКА: ${message}`)
            this.logActivity(conversationId, 'error', `Не удалось: ${TOOL_LABELS[call.name] ?? call.name}`, {
              detail: message,
              tool: call.name,
              durationMs: Date.now() - started,
            })
          }
        }

        if (stopped) {
          this.events.runtime({ running: false, conversationId, phase: 'awaiting_user', currentActivity: 'Ожидаю подтверждения' })
          return
        }
      }
      if (!finished) {
        // Не просим пользователя «продолжай»: продолжаем сами, пока не упрёмся
        // в финальную кнопку, реальный блокер или общий лимит времени.
        const used = this.autoContinues.get(conversationId) ?? 0
        const elapsed = Date.now() - (this.runStartedAt.get(conversationId) ?? Date.now())
        if (used < 6 && elapsed < 15 * 60_000) {
          this.autoContinues.set(conversationId, used + 1)
          this.logActivity(conversationId, 'thinking', 'Продолжаю работу с того же места')
          setTimeout(() => void this.run(conversationId), 400)
        } else {
          this.autoContinues.delete(conversationId)
          this.postAssistant(
            conversationId,
            'Остановился: задача очень длинная (лимит шагов/времени). Форма сохранена — напишите «продолжай», и я продолжу с этого места.',
          )
        }
      }
    } finally {
      this.controllers.delete(conversationId)
      this.running.delete(conversationId)
      this.events.runtime({ running: this.running.size > 0, conversationId, phase: 'idle' })
    }
  }

  private lastSources: SourceRef[] = []

  private async buildHistory(conversationId: string): Promise<LlmMessage[]> {
    const rows = this.deps.db.all<any>(
      `SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at DESC LIMIT ?`,
      conversationId,
      HISTORY_MESSAGES,
    ).reverse()

    // История не должна начинаться с tool-сообщения без предшествующего assistant/tool_calls.
    while (rows.length && rows[0].role === 'tool') rows.shift()

    const out: LlmMessage[] = []
    let budget = 90_000
    const recentUserIds = rows.filter((r) => r.role === 'user').slice(-2).map((r) => r.id)

    for (const r of rows) {
      if (budget <= 0) break
      let content: string = r.content ?? ''
      if (r.role === 'tool') {
        content = content.slice(0, 12_000)
        budget -= content.length
        out.push({ role: 'tool', toolCallId: r.tool_call_id ?? '', name: r.tool_name ?? 'tool', content })
        continue
      }
      if (r.role === 'assistant') {
        budget -= content.length
        out.push({ role: 'assistant', content, toolCalls: r.tool_calls ? JSON.parse(r.tool_calls) : undefined })
        continue
      }
      budget -= content.length
      const atts = this.attachmentsFor(r.id) ?? []
      const imageParts = recentUserIds.includes(r.id)
        ? atts.filter((a) => a.kind === 'image' && a.path)
        : []
      const docText = atts
        .filter((a) => a.kind === 'document' && a.extractedText)
        .map((a) => `\n\n[Вложение «${a.filename}»]\n${String(a.extractedText).slice(0, 12_000)}`)
        .join('')
      const audioText = atts
        .filter((a) => a.kind === 'audio')
        .map(
          (a) =>
            `\n\n[Аудиофайл «${a.filename}» приложен. Его можно прикрепить в кабинет инструментом account_upload_files (attachment_id: ${a.id}).]`,
        )
        .join('')

      if (imageParts.length && this.deps.llm.supportsVision()) {
        const parts: any[] = [{ type: 'text', text: content + docText + audioText }]
        for (const img of imageParts.slice(0, 4)) {
          try {
            const b64 = this.deps.files.base64ForVision(img.path!)
            parts.push({ type: 'image', mimeType: b64.mimeType, dataBase64: b64.dataBase64 })
          } catch {
            /* пропускаем битые файлы */
          }
        }
        out.push({ role: 'user', content: parts })
      } else {
        const visionText = await this.describeImages(atts, recentUserIds.includes(r.id), content)
        out.push({ role: 'user', content: content + docText + audioText + visionText })
      }
    }

    // Если предыдущее выполнение прервалось, у assistant.tool_calls может не быть ответов —
    // подставляем заглушки, иначе провайдер отвергает всю историю.
    const fixed: LlmMessage[] = []
    for (let i = 0; i < out.length; i++) {
      const m = out[i]!
      fixed.push(m)
      if (m.role === 'assistant' && m.toolCalls?.length) {
        const missing = new Set(m.toolCalls.map((c) => c.id))
        while (i + 1 < out.length && out[i + 1]!.role === 'tool') {
          const t = out[++i] as Extract<LlmMessage, { role: 'tool' }>
          fixed.push(t)
          missing.delete(t.toolCallId)
        }
        for (const id of missing) {
          fixed.push({ role: 'tool', toolCallId: id, name: 'tool', content: 'Не выполнено: выполнение прервалось (таймаут или перезапуск приложения).' })
        }
      }
    }
    return fixed
  }

  /**
   * Если основная модель текстовая (DeepSeek), изображения описывает отдельная
   * vision-модель, а результат кэшируется в chat_attachments.extracted_text.
   */
  /** Инструмент не должен подвешивать диалог: ограничиваем выполнение по времени. */
  private async runTool(def: ToolDef, args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const timeoutMs = def.timeoutMs ?? 60_000
    let timer: NodeJS.Timeout | undefined
    try {
      return await Promise.race([
        def.run(args, ctx),
        new Promise<ToolResult>((_, reject) => {
          timer = setTimeout(
            () =>
              reject(
                new Error(
                  `Инструмент не ответил за ${Math.round((def.timeoutMs ?? 60_000) / 1000)} секунд — похоже, страница кабинета зависла. Переоткрой кабинет (account_open) и повтори действие.`,
                ),
              ),
            timeoutMs,
          )
        }),
      ])
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  private async describeImages(atts: AttachmentRef[], allowNew: boolean, hint: string): Promise<string> {
    const images = atts.filter((a) => a.kind === 'image' && a.path)
    if (!images.length) return ''
    const chunks: string[] = []
    for (const img of images.slice(0, 4)) {
      const cached = (img.extractedText ?? '').trim()
      if (cached.length > 20) {
        chunks.push(`[Изображение «${img.filename}»]\n${cached.slice(0, 3000)}`)
        continue
      }
      if (!allowNew) continue
      const vision = this.deps.vision
      if (!vision.config()) {
        chunks.push(
          `[Изображение «${img.filename}»: анализ недоступен — vision-модель не подключена. Скажи пользователю открыть «Настройки → AI → Анализ изображений» и подключить Gemini/OpenAI/Claude. WAV и файлы при этом можно прикреплять в кабинет.]`,
        )
        continue
      }
      try {
        const text = await vision.describeImage(img.path!, img.mimeType, hint)
        this.deps.db.run(`UPDATE chat_attachments SET extracted_text = ? WHERE id = ?`, text.slice(0, 8000), img.id)
        chunks.push(`[Изображение «${img.filename}», анализ vision-модели]\n${text.slice(0, 3000)}`)
        this.logActivity(undefined, 'success', `Проанализировал изображение «${img.filename}»`, { tool: 'vision' })
      } catch (e) {
        chunks.push(`[Не удалось проанализировать изображение «${img.filename}»: ${(e as Error).message}]`)
      }
    }
    return chunks.length ? '\n\n' + chunks.join('\n\n') : ''
  }

  private toolContext(conversationId: string): ToolContext {
    const atts = new Map<string, AttachmentRef>()
    for (const m of this.messages(conversationId)) {
      for (const a of m.attachments ?? []) atts.set(a.id, a)
    }
    return {
      db: this.deps.db,
      kb: this.deps.kb,
      email: this.deps.email,
      browser: this.deps.browser,
      files: this.deps.files,
      settings: () => readSettings(this.deps.db),
      attachments: atts,
      accountCredentials: () => ({
        login: readSettings(this.deps.db).accountLogin ?? '',
        password: secrets().get('broma:password'),
      }),
      vision: this.deps.vision,
      conversationId,
    }
  }

  private saveToolResult(conversationId: string, call: ToolCall, content: string, actionId?: string) {
    const id = `msg_${randomUUID().slice(0, 10)}`
    this.deps.db.run(
      `INSERT INTO messages (id, conversation_id, role, content, created_at, tool_name, tool_call_id) VALUES (?, ?, 'tool', ?, ?, ?, ?)`,
      id, conversationId, content, Date.now(), call.name, call.id,
    )
    if (actionId) {
      this.deps.db.run(`UPDATE pending_actions SET placeholder_id = ? WHERE id = ?`, id, actionId)
    }
  }

  private postAssistant(conversationId: string, text: string, opts: { error?: string; sources?: SourceRef[] } = {}) {
    const id = `msg_${randomUUID().slice(0, 10)}`
    this.deps.db.run(
      `INSERT INTO messages (id, conversation_id, role, content, created_at, error, sources) VALUES (?, ?, 'assistant', ?, ?, ?, ?)`,
      id, conversationId, text, Date.now(), opts.error ?? null, opts.sources ? JSON.stringify(opts.sources) : null,
    )
    this.events.message({
      id, conversationId, role: 'assistant', content: text, createdAt: Date.now(),
      error: opts.error, sources: opts.sources,
    })
  }

  private formatError(err: LlmError): string {
    if (err.code === 'auth') return `🔑 ${err.message}`
    if (err.code === 'quota') return `💳 ${err.message}`
    if (err.code === 'rate_limit') return `⏳ ${err.message}`
    return `⚠️ ${err.message}`
  }

  /* ------------------------------ действия ------------------------------ */

  private createPendingAction(conversationId: string, def: ToolDef, args: Record<string, unknown>, call: ToolCall): PendingAction {
    const id = `act_${randomUUID().slice(0, 8)}`
    const action: PendingAction = {
      id,
      conversationId,
      tool: def.name,
      title: def.title?.(args) ?? def.name,
      description: def.description,
      risk: 'confirm',
      params: { ...args, __callId: call.id },
      preview: def.preview?.(args, this.toolContext(conversationId)),
      status: 'pending',
      createdAt: Date.now(),
    }
    this.deps.db.run(
      `INSERT INTO pending_actions (id, conversation_id, tool, title, description, risk, params, preview, status, created_at) VALUES (?, ?, ?, ?, ?, 'confirm', ?, ?, 'pending', ?)`,
      id, conversationId, action.tool, action.title, action.description, JSON.stringify(action.params), JSON.stringify(action.preview ?? {}), action.createdAt,
    )
    this.events.action(action)
    return action
  }

  actions(conversationId?: string): PendingAction[] {
    const rows = conversationId
      ? this.deps.db.all<any>(`SELECT * FROM pending_actions WHERE conversation_id = ? ORDER BY created_at DESC LIMIT 50`, conversationId)
      : this.deps.db.all<any>(`SELECT * FROM pending_actions ORDER BY created_at DESC LIMIT 50`)
    return rows.map((r) => this.mapAction(r))
  }

  private mapAction(r: any): PendingAction {
    return {
      id: r.id,
      conversationId: r.conversation_id ?? undefined,
      tool: r.tool,
      title: r.title,
      description: r.description,
      risk: r.risk,
      params: safeParse(r.params, {}),
      preview: safeParse(r.preview, undefined),
      status: r.status,
      createdAt: r.created_at,
      result: r.result ?? undefined,
      error: r.error ?? undefined,
    }
  }

  async approve(actionId: string): Promise<{ ok: boolean; error?: string }> {
    const row = this.deps.db.get<any>(`SELECT * FROM pending_actions WHERE id = ?`, actionId)
    if (!row) return { ok: false, error: 'Действие не найдено' }
    if (row.status !== 'pending') return { ok: false, error: `Действие уже ${row.status}` }
    const action = this.mapAction(row)
    const def = toolMap().get(action.tool)
    if (!def) return { ok: false, error: 'Инструмент не найден' }

    this.deps.db.run(`UPDATE pending_actions SET status = 'executing' WHERE id = ?`, actionId)
    this.events.action({ ...action, status: 'executing' })

    const started = Date.now()
    try {
      const { __callId, ...args } = action.params as any
      const res = await this.runTool(def, args, this.toolContext(action.conversationId ?? ''))
      this.deps.db.run(`UPDATE pending_actions SET status = 'done', result = ? WHERE id = ?`, res.content.slice(0, 4000), actionId)
      const placeholder = this.deps.db.get<any>(`SELECT placeholder_id FROM pending_actions WHERE id = ?`, actionId)
      if (placeholder?.placeholder_id) {
        this.deps.db.run(`UPDATE messages SET content = ? WHERE id = ?`, res.content, placeholder.placeholder_id)
      }
      if (action.conversationId) {
        this.deps.db.run(
          `UPDATE messages SET content = ?
           WHERE conversation_id = ? AND role = 'tool'
             AND content LIKE 'Не выполнено: ожидает подтверждения%'
             AND created_at >= ?`,
          'Не выполнено: действие уже выполнено отдельно. Проверь результат через account_read и продолжай.',
          action.conversationId,
          Date.now() - 15 * 60_000,
        )
      }
      this.logActivity(action.conversationId, 'success', `Выполнено: ${action.title}`, {
        detail: res.content.slice(0, 400),
        tool: action.tool,
        durationMs: Date.now() - started,
      })
      this.events.action({ ...action, status: 'done', result: res.content })
      if (action.conversationId) void this.run(action.conversationId)
      return { ok: true }
    } catch (e) {
      const message = (e as Error).message
      this.deps.db.run(`UPDATE pending_actions SET status = 'failed', error = ? WHERE id = ?`, message, actionId)
      const placeholder = this.deps.db.get<any>(`SELECT placeholder_id FROM pending_actions WHERE id = ?`, actionId)
      if (placeholder?.placeholder_id) {
        this.deps.db.run(`UPDATE messages SET content = ? WHERE id = ?`, `ОШИБКА при выполнении: ${message}`, placeholder.placeholder_id)
      }
      this.logActivity(action.conversationId, 'error', `Не удалось выполнить: ${action.title}`, { detail: message, tool: action.tool })
      this.events.action({ ...action, status: 'failed', error: message })
      return { ok: false, error: message }
    }
  }

  reject(actionId: string): { ok: boolean } {
    const row = this.deps.db.get<any>(`SELECT * FROM pending_actions WHERE id = ?`, actionId)
    if (!row || row.status !== 'pending') return { ok: false }
    this.deps.db.run(`UPDATE pending_actions SET status = 'rejected' WHERE id = ?`, actionId)
    const placeholder = this.deps.db.get<any>(`SELECT placeholder_id FROM pending_actions WHERE id = ?`, actionId)
    if (placeholder?.placeholder_id) {
      this.deps.db.run(
        `UPDATE messages SET content = ? WHERE id = ?`,
        'ПОЛЬЗОВАТЕЛЬ ОТКЛОНИЛ ДЕЙСТВИЕ. Не выполняй его, предложи альтернативу.',
        placeholder.placeholder_id,
      )
    }
    // Снимаем «зависшие» отложенные результаты того же шага, иначе модель видит
    // «ожидает подтверждения» уже после отказа и снова останавливается.
    if (row.conversation_id) {
      this.deps.db.run(
        `UPDATE messages SET content = ?
         WHERE conversation_id = ? AND role = 'tool'
           AND content LIKE 'Не выполнено: ожидает подтверждения%'
           AND created_at >= ?`,
        'Не выполнено: пользователь отклонил связанное действие. Продолжай без него.',
        row.conversation_id,
        Date.now() - 15 * 60_000,
      )
    }
    const action = this.mapAction(row)
    this.events.action({ ...action, status: 'rejected' })
    this.logActivity(action.conversationId, 'warning', 'Действие отклонено пользователем', { detail: action.title })
    if (action.conversationId) void this.run(action.conversationId)
    return { ok: true }
  }

  private resultSummary(tool: string, content: string): string {
    const first = content.split('\n').find((l) => l.trim()) ?? ''
    const clean = first.replace(/[#*`]/g, '').slice(0, 120)
    if (tool === 'kb_search') return 'Нашёл статьи в FAQ Broma 16'
    if (tool === 'kb_sync') return 'База FAQ обновлена'
    if (tool === 'email_sync') return 'Почта синхронизирована'
    if (tool === 'email_send') return 'Письмо отправлено'
    if (tool === 'account_read') return 'Данные кабинета получены'
    if (tool === 'web_search') return 'Поиск выполнен'
    return clean || 'Готово'
  }
}

function parseArgs(raw: string): Record<string, unknown> {
  if (!raw) return {}
  try {
    const parsed = JSON.parse(raw)
    return typeof parsed === 'object' && parsed ? parsed : {}
  } catch {
    return {}
  }
}

function safeParse<T>(raw: unknown, fallback: T): T {
  try {
    if (typeof raw !== 'string' || !raw) return fallback
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}
