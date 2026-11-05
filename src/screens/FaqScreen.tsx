import React from 'react'
import type { FaqArticle } from '@shared/types'
import { useApp } from '../store'
import { Icon, Spinner, Empty, Badge } from '../components/ui'
import { fmtDate, mdToHtml, timeAgo } from '../lib/format'

interface Row {
  id: string
  title: string
  category: string
  folder?: string
  url: string
  lastVerified: number
  official: boolean
  preview: string
  length: number
}

export default function FaqScreen() {
  const app = useApp()
  const [articles, setArticles] = React.useState<Row[]>([])
  const [query, setQuery] = React.useState('')
  const [cat, setCat] = React.useState<string>('all')
  const [selected, setSelected] = React.useState<FaqArticle | null>(null)
  const [syncing, setSyncing] = React.useState(false)
  const [loading, setLoading] = React.useState(true)

  const load = React.useCallback(async () => {
    setLoading(true)
    const rows = await window.api.kb.articles()
    setArticles(rows)
    setLoading(false)
  }, [])

  React.useEffect(() => {
    void load()
  }, [load])

  React.useEffect(() => {
    if (!selected && articles.length) {
      const first = articles.find((a) => /pitching/i.test(a.title)) ?? articles[0]
      void window.api.kb.article(first!.id).then(setSelected)
    }
  }, [articles, selected])

  const categories = React.useMemo(() => {
    const map = new Map<string, number>()
    for (const a of articles) map.set(a.category, (map.get(a.category) ?? 0) + 1)
    return [...map.entries()]
  }, [articles])

  const filtered = React.useMemo(() => {
    const q = query.trim().toLowerCase()
    return articles.filter((a) => {
      if (cat !== 'all' && a.category !== cat) return false
      if (!q) return true
      return a.title.toLowerCase().includes(q) || a.preview.toLowerCase().includes(q)
    })
  }, [articles, query, cat])

  const sync = async () => {
    setSyncing(true)
    try {
      const s = await window.api.kb.sync()
      app.onKnowledge(s)
      app.toast(`FAQ обновлён: ${s.articles} статей`, 'success')
      await load()
    } catch (e: any) {
      app.toast(e?.message ?? 'Не удалось обновить FAQ', 'error')
    } finally {
      setSyncing(false)
    }
  }

  return (
    <div className="screen">
      <div className="screen-head">
        <div>
          <h1>База знаний Broma 16</h1>
          <p>
            {articles.length} статей из официального Help Center · обновлено {timeAgo(app.knowledge?.lastSync)}
            {(app.knowledge?.staleDays ?? 0) > 14 ? ' · данные устарели, обновите базу' : ''}
          </p>
        </div>
        <div className="spacer" />
        <button className="btn" onClick={sync} disabled={syncing}>
          {syncing ? <Spinner /> : <Icon name="refresh" size={14} />} Обновить базу FAQ
        </button>
        <button className="btn btn-ghost" onClick={() => window.api.system.openExternal('https://broma16nlbv.freshdesk.com/support/solutions')}>
          <Icon name="external" size={14} /> Help Center
        </button>
      </div>

      <div className="screen-body" style={{ paddingBottom: 20 }}>
        <div className="toolbar">
          <div className="searchbox">
            <Icon name="search" size={15} />
            <input
              placeholder="Поиск по статьям: выплаты, питчинг, Content ID, лирика…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            {query && <button className="icon-btn" onClick={() => setQuery('')}><Icon name="x" size={13} /></button>}
          </div>
          <div className="chips">
            <button className={`chip ${cat === 'all' ? 'active' : ''}`} onClick={() => setCat('all')}>Все ({articles.length})</button>
            {categories.map(([c, n]) => (
              <button key={c} className={`chip ${cat === c ? 'active' : ''}`} onClick={() => setCat(c)}>
                {c} ({n})
              </button>
            ))}
          </div>
        </div>

        {loading ? (
          <div style={{ display: 'grid', placeItems: 'center', padding: 60 }}><Spinner size={20} /></div>
        ) : filtered.length === 0 ? (
          <Empty icon="book" title="Ничего не найдено" hint="Попробуйте другой запрос или обновите базу из Help Center." />
        ) : (
          <div className="faq-grid">
            <div className="faq-list">
              {filtered.map((a) => (
                <button
                  key={a.id}
                  className={`faq-item ${selected?.id === a.id ? 'active' : ''}`}
                  onClick={() => window.api.kb.article(a.id).then(setSelected)}
                >
                  <div className="ft">{a.title}</div>
                  <div className="fm">
                    <span>{a.folder || a.category}</span>
                    <span>·</span>
                    <span>{fmtDate(a.lastVerified)}</span>
                    {a.official && <Badge tone="green">официально</Badge>}
                  </div>
                </button>
              ))}
            </div>

            <div className="card faq-view">
              {selected ? (
                <div className="card-pad">
                  <h2>{selected.title}</h2>
                  <div className="faq-meta">
                    <Badge tone="green">официальный источник</Badge>
                    <span>{selected.category}</span>
                    {selected.folder && <><span>·</span><span>{selected.folder}</span></>}
                    <span>·</span>
                    <span>проверено {fmtDate(selected.lastVerified)}</span>
                    <div style={{ flex: 1 }} />
                    <button className="btn btn-sm" onClick={() => window.api.system.openExternal(selected.url)}>
                      <Icon name="external" size={13} /> Оригинал статьи
                    </button>
                  </div>
                  {/<[a-z][\s\S]*>/i.test(selected.content) ? (
                    <div className="md" dangerouslySetInnerHTML={{ __html: mdToHtml(selected.content) }} />
                  ) : (
                    <div className="faq-content">{selected.contentText}</div>
                  )}
                  <div className="hr" />
                  <p style={{ color: 'var(--muted)', fontSize: 11.5 }}>
                    Источник: {selected.source}. Текст статьи сохранён локально и обновляется при синхронизации Help Center.
                  </p>
                </div>
              ) : (
                <Empty icon="book" title="Выберите статью" hint="Слева — список официальных статей Broma 16." />
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
