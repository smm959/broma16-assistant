import type { Db } from '../db/index.js'
import type { KnowledgeBase } from '../kb/index.js'
import type { EmailService } from '../email/index.js'
import type { BrowserAutomation } from '../browser/automation.js'
import type { FileService } from '../files/index.js'
import type { SourceRef, AttachmentRef } from '../../shared/types.js'
import { randomUUID } from 'node:crypto'
import { readFileSync, existsSync } from 'node:fs'
import { autoLogin } from '../browser/login.js'

export type Risk = 'safe' | 'confirm'

export interface ToolContext {
  db: Db
  kb: KnowledgeBase
  email: EmailService
  browser: BrowserAutomation
  files: FileService
  settings: () => Record<string, any>
  attachments: Map<string, AttachmentRef>
  accountCredentials: () => { login: string; password: string | null }
}

export interface ToolResult {
  content: string
  sources?: SourceRef[]
  /** данные для UI (например, созданный черновик) */
  data?: unknown
}

export interface ToolDef {
  name: string
  description: string
  risk: Risk | ((args: Record<string, any>) => Risk)
  parameters: Record<string, unknown>
  title?: (args: Record<string, any>) => string
  preview?: (args: Record<string, any>, ctx: ToolContext) => {
    to?: string
    subject?: string
    body?: string
    details?: { label: string; value: string }[]
  }
  run: (args: Record<string, any>, ctx: ToolContext) => Promise<ToolResult>
}

const obj = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false,
})
const str = (description: string) => ({ type: 'string', description })

