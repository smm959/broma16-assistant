import { ImapFlow } from 'imapflow'
import nodemailer from 'nodemailer'
import { simpleParser } from 'mailparser'
import { randomUUID } from 'node:crypto'
import type { Db } from '../db/index.js'
import type { EmailAccount, EmailMessage } from '../../shared/types.js'
import { secrets } from '../security/secrets.js'

const SECRET_PREFIX = 'email:'

export const EMAIL_PRESETS = [
  {
    id: 'gmail',
    name: 'Gmail / Google Workspace',
    imapHost: 'imap.gmail.com',
    imapPort: 993,
    smtpHost: 'smtp.gmail.com',
    smtpPort: 465,
    hint: 'Нужен «пароль приложения» Google (2FA обязательна). OAuth-подключение появится позже.',
  },
  {
    id: 'yandex',
    name: 'Яндекс Почта',
    imapHost: 'imap.yandex.ru',
    imapPort: 993,
    smtpHost: 'smtp.yandex.ru',
    smtpPort: 465,
    hint: 'Включите доступ по IMAP в настройках почты и создайте пароль приложения.',
  },
  {
    id: 'mailru',
    name: 'Mail.ru',
    imapHost: 'imap.mail.ru',
    imapPort: 993,
    smtpHost: 'smtp.mail.ru',
    smtpPort: 465,
    hint: 'Используйте пароль для внешних приложений.',
  },
  {
    id: 'outlook',
    name: 'Outlook / Microsoft 365',
    imapHost: 'outlook.office365.com',
    imapPort: 993,
    smtpHost: 'smtp.office365.com',
    smtpPort: 587,
    hint: 'Microsoft может требовать OAuth — при ошибке входа используйте пароль приложения или другой ящик.',
  },
  {
    id: 'custom',
    name: 'Другой IMAP/SMTP',
    imapHost: '',
    imapPort: 993,
    smtpHost: '',
    smtpPort: 465,
    hint: 'Укажите серверы вашего почтового провайдера вручную.',
  },
]

const BROMA_DEPARTMENTS: Record<string, string> = {
  'marketing@broma16.com': 'Marketing / Pitching',
  'reports@broma16.com': 'Reports / Payments',
  'pr@broma16.com': 'PR',
  'support@broma16.com': 'Support',
  'info@broma16.com': 'General',
  'hello@broma16.com': 'General',
  'legal@broma16.com': 'Legal',
}

export function departmentForAddress(address: string): string | undefined {
  const clean = address.toLowerCase().trim()
  if (BROMA_DEPARTMENTS[clean]) return BROMA_DEPARTMENTS[clean]
  const m = /^([a-z0-9._-]+)@broma16\.com$/.exec(clean)
  if (m) return `Broma16 / ${m[1]}`
  return undefined
}

