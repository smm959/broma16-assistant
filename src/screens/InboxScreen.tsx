import React from 'react'
import type { TgSubmission } from '@shared/types'
import { useApp } from '../store'
import { Badge, Empty, Icon, Spinner } from '../components/ui'
import { fmtDate } from '../lib/format'

const TONE: Record<TgSubmission['status'], 'amber' | 'green' | 'red'> = {
  pending: 'amber',
  approved: 'green',
  rejected: 'red',
}

const LABEL: Record<TgSubmission['status'], string> = {
  pending: 'На проверке',
  approved: 'Одобрено',
  rejected: 'Отклонено',
}

export default function InboxScreen() {
  const app = useApp()
  const [rows, setRows] = React.useState<TgSubmission[]>([])
  const [selected, setSelected] = React.useState<string | null>(null)
  const [loading, setLoading] = React.useState(true)
  const [busy, setBusy] = React.useState<string | null>(null)
  const [note, setNote] = React.useState<{ text: string; tone: 'success' | 'error' } | null>(null)

  const load = React.useCallback(async () => {
    const list = await window.api.submissions.list()
    setRows(list)
    setSelected((prev) => (prev && list.some((r) => r.id === prev) ? prev : list[0]?.id ?? null))
    setLoading(false)
  }, [])

  React.useEffect(() => {
    void load()
    const off = window.api.events.onSubmissions(() => void load())
    return off
  }, [load])

  const detail = rows.find((r) => r.id === selected) ?? null

  const approve = async (sub: TgSubmission) => {
    setBusy(sub.id)
    setNote(null)
    try {
      const res = await window.api.submissions.approve(sub.id)
      setNote({ text: res.text, tone: res.ok ? 'success' : 'error' })
      app.toast(res.ok ? 'Релиз собран до «Обзора»' : 'Не удалось собрать релиз', res.ok ? 'success' : 'error')
      await load()
    } finally {
      setBusy(null)
    }
  }

  const reject = async (sub: TgSubmission) => {
    setBusy(sub.id)
    try {
      await window.api.submissions.reject(sub.id)
      setNote({ text: 'Заявка отклонена.', tone: 'error' })
      app.toast('Заявка отклонена')
      await load()
    } finally {
      setBusy(null)
    }
  }

  const remove = async (sub: TgSubmission) => {
    setBusy(sub.id)
    try {
      await window.api.submissions.remove(sub.id)
      await load()
    } finally {
      setBusy(null)
    }
  }

  const pendingCount = rows.filter((r) => r.status === 'pending').length

  return (
    <div className="screen">
      <div className="screen-head">
        <div>
          <h1>Заявки</h1>
          <p>
            Релизы, присланные через Telegram-бота. Послушайте, проверьте обложку и описание — и одобрите или отклоните.
            {pendingCount ? ` На проверке: ${pendingCount}.` : ''}
          </p>
        </div>
        <div className="spacer" />
        <button className="btn btn-ghost" onClick={() => void load()} aria-label="Обновить">
          <Icon name="refresh" size={14} />
        </button>
      </div>

      <div className="screen-body" style={{ padding: 0, display: 'grid', gridTemplateColumns: '340px minmax(0,1fr)', minHeight: 0 }}>
        <div style={{ borderRight: '1px solid var(--line-soft)', overflowY: 'auto', padding: 12 }}>
          {loading ? (
            <div style={{ display: 'grid', placeItems: 'center', padding: 40 }}><Spinner /></div>
          ) : rows.length === 0 ? (
            <Empty
              icon="inbox"
              title="Заявок пока нет"
              hint="Отправьте боту @music959labelbot /start — он соберёт данные и пришлёт заявку сюда."
            />
          ) : (
            <div className="list">
              {rows.map((r) => (
                <button
                  key={r.id}
                  className={`list-row ${selected === r.id ? 'active' : ''}`}
                  onClick={() => setSelected(r.id)}
                  style={selected === r.id ? { borderColor: '#3a3a44', background: 'var(--panel-2)' } : undefined}
                >
                  {r.coverPath ? (
                    <img
                      src={`attachment://local${encodeURI(r.coverPath)}`}
                      alt=""
                      style={{ width: 44, height: 44, borderRadius: 8, objectFit: 'cover', flexShrink: 0 }}
                    />
                  ) : null}
                  <div className="grow" style={{ minWidth: 0 }}>
                    <div className="t" style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{r.title}</div>
                    <div className="s">{r.artist} · {r.releaseDate ?? 'дата не указана'}</div>
                    <div className="s">{fmtDate(r.createdAt)}</div>
                  </div>
                  <Badge tone={TONE[r.status]}>{LABEL[r.status]}</Badge>
                </button>
              ))}
            </div>
          )}
        </div>

        <div style={{ overflowY: 'auto', padding: '22px 26px 40px' }}>
          {!detail ? (
            <Empty icon="inbox" title="Выберите заявку" hint="Здесь будет плеер, обложка, описание и кнопки «Одобрить» / «Отклонить»." />
          ) : (
            <div style={{ maxWidth: 880 }}>
              <div style={{ display: 'flex', gap: 14, alignItems: 'flex-start' }}>
                <div style={{ flex: 1 }}>
                  <h2 style={{ margin: '0 0 6px', fontSize: 20, letterSpacing: '-0.02em' }}>{detail.artist} — {detail.title}</h2>
                  <div style={{ display: 'flex', gap: 10, color: 'var(--muted)', fontSize: 12, flexWrap: 'wrap' }}>
                    <span>{detail.label}</span>
                    <span>·</span>
                    <span>{detail.genres.join(', ') || 'жанры не указаны'}</span>
                    <span>·</span>
                    <span>{detail.releaseDate ?? 'дата не указана'}</span>
                    <span>·</span>
                    <span>{detail.explicit ? 'ненормативная лексика' : 'без мата'}</span>
                  </div>
                </div>
                <Badge tone={TONE[detail.status]}>{LABEL[detail.status]}</Badge>
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: '300px minmax(0,1fr)', gap: 22, marginTop: 20 }}>
                <div>
                  {detail.coverPath ? (
                    <img
                      src={`attachment://local${encodeURI(detail.coverPath)}`}
                      alt="Обложка"
                      style={{ width: '100%', aspectRatio: '1 / 1', objectFit: 'cover', borderRadius: 14, border: '1px solid var(--line-soft)' }}
                    />
                  ) : null}
                  <div style={{ marginTop: 10, fontSize: 11, color: 'var(--muted)' }}>{detail.coverName}</div>
                </div>

                <div>
                  <audio
                    controls
                    preload="metadata"
                    src={`attachment://local${encodeURI(detail.audioPath)}`}
                    style={{ width: '100%' }}
                  />
                  <div style={{ marginTop: 8, fontSize: 11, color: 'var(--muted)' }}>{detail.audioName}</div>

                  <div style={{ marginTop: 18 }}>
                    <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 6 }}>Описание</div>
                    <div style={{ fontSize: 14, lineHeight: 1.55, whiteSpace: 'pre-wrap' }}>
                      {detail.description?.trim() || 'Описание не указано.'}
                    </div>
                  </div>

                  <div style={{ display: 'grid', gridTemplateColumns: '140px 1fr', gap: '8px 14px', marginTop: 20, fontSize: 13 }}>
                    <span style={{ color: 'var(--muted)' }}>Автор и доля</span>
                    <span>{detail.author ?? '—'}</span>
                    <span style={{ color: 'var(--muted)' }}>Отправитель</span>
                    <span>{detail.username || `chat ${detail.chatId}`}</span>
                    <span style={{ color: 'var(--muted)' }}>Создана</span>
                    <span>{fmtDate(detail.createdAt, true)}</span>
                    {detail.result ? (
                      <>
                        <span style={{ color: 'var(--muted)' }}>Результат</span>
                        <span>{detail.result}</span>
                      </>
                    ) : null}
                  </div>
                </div>
              </div>

              {note ? (
                <div className="banner" style={{ marginTop: 18, borderColor: note.tone === 'success' ? 'var(--lime)' : 'var(--red)' }}>
                  {note.text}
                </div>
              ) : null}

              <div style={{ display: 'flex', gap: 10, marginTop: 22, flexWrap: 'wrap' }}>
                <button
                  className="btn btn-primary"
                  disabled={detail.status !== 'pending' || busy === detail.id}
                  onClick={() => void approve(detail)}
                >
                  {busy === detail.id ? <Spinner /> : <Icon name="check" size={14} />} Одобрить и собрать
                </button>
                <button
                  className="btn btn-ghost"
                  disabled={detail.status === 'rejected' || busy === detail.id}
                  onClick={() => void reject(detail)}
                >
                  <Icon name="x" size={14} /> Отклонить
                </button>
                <div style={{ flex: 1 }} />
                <button className="btn btn-ghost" disabled={busy === detail.id} onClick={() => void remove(detail)}>
                  Удалить
                </button>
              </div>
              <p style={{ color: 'var(--muted)', fontSize: 12, marginTop: 10 }}>
                «Одобрить» собирает релиз в кабинете до экрана «Обзор». Отправку на модерацию вы нажимаете сами.
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
