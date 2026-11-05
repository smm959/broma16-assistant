import React from 'react'
import type { Release } from '@shared/types'
import { useApp } from '../store'
import { Icon, Empty, Modal, Field, Badge, Spinner } from '../components/ui'
import { fmtDate } from '../lib/format'

const EMPTY: Partial<Release> = { title: '', artist: '', releaseDate: '', upc: '', isrc: '', status: 'planned', platformLinks: {}, notes: '' }

const STATUSES = [
  ['planned', 'Запланирован'],
  ['delivered', 'Доставлен'],
  ['live', 'Вышел'],
  ['rejected', 'Отклонён'],
  ['takedown', 'Снят'],
  ['unknown', 'Неизвестно'],
] as const

export default function ReleasesScreen() {
  const app = useApp()
  const [releases, setReleases] = React.useState<Release[]>([])
  const [editing, setEditing] = React.useState<Partial<Release> | null>(null)
  const [loading, setLoading] = React.useState(true)
  const [busy, setBusy] = React.useState(false)

  const load = React.useCallback(async () => {
    setLoading(true)
    setReleases(await window.api.releases.list())
    setLoading(false)
  }, [])

  React.useEffect(() => {
    void load()
  }, [load])

  const save = async () => {
    if (!editing?.title?.trim()) return
    setBusy(true)
    try {
      const rows = await window.api.releases.save({
        ...editing,
        title: editing.title.trim(),
        platformLinks: {
          ...(editing.platformLinks ?? {}),
        },
      })
      setReleases(rows)
      setEditing(null)
      app.toast('Релиз сохранён', 'success')
    } finally {
      setBusy(false)
    }
  }

  const uploadToPortal = async (r: Release) => {
    const c = await window.api.conv.create()
    app.setScreen('chat')
    app.setConversationId(c.id)
    await window.api.chat.send({
      conversationId: c.id,
      text: [
        `Загружаем релиз «${r.title}» в личный кабинет Broma 16.`,
        `Данные: артист — ${r.artist || 'не указан'}, дата релиза — ${r.releaseDate || 'не указана'}, UPC/EAN — ${r.upc || 'нет'}, ISRC — ${r.isrc || 'нет'}, лейбл — ${app.settings?.labelName || app.settings?.accountName || 'не указан'}.`,
        'Открой кабинет, помоги мне войти, покажи форму создания релиза и поля загрузки файлов (account_file_inputs).',
        'Я пришлю обложку и WAV в чат — прикрепи их через account_upload_files. Заполняй поля по шагам и ничего не отправляй без моего подтверждения.',
      ].join(' '),
    })
    app.refreshConversations()
  }

  const importFromAccount = async () => {
    const c = await window.api.conv.create()
    app.setScreen('chat')
    app.setConversationId(c.id)
    await window.api.chat.send({
      conversationId: c.id,
      text: 'Открой личный кабинет Broma 16 и собери список моих релизов: название, артист, дата, UPC/EAN, ISRC, статус. Сохрани их в базу через release_save. Если нужен вход — попроси меня войти в открытом окне.',
    })
    app.refreshConversations()
  }

  return (
    <div className="screen">
      <div className="screen-head">
        <div>
          <h1>Мои релизы</h1>
          <p>Локальная база: UPC, ISRC, даты, статусы и ссылки. Используется агентом при подготовке писем.</p>
        </div>
        <div className="spacer" />
        <button className="btn" onClick={importFromAccount}><Icon name="disc" size={14} /> Собрать из кабинета</button>
        <button className="btn btn-primary" onClick={() => setEditing({ ...EMPTY })}><Icon name="plus" size={14} /> Добавить релиз</button>
      </div>
      <div className="screen-body">
        {loading ? (
          <div style={{ display: 'grid', placeItems: 'center', padding: 60 }}><Spinner size={20} /></div>
        ) : releases.length === 0 ? (
          <Empty
            icon="disc"
            title="Релизов пока нет"
            hint="Добавьте релиз вручную или попросите агента собрать данные из личного кабинета Broma 16."
            action={<button className="btn btn-primary" onClick={() => setEditing({ ...EMPTY })}><Icon name="plus" size={14} /> Добавить релиз</button>}
          />
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Релиз</th><th>Дата</th><th>UPC / EAN</th><th>ISRC</th><th>Статус</th><th />
              </tr>
            </thead>
            <tbody>
              {releases.map((r) => (
                <tr key={r.id}>
                  <td>
                    <div style={{ fontWeight: 550 }}>{r.title}</div>
                    <div style={{ color: 'var(--muted)', fontSize: 11.5 }}>{r.artist || '—'}</div>
                  </td>
                  <td className="mono">{r.releaseDate || '—'}</td>
                  <td className="mono">{r.upc || '—'}</td>
                  <td className="mono">{r.isrc || '—'}</td>
                  <td>
                    <Badge tone={r.status === 'live' ? 'green' : r.status === 'rejected' ? 'red' : r.status === 'delivered' ? 'blue' : 'neutral'}>
                      {STATUSES.find(([k]) => k === r.status)?.[1] ?? r.status}
                    </Badge>
                  </td>
                  <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                    <button className="icon-btn" title="Загрузить в Broma 16" onClick={() => uploadToPortal(r)}><Icon name="external" size={14} /></button>
                    <button className="icon-btn" title="Редактировать" onClick={() => setEditing(r)}><Icon name="edit" size={14} /></button>
                    <button
                      className="icon-btn"
                      title="Удалить"
                      onClick={async () => {
                        if (!confirm(`Удалить «${r.title}» из базы?`)) return
                        setReleases(await window.api.releases.remove(r.id))
                      }}
                    >
                      <Icon name="trash" size={14} />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {editing && (
        <Modal title={editing.id ? 'Редактировать релиз' : 'Новый релиз'} onClose={() => setEditing(null)}>
          <Field label="Название релиза"><input className="input" value={editing.title ?? ''} onChange={(e) => setEditing({ ...editing, title: e.target.value })} placeholder="например, Night Drive" /></Field>
          <div className="row2">
            <Field label="Артист"><input className="input" value={editing.artist ?? ''} onChange={(e) => setEditing({ ...editing, artist: e.target.value })} /></Field>
            <Field label="Дата релиза"><input className="input" type="date" value={editing.releaseDate ?? ''} onChange={(e) => setEditing({ ...editing, releaseDate: e.target.value })} /></Field>
          </div>
          <div className="row2">
            <Field label="UPC / EAN"><input className="input mono" value={editing.upc ?? ''} onChange={(e) => setEditing({ ...editing, upc: e.target.value })} /></Field>
            <Field label="ISRC"><input className="input mono" value={editing.isrc ?? ''} onChange={(e) => setEditing({ ...editing, isrc: e.target.value })} /></Field>
          </div>
          <div className="row2">
            <Field label="Статус">
              <select className="input" value={editing.status ?? 'unknown'} onChange={(e) => setEditing({ ...editing, status: e.target.value })}>
                {STATUSES.map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </select>
            </Field>
            <Field label="Ссылка Spotify"><input className="input" value={editing.platformLinks?.spotify ?? ''} onChange={(e) => setEditing({ ...editing, platformLinks: { ...(editing.platformLinks ?? {}), spotify: e.target.value } })} /></Field>
          </div>
          <Field label="Заметки"><textarea className="input" value={editing.notes ?? ''} onChange={(e) => setEditing({ ...editing, notes: e.target.value })} /></Field>
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
            <button className="btn" onClick={() => setEditing(null)}>Отмена</button>
            <button className="btn btn-primary" onClick={save} disabled={busy || !editing.title?.trim()}>{busy ? <Spinner /> : <Icon name="check" size={14} />} Сохранить</button>
          </div>
        </Modal>
      )}
    </div>
  )
}