export function extractTicketId(text: string): string | undefined {
  const patterns = [
    /\[#?(\d{4,})\]/,
    /(?:ticket|тикет|заявк[аи]|request)\s*(?:id|#|№)?\s*[:#]?\s*(\d{4,})/i,
    /(?:^|\s)#(\d{5,})(?:\s|$)/,
  ]
  for (const re of patterns) {
    const m = re.exec(text)
    if (m?.[1]) return m[1]
  }
  return undefined
}

const CATEGORY_RULES: [string, RegExp][] = [
  ['invoice', /invoice|инвойс|счет|счёт/i],
  ['payments', /payment|payout|выплат|роялти|royalt|bank|банк/i],
  ['reports', /report|отчёт|отчет|statement|statistic|статистик/i],
  ['marketing', /marketing|pitch|промо|promo|маркетинг|playlist|плейлист/i],
  ['content_id', /content id|content-id|claim|заявк[аи] на видео|whitelist|страйк|strike/i],
  ['copyright', /copyright|авторск|infring|нарушен/i],
  ['release_delivery', /delivery|доставк|release|релиз|spotify|apple music|soundcloud|tiktok/i],
  ['pr', /press|pr\b|interview|интервью|пресс/i],
  ['account', /account|аккаунт|login|вход|verification|верификац/i],
  ['metadata', /metadata|метадан|artwork|обложк|title|назван/i],
  ['support', /support|поддержк|ticket|тикет|issue|проблем/i],
]

export function classifyEmail(subject: string, body: string, department?: string): string {
  const haystack = `${subject}\n${body.slice(0, 4000)}`
  // Сначала содержание: тема письма точнее отдела-отправителя.
  for (const [category, re] of CATEGORY_RULES) if (re.test(haystack)) return category
  if (department) {
    const d = department.toLowerCase()
    if (d.includes('marketing')) return 'marketing'
    if (d.includes('report')) return 'reports'
    if (d.includes('payment')) return 'payments'
    if (d.includes('pr')) return 'pr'
    if (d.includes('legal')) return 'copyright'
    if (d.includes('support')) return 'support'
  }
  return 'general'
}

export interface SyncResult {
  added: number
  total: number
  accounts: number
  errors: string[]
}

export class EmailService {
  constructor(private readonly db: Db) {}

  accounts(): EmailAccount[] {
    return this.db.all<any>(`SELECT * FROM email_accounts ORDER BY created_at`).map((r) => this.toAccount(r))
  }

  private toAccount(r: any): EmailAccount {
    return {
      id: r.id,
      label: r.label,
      email: r.email,
      provider: r.provider,
      imapHost: r.imap_host,
      imapPort: r.imap_port,
      imapSecure: Boolean(r.imap_secure),
      smtpHost: r.smtp_host,
      smtpPort: r.smtp_port,
      smtpSecure: Boolean(r.smtp_secure),
      username: r.username,
      hasPassword: secrets().has(SECRET_PREFIX + r.id),
      lastSyncAt: r.last_sync_at ?? undefined,
      status: r.status,
      lastError: r.last_error ?? undefined,
    }
  }

  account(id: string): EmailAccount | null {
    const r = this.db.get<any>(`SELECT * FROM email_accounts WHERE id = ?`, id)
    return r ? this.toAccount(r) : null
  }

  async saveAccount(input: {
    id?: string
    label: string
    email: string
    username?: string
    imapHost: string
    imapPort: number
    smtpHost: string
    smtpPort: number
    password?: string
    provider?: 'gmail' | 'imap'
  }): Promise<EmailAccount> {
    const id = input.id ?? `acc_${randomUUID().slice(0, 8)}`
    const secure = input.imapPort === 993 ? 1 : 0
    const smtpSecure = input.smtpPort === 465 ? 1 : 0
    if (input.password) secrets().set(SECRET_PREFIX + id, input.password)

    const existing = this.db.get<any>(`SELECT id FROM email_accounts WHERE id = ?`, id)
    if (existing) {
      this.db.run(
        `UPDATE email_accounts SET label=?, email=?, username=?, imap_host=?, imap_port=?, imap_secure=?, smtp_host=?, smtp_port=?, smtp_secure=?, provider=?, status='connected', last_error=NULL WHERE id=?`,
        input.label,
        input.email,
        input.username || input.email,
        input.imapHost,
        input.imapPort,
        secure,
        input.smtpHost,
        input.smtpPort,
        smtpSecure,
        input.provider ?? 'imap',
        id,
      )
    } else {
      this.db.run(
        `INSERT INTO email_accounts (id, label, email, provider, imap_host, imap_port, imap_secure, smtp_host, smtp_port, smtp_secure, username, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'connected', ?)`,
        id,
        input.label,
        input.email,
        input.provider ?? 'imap',
        input.imapHost,
        input.imapPort,
        secure,
        input.smtpHost,
        input.smtpPort,
        smtpSecure,
        input.username || input.email,
        Date.now(),
      )
    }
    return this.account(id)!
  }

  deleteAccount(id: string) {
    secrets().delete(SECRET_PREFIX + id)
    this.db.run(`DELETE FROM email_accounts WHERE id = ?`, id)
    this.db.run(`DELETE FROM email_messages WHERE account_id = ?`, id)
  }

  private client(accountId: string): { account: EmailAccount; password: string; client: ImapFlow } {
    const account = this.account(accountId)
    if (!account) throw new Error('Почтовый аккаунт не найден.')
    const password = secrets().get(SECRET_PREFIX + accountId)
    if (!password) throw new Error('Пароль почты не найден в хранилище секретов. Переподключите аккаунт.')
    const client = new ImapFlow({
      host: account.imapHost,
      port: account.imapPort,
      secure: account.imapSecure,
      auth: { user: account.username, pass: password },
      logger: false,
      socketTimeout: 30_000,
    })
    return { account, password, client }
  }

  async test(accountId: string): Promise<{ imap: string; smtp: string }> {
    const { account, password, client } = this.client(accountId)
    const result = { imap: 'не проверено', smtp: 'не проверено' }
    try {
      await client.connect()
      result.imap = 'OK'
      await client.logout()
    } catch (e) {
      result.imap = `ошибка: ${(e as Error).message}`
      this.markError(accountId, (e as Error).message)
    }
    try {
      const transport = nodemailer.createTransport({
        host: account.smtpHost,
        port: account.smtpPort,
        secure: account.smtpSecure,
        auth: { user: account.username, pass: password },
      })
      await transport.verify()
      result.smtp = 'OK'
      this.db.run(`UPDATE email_accounts SET status='connected', last_error=NULL WHERE id=?`, accountId)
    } catch (e) {
      result.smtp = `ошибка: ${(e as Error).message}`
      this.markError(accountId, (e as Error).message)
    }
    return result
  }

  private markError(accountId: string, message: string) {
    this.db.run(`UPDATE email_accounts SET status='error', last_error=? WHERE id=?`, message, accountId)
  }

  async sync(accountId: string, limit = 80): Promise<{ added: number; scanned: number }> {
    const { account, client } = this.client(accountId)
    await client.connect()
    let added = 0
    let scanned = 0
    try {
      const mailboxes = await client.list()
      const inbox = mailboxes.find((m) => m.path.toUpperCase() === 'INBOX') || mailboxes.find((m) => m.specialUse === '\\Inbox')
      if (!inbox) throw new Error('Не удалось найти папку INBOX.')
      const lock = await client.getMailboxLock(inbox.path)
      try {
        const mailbox = client.mailbox
        const exists = typeof mailbox === 'object' ? mailbox.exists : 0
        const start = Math.max(1, exists - limit + 1)
        if (exists > 0) {
          for await (const msg of client.fetch(`${start}:*`, { uid: true, source: true, flags: true })) {
            scanned++
            try {
              const parsed = await simpleParser(msg.source as Buffer)
              this.storeParsed(account, String(msg.uid), inbox.path, parsed, msg.flags)
              added++
            } catch {
              /* пропускаем битые письма */
            }
          }
        }
      } finally {
        lock.release()
      }
      this.db.run(`UPDATE email_accounts SET last_sync_at=?, status='connected', last_error=NULL WHERE id=?`, Date.now(), accountId)
    } finally {
      await client.logout().catch(() => undefined)
    }
    return { added, scanned }
  }

  private storeParsed(account: EmailAccount, uid: string, folder: string, parsed: any, flags?: Set<string>) {
    const fromAddr = parsed.from?.value?.[0]?.address ?? ''
    const fromName = parsed.from?.value?.[0]?.name ?? ''
    const toAddr = Array.isArray(parsed.to) ? parsed.to.map((t: any) => t.text).join(', ') : parsed.to?.text ?? ''
    const subject = parsed.subject ?? '(без темы)'
    const date = parsed.date ? new Date(parsed.date).getTime() : Date.now()
    const text = (parsed.text ?? '').slice(0, 100_000)
    const html = typeof parsed.html === 'string' ? parsed.html.slice(0, 400_000) : ''
    const dept = departmentForAddress(fromAddr)
    const category = classifyEmail(subject, text, dept)
    const isBroma = Boolean(dept) || /broma\s*16/i.test(fromAddr) || /broma16/i.test(text.slice(0, 4000))
    const ticketId = extractTicketId(subject) ?? extractTicketId(text.slice(0, 6000))
    const attachments = (parsed.attachments ?? []).map((a: any) => ({
      filename: a.filename ?? 'attachment',
      size: a.size ?? 0,
      mimeType: a.contentType ?? 'application/octet-stream',
    }))
    const flagList = flags ? [...flags] : []

    this.db.run(
      `INSERT INTO email_messages (id, account_id, uid, folder, direction, sender, sender_name, recipient, subject, body_text, body_html, date, ticket_id, department, category, is_broma16, flags, attachments, created_at)
       VALUES (?, ?, ?, ?, 'incoming', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(account_id, folder, uid) DO UPDATE SET
         body_text = excluded.body_text,
         flags = excluded.flags,
         category = excluded.category`,
      `em_${account.id}_${uid}`,
      account.id,
      uid,
      folder,
      fromAddr,
      fromName,
      toAddr,
      subject,
      text,
      html,
      date,
      ticketId ?? null,
      dept ?? null,
      category,
      isBroma ? 1 : 0,
      JSON.stringify(flagList),
      JSON.stringify(attachments),
      Date.now(),
    )

    // Автоматически привязываем письмо к обращению по Ticket ID или адресу/теме
    if (ticketId) {
      const ticket = this.db.get<any>(
        `SELECT id FROM tickets WHERE external_ticket_id = ? OR subject LIKE ? ORDER BY created_at DESC LIMIT 1`,
        ticketId,
        `%${ticketId}%`,
      )
      if (ticket) {
        this.db.run(`UPDATE email_messages SET ticket_id=? WHERE id=?`, ticket.id, `em_${account.id}_${uid}`)
        this.db.run(
          `INSERT OR IGNORE INTO ticket_messages (id, ticket_id, direction, sender, recipient, subject, body, timestamp, message_id, email_message_id)
           VALUES (?, ?, 'incoming', ?, ?, ?, ?, ?, ?, ?)`,
          `tm_${randomUUID()}`,
          ticket.id,
          fromAddr,
          toAddr,
          subject,
          text,
          date,
          parsed.messageId ?? null,
          `em_${account.id}_${uid}`,
        )
        this.db.run(`UPDATE tickets SET status='answered', last_message_at=?, updated_at=? WHERE id=?`, date, Date.now(), ticket.id)
      }
    } else if (isBroma) {
      this.db.run(`UPDATE email_messages SET ticket_id = NULL WHERE id = ?`, `em_${account.id}_${uid}`)
    }
  }

  messages(opts: { query?: string; bromaOnly?: boolean; limit?: number; accountId?: string } = {}): EmailMessage[] {
    const where: string[] = []
    const params: unknown[] = []
    if (opts.bromaOnly) where.push('is_broma16 = 1')
    if (opts.accountId) {
      where.push('account_id = ?')
      params.push(opts.accountId)
    }
    if (opts.query) {
      where.push('(subject LIKE ? OR body_text LIKE ? OR sender LIKE ?)')
      const q = `%${opts.query}%`
      params.push(q, q, q)
    }
    const sql = `SELECT * FROM email_messages ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY date DESC LIMIT ?`
    params.push(opts.limit ?? 100)
    return this.db.all<any>(sql, ...params).map((r) => this.toMessage(r))
  }

  message(id: string): EmailMessage | null {
    const r = this.db.get<any>(`SELECT * FROM email_messages WHERE id = ?`, id)
    return r ? this.toMessage(r) : null
  }

  private toMessage(r: any): EmailMessage {
    return {
      id: r.id,
      accountId: r.account_id,
      uid: r.uid,
      folder: r.folder,
      direction: r.direction,
      from: r.sender ?? '',
      fromName: r.sender_name ?? undefined,
      to: r.recipient ?? '',
      subject: r.subject ?? '',
      bodyText: r.body_text ?? '',
      bodyHtml: r.body_html ?? undefined,
      date: r.date,
      ticketId: r.ticket_id ?? undefined,
      department: r.department ?? undefined,
      category: r.category ?? undefined,
      isBroma16: Boolean(r.is_broma16),
      flags: safeJson(r.flags, []),
      attachments: safeJson(r.attachments, []),
    }
  }

  async send(input: {
    accountId: string
    to: string
    cc?: string
    subject: string
    body: string
    attachments?: { filename: string; path: string }[]
    ticketId?: string
  }): Promise<{ messageId: string; accepted: string[] }> {
    const account = this.account(input.accountId)
    if (!account) throw new Error('Аккаунт почты не выбран.')
    const password = secrets().get(SECRET_PREFIX + account.id)
    if (!password) throw new Error('Пароль почты не найден. Переподключите аккаунт.')

    const transport = nodemailer.createTransport({
      host: account.smtpHost,
      port: account.smtpPort,
      secure: account.smtpSecure,
      auth: { user: account.username, pass: password },
    })
    const info = await transport.sendMail({
      from: `"${account.label}" <${account.email}>`,
      to: input.to,
      cc: input.cc,
      subject: input.subject,
      text: input.body,
      attachments: input.attachments?.map((a) => ({ filename: a.filename, path: a.path })),
    })
    const messageId = info.messageId ?? `local_${randomUUID()}`

    this.db.run(
      `INSERT INTO email_messages (id, account_id, uid, folder, direction, sender, sender_name, recipient, subject, body_text, body_html, date, ticket_id, department, is_broma16, flags, attachments, created_at)
       VALUES (?, ?, ?, 'SENT', 'outgoing', ?, ?, ?, ?, ?, '', ?, ?, NULL, ?, '[]', ?, ?)`,
      `em_out_${randomUUID()}`,
      account.id,
      messageId,
      account.email,
      account.label,
      input.to,
      input.subject,
      input.body,
      Date.now(),
      input.ticketId ?? null,
      input.to.toLowerCase().includes('broma16') ? 1 : 0,
      JSON.stringify(input.attachments ?? []),
      Date.now(),
    )

    if (input.ticketId) {
      this.db.run(
        `INSERT INTO ticket_messages (id, ticket_id, direction, sender, recipient, subject, body, timestamp, message_id)
         VALUES (?, ?, 'outgoing', ?, ?, ?, ?, ?, ?)`,
        `tm_${randomUUID()}`,
        input.ticketId,
        account.email,
        input.to,
        input.subject,
        input.body,
        Date.now(),
        messageId,
      )
      this.db.run(
        `UPDATE tickets SET status='awaiting_reply', updated_at=?, last_message_at=? WHERE id=?`,
        Date.now(),
        Date.now(),
        input.ticketId,
      )
    }

    return { messageId, accepted: (info.accepted ?? []).map(String) }
  }
}

function safeJson<T>(value: unknown, fallback: T): T {
  try {
    if (typeof value !== 'string') return fallback
    return JSON.parse(value) as T
  } catch {
    return fallback
  }
}
