import { marked } from 'marked'
import DOMPurify from 'dompurify'

marked.setOptions({ gfm: true, breaks: true })

export function mdToHtml(text: string): string {
  const html = marked.parse(text ?? '', { async: false }) as string
  return DOMPurify.sanitize(html, {
    ADD_ATTR: ['target', 'rel'],
    FORBID_TAGS: ['style', 'iframe', 'form', 'input', 'script'],
  })
}

export function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)
}

export function timeAgo(ts?: number): string {
  if (!ts) return '—'
  const diff = Date.now() - ts
  const min = Math.floor(diff / 60000)
  if (min < 1) return 'только что'
  if (min < 60) return `${min} мин назад`
  const h = Math.floor(min / 60)
  if (h < 24) return `${h} ч назад`
  const d = Math.floor(h / 24)
  if (d < 7) return `${d} дн назад`
  return new Date(ts).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' })
}

export function fmtDate(ts?: number, withTime = false): string {
  if (!ts) return '—'
  return new Date(ts).toLocaleString('ru-RU', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    ...(withTime ? { hour: '2-digit', minute: '2-digit' } : {}),
  })
}

export function fmtBytes(n: number): string {
  if (n < 1024) return `${n} Б`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} КБ`
  return `${(n / 1024 / 1024).toFixed(1)} МБ`
}

export const CATEGORY_LABELS: Record<string, string> = {
  release_delivery: 'Доставка релиза',
  metadata: 'Метаданные',
  upc_isrc: 'UPC / ISRC',
  spotify: 'Spotify',
  apple_music: 'Apple Music',
  youtube: 'YouTube',
  soundcloud: 'SoundCloud',
  content_id: 'Content ID',
  copyright: 'Авторские права',
  marketing: 'Маркетинг',
  reports: 'Отчёты',
  payments: 'Выплаты',
  invoice: 'Инвойс',
  contract: 'Договор',
  lyrics: 'Тексты песен',
  pr: 'PR',
  account: 'Аккаунт',
  technical_support: 'Техподдержка',
  other: 'Другое',
}

export const STATUS_LABELS: Record<string, string> = {
  draft: 'Черновик',
  ready: 'Готово к отправке',
  sent: 'Отправлено',
  awaiting_reply: 'Ждём ответ',
  answered: 'Ответ получен',
  resolved: 'Решено',
  closed: 'Закрыто',
}