export const TOOLS: ToolDef[] = [
  /* ------------------------------- База знаний ------------------------------- */
  {
    name: 'kb_search',
    description:
      'Поиск по официальной базе знаний Broma 16 (Help Center / FAQ). Возвращает статьи с цитатами, ссылками и датой проверки. Используй ВСЕГДА, когда вопрос касается правил, процедур, отчётов, выплат, питчинга, YouTube, Content ID, лирики и т.п.',
    risk: 'safe',
    parameters: obj({ query: str('Поисковый запрос на русском или английском'), limit: { type: 'number', description: 'Сколько статей вернуть (1-8)' } }, ['query']),
    run: async (args, ctx) => {
      const hits = ctx.kb.index.search(String(args.query ?? ''), Math.min(8, Number(args.limit) || 5))
      if (!hits.length) {
        return {
          content:
            'В официальной базе Broma 16 ничего не найдено по этому запросу. Не выдумывай правила — сообщи об отсутствии статьи и предложи уточнить запрос или обратиться в поддержку.',
        }
      }
      const body = hits
        .map(
          (h, i) =>
            `### ${i + 1}. ${h.article.title}\nКатегория: ${h.article.category}\nURL: ${h.article.url}\nПроверено: ${new Date(h.article.lastVerified).toLocaleDateString('ru-RU')}\nФрагмент: ${h.article.snippet}`,
        )
        .join('\n\n')
      return {
        content: body,
        sources: hits.map((h) => ({
          title: h.article.title,
          url: h.article.url,
          kind: 'faq' as const,
          quote: h.article.snippet.slice(0, 240),
          confidence: 'high' as const,
          verifiedAt: h.article.lastVerified,
        })),
      }
    },
  },
  {
    name: 'kb_read',
    description: 'Прочитать полный текст официальной статьи Help Center по её id или URL.',
    risk: 'safe',
    parameters: obj({ id: str('id статьи из kb_search или полный URL') }, ['id']),
    run: async (args, ctx) => {
      const raw = String(args.id ?? '')
      const id = raw.includes('/') ? raw.split('/').filter(Boolean).pop() ?? raw : raw
      const article = ctx.kb.index.getArticle(id) ?? ctx.kb.index.getArticle(`faq_${id}`)
      if (!article) return { content: 'Статья не найдена в локальной базе. Попробуй kb_search или обнови базу (kb_sync).' }
      return {
        content: `# ${article.title}\nURL: ${article.url}\nКатегория: ${article.category}\nПроверено: ${new Date(article.lastVerified).toLocaleDateString('ru-RU')}\n\n${article.contentText}`,
        sources: [
          {
            title: article.title,
            url: article.url,
            kind: 'faq',
            quote: article.contentText.slice(0, 240),
            confidence: 'high',
            verifiedAt: article.lastVerified,
          },
        ],
      }
    },
  },
  {
    name: 'kb_sync',
    description: 'Обновить локальную базу знаний из официального Help Center Broma 16 (Freshdesk). Вызывай, если данных не хватает или пользователь просит проверить актуальность.',
    risk: 'safe',
    parameters: obj({}),
    run: async (_args, ctx) => {
      const status = await ctx.kb.sync()
      return {
        content: `База FAQ обновлена: ${status.articles} статей в ${status.categories} категориях. Последняя проверка: ${new Date(status.lastSync ?? Date.now()).toLocaleString('ru-RU')}.`,
        sources: [
          {
            title: 'Broma 16 Help Center',
            url: 'https://broma16nlbv.freshdesk.com/support/solutions',
            kind: 'faq',
            confidence: 'high',
            verifiedAt: Date.now(),
          },
        ],
      }
    },
  },
  {
    name: 'contacts_lookup',
    description:
      'Найти официальный контакт Broma 16 для типа вопроса (marketing, reports, payments, invoice, pr, support, content_id, youtube и т.д.). Возвращает email, отдел, статус проверки и источник.',
    risk: 'safe',
    parameters: obj({ issue_type: str('Тип вопроса, например: marketing, reports, invoice, content_id, youtube, general') }, ['issue_type']),
    run: async (args, ctx) => {
      const type = String(args.issue_type ?? '').toLowerCase()
      const rows = ctx.db.all<any>(`SELECT * FROM contacts ORDER BY verification_status`)
      const matched = rows.filter((r) => {
        const types: string[] = safeJson(r.supported_issue_types, [])
        return types.some((t) => type.includes(t) || t.includes(type)) || r.department.toLowerCase().includes(type)
      })
      const list = (matched.length ? matched : rows).map(
        (r) =>
          `- ${r.email} — ${r.department} (${r.verification_status})\n  Назначение: ${r.purpose}\n  Источник: ${r.source_url || 'не указан'}${r.last_verified ? `\n  Проверено: ${new Date(r.last_verified).toLocaleDateString('ru-RU')}` : ''}`,
      )
      const form = ctx.db.get<{ value: string }>(`SELECT value FROM kv WHERE key = 'kb.contactForm'`)?.value
      return {
        content: `Контакты Broma 16:\n${list.join('\n')}\n\nОбщая форма: ${form ?? 'https://broma16.com/ru/contact/'}\n\nВАЖНО: используй только эти адреса. Не придумывай support@, legal@, payments@ и подобные. pr@broma16.com пока UNVERIFIED — если вопрос не про прессу, используй форму.`,
        sources: matched.map((r) => ({
          title: `${r.department} — ${r.email}`,
          url: r.source_url || undefined,
          kind: 'faq' as const,
          confidence: r.verification_status === 'VERIFIED' ? ('high' as const) : ('medium' as const),
          verifiedAt: r.last_verified ?? undefined,
        })),
      }
    },
  },

  /* --------------------------------- Релизы --------------------------------- */
  {
    name: 'releases_list',
    description: 'Показать релизы пользователя из локальной базы (UPC/EAN, ISRC, дата, статус, ссылки).',
    risk: 'safe',
    parameters: obj({ query: str('Фильтр по названию/артисту (необязательно)') }),
    run: async (args, ctx) => {
      const q = String(args.query ?? '').trim().toLowerCase()
      let rows = ctx.db.all<any>(`SELECT * FROM releases ORDER BY updated_at DESC`)
      if (q) rows = rows.filter((r) => `${r.title} ${r.artist ?? ''}`.toLowerCase().includes(q))
      if (!rows.length) return { content: 'В локальной базе пока нет релизов. Их можно добавить в разделе «Мои релизы» или попросить агента сохранить данные.' }
      return {
        content: rows
          .map(
            (r) =>
              `- ${r.artist ? r.artist + ' — ' : ''}${r.title} | дата: ${r.release_date || '—'} | UPC/EAN: ${r.upc || r.ean || '—'} | ISRC: ${r.isrc || '—'} | статус: ${r.status}`,
          )
          .join('\n'),
      }
    },
  },
  {
    name: 'release_save',
    description: 'Сохранить или обновить релиз в локальной базе (название, артист, дата, UPC/EAN, ISRC, статус, ссылки).',
    risk: 'safe',
    parameters: obj({
      title: str('Название релиза'),
      artist: str('Артист'),
      release_date: str('Дата релиза в формате YYYY-MM-DD'),
      upc: str('UPC/EAN'),
      isrc: str('ISRC'),
      status: str('Статус релиза'),
      spotify_link: str('Ссылка Spotify'),
      id: str('id существующего релиза для обновления'),
    }, ['title']),
    run: async (args, ctx) => {
      const existing = args.id
        ? ctx.db.get<any>(`SELECT * FROM releases WHERE id = ?`, args.id)
        : ctx.db.get<any>(`SELECT * FROM releases WHERE lower(title) = lower(?) AND lower(coalesce(artist,'')) = lower(?)`, args.title, args.artist ?? '')
      const links: Record<string, string> = { ...(existing ? safeJson<Record<string, string>>(existing.platform_links, {}) : {}) }
      if (args.spotify_link) links.spotify = args.spotify_link
      const id = existing?.id ?? `rel_${randomUUID().slice(0, 8)}`
      if (existing) {
        ctx.db.run(
          `UPDATE releases SET title=?, artist=?, release_date=?, upc=?, isrc=?, status=?, platform_links=?, updated_at=? WHERE id=?`,
          args.title, args.artist ?? existing.artist, args.release_date ?? existing.release_date,
          args.upc ?? existing.upc, args.isrc ?? existing.isrc, args.status ?? existing.status,
          JSON.stringify(links), Date.now(), id,
        )
      } else {
        ctx.db.run(
          `INSERT INTO releases (id, artist, title, release_date, upc, ean, isrc, status, platform_links, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?)`,
          id, args.artist ?? null, args.title, args.release_date ?? null, args.upc ?? null,
          args.isrc ?? null, args.status ?? 'unknown', JSON.stringify(links), Date.now(), Date.now(),
        )
      }
      return { content: `Релиз «${args.title}» сохранён в локальной базе (id: ${id}).`, data: { id } }
    },
  },

  /* --------------------------------- Почта ---------------------------------- */
  {
    name: 'email_search',
    description: 'Найти письма в подключённом почтовом ящике (локальный индекс). Можно фильтровать только письма Broma 16.',
    risk: 'safe',
    parameters: obj({
      query: str('Текст для поиска по теме/телу/адресу'),
      broma_only: { type: 'boolean', description: 'Только письма от Broma 16' },
      limit: { type: 'number' },
    }),
    run: async (args, ctx) => {
      const msgs = ctx.email.messages({ query: args.query ? String(args.query) : undefined, bromaOnly: Boolean(args.broma_only), limit: Number(args.limit) || 20 })
      if (!msgs.length) return { content: 'Писем не найдено. Если ящик ещё не синхронизирован — вызови email_sync.' }
      return {
        content: msgs
          .map(
            (m) =>
              `- [${new Date(m.date).toLocaleString('ru-RU')}] ${m.direction === 'incoming' ? 'от' : 'кому'} ${m.from || m.to} — «${m.subject}»${m.ticketId ? ` (ticket ${m.ticketId})` : ''}${m.isBroma16 ? ' [Broma16]' : ''}\n  id: ${m.id}\n  ${m.bodyText.slice(0, 180).replace(/\s+/g, ' ')}`,
          )
          .join('\n'),
      }
    },
  },
  {
    name: 'email_read',
    description: 'Прочитать полный текст письма по id.',
    risk: 'safe',
    parameters: obj({ id: str('id письма') }, ['id']),
    run: async (args, ctx) => {
      const m = ctx.email.message(String(args.id))
      if (!m) return { content: 'Письмо не найдено.' }
      return {
        content: `От: ${m.fromName ? m.fromName + ' <' + m.from + '>' : m.from}\nКому: ${m.to}\nДата: ${new Date(m.date).toLocaleString('ru-RU')}\nТема: ${m.subject}\nОтдел: ${m.department ?? '—'}\nTicket: ${m.ticketId ?? '—'}\n\n${m.bodyText.slice(0, 12000)}`,
        sources: [{ title: m.subject, kind: 'email', confidence: 'high', verifiedAt: m.date }],
      }
    },
  },
  {
    name: 'email_sync',
    description: 'Синхронизировать входящие письма из подключённого ящика (IMAP).',
    risk: 'safe',
    parameters: obj({ account_id: str('id почтового аккаунта (необязательно)') }),
    run: async (args, ctx) => {
      const accounts = ctx.email.accounts()
      if (!accounts.length) return { content: 'Почта не подключена. Пользователю нужно подключить ящик в разделе «Почта».' }
      const account = args.account_id ? accounts.find((a) => a.id === args.account_id) : accounts[0]
      if (!account) return { content: 'Аккаунт не найден.' }
      const res = await ctx.email.sync(account.id)
      return { content: `Синхронизировано писем: ${res.added} (проверено ${res.scanned}) в ящике ${account.email}.` }
    },
  },
  {
    name: 'email_send',
    description:
      'Отправить электронное письмо от имени пользователя. ВСЕГДА требует подтверждения пользователя. Перед вызовом убедись, что адрес получателя — официальный контакт Broma 16 или адрес, который дал пользователь.',
    risk: 'confirm',
    parameters: obj(
      {
        to: str('Email получателя'),
        subject: str('Тема письма'),
        body: str('Полный текст письма (plain text)'),
        ticket_id: str('id обращения в локальной базе (если есть)'),
        account_id: str('id почтового аккаунта'),
        attachments: { type: 'array', items: { type: 'string' }, description: 'Пути к файлам для вложения' },
      },
      ['to', 'subject', 'body'],
    ),
    title: (a) => `Отправить письмо на ${a.to}`,
    preview: (a) => ({
      to: String(a.to ?? ''),
      subject: String(a.subject ?? ''),
      body: String(a.body ?? ''),
      details: a.ticket_id ? [{ label: 'Обращение', value: String(a.ticket_id) }] : [],
    }),
    run: async (args, ctx) => {
      const accounts = ctx.email.accounts()
      if (!accounts.length) return { content: 'Почта не подключена — отправить письмо невозможно. Пользователю нужно подключить ящик в разделе «Почта».' }
      const account = args.account_id ? accounts.find((a) => a.id === args.account_id) : accounts[0]
      if (!account) return { content: 'Почтовый аккаунт не найден.' }
      const attachments = Array.isArray(args.attachments)
        ? (args.attachments as string[])
            .filter((p) => typeof p === 'string' && existsSync(p))
            .map((p) => ({ filename: p.split('/').pop() ?? 'attachment', path: p }))
        : []
      const res = await ctx.email.send({
        accountId: account.id,
        to: String(args.to),
        subject: String(args.subject),
        body: String(args.body),
        attachments,
        ticketId: args.ticket_id ? String(args.ticket_id) : undefined,
      })
      return { content: `Письмо отправлено на ${args.to} с адреса ${account.email}. Message-ID: ${res.messageId}` }
    },
  },

  /* -------------------------------- Обращения -------------------------------- */
  {
    name: 'ticket_create',
    description: 'Создать локальное обращение (тикет) с темой, категорией, получателем и первым сообщением. Используется для истории и последующего follow-up.',
    risk: 'safe',
    parameters: obj(
      {
        subject: str('Тема обращения'),
        category: str('Категория: release_delivery, metadata, upc_isrc, spotify, apple_music, youtube, soundcloud, content_id, copyright, marketing, reports, payments, invoice, contract, lyrics, pr, account, technical_support, other'),
        artist: str('Артист'),
        release_id: str('id релиза'),
        recipient: str('Email получателя'),
        body: str('Текст первого сообщения'),
      },
      ['subject', 'body'],
    ),
    run: async (args, ctx) => {
      const id = `tkt_${randomUUID().slice(0, 8)}`
      ctx.db.run(
        `INSERT INTO tickets (id, subject, category, artist, release_id, recipient, status, created_at, updated_at, last_message_at)
         VALUES (?, ?, ?, ?, ?, ?, 'ready', ?, ?, ?)`,
        id, String(args.subject), String(args.category ?? 'other'), args.artist ?? null,
        args.release_id ?? null, args.recipient ?? null, Date.now(), Date.now(), Date.now(),
      )
      ctx.db.run(
        `INSERT INTO ticket_messages (id, ticket_id, direction, sender, recipient, subject, body, timestamp)
         VALUES (?, ?, 'outgoing', 'me', ?, ?, ?, ?)`,
        `tm_${randomUUID()}`, id, args.recipient ?? '', String(args.subject), String(args.body), Date.now(),
      )
      return { content: `Обращение создано (id: ${id}, тема: «${args.subject}»). Используй этот id в email_send и для follow-up.`, data: { id } }
    },
  },
  {
    name: 'tickets_list',
    description: 'Список обращений пользователя с их статусами.',
    risk: 'safe',
    parameters: obj({ status: str('Фильтр по статусу'), limit: { type: 'number' } }),
    run: async (args, ctx) => {
      const limit = Number(args.limit) || 20
      const rows = args.status
        ? ctx.db.all<any>(`SELECT * FROM tickets WHERE status = ? ORDER BY updated_at DESC LIMIT ?`, String(args.status), limit)
        : ctx.db.all<any>(`SELECT * FROM tickets ORDER BY updated_at DESC LIMIT ?`, limit)
      if (!rows.length) return { content: 'Обращений пока нет.' }
      return {
        content: rows
          .map(
            (r) =>
              `- ${r.subject} | id: ${r.id} | категория: ${r.category} | статус: ${r.status} | получатель: ${r.recipient ?? '—'} | обновлено: ${new Date(r.updated_at).toLocaleDateString('ru-RU')}${r.external_ticket_id ? ` | ticket: ${r.external_ticket_id}` : ''}`,
          )
          .join('\n'),
      }
    },
  },
  {
    name: 'followup_prepare',
    description: 'Подготовить текст повторного обращения по существующему тикету (Follow-up). Возвращает готовое письмо, но НЕ отправляет его.',
    risk: 'safe',
    parameters: obj({ ticket_id: str('id обращения'), note: str('Что добавить/уточнить') }, ['ticket_id']),
    run: async (args, ctx) => {
      const t = ctx.db.get<any>(`SELECT * FROM tickets WHERE id = ?`, args.ticket_id)
      if (!t) return { content: 'Обращение не найдено.' }
      const profile = ctx.settings()
      const last = ctx.db.get<any>(
        `SELECT * FROM ticket_messages WHERE ticket_id = ? ORDER BY timestamp DESC LIMIT 1`,
        args.ticket_id,
      )
      const subject = `Follow-up — ${t.subject}${t.external_ticket_id ? ` — #${t.external_ticket_id}` : ''}`
      const body = `Hello,\n\nI am following up on my previous request.\n\nTicket ID: ${t.external_ticket_id ?? '—'}\nDate of Previous Request: ${new Date(t.created_at).toLocaleDateString('en-GB')}\nArtist: ${t.artist ?? profile.artistName ?? '—'}\nRelease: ${t.subject}\n\n${args.note ? String(args.note) + '\n\n' : ''}The issue still remains unresolved.\n\nCould you please provide an update on the status of this request and clarify the next steps?\n\nBest regards,\n${profile.labelName || profile.accountName || ''}`
      return { content: `Готовый follow-up:\n\nTo: ${t.recipient ?? '—'}\nSubject: ${subject}\n\n${body}`, data: { to: t.recipient, subject, body, ticketId: t.id } }
    },
  },

  /* ---------------------------- Аккаунт Broma 16 ---------------------------- */
  {
    name: 'account_open',
    description:
      'Открыть личный кабинет Broma 16. Если в настройках сохранён вход, приложение само подставит логин/пароль и код из почты и попробует войти.',
    risk: 'safe',
    parameters: obj({ url: str('URL (по умолчанию портал дистрибуции)') }),
    run: async (args, ctx) => {
      const url = typeof args.url === 'string' && args.url.startsWith('http') ? args.url : undefined
      const creds = ctx.accountCredentials()
      if (creds.login && creds.password) {
        const res = await autoLogin({ browser: ctx.browser, email: ctx.email, credentials: creds }, { url, show: true })
        return {
          content: [
            `Кабинет открыт. Шаги: ${res.steps.join('; ')}.`,
            res.note,
            res.loggedIn
              ? 'Можно продолжать: прочитай страницу (account_read) и веди пользователя по задаче.'
              : 'Если нужен ручной шаг (2FA-приложение, CAPTCHA) — попроси пользователя завершить вход в открытом окне.',
          ].join('\n'),
        }
      }
      const r = await ctx.browser.open(url)
      return {
        content: `Открыт браузер: ${r.url} («${r.title}»). Сохранённого входа нет — попроси пользователя войти в открытом окне или включить «Запоминать вход» в настройках.`,
      }
    },
  },
  {
    name: 'account_autologin',
    description:
      'Открыть кабинет Broma 16 и подставить сохранённые логин/пароль (если пользователь включил «Запоминать вход»). Вход выполняется автоматически.',
    risk: 'safe',
    parameters: obj({}),
    title: () => 'Войти в кабинет Broma 16 сохранёнными данными',
    run: async (_a, ctx) => {
      const creds = ctx.accountCredentials()
      if (!creds.login || !creds.password) {
        return {
          content:
            'Сохранённого входа нет. Попроси пользователя включить «Запоминать вход» в «Настройки → Аккаунт Broma 16» и сохранить логин/пароль.',
        }
      }
      const res = await autoLogin({ browser: ctx.browser, email: ctx.email, credentials: creds }, { show: true })
      return {
        content: [`Шаги: ${res.steps.join('; ')}.`, res.note, res.loggedIn ? 'Вход выполнен.' : 'Нужен ручной шаг — попроси пользователя помочь в окне браузера.'].join('\n'),
      }
    },
  },
  {
    name: 'account_read',
    description: 'Прочитать текущую страницу личного кабинета: заголовок, текст, список ссылок. Используй после account_open, чтобы извлечь релизы, отчёты, статусы.',
    risk: 'safe',
    parameters: obj({ max_chars: { type: 'number' } }),
    run: async (args, ctx) => {
      const r = await ctx.browser.read({ maxChars: Number(args.max_chars) || 20000 })
      return {
        content: `URL: ${r.url}\nЗаголовок: ${r.title}\nВход выполнен: ${r.loggedIn ? 'похоже, да' : 'неизвестно'}\n\nТекст страницы:\n${r.text}\n\nСсылки:\n${r.links.slice(0, 40).map((l) => `- ${l.text} → ${l.href}`).join('\n')}`,
        sources: [{ title: r.title || 'Личный кабинет Broma 16', url: r.url, kind: 'account', confidence: 'medium', verifiedAt: Date.now() }],
      }
    },
  },
  {
    name: 'account_click',
    description:
      'Нажать элемент в кабинете (CSS-селектор или текст). Навигация, вкладки, «Далее», выбор типа релиза — без подтверждения. Кнопки отправки/публикации требуют подтверждения пользователя.',
    risk: (a) => (isFinalSubmit(String(a.selector_or_text ?? '')) ? 'confirm' : 'safe'),
    parameters: obj({ selector_or_text: str('CSS-селектор или видимый текст') }, ['selector_or_text']),
    title: (a) => `Нажать «${a.selector_or_text}» в аккаунте Broma 16`,
    preview: (a) => ({ details: [{ label: 'Элемент', value: String(a.selector_or_text) }] }),
    run: async (args, ctx) => {
      const r = await ctx.browser.click(String(args.selector_or_text))
      return { content: r.ok ? `Клик выполнен: ${r.note}. Прочитай страницу снова (account_read), чтобы увидеть результат.` : `Не удалось: ${r.note}` }
    },
  },
  {
    name: 'account_fill',
    description: 'Заполнить поле формы в личном кабинете. Обычные поля — без подтверждения; отправка формы (submit=true) требует подтверждения. Пароли и платёжные данные не заполнять без разрешения.',
    risk: (a) => (a.submit ? 'confirm' : 'safe'),
    parameters: obj({ selector: str('CSS-селектор поля'), value: str('Значение'), submit: { type: 'boolean' } }, ['selector', 'value']),
    title: (a) => `Заполнить поле ${a.selector} в аккаунте`,
    preview: (a) => ({ details: [{ label: 'Поле', value: String(a.selector) }, { label: 'Значение', value: String(a.value) }] }),
    run: async (args, ctx) => {
      const r = await ctx.browser.fill(String(args.selector), String(args.value), Boolean(args.submit))
      return { content: r.ok ? `Поле заполнено (${r.note}).` : `Не удалось: ${r.note}` }
    },
  },
  {
    name: 'account_file_inputs',
    description:
      'Показать поля загрузки файлов (input[type=file]) на открытой странице кабинета: номер, accept, multiple, видимость, подпись. Нужно, чтобы понять, куда прикладывать обложку и WAV.',
    risk: 'safe',
    parameters: obj({}),
    run: async (_a, ctx) => {
      const inputs = await ctx.browser.listFileInputs()
      if (!inputs.length) {
        return {
          content:
            'На текущей странице нет полей загрузки файлов. Возможно, нужен другой раздел — прочитай страницу (account_read) и перейди в форму создания релиза.',
        }
      }
      return {
        content: inputs
          .map(
            (i) =>
              `- поле №${i.index}: accept="${i.accept ?? ''}", multiple=${i.multiple ? 'да' : 'нет'}, ${i.visible ? 'видимое' : 'скрытое (открывается кнопкой)'}${i.hint ? `, подпись: ${i.hint}` : ''}`,
          )
          .join('\n'),
      }
    },
  },
  {
    name: 'account_upload_files',
    description:
      'Прикрепить файлы из вложений диалога (обложка, WAV, документы) в поле загрузки личного кабинета. Работает с обычными и скрытыми input[type=file]. Загрузка идёт без отдельного подтверждения — проверь поля через account_file_inputs.',
    risk: 'safe',
    parameters: obj(
      {
        attachment_ids: {
          type: 'array',
          items: { type: 'string' },
          description: 'id вложений из текущего диалога (из сообщения пользователя)',
        },
        input_index: { type: 'number', description: 'Номер поля загрузки (по умолчанию 0)' },
      },
      ['attachment_ids'],
    ),
    title: (a) => `Прикрепить файлы в Broma 16 (${Array.isArray(a.attachment_ids) ? a.attachment_ids.length : 0} шт.)`,
    preview: (a, ctx) => {
      const ids: string[] = Array.isArray(a.attachment_ids) ? (a.attachment_ids as string[]) : []
      const files = ids.map((id) => ctx.attachments.get(id)).filter(Boolean)
      return {
        details: [
          { label: 'Файлы', value: files.map((f) => `${f!.filename} (${Math.round(f!.size / 1024)} КБ)`).join(', ') || '—' },
          { label: 'Поле', value: `№${Number(a.input_index) || 0}` },
        ],
      }
    },
    run: async (args, ctx) => {
      const ids: string[] = Array.isArray(args.attachment_ids) ? (args.attachment_ids as string[]).map(String) : []
      const files = ids.map((id) => ctx.attachments.get(id)).filter((f): f is NonNullable<typeof f> => Boolean(f?.path))
      if (!files.length) {
        return {
          content:
            'Не найдены вложения с файлами. Попроси пользователя прикрепить обложку/WAV к сообщению в чате (скрепка или drag&drop).',
        }
      }
      const index = Math.max(0, Number(args.input_index) || 0)
      const res = await ctx.browser.uploadFiles(index, files.map((f) => f.path!))
      if (!res.ok) return { content: `Не удалось прикрепить файлы: ${res.note}` }
      return {
        content: `Файлы прикреплены в поле №${index}: ${(res.files ?? []).map((f) => f.name).join(', ')}. Дальше проверь остальные поля и НЕ отправляй форму без подтверждения.`,
        data: res,
      }
    },
  },
  {
    name: 'account_screenshot',
    description: 'Сделать скриншот текущей страницы личного кабинета и сохранить локально.',
    risk: 'safe',
    parameters: obj({}),
    run: async (_a, ctx) => {
      const r = await ctx.browser.screenshot()
      return { content: `Скриншот сохранён: ${r.path}`, data: r }
    },
  },

  /* ---------------------------------- Web ----------------------------------- */
  {
    name: 'web_fetch',
    description: 'Загрузить страницу в интернете и получить её текст. Используй для проверки актуальной информации на broma16.com и других сайтах.',
    risk: 'safe',
    parameters: obj({ url: str('HTTP(S) URL') }, ['url']),
    run: async (args) => {
      const url = String(args.url)
      if (!/^https?:\/\//i.test(url)) return { content: 'Разрешены только http(s)-URL.' }
      const res = await fetch(url, {
        headers: { 'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/138 Safari/537.36' },
        redirect: 'follow',
      })
      if (!res.ok) return { content: `Страница вернула HTTP ${res.status}.` }
      const html = await res.text()
      const text = html
        .replace(/<script[\s\S]*?<\/script>/gi, ' ')
        .replace(/<style[\s\S]*?<\/style>/gi, ' ')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&quot;/g, '"')
        .replace(/\s+/g, ' ')
        .trim()
      return {
        content: `URL: ${url}\n\n${text.slice(0, 20000)}`,
        sources: [{ title: url, url, kind: 'web', confidence: 'medium', verifiedAt: Date.now() }],
      }
    },
  },
  {
    name: 'web_search',
    description: 'Поиск в интернете (DuckDuckGo). Возвращает заголовки, ссылки и сниппеты. Используй для проверки внешних правил площадок.',
    risk: 'safe',
    parameters: obj({ query: str('Поисковый запрос') }, ['query']),
    run: async (args) => {
      const q = String(args.query)
      const res = await fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}`, {
        headers: { 'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/138 Safari/537.36' },
      })
      if (!res.ok) return { content: `Поиск недоступен (HTTP ${res.status}). Попробуй web_fetch известного URL.` }
      const html = await res.text()
      const items: { title: string; url: string; snippet: string }[] = []
      const re = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g
      let m: RegExpExecArray | null
      while ((m = re.exec(html)) && items.length < 8) {
        items.push({
          url: decodeURIComponent(m[1]!.replace(/^.*uddg=/, '').replace(/&rut=.*$/, '')),
          title: stripTags(m[2]!),
          snippet: stripTags(m[3]!),
        })
      }
      if (!items.length) return { content: 'Поиск не вернул результатов (возможно, DuckDuckGo ограничил запросы).' }
      return {
        content: items.map((i, idx) => `${idx + 1}. ${i.title}\n${i.url}\n${i.snippet}`).join('\n\n'),
        sources: items.map((i) => ({ title: i.title, url: i.url, kind: 'web' as const, quote: i.snippet.slice(0, 200), confidence: 'medium' as const })),
      }
    },
  },

  /* ------------------------------- Память ---------------------------------- */
  {
    name: 'memory_set',
    description: 'Запомнить важный факт о пользователе, артисте, релизе или процессе (например: «лейбл Music 959», «UPC 123…», «любимый жанр»).',
    risk: 'safe',
    parameters: obj({ scope: str('scope: user | artist | release | process'), key: str('Ключ'), value: str('Значение') }, ['scope', 'key', 'value']),
    run: async (args, ctx) => {
      ctx.db.run(
        `INSERT INTO memory_facts (id, scope, key, value, updated_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
        `mem_${args.scope}_${args.key}`,
        String(args.scope),
        String(args.key),
        String(args.value),
        Date.now(),
      )
      return { content: `Запомнено: ${args.scope}/${args.key} = ${args.value}` }
    },
  },
  {
    name: 'memory_get',
    description: 'Прочитать сохранённые факты (память).',
    risk: 'safe',
    parameters: obj({ scope: str('Фильтр по scope') }),
    run: async (args, ctx) => {
      const rows = args.scope
        ? ctx.db.all<any>(`SELECT * FROM memory_facts WHERE scope = ? ORDER BY updated_at DESC`, String(args.scope))
        : ctx.db.all<any>(`SELECT * FROM memory_facts ORDER BY updated_at DESC LIMIT 100`)
      if (!rows.length) return { content: 'Память пуста.' }
      return { content: rows.map((r) => `- [${r.scope}] ${r.key}: ${r.value}`).join('\n') }
    },
  },
  {
    name: 'file_read',
    description: 'Прочитать загруженный пользователем документ (PDF, DOCX, XLSX, CSV, TXT) по id вложения.',
    risk: 'safe',
    parameters: obj({ attachment_id: str('id вложения') }, ['attachment_id']),
    run: async (args, ctx) => {
      const att = ctx.attachments.get(String(args.attachment_id))
      if (!att) return { content: 'Вложение не найдено в текущем диалоге.' }
      if (att.kind === 'image') return { content: `Это изображение (${att.filename}). Оно уже передано модели для визуального анализа.` }
      if (att.extractedText) return { content: `Документ «${att.filename}»:\n\n${att.extractedText.slice(0, 40000)}` }
      if (att.path && existsSync(att.path)) {
        const text = await ctx.files.extractText(att.path, att.mimeType)
        att.extractedText = text
        return { content: `Документ «${att.filename}»:\n\n${text.slice(0, 40000)}` }
      }
      return { content: 'Не удалось прочитать файл.' }
    },
  },
  {
    name: 'export_text',
    description: 'Сохранить подготовленный текст (письмо, план, отчёт) в файл в папке документов приложения и вернуть путь.',
    risk: 'safe',
    parameters: obj({ filename: str('Имя файла, например promo-plan.md'), content: str('Содержимое') }, ['filename', 'content']),
    run: async (args, ctx) => {
      const path = ctx.files.exportText(String(args.filename || 'broma16-document.txt'), String(args.content ?? ''))
      return { content: `Файл сохранён: ${path}`, data: { path } }
    },
  },
]

export function toolMap(): Map<string, ToolDef> {
  return new Map(TOOLS.map((t) => [t.name, t]))
}

/** Кнопки, которые отправляют релиз/форму на модерацию — их жмём только после подтверждения. */
export function isFinalSubmit(text: string): boolean {
  return /(отправ\w*|опублик\w*|на релиз|на модерац\w*|submit|publish|send|finish|complete|заверш\w*|подтверд\w* релиз)/i.test(
    text,
  )
}

function stripTags(html: string) {
  return html.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/\s+/g, ' ').trim()
}

function safeJson<T>(v: unknown, fallback: T): T {
  try {
    return typeof v === 'string' ? (JSON.parse(v) as T) : fallback
  } catch {
    return fallback
  }
}
