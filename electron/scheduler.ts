import { Notification, app } from 'electron'
import type { Services } from './services.js'

const EMAIL_INTERVAL_MS = 10 * 60 * 1000
const FAQ_INTERVAL_MS = 24 * 60 * 60 * 1000
const FAQ_STALE_MS = 7 * 24 * 60 * 60 * 1000

/**
 * Фоновая автоматика: проверка почты, напоминания о follow-up, обновление FAQ.
 * Работает, пока приложение свёрнуто в трей. Ничего не отправляет без пользователя.
 */
export class Scheduler {
  private timers: NodeJS.Timeout[] = []
  private lastNotified = new Map<string, number>()

  constructor(
    private readonly svc: Services,
    private readonly focusWindow: () => void,
  ) {}

  start() {
    setTimeout(() => void this.syncMail(true), 12_000)
    setTimeout(() => void this.refreshFaqIfStale(), 20_000)
    setTimeout(() => this.checkFollowUps(), 15_000)

    this.timers.push(setInterval(() => void this.syncMail(false), EMAIL_INTERVAL_MS))
    this.timers.push(setInterval(() => void this.checkFollowUps(), 6 * 60 * 60 * 1000))
    this.timers.push(setInterval(() => void this.refreshFaqIfStale(), FAQ_INTERVAL_MS))
    this.timers.push(
      setInterval(() => {
        const now = Date.now()
        for (const [key, ts] of this.lastNotified) if (now - ts > 24 * 60 * 60 * 1000) this.lastNotified.delete(key)
      }, 60 * 60 * 1000),
    )
  }

  stop() {
    for (const t of this.timers) clearInterval(t)
    this.timers = []
  }

  private notify(title: string, body: string, key: string) {
    if (this.lastNotified.has(key)) return
    this.lastNotified.set(key, Date.now())
    if (Notification.isSupported()) {
      const n = new Notification({ title, body, silent: false })
      n.on('click', () => this.focusWindow())
      n.show()
    }
    this.svc.emit('event:notify', { title, body })
  }

  private async syncMail(silent: boolean) {
    const accounts = this.svc.email.accounts().filter((a) => a.hasPassword)
    if (!accounts.length) return
    for (const account of accounts) {
      const before = this.svc.db.get<{ c: number }>(
        `SELECT COUNT(*) AS c FROM email_messages WHERE account_id = ? AND is_broma16 = 1`,
        account.id,
      )?.c ?? 0
      try {
        const res = await this.svc.email.sync(account.id, silent ? 30 : 60)
        const after = this.svc.db.get<{ c: number }>(
          `SELECT COUNT(*) AS c FROM email_messages WHERE account_id = ? AND is_broma16 = 1`,
          account.id,
        )?.c ?? 0
        if (after > before) {
          const latest = this.svc.db.get<any>(
            `SELECT subject, sender, ticket_id FROM email_messages WHERE account_id = ? AND is_broma16 = 1 ORDER BY date DESC LIMIT 1`,
            account.id,
          )
          this.notify(
            'Broma 16 — новое письмо',
            `${latest?.sender ?? 'Поддержка'}: ${latest?.subject ?? ''}`.slice(0, 160),
            `mail:${latest?.subject}:${latest?.sender}`,
          )
        }
        if (res.added) this.svc.emit('event:email-sync', { accountId: account.id })
      } catch (e) {
        this.svc.db.run(
          `UPDATE email_accounts SET status='error', last_error=? WHERE id=?`,
          (e as Error).message,
          account.id,
        )
      }
    }
    this.checkFollowUps()
  }

  private checkFollowUps() {
    const days = Number(this.svc.settings().autoFollowUpDays ?? 14) || 14
    const cutoff = Date.now() - days * 86_400_000
    const due = this.svc.db.all<any>(
      `SELECT id, subject, last_message_at FROM tickets
       WHERE status IN ('sent','awaiting_reply') AND COALESCE(last_message_at, created_at) < ?`,
      cutoff,
    )
    if (!due.length) return
    this.svc.emit('event:followup-due', {
      count: due.length,
      tickets: due.map((t) => ({ id: t.id, subject: t.subject, lastMessageAt: t.last_message_at })),
    })
    this.notify(
      'Пора напомнить о себе',
      `По ${due.length} обращени${due.length === 1 ? 'ю' : 'ям'} нет ответа больше ${days} дней`,
      `followup:${new Date().toISOString().slice(0, 10)}`,
    )
  }

  private async refreshFaqIfStale() {
    const status = this.svc.kb.status()
    if (status.syncing) return
    if (status.lastSync && Date.now() - status.lastSync < FAQ_STALE_MS) return
    try {
      const next = await this.svc.kb.sync()
      this.svc.emit('event:kb-status', next)
    } catch {
      /* тихая ошибка — повторим позже */
    }
  }
}

export function initScheduler(svc: Services, focusWindow: () => void) {
  if (!app.isReady()) return null
  const scheduler = new Scheduler(svc, focusWindow)
  scheduler.start()
  return scheduler
}
