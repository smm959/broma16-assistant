import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import type { Db } from '../db/index.js'
import type { KnowledgeStatus } from '../../shared/types.js'
import { FaqIndex } from './search.js'

const BASE = 'https://broma16nlbv.freshdesk.com'
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0 Safari/537.36'

interface SeedArticle {
  externalId: string
  title: string
  category: string
  folder?: string
  content: string
  contentText: string
  url: string
  source: string
  lastVerified: number
  contentHash: string
  official: boolean
}

interface SeedFile {
  generatedAt: number
  articles: SeedArticle[]
  folders?: { id: string; name: string; categoryId: string }[]
  categories?: { id: string; name: string }[]
}

export function htmlToText(html: string): string {
  return html
    .replace(/<\s*br\s*\/?\s*>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6]|tr)>/gi, '\n')
    .replace(/<li[^>]*>/gi, '• ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim()
}

export class KnowledgeBase {
  readonly index: FaqIndex
  private syncing = false
  private lastError?: string
  private listeners = new Set<(status: KnowledgeStatus) => void>()

  constructor(
    private readonly db: Db,
    private readonly seedDir: string,
  ) {
    this.index = new FaqIndex(db)
  }

  onStatus(fn: (s: KnowledgeStatus) => void): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  private emit() {
    const s = this.status()
    for (const fn of this.listeners) fn(s)
  }

