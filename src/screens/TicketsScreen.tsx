import React from 'react'
import type { Ticket } from '@shared/types'
import { useApp } from '../store'
import { Icon, Empty, Badge, Spinner, Modal, Field } from '../components/ui'
import { CATEGORY_LABELS, STATUS_LABELS, fmtDate, timeAgo } from '../lib/format'

const STATUS_TONE: Record<string, 'neutral' | 'green' | 'lime' | 'red' | 'amber' | 'blue'> = {
  draft: 'neutral',
  ready: 'blue',
  sent: 'blue',
  awaiting_reply: 'amber',
  answered: 'lime',
  resolved: 'green',
  closed: 'neutral',
}

export default function TicketsScreen() {
  const app = useApp()
  const [tickets, setTickets] = React.useState<Ticket[]>([])
  const [selectedId, setSelectedId] = React.useState<string | null>(null)
  const [detail, setDetail] = React.useState<{ ticket: Ticket; messages: any[] } | null>(null)
  const [filter, setFilter] = React.useState('all')
  const [loading, setLoading] = React.useState(true)
  const [contacts, setContacts] = React.useState<any[]>([])
  const [draft, setDraft] = React.useState<{ subject: string; category: string; recipient: string; body: string } | null>(null)
  const [followupDue, setFollowupDue] = React.useState(0)
  const [mailAccounts, setMailAccounts] = React.useState<any[]>([])
  const [sendMail, setSendMail] = React.useState<{ to: string; subject: string; body: string } | null>(null)

  const load = React.useCallback(async () => {
    setLoading(true)
    const rows = await window.api.tickets.list()
    setTickets(rows)
    setSelectedId((prev) => prev ?? rows[0]?.id ?? null)
    setLoading(false)
  }, [])

  React.useEffect(() => {
    void load()
    void window.api.contacts().then(setContacts)
    void window.api.email.accounts().then(setMailAccounts)
    const off = window.api.events.onFollowupDue((p) => setFollowupDue(p.count))
    return off
  }, [load])

  React.useEffect(() => {
    if (!selectedId) return setDetail(null)
    void window.api.tickets.get(selectedId).then(setDetail)
  }, [selectedId])

  const filtered = filter === 'all' ? tickets : tickets.filter((t) => t.status === filter)

  const followUp = async (t: Ticket) => {
    const c = await window.api.conv.create()
    app.setScreen('chat')
    app.setConversationId(c.id)
    await window.api.chat.send({ conversationId: c.id, text: `Подготовь follow-up по обращению «${t.subject}» (id: ${t.id}). Проблема не решена, нужен вежливый запрос статуса.` })
    app.refreshConversations()
  }

  return (
    <div className="screen">
      <div className="screen-head">
        <div>
          <h1>Обращения</h1>
          <p>История писем, ответы поддержки и статусы. {tickets.length ? `${tickets.length} шт.` : 'Пока нет обращений'}</p>
        </div>
        <div className="spacer" />
        <button className="btn btn-primary" onClick={() => setDraft({ subject: '', category: 'other', recipient: contacts.find((c) => c.verificationStatus === 'VERIFIED')?.email ?? '', body: '' })}>
          <Icon name="plus" size={14} /> Новое обращение
        </button>
        <div className="chips">
          {['all', 'draft', 'awaiting_reply', 'answered', 'resolved'].map((s) => (
            <button key={s} className={`chip ${filter === s ? 'active' : ''}`} onClick={() => setFilter(s)}>
              {s === 'all' ? 'Все' : STATUS_LABELS[s]}
            </button>
          ))}
        </div>
        <button className="btn btn-ghost" onClick={load}><Icon name="refresh" size={14} /></button>
      </div>

      <div className="screen-body" style={{ padding: 0, display: 'grid', gridTemplateColumns: '360px minmax(0,1fr)', minHeight: 0 }}>
        <div style={{ borderRight: '1px solid var(--line-soft)', overflowY: 'auto', padding: 12 }}>
          {followupDue > 0 && (
            <div className="banner" style={{ marginBottom: 10 }}>
              <Icon name="clock" size={15} />
              <div className="grow">Нет ответа по {followupDue} обращени{followupDue === 1 ? 'ю' : 'ям'}. Стоит напомнить о себе.</div>
            </div>
          )}
          {loading ? (
            <div style={{ display: 'grid', placeItems: 'center', padding: 40 }}><Spinner /></div>
          ) : filtered.length === 0 ? (
            <Empty icon="ticket" title="Обращений нет" hint="Попросите агента подготовить письмо в Broma 16 — оно появится здесь вместе с историей переписки." />
          ) : (
            <div className="list">
              {filtered.map((t) => (
                <button key={t.id} className={`list-row ${selectedId === t.id ? 'active' : ''}`} onClick={() => setSelectedId(t.id)} style={selectedId === t.id ? { borderColor: '#3a3a44', background: 'var(--panel-2)' } : undefined}>
                  <div className="grow">
                    <div className="t">{t.subject}</div>
                    <div className="s">{CATEGORY_LABELS[t.category] ?? t.category} · {t.recipient ?? 'без получателя'}</div>
                    <div className="s">{timeAgo(t.updatedAt)}</div>
                  </div>
                  <Badge tone={STATUS_TONE[t.status] ?? 'neutral'}>{STATUS_LABELS[t.status] ?? t.status}</Badge>
                </button>
              ))}
            </div>
          )}
        </div>

        <div style={{ overflowY: 'auto', padding: '22px 26px 40px' }}>
          {!detail ? (
            <Empty icon="ticket" title="Выберите обращение" hint="Здесь появится переписка, вложения и статус." />
          ) : (
            <div style={{ maxWidth: 820 }}>
              <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
                <div style={{ flex: 1 }}>
                  <h2 style={{ margin: '0 0 6px', fontSize: 18, letterSpacing: '-0.02em' }}>{detail.ticket.subject}</h2>
                  <div style={{ display: 'flex', gap: 10, color: 'var(--muted)', fontSize: 12, flexWrap: 'wrap' }}>
                    <span>{CATEGORY_LABELS[detail.ticket.category] ?? detail.ticket.category}</span>
                    <span>·</span>
                    <span>{detail.ticket.recipient ?? 'получатель не указан'}</span>
                    <span>·</span>
                    <span>создано {fmtDate(detail.ticket.createdAt, true)}</span>
                    {detail.ticket.externalTicketId && <><span>·</span><span>ticket #{detail.ticket.externalTicketId}</span></>}
                  </div>
                </div>
                <select
                  className="input"
                  style={{ width: 170 }}
                  value={detail.ticket.status}
                  onChange={async (e) => {
                    await window.api.tickets.update(detail.ticket.id, { status: e.target.value as Ticket['status'] })
                    await load()
                    const d = await window.api.tickets.get(detail.ticket.id)
                    setDetail(d)
                  }}
                >
                  {Object.entries(STATUS_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                </select>
              </div>

              <div style={{ display: 'flex', gap: 8, margin: '16px 0 20px' }}>
                <button
                  className="btn btn-primary btn-sm"
                  onClick={() => {
                    const last = [...detail.messages].reverse().find((m: any) => m.direction === 'outgoing')
                    setSendMail({
                      to: detail.ticket.recipient ?? '',
                      subject: detail.ticket.subject,
                      body: last?.body ?? '',
                    })
                  }}
                >
                  <Icon name="send" size={13} /> Отправить письмо
                </button>
                <button className="btn btn-sm" onClick={() => followUp(detail.ticket)}>
                  <Icon name="clock" size={13} /> Сделать follow-up
                </button>
                <button
                  className="btn btn-sm"
                  onClick={() => {
                    const last = [...detail.messages].reverse().find((m: any) => m.direction === 'outgoing')
                    navigator.clipboard.writeText(`${detail.ticket.subject}\n\n${last?.body ?? ''}`)
                    app.toast('Текст скопирован', 'success')
                  }}
                >
                  <Icon name="copy" size={13} /> Копировать
                </button>
                <button className="btn btn-sm" onClick={() => window.api.tickets.update(detail.ticket.id, { status: 'resolved' }).then(load)}>
                  <Icon name="check" size={13} /> Пометить решённым
                </button>
                <button
                  className="btn btn-danger btn-sm"
                  onClick={async () => {
                    if (!confirm('Удалить обращение и его историю?')) return
                    await window.api.tickets.remove(detail.ticket.id)
                    setSelectedId(null)
                    await load()
                  }}
                >
                  <Icon name="trash" size={13} /> Удалить
                </button>
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                {detail.messages.length === 0 && <div style={{ color: 'var(--muted)', fontSize: 12.5 }}>Сообщений пока нет.</div>}
                {detail.messages.map((m: any) => (
                  <div key={m.id} className="card card-pad" style={m.direction === 'outgoing' ? { borderColor: '#2e3320' } : {}}>
                    <div style={{ display: 'flex', gap: 8, fontSize: 11.5, color: 'var(--muted)', marginBottom: 8 }}>
                      <Badge tone={m.direction === 'outgoing' ? 'lime' : 'blue'}>{m.direction === 'outgoing' ? 'исходящее' : 'входящее'}</Badge>
                      <span>{m.direction === 'outgoing' ? 'Вы' : m.sender}</span>
                      <span>·</span>
                      <span>{fmtDate(m.timestamp, true)}</span>
                    </div>
                    <div style={{ fontSize: 13, color: 'var(--text-2)', whiteSpace: 'pre-wrap' }}>{m.body}</div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>

      {sendMail && (
        <Modal title="Отправить письмо" onClose={() => setSendMail(null)} wide>
          <Field label="Кому"><input className="input" value={sendMail.to} onChange={(e) => setSendMail({ ...sendMail, to: e.target.value })} /></Field>
          <Field label="Тема"><input className="input" value={sendMail.subject} onChange={(e) => setSendMail({ ...sendMail, subject: e.target.value })} /></Field>
          <Field label="Текст"><textarea className="input" style={{ minHeight: 240 }} value={sendMail.body} onChange={(e) => setSendMail({ ...sendMail, body: e.target.value })} /></Field>
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
            <button className="btn" onClick={() => setSendMail(null)}>Отмена</button>
            <button
              className="btn btn-primary"
              onClick={async () => {
                if (!mailAccounts.length) {
                  app.toast('Сначала подключите почту в разделе «Почта»', 'error')
                  return
                }
                if (!confirm(`Отправить письмо на ${sendMail.to}?`)) return
                try {
                  await window.api.email.send({ accountId: mailAccounts[0].id, to: sendMail.to, subject: sendMail.subject, body: sendMail.body, ticketId: detail?.ticket.id })
                  app.toast('Письмо отправлено', 'success')
                  setSendMail(null)
                  await load()
                  if (selectedId) setDetail(await window.api.tickets.get(selectedId))
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

      {draft && (
        <Modal title="Новое обращение" onClose={() => setDraft(null)}>
          <Field label="Тема"><input className="input" value={draft.subject} onChange={(e) => setDraft({ ...draft, subject: e.target.value })} placeholder="Support Request — Artist — Release — Issue" /></Field>
          <div className="row2">
            <Field label="Категория">
              <select className="input" value={draft.category} onChange={(e) => setDraft({ ...draft, category: e.target.value })}>
                {Object.entries(CATEGORY_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </select>
            </Field>
            <Field label="Получатель" hint="Только официальные контакты Broma 16">
              <select className="input" value={draft.recipient} onChange={(e) => setDraft({ ...draft, recipient: e.target.value })}>
                <option value="">— не указан —</option>
                {contacts.map((c) => <option key={c.id} value={c.email}>{c.email} ({c.department})</option>)}
              </select>
            </Field>
          </div>
          <Field label="Текст письма"><textarea className="input" style={{ minHeight: 220 }} value={draft.body} onChange={(e) => setDraft({ ...draft, body: e.target.value })} /></Field>
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
            <button className="btn" onClick={() => setDraft(null)}>Отмена</button>
            <button
              className="btn btn-primary"
              disabled={!draft.subject.trim()}
              onClick={async () => {
                const rows = await window.api.tickets.create(draft)
                setTickets(rows)
                setSelectedId(rows[0]?.id ?? null)
                setDraft(null)
                app.toast('Обращение создано', 'success')
              }}
            >
              <Icon name="check" size={14} /> Создать
            </button>
          </div>
        </Modal>
      )}
    </div>
  )
}
