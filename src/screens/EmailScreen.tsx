import React from 'react'
import type { EmailAccount, EmailMessage } from '@shared/types'
import { useApp } from '../store'
import { Icon, Empty, Modal, Field, Badge, Spinner } from '../components/ui'
import { fmtDate, timeAgo } from '../lib/format'

export default function EmailScreen() {
  const app = useApp()
  const [accounts, setAccounts] = React.useState<EmailAccount[]>([])
  const [presets, setPresets] = React.useState<any[]>([])
  const [messages, setMessages] = React.useState<EmailMessage[]>([])
  const [selected, setSelected] = React.useState<EmailMessage | null>(null)
  const [query, setQuery] = React.useState('')
  const [bromaOnly, setBromaOnly] = React.useState(false)
  const [syncing, setSyncing] = React.useState(false)
  const [loading, setLoading] = React.useState(true)
  const [compose, setCompose] = React.useState<{ id?: string; to: string; subject: string; body: string; attachments?: { filename: string; path: string }[] } | null>(null)
  const [drafts, setDrafts] = React.useState<any[]>([])
  const [view, setView] = React.useState<'inbox' | 'drafts'>('inbox')
  const [testResult, setTestResult] = React.useState<string | null>(null)
  const [setup, setSetup] = React.useState<any>({ preset: 'gmail', email: '', password: '', label: 'Моя почта' })
  const [savingAccount, setSavingAccount] = React.useState(false)

  const load = React.useCallback(async () => {
    setLoading(true)
    const [accs, msgs, pr, drf] = await Promise.all([
      window.api.email.accounts(),
      window.api.email.messages({ limit: 80 }),
      window.api.email.presets(),
      window.api.drafts.list(),
    ])
    setAccounts(accs)
    setMessages(msgs)
    setPresets(pr)
    setDrafts(drf)
    setLoading(false)
  }, [])

  React.useEffect(() => {
    void load()
    const off = window.api.events.onEmailSync(() => void load())
    return off
  }, [load])

  const preset = presets.find((p) => p.id === setup.preset)

  React.useEffect(() => {
    if (preset) {
      setSetup((s: any) => ({
        ...s,
        imapHost: preset.imapHost,
        imapPort: preset.imapPort,
        smtpHost: preset.smtpHost,
        smtpPort: preset.smtpPort,
      }))
    }
  }, [setup.preset, presets.length])

  const connect = async () => {
    if (!setup.email || !setup.password) return
    setSavingAccount(true)
    try {
      const accs = await window.api.email.save({
        label: setup.label || 'Моя почта',
        email: setup.email,
        username: setup.email,
        password: setup.password,
        provider: setup.preset,
        imapHost: setup.imapHost,
        imapPort: Number(setup.imapPort),
        smtpHost: setup.smtpHost,
        smtpPort: Number(setup.smtpPort),
      })
      setAccounts(accs)
      const id = accs[0]?.id
      if (id) {
        const res = await window.api.email.test(id)
        setTestResult(`IMAP: ${res.imap} · SMTP: ${res.smtp}`)
        if (res.imap === 'OK' || res.smtp === 'OK') {
          app.toast('Почта подключена', 'success')
          await load()
          await window.api.email.sync(id).catch(() => undefined)
          await load()
        }
      }
    } catch (e: any) {
      app.toast(e?.message ?? 'Не удалось подключить почту', 'error')
    } finally {
      setSavingAccount(false)
    }
  }

  const sync = async () => {
    const acc = accounts[0]
    if (!acc) return
    setSyncing(true)
    try {
      const res = await window.api.email.sync(acc.id)
      app.toast(`Синхронизировано ${res.added} писем`, 'success')
      await load()
    } catch (e: any) {
      app.toast(e?.message ?? 'Ошибка синхронизации', 'error')
    } finally {
      setSyncing(false)
    }
  }

  const search = async (q: string, broma: boolean) => {
    setMessages(await window.api.email.messages({ query: q || undefined, bromaOnly: broma, limit: 100 }))
  }

  if (!loading && accounts.length === 0) {
    return (
      <div className="screen">
        <div className="screen-head">
          <div>
            <h1>Подключение почты</h1>
            <p>Агент будет искать ответы Broma 16, связывать их с обращениями и готовить ответы.</p>
          </div>
        </div>
        <div className="screen-body narrow">
          <div className="card card-pad" style={{ maxWidth: 560 }}>
            <Field label="Провайдер" hint={preset?.hint}>
              <select className="input" value={setup.preset} onChange={(e) => setSetup({ ...setup, preset: e.target.value })}>
                {presets.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </Field>
            <div className="row2">
              <Field label="Email"><input className="input" value={setup.email} onChange={(e) => setSetup({ ...setup, email: e.target.value })} placeholder="you@example.com" /></Field>
              <Field label="Пароль приложения"><input className="input" type="password" value={setup.password} onChange={(e) => setSetup({ ...setup, password: e.target.value })} /></Field>
            </div>
            <div className="row2">
              <Field label="IMAP-сервер"><input className="input" value={setup.imapHost ?? ''} onChange={(e) => setSetup({ ...setup, imapHost: e.target.value })} /></Field>
              <Field label="Порт"><input className="input" value={setup.imapPort ?? 993} onChange={(e) => setSetup({ ...setup, imapPort: e.target.value })} /></Field>
            </div>
            <div className="row2">
              <Field label="SMTP-сервер"><input className="input" value={setup.smtpHost ?? ''} onChange={(e) => setSetup({ ...setup, smtpHost: e.target.value })} /></Field>
              <Field label="Порт"><input className="input" value={setup.smtpPort ?? 465} onChange={(e) => setSetup({ ...setup, smtpPort: e.target.value })} /></Field>
            </div>
            <p style={{ color: 'var(--muted)', fontSize: 11.5, marginTop: 0 }}>
              Пароль хранится только в системном хранилище секретов и не попадает в базу или логи.
              Gmail требует двухфакторную аутентификацию и «пароль приложения».
            </p>
            <button className="btn btn-primary" onClick={connect} disabled={savingAccount || !setup.email || !setup.password}>
              {savingAccount ? <Spinner /> : <Icon name="check" size={14} />} Подключить и проверить
            </button>
            {testResult && <div className="banner" style={{ marginTop: 14 }}><div className="grow">{testResult}</div></div>}
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="screen">
      <div className="screen-head">
        <div>
          <h1>Почта</h1>
          <p>
            {accounts.map((a) => a.email).join(', ')}
            {accounts[0]?.lastSyncAt ? ` · синхронизировано ${timeAgo(accounts[0].lastSyncAt)}` : ' · синхронизация ещё не выполнялась'}
          </p>
        </div>
        <div className="spacer" />
        <div className="chips">
          <button className={`chip ${view === 'inbox' ? 'active' : ''}`} onClick={() => setView('inbox')}>Входящие</button>
          <button className={`chip ${view === 'drafts' ? 'active' : ''}`} onClick={() => setView('drafts')}>Черновики{drafts.length ? ` (${drafts.length})` : ''}</button>
        </div>
        <label className="chip" style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
          <input type="checkbox" checked={bromaOnly} onChange={(e) => { setBromaOnly(e.target.checked); void search(query, e.target.checked) }} />
          только Broma 16
        </label>
        <button className="btn" onClick={sync} disabled={syncing}>{syncing ? <Spinner /> : <Icon name="refresh" size={14} />} Синхронизировать</button>
        <button className="btn btn-primary" onClick={() => setCompose({ to: '', subject: '', body: '' })}><Icon name="send" size={14} /> Написать</button>
      </div>
      <div className="screen-body" style={{ padding: 0, minHeight: 0 }}>
        <div className="email-grid">
          <div>
            <div style={{ padding: 10, borderBottom: '1px solid var(--line-soft)' }}>
              <div className="searchbox" style={{ maxWidth: 'none' }}>
                <Icon name="search" size={14} />
                <input
                  placeholder="Поиск писем"
                  value={query}
                  onChange={(e) => { setQuery(e.target.value); void search(e.target.value, bromaOnly) }}
                />
              </div>
            </div>
            <div className="email-list">
              {view === 'drafts' ? (
                drafts.length === 0 ? (
                  <Empty icon="edit" title="Черновиков нет" hint="Нажмите «Написать» и сохраните черновик — он появится здесь." />
                ) : drafts.map((d) => (
                  <button key={d.id} className="email-item" onClick={() => setCompose({ id: d.id, to: d.to, subject: d.subject, body: d.body, attachments: d.attachments })}>
                    <div className="from">Черновик <Badge tone="neutral">{d.to || 'без получателя'}</Badge></div>
                    <div className="subj">{d.subject || '(без темы)'}</div>
                    <div className="prev">{String(d.body || '').replace(/\s+/g, ' ').slice(0, 90)}</div>
                    <div className="prev" style={{ opacity: .7 }}>{fmtDate(d.updatedAt, true)}</div>
                  </button>
                ))
              ) : loading ? <div style={{ padding: 30, display: 'grid', placeItems: 'center' }}><Spinner /></div> : messages.length === 0 ? (
                <Empty icon="mail" title="Писем нет" hint="Синхронизируйте ящик или измените поиск." />
              ) : messages.map((m) => (
                <button key={m.id} className={`email-item ${selected?.id === m.id ? 'active' : ''}`} onClick={() => window.api.email.message(m.id).then(setSelected)}>
                  <div className="from">
                    {m.direction === 'outgoing' ? '→ ' : ''}{m.fromName || m.from || 'неизвестный'}
                    {m.isBroma16 && <Badge tone="lime">Broma16</Badge>}
                    {m.ticketId && <Badge tone="blue">#{m.ticketId}</Badge>}
                  </div>
                  <div className="subj">{m.subject}</div>
                  <div className="prev">{m.bodyText.replace(/\s+/g, ' ').slice(0, 90)}</div>
                  <div className="prev" style={{ opacity: .7 }}>{fmtDate(m.date, true)}</div>
                </button>
              ))}
            </div>
          </div>
          <div className="email-view">
            {selected ? (
              <div style={{ maxWidth: 780 }}>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                  <h2 style={{ margin: 0, fontSize: 17, letterSpacing: '-0.02em' }}>{selected.subject}</h2>
                  {selected.department && <Badge tone="neutral">{selected.department}</Badge>}
                  {selected.ticketId && <Badge tone="blue">ticket #{selected.ticketId}</Badge>}
                </div>
                <div style={{ color: 'var(--muted)', fontSize: 12, margin: '6px 0 16px' }}>
                  {selected.fromName ? `${selected.fromName} <${selected.from}>` : selected.from} · {fmtDate(selected.date, true)}
                </div>
                <div className="card card-pad" style={{ marginBottom: 14 }}>
                  <pre style={{ margin: 0, whiteSpace: 'pre-wrap', font: 'inherit', fontSize: 13, color: 'var(--text-2)' }}>{selected.bodyText || '(пустое письмо)'}</pre>
                </div>
                <div style={{ display: 'flex', gap: 8 }}>
                  <button className="btn" onClick={() => setCompose({ to: selected.from, subject: `Re: ${selected.subject}`, body: `\n\n---\n${selected.bodyText.slice(0, 1200)}` })}>
                    <Icon name="send" size={14} /> Ответить
                  </button>
                  {selected.ticketId && (
                    <button className="btn btn-ghost" onClick={() => app.setScreen('tickets')}>Открыть обращение</button>
                  )}
                </div>
              </div>
            ) : (
              <Empty icon="mail" title="Выберите письмо" hint="Письма Broma 16 помечены и связываются с обращениями по Ticket ID." />
            )}
          </div>
        </div>
      </div>

      {compose && (
        <Modal title="Новое письмо" onClose={() => setCompose(null)} wide>
          <Field label="Кому"><input className="input" value={compose.to} onChange={(e) => setCompose({ ...compose, to: e.target.value })} placeholder="reports@broma16.com" /></Field>
          <Field label="Тема"><input className="input" value={compose.subject} onChange={(e) => setCompose({ ...compose, subject: e.target.value })} /></Field>
          <Field label="Текст"><textarea className="input" style={{ minHeight: 240 }} value={compose.body} onChange={(e) => setCompose({ ...compose, body: e.target.value })} /></Field>
          <div className="composer-att" style={{ marginBottom: 10 }}>
            {(compose.attachments ?? []).map((a) => (
              <span key={a.path} className="att">
                <span className="att-name">{a.filename}</span>
                <button className="icon-btn" style={{ width: 20, height: 20 }} onClick={() => setCompose({ ...compose, attachments: (compose.attachments ?? []).filter((x) => x.path !== a.path) })}>
                  <Icon name="x" size={11} />
                </button>
              </span>
            ))}
            <button
              className="btn btn-ghost btn-sm"
              onClick={async () => {
                const picked = await window.api.attachment.pick()
                const files = picked.filter((p) => p.path).map((p) => ({ filename: p.filename, path: p.path! }))
                setCompose({ ...compose, attachments: [...(compose.attachments ?? []), ...files] })
              }}
            >
              <Icon name="paperclip" size={13} /> Вложить файл
            </button>
          </div>
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
            <button
              className="btn"
              onClick={async () => {
                if (!compose.to && !compose.subject) return
                await window.api.drafts.save({ id: compose.id, to: compose.to, subject: compose.subject, body: compose.body, attachments: compose.attachments })
                setDrafts(await window.api.drafts.list())
                app.toast('Черновик сохранён', 'success')
                setCompose(null)
              }}
            >
              Сохранить черновик
            </button>
            <button className="btn" onClick={() => setCompose(null)}>Отмена</button>
            <button
              className="btn btn-primary"
              onClick={async () => {
                if (!compose.to || !compose.subject) return
                if (!confirm(`Отправить письмо на ${compose.to}?`)) return
                try {
                  await window.api.email.send({ accountId: accounts[0]!.id, to: compose.to, subject: compose.subject, body: compose.body, attachments: compose.attachments })
                  if (compose.id) await window.api.drafts.remove(compose.id)
                  app.toast('Письмо отправлено', 'success')
                  setCompose(null)
                  await load()
                } catch (e: any) {
                  app.toast(e?.message ?? 'Не удалось отправить', 'error')
                }
              }}
            >
              <Icon name="send" size={14} /> Отправить
            </button>
          </div>
        </Modal>
      )}
    </div>
  )
}
