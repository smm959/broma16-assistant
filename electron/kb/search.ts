import type { Db } from '../db/index.js'
import type { FaqArticle } from '../../shared/types.js'

const STOP_WORDS = new Set(
  'и в во не что он на я с со как а то все она так его но да ты к у же вы за бы по только ее мне было вот от меня еще нет о из ему теперь когда даже ну ли если уже или ни быть был него до вас нибудь опять уж вам ведь там потом себя ничего ей может они тут где есть надо ней для мы тебя их чем была сам чтоб без будто чего раз тоже себе под будет ж тогда кто этот того потому этого какой совсем ним здесь этом один почти мой тем чтобы нее сейчас были куда зачем всех никогда можно при наконец два об другой хоть после над больше тот через эти нас про всего них какая много разве три эту моя впрочем хорошо свою этой перед иногда лучше чуть том нельзя такой им более всегда конечно всю между это the a an and or of to in for on with is are was were be been this that these those how what when where who why can could should would do does did i you he she it we they my your our their'.split(
    ' ',
  ),
)

export function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function stem(token: string): string {
  // Очень лёгкий стеммер: русские окончания и английские плюралы.
  let t = token
  if (t.length > 5) {
    t = t.replace(/(иями|ями|ами|ого|ему|ому|ыми|ими|ая|яя|ое|ее|ые|ие|ой|ей|ий|ый|ов|ев|ам|ям|ах|ях|ом|ем|ум|юм|а|я|ы|и|о|е|у|ю|ь)$/, '')
  }
  if (t.length > 4) t = t.replace(/(ies|ing|ed|es|s)$/, '')
  return t.length >= 3 ? t : token
}

export function tokenize(text: string): string[] {
  return normalize(text)
    .split(' ')
    .filter((t) => t.length > 1 && !STOP_WORDS.has(t))
    .map(stem)
}

interface Doc {
  id: string
  title: string
  url: string
  category: string
  text: string
  weight: Record<string, number>
  length: number
}

export interface SearchHit {
  article: {
    id: string
    title: string
    category: string
    url: string
    snippet: string
    lastVerified: number
  }
  score: number
}

export class FaqIndex {
  private docs: Doc[] = []
  private df = new Map<string, number>()
  private avgLen = 1
  private builtAt = 0

  constructor(private readonly db: Db) {}

  rebuild() {
    const rows = this.db.all<{
      id: string
      title: string
      category: string
      content_text: string
      url: string
      last_verified: number
    }>(
      `SELECT id, title, category, content_text, url, last_verified FROM faq_articles ORDER BY last_verified DESC`,
    )
    this.docs = rows.map((r) => {
      const titleTokens = tokenize(r.title)
      const bodyTokens = tokenize(r.content_text)
      const weight: Record<string, number> = {}
      for (const t of titleTokens) weight[t] = (weight[t] ?? 0) + 4
      for (const t of bodyTokens) weight[t] = (weight[t] ?? 0) + 1
      return {
        id: r.id,
        title: r.title,
        url: r.url,
        category: r.category,
        text: r.content_text,
        weight,
        length: titleTokens.length + bodyTokens.length,
      }
    })
    this.df.clear()
    for (const d of this.docs) {
      for (const term of Object.keys(d.weight)) this.df.set(term, (this.df.get(term) ?? 0) + 1)
    }
    this.avgLen = this.docs.reduce((s, d) => s + d.length, 0) / Math.max(1, this.docs.length)
    this.verifyCache.clear()
    this.builtAt = Date.now()
  }

  get size() {
    return this.docs.length
  }

  search(query: string, limit = 5): SearchHit[] {
    if (!this.docs.length) this.rebuild()
    const qTokens = [...new Set(tokenize(query))]
    if (!qTokens.length) return []
    const N = this.docs.length
    const k1 = 1.4
    const b = 0.72

    const scored = this.docs.map((d) => {
      let score = 0
      for (const t of qTokens) {
        const tf = d.weight[t]
        if (!tf) continue
        const df = this.df.get(t) ?? 0
        const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5))
        score += idf * ((tf * (k1 + 1)) / (tf + k1 * (1 - b + b * (d.length / this.avgLen))))
      }
      // Бонус за точное вхождение фразы в заголовок
      const normTitle = normalize(d.title)
      if (query.trim() && normTitle.includes(normalize(query))) score += 6
      return { d, score }
    })

    return scored
      .filter((s) => s.score > 0)
      .sort((a, b2) => b2.score - a.score)
      .slice(0, limit)
      .map(({ d, score }) => ({
        score: Math.round(score * 100) / 100,
        article: {
          id: d.id,
          title: d.title,
          category: d.category,
          url: d.url,
          snippet: snippet(d.text, qTokens),
          lastVerified: this.lastVerified(d.id),
        },
      }))
  }

  private verifyCache = new Map<string, number>()
  private lastVerified(id: string): number {
    const cached = this.verifyCache.get(id)
    if (cached) return cached
    const row = this.db.get<{ last_verified: number }>(`SELECT last_verified FROM faq_articles WHERE id = ?`, id)
    const v = row?.last_verified ?? 0
    this.verifyCache.set(id, v)
    return v
  }

  getArticle(id: string): FaqArticle | null {
    const r = this.db.get<any>(`SELECT * FROM faq_articles WHERE id = ? OR external_id = ?`, id, id)
    if (!r) return null
    return {
      id: r.id,
      externalId: r.external_id ?? undefined,
      title: r.title,
      category: r.category,
      folder: r.folder ?? undefined,
      content: r.content,
      contentText: r.content_text,
      url: r.url,
      source: r.source,
      lastVerified: r.last_verified,
      contentHash: r.content_hash,
      official: Boolean(r.official),
    }
  }
}

function snippet(text: string, tokens: string[], radius = 220): string {
  const norm = normalize(text)
  let best = -1
  for (const t of tokens) {
    const i = norm.indexOf(t)
    if (i >= 0 && (best === -1 || i < best)) best = i
  }
  if (best < 0) return text.slice(0, radius).trim() + (text.length > radius ? '…' : '')
  const start = Math.max(0, best - 80)
  const end = Math.min(text.length, start + radius)
  return (start > 0 ? '…' : '') + text.slice(start, end).replace(/\s+/g, ' ').trim() + (end < text.length ? '…' : '')
}
