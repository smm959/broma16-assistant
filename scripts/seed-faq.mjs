import { writeFileSync, mkdirSync } from 'node:fs'
import { createHash } from 'node:crypto'

const BASE = 'https://broma16nlbv.freshdesk.com'
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/138 Safari/537.36'

async function get(url, tries = 3) {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, { headers: { 'user-agent': UA, accept: 'text/html,application/json' } })
      if (res.status === 429) { await new Promise(r => setTimeout(r, 1500 * (i + 1))); continue }
      return await res.text()
    } catch (e) { if (i === tries - 1) throw e; await new Promise(r => setTimeout(r, 800)) }
  }
  return ''
}

const unescape = (s) => s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
const htmlToText = (html) => unescape(html
  .replace(/<\s*br\s*\/?\s*>/gi, '\n')
  .replace(/<\/(p|div|li|h[1-6]|tr)>/gi, '\n')
  .replace(/<li[^>]*>/gi, '• ')
  .replace(/<[^>]+>/g, ''))
  .replace(/\n{3,}/g, '\n\n')
  .replace(/[ \t]+/g, ' ')
  .trim()

const indexHtml = await get(`${BASE}/support/solutions`)
const categoryIds = [...new Set([...indexHtml.matchAll(/href="\/support\/solutions\/(\d+)"/g)].map(m => m[1]))]
const folderIds = new Set([...indexHtml.matchAll(/href="\/support\/solutions\/folders\/(\d+)"/g)].map(m => m[1]))

const categories = []
for (const id of categoryIds) {
  const html = await get(`${BASE}/support/solutions/${id}`)
  const title = /<title>\s*([^<:]+?)\s*:/i.exec(html)?.[1]?.trim() || `Category ${id}`
  const name = unescape(title)
  categories.push({ id, name })
  for (const m of html.matchAll(/href="\/support\/solutions\/folders\/(\d+)"/g)) folderIds.add(m[1])
}

const folderMeta = []
for (const id of folderIds) {
  const raw = await get(`${BASE}/support/solutions/folders/${id}.json`)
  let json
  try { json = JSON.parse(raw) } catch { continue }
  const f = json.folder
  if (!f) continue
  folderMeta.push({ id, name: f.name, categoryId: String(f.category_id) })
}

const catName = (id) => categories.find(c => c.id === id)?.name || 'Broma 16 Help Center'

const articles = []
const seen = new Set()
for (const folder of folderMeta) {
  const raw = await get(`${BASE}/support/solutions/folders/${folder.id}.json`)
  let json
  try { json = JSON.parse(raw) } catch { continue }
  for (const a of json.folder?.published_articles ?? []) {
    if (seen.has(String(a.id))) continue
    seen.add(String(a.id))
    const content = a.description || ''
    const text = a.desc_un_html ? htmlToText(a.desc_un_html) : htmlToText(content)
    articles.push({
      externalId: String(a.id),
      title: a.title,
      category: catName(folder.categoryId),
      folder: folder.name,
      content,
      contentText: text,
      url: `${BASE}/support/solutions/articles/${a.id}`,
      source: 'Freshdesk Help Center (Broma 16)',
      lastVerified: Date.now(),
      contentHash: createHash('sha256').update(content).digest('hex'),
      official: true,
      modifiedAt: a.modified_at || a.updated_at,
    })
    process.stdout.write('.')
  }
}

const contacts = []
const emailRe = /[a-z0-9._%+-]+@broma16\.com/gi
for (const a of articles) {
  for (const e of a.contentText.match(emailRe) ?? []) {
    if (!contacts.some(c => c.email.toLowerCase() === e.toLowerCase())) contacts.push({ email: e.toLowerCase(), sourceUrl: a.url, articleTitle: a.title })
  }
}

mkdirSync('resources', { recursive: true })
writeFileSync('resources/faq-seed.json', JSON.stringify({ generatedAt: Date.now(), base: BASE, categories, folders: folderMeta, articles }, null, 1))
console.log(`\narticles: ${articles.length}, folders: ${folderMeta.length}, categories: ${categories.length}`)
console.log('emails found:', contacts)