  seed(): void {
    const configured = this.db.get<{ value: string }>(`SELECT value FROM kv WHERE key = 'kb.seeded'`)
    const count = this.db.get<{ c: number }>(`SELECT COUNT(*) AS c FROM faq_articles`)?.c ?? 0
    if (configured && count > 0) return
    const candidates = [
      join(this.seedDir, 'faq-seed.json'),
      join(process.cwd(), 'resources', 'faq-seed.json'),
      join(process.resourcesPath ?? '', 'resources', 'faq-seed.json'),
    ]
    const path = candidates.find((p) => p && existsSync(p))
    if (!path) {
      this.lastError =
        'Стартовый набор FAQ не найден. Нажмите «Обновить базу FAQ», чтобы загрузить статьи с официального Help Center Broma 16.'
      return
    }
    try {
      const seed = JSON.parse(readFileSync(path, 'utf8')) as SeedFile
      const step = <T,>(name: string, fn: () => T): T => {
        try {
          return fn()
        } catch (e) {
          throw new Error(`${name}: ${(e as Error).message}`)
        }
      }
      step('articles', () => this.upsertArticles(seed.articles))
      this.db.run(`INSERT INTO kv(key, value) VALUES('kb.lastSync', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`, String(seed.generatedAt))
      this.db.run(`INSERT INTO kv(key, value) VALUES('kb.source', 'seed') ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
      step('index', () => this.index.rebuild())
      step('contacts', () => this.seedContacts(seed.articles))
    } catch (e) {
      this.lastError = `Не удалось загрузить стартовый FAQ: ${(e as Error).message}`
      console.error('SEED STACK', (e as Error).stack)
    }
    this.emit()
  }

  private upsertArticles(articles: SeedArticle[]) {
    const stmt = this.db.prepare(`
      INSERT INTO faq_articles (id, external_id, title, category, folder, content, content_text, url, source, last_verified, content_hash, official, synced_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        title = excluded.title,
        category = excluded.category,
        folder = excluded.folder,
        content = excluded.content,
        content_text = excluded.content_text,
        url = excluded.url,
        source = excluded.source,
        last_verified = excluded.last_verified,
        content_hash = excluded.content_hash,
        official = excluded.official,
        synced_at = excluded.synced_at
    `)
    this.db.transaction(() => {
      for (const a of articles) {
        const id = `faq_${a.externalId}`
        stmt.run(
          id,
          a.externalId,
          a.title,
          a.category || 'General',
          a.folder ?? null,
          a.content,
          a.contentText,
          a.url,
          a.source,
          a.lastVerified,
          a.contentHash,
          a.official ? 1 : 0,
          Date.now(),
        )
      }
    })
  }

  private seedContacts(articles: SeedArticle[]) {
    const officialArticle = articles.find((a) => /pitching/i.test(a.title))
    const reportsArticle = articles.find((a) => /invoice template|payment for compensation|form should the invoice/i.test(a.title))
    const rows: {
      email: string
      department: string
      purpose: string
      status: string
      source: string
      types: string[]
    }[] = [
      {
        email: 'marketing@broma16.com',
        department: 'Marketing / Editorial Pitching',
        purpose: 'Отправка маркетинг-китов, питчинг релизов редакциям стриминговых платформ',
        status: officialArticle ? 'VERIFIED' : 'UNVERIFIED',
        source: officialArticle?.url ?? '',
        types: ['marketing', 'pitching', 'promotion'],
      },
      {
        email: 'reports@broma16.com',
        department: 'Reports / Invoice Processing',
        purpose: 'Подписанные отчёты, инвойсы, обработка выплат',
        status: 'VERIFIED',
        source: reportsArticle?.url ?? `${BASE}/support/solutions`,
        types: ['reports', 'payments', 'invoice', 'royalties'],
      },
      {
        email: 'pr@broma16.com',
        department: 'PR / Press',
        purpose: 'Пресс-служба и медиа-запросы (требует подтверждения)',
        status: 'UNVERIFIED',
        source: 'https://broma16.com/ru/contact/',
        types: ['pr', 'press'],
      },
    ]
    for (const r of rows) {
      this.db.run(
        `INSERT INTO contacts (id, email, department, purpose, verification_status, source_url, last_verified, supported_issue_types)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(email) DO UPDATE SET
           department = excluded.department,
           purpose = excluded.purpose,
           verification_status = excluded.verification_status,
           source_url = excluded.source_url,
           last_verified = excluded.last_verified,
           supported_issue_types = excluded.supported_issue_types`,
        `c_${r.email}`,
        r.email,
        r.department,
        r.purpose,
        r.status,
        r.source,
        r.status === 'VERIFIED' ? Date.now() : null,
        JSON.stringify(r.types),
      )
    }
    this.db.run(
      `INSERT INTO kv(key, value) VALUES('kb.contactForm', 'https://broma16.com/ru/contact/') ON CONFLICT(key) DO NOTHING`,
    )
  }

  status(): KnowledgeStatus {
    const articles = this.db.get<{ c: number }>(`SELECT COUNT(*) AS c FROM faq_articles`)?.c ?? 0
    const categories = this.db.get<{ c: number }>(`SELECT COUNT(DISTINCT category) AS c FROM faq_articles`)?.c ?? 0
    const lastSyncRaw = this.db.get<{ value: string }>(`SELECT value FROM kv WHERE key = 'kb.lastSync'`)?.value
    const lastSync = lastSyncRaw ? Number(lastSyncRaw) : undefined
    const staleDays = lastSync ? Math.floor((Date.now() - lastSync) / 86_400_000) : 0
    return {
      articles,
      categories,
      lastSync,
      syncing: this.syncing,
      lastError: this.lastError,
      staleDays,
    }
  }

  async sync(): Promise<KnowledgeStatus> {
    if (this.syncing) return this.status()
    this.syncing = true
    this.lastError = undefined
    this.emit()
    try {
      const folders = await this.discoverFolders()
      const articles: SeedArticle[] = []
      const seen = new Set<string>()
      for (const folder of folders) {
        const json = await this.getJson(`${BASE}/support/solutions/folders/${folder.id}.json`)
        for (const a of json?.folder?.published_articles ?? []) {
          const externalId = String(a.id)
          if (seen.has(externalId)) continue
          seen.add(externalId)
          const content: string = a.description ?? ''
          articles.push({
            externalId,
            title: a.title,
            category: folder.category,
            folder: folder.name,
            content,
            contentText: htmlToText(content),
            url: `${BASE}/support/solutions/articles/${externalId}`,
            source: 'Freshdesk Help Center (Broma 16)',
            lastVerified: Date.now(),
            contentHash: createHash('sha256').update(content).digest('hex'),
            official: true,
          })
        }
        await sleep(250)
      }
      if (!articles.length) throw new Error('Freshdesk вернул 0 статей — возможно, изменилась структура портала.')
      this.upsertArticles(articles)
      this.seedContacts(articles)
      this.db.run(`INSERT INTO kv(key, value) VALUES('kb.lastSync', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`, String(Date.now()))
      this.db.run(`INSERT INTO kv(key, value) VALUES('kb.source', 'live') ON CONFLICT(key) DO UPDATE SET value = excluded.value`, 'live')
      this.index.rebuild()
    } catch (e) {
      this.lastError = `Не удалось обновить FAQ: ${(e as Error).message}`
      throw e
    } finally {
      this.syncing = false
      this.emit()
    }
    return this.status()
  }

  private async discoverFolders(): Promise<{ id: string; name: string; category: string }[]> {
    const indexHtml = await this.getText(`${BASE}/support/solutions`)
    const categoryIds = [...new Set([...indexHtml.matchAll(/href="\/support\/solutions\/(\d+)"/g)].map((m) => m[1]!))]
    const out = new Map<string, { id: string; name: string; category: string }>()
    const folderIds = new Set([...indexHtml.matchAll(/href="\/support\/solutions\/folders\/(\d+)"/g)].map((m) => m[1]!))

    for (const catId of categoryIds) {
      const html = await this.getText(`${BASE}/support/solutions/${catId}`)
      const title = decodeEntities(/<title>\s*([^<:]+?)\s*:/i.exec(html)?.[1]?.trim() ?? `Категория ${catId}`)
      for (const m of html.matchAll(/href="\/support\/solutions\/folders\/(\d+)"/g)) {
        const id = m[1]!
        if (!folderIds.has(id)) folderIds.add(id)
        out.set(id, { id, name: '', category: title })
      }
      await sleep(250)
    }
    for (const id of folderIds) {
      if (!out.has(id)) out.set(id, { id, name: '', category: 'Broma 16 Help Center' })
    }
    // Названия папок берём из JSON
    for (const folder of out.values()) {
      try {
        const json = await this.getJson(`${BASE}/support/solutions/folders/${folder.id}.json`)
        folder.name = json?.folder?.name ?? folder.name
      } catch {
        folder.name = folder.name || `Раздел ${folder.id}`
      }
      await sleep(120)
    }
    return [...out.values()]
  }

  private async getText(url: string, tries = 3): Promise<string> {
    let lastErr: unknown
    for (let i = 0; i < tries; i++) {
      try {
        const res = await fetch(url, { headers: { 'user-agent': UA, accept: 'text/html' } })
        if (res.status === 429) {
          await sleep(1200 * (i + 1))
          continue
        }
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        return await res.text()
      } catch (e) {
        lastErr = e
        await sleep(600)
      }
    }
    throw new Error(`Не удалось загрузить ${url}: ${(lastErr as Error)?.message ?? 'ошибка сети'}`)
  }

  private async getJson(url: string): Promise<any> {
    const text = await this.getText(url)
    try {
      return JSON.parse(text)
    } catch {
      throw new Error(`Некорректный JSON от ${url}`)
    }
  }

  articles(filter?: { category?: string; query?: string }): any[] {
    let rows = this.db.all<any>(`SELECT * FROM faq_articles ORDER BY category, title`)
    if (filter?.category) rows = rows.filter((r) => r.category === filter.category)
    if (filter?.query) {
      const q = filter.query.toLowerCase()
      rows = rows.filter((r) => r.title.toLowerCase().includes(q) || r.content_text.toLowerCase().includes(q))
    }
    return rows.map((r) => ({
      id: r.id,
      title: r.title,
      category: r.category,
      folder: r.folder,
      url: r.url,
      lastVerified: r.last_verified,
      official: Boolean(r.official),
      preview: String(r.content_text).slice(0, 200),
      length: String(r.content_text).length,
    }))
  }
}

function decodeEntities(s: string) {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
