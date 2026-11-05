import React from 'react'
import type { ActivityEvent, AttachmentRef, ChatMessage, PendingAction, ProviderConnection } from '@shared/types'
import { useApp } from '../store'
import { Icon, Spinner, Empty } from '../components/ui'
import { MessageView, ActionCard, AttachmentList } from '../components/MessageView'
import ActivityPanel from '../components/ActivityPanel'
import { timeAgo, fmtBytes } from '../lib/format'

const SUGGESTIONS = [
  { t: 'Проверить новый релиз', d: 'Что нужно сделать до выхода трека и какие возможности Broma 16 я ещё не использовал' },
  { t: 'Проблема с площадкой', d: 'Релиз не появился на Spotify — разберись, в чём причина, и подготовь обращение' },
  { t: 'Питчинг и промо', d: 'Подготовь маркетинговый питчинг для нового релиза и письмо в Broma 16' },
  { t: 'Разобрать отчёт', d: 'Объясни мой отчёт по роялти и как запросить выплату' },
]

export default function ChatScreen({
  connection,
  onConnect,
  activityOpen,
  setActivityOpen,
}: {
  connection: ProviderConnection | null
  onConnect: () => void
  activityOpen: boolean
  setActivityOpen: (v: boolean) => void
}) {
  const app = useApp()
  const { conversationId, setConversationId, conversations, running, setRunning } = app
  const [messages, setMessages] = React.useState<ChatMessage[]>([])
  const [activity, setActivity] = React.useState<ActivityEvent[]>([])
  const [actions, setActions] = React.useState<PendingAction[]>([])
  const [streaming, setStreaming] = React.useState<{ id: string; text: string } | null>(null)
  const [input, setInput] = React.useState('')
  const [attachments, setAttachments] = React.useState<AttachmentRef[]>([])
  const [sending, setSending] = React.useState(false)
  const [currentActivity, setCurrentActivity] = React.useState<string>()
  const [showConvs, setShowConvs] = React.useState(true)
  const [dragOver, setDragOver] = React.useState(false)

  const convRef = React.useRef(conversationId)
  convRef.current = conversationId
  const scrollRef = React.useRef<HTMLDivElement>(null)
  const taRef = React.useRef<HTMLTextAreaElement>(null)
  const stickRef = React.useRef(true)

  const loadConversation = React.useCallback(async (id?: string) => {
    if (!id) {
      setMessages([])
      setActivity([])
      setActions([])
      return
    }
    const [msgs, acts, pending] = await Promise.all([
      window.api.conv.messages(id),
      window.api.activity.list(id),
      window.api.actions.list(id),
    ])
    setMessages(msgs)
    setActivity(acts)
    setActions(pending)
    setStreaming(null)
  }, [])

  React.useEffect(() => {
    void loadConversation(conversationId)
  }, [conversationId, loadConversation])

  React.useEffect(() => {
    const offDelta = window.api.events.onDelta((p) => {
      if (p.conversationId !== convRef.current) return
      setStreaming((s) => ({ id: p.messageId, text: (s && s.id === p.messageId ? s.text : '') + p.text }))
    })
    const offMsg = window.api.events.onMessage((m) => {
      if (m.conversationId !== convRef.current) return
      setMessages((prev) => {
        const idx = prev.findIndex((x) => x.id === m.id)
        if (idx >= 0) {
          const copy = [...prev]
          copy[idx] = m
          return copy
        }
        return [...prev, m]
      })
      setStreaming((s) => (m.role === 'assistant' ? null : s))
      setSending(false)
    })
    const offAct = window.api.events.onActivity((e) => {
      if (e.conversationId && e.conversationId !== convRef.current) return
      setActivity((prev) => [e, ...prev.filter((x) => x.id !== e.id)])
    })
    const offAction = window.api.events.onAction((a) => {
      if (a.conversationId && a.conversationId !== convRef.current) return
      setActions((prev) => {
        const idx = prev.findIndex((x) => x.id === a.id)
        if (idx >= 0) {
          const copy = [...prev]
          copy[idx] = a
          return copy
        }
        return [a, ...prev]
      })
    })
    const offRuntime = window.api.events.onRuntime((s) => {
      if (s.conversationId && s.conversationId !== convRef.current) return
      setRunning(s.running)
      setCurrentActivity(s.currentActivity)
      if (s.phase === 'awaiting_user') setSending(false)
    })
    const offKb = window.api.events.onKbStatus(() => undefined)
    return () => {
      offDelta()
      offMsg()
      offAct()
      offAction()
      offRuntime()
      offKb()
    }
  }, [setRunning])

  // автоскролл
  React.useEffect(() => {
    const el = scrollRef.current
    if (!el || !stickRef.current) return
    el.scrollTop = el.scrollHeight
  }, [messages, streaming, actions])

  const onScroll = () => {
    const el = scrollRef.current
    if (!el) return
    stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120
  }

  const send = async () => {
    const text = input.trim()
    if (!text || sending) return
    let convId = conversationId
    if (!convId) {
      const c = await window.api.conv.create()
      convId = c.id
      setConversationId(c.id)
    }
    setSending(true)
    setInput('')
    const atts = attachments
    setAttachments([])
    stickRef.current = true
    try {
      await window.api.chat.send({ conversationId: convId, text, attachments: atts })
      app.refreshConversations()
    } catch (e: any) {
      app.toast(e?.message ?? 'Не удалось отправить сообщение', 'error')
      setSending(false)
    }
    requestAnimationFrame(() => taRef.current?.focus())
  }

  const newChat = async () => {
    const c = await window.api.conv.create()
    setConversationId(c.id)
    app.refreshConversations()
    setMessages([])
    setActivity([])
    setActions([])
  }

  const addAttachments = async (files: FileList | File[]) => {
    const arr = Array.from(files).slice(0, 8)
    for (const f of arr) {
      const path = window.api.attachment.pathFor(f)
      try {
        if (path) {
          const refs = await window.api.attachment.fromPaths([path])
          setAttachments((a) => [...a, ...refs])
        } else {
          const bytes = new Uint8Array(await f.arrayBuffer())
          const ref = await window.api.attachment.fromBytes(f.name || `file-${Date.now()}`, f.type || 'application/octet-stream', bytes)
          setAttachments((a) => [...a, ref])
        }
      } catch (e: any) {
        app.toast(`Не удалось прикрепить «${f.name}»: ${e?.message ?? e}`, 'error')
      }
    }
  }

  const pending = actions.filter((a) => a.status === 'pending')
  const recentActions = actions.filter((a) => a.status !== 'pending').slice(0, 3)
  const lastAssistantId = [...messages].reverse().find((m) => m.role === 'assistant')?.id

  const approve = async (id: string) => {
    const res = await window.api.actions.approve(id)
    if (!res.ok) app.toast(res.error ?? 'Не удалось выполнить действие', 'error')
  }
  const reject = async (id: string) => {
    await window.api.actions.reject(id)
  }

  return (
    <div className={`workspace ${activityOpen ? '' : 'no-activity'} ${showConvs ? '' : 'no-convs'}`}>
      {showConvs && (
        <aside className="convs">
          <div className="convs-head">
            <span className="convs-title">Диалоги</span>
            <button className="icon-btn" onClick={newChat} title="Новый диалог"><Icon name="plus" size={16} /></button>
          </div>
          <div className="convs-list">
            {conversations.map((c) => (
              <div
                key={c.id}
                className={`conv ${c.id === conversationId ? 'active' : ''}`}
                onClick={() => setConversationId(c.id)}
              >
                <div className="conv-body">
                  <div className="conv-name">{c.title}</div>
                  <div className="conv-meta">{timeAgo(c.updatedAt)}</div>
                </div>
                <button
                  className="icon-btn conv-del"
                  title="Удалить диалог"
                  onClick={async (e) => {
                    e.stopPropagation()
                    await window.api.conv.remove(c.id)
                    if (conversationId === c.id) setConversationId(undefined)
                    app.refreshConversations()
                  }}
                >
                  <Icon name="trash" size={13} />
                </button>
              </div>
            ))}
            {conversations.length === 0 && (
              <div style={{ padding: '14px 10px', color: 'var(--muted)', fontSize: 12 }}>
                Пока пусто. Напишите первую задачу — диалог появится здесь.
              </div>
            )}
          </div>
        </aside>
      )}

      <div
        className="chat"
        onDragOver={(e) => {
          e.preventDefault()
          setDragOver(true)
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault()
          setDragOver(false)
          if (e.dataTransfer.files.length) void addAttachments(e.dataTransfer.files)
        }}
        style={dragOver ? { outline: '1px dashed var(--accent)', outlineOffset: -8, borderRadius: 12 } : undefined}
      >
        <div className="chat-scroll" ref={scrollRef} onScroll={onScroll}>
          <div className="chat-inner">
            {messages.length === 0 && !streaming && (
              <div className="hello">
                <div className="hello-kicker">Broma 16 Assistant</div>
                <h1 className="hello-title">Что делаем сегодня?</h1>
                <p className="hello-sub">
                  Опишите задачу обычным языком: разобраться с релизом, найти правила Broma 16, подготовить письмо
                  или проверить ответ поддержки. Я найду официальную информацию и выполню действия после вашего подтверждения.
                </p>
                {!connection && (
                  <div className="banner" style={{ marginTop: 18 }}>
                    <Icon name="sparkle" size={16} />
                    <div className="grow">Чтобы агент заработал, подключите AI-провайдера и API-ключ.</div>
                    <button className="btn btn-primary btn-sm" onClick={onConnect}>Подключить AI</button>
                  </div>
                )}
                <div className="hello-cards">
                  {SUGGESTIONS.map((s) => (
                    <button key={s.t} className="hello-card" onClick={() => { setInput(s.d); taRef.current?.focus() }}>
                      <b>{s.t}</b>
                      <span>{s.d}</span>
                    </button>
                  ))}
                </div>
              </div>
            )}

            {messages.map((m) => (
              <MessageView
                key={m.id}
                message={m}
                streaming={streaming?.id === m.id && running}
              />
            ))}

            {streaming && !messages.some((m) => m.id === streaming.id) && (
              <MessageView
                message={{ id: streaming.id, conversationId: conversationId ?? '', role: 'assistant', content: streaming.text, createdAt: Date.now() }}
                streaming
              />
            )}

            {(pending.length > 0 || recentActions.length > 0) && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {pending.map((a) => (
                  <ActionCard key={a.id} action={a} onApprove={() => approve(a.id)} onReject={() => reject(a.id)} />
                ))}
                {recentActions.map((a) => (
                  <ActionCard key={a.id} action={a} onApprove={() => approve(a.id)} onReject={() => reject(a.id)} />
                ))}
              </div>
            )}

            {sending && !streaming && (
              <div className="msg msg-assistant">
                <div className="msg-head">
                  <div className="msg-avatar">B</div>
                  <span>Broma 16 Assistant</span>
                </div>
                <div className="typing"><i /><i /><i /></div>
              </div>
            )}
          </div>
        </div>

        <div className="composer-wrap">
          <div className="composer">
            {attachments.length > 0 && (
              <div className="composer-att">
                {attachments.map((a) => (
                  <div className="att" key={a.id}>
                    {a.kind === 'image' && a.path ? (
                      <img src={`attachment://local${encodeURI(a.path)}`} alt="" />
                    ) : (
                      <div className="att-ico"><Icon name="paperclip" size={13} /></div>
                    )}
                    <span className="att-name" style={{ maxWidth: 140 }}>{a.filename}</span>
                    <button className="icon-btn" style={{ width: 20, height: 20 }} onClick={() => setAttachments((x) => x.filter((y) => y.id !== a.id))}>
                      <Icon name="x" size={11} />
                    </button>
                  </div>
                ))}
              </div>
            )}
            <textarea
              ref={taRef}
              rows={1}
              placeholder="Напишите задачу обычным языком…"
              value={input}
              onChange={(e) => {
                setInput(e.target.value)
                const el = e.target as HTMLTextAreaElement
                el.style.height = 'auto'
                el.style.height = Math.min(220, el.scrollHeight) + 'px'
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault()
                  void send()
                }
              }}
              onPaste={(e) => {
                const files = Array.from(e.clipboardData.files)
                if (files.length) {
                  e.preventDefault()
                  void addAttachments(files)
                }
              }}
            />
            <div className="composer-row">
              <button className="icon-btn" title="Прикрепить файл" onClick={async () => { const picked = await window.api.attachment.pick(); setAttachments((a) => [...a, ...picked]) }}>
                <Icon name="paperclip" size={17} />
              </button>
              <button className="icon-btn" title="Показать диалоги" onClick={() => setShowConvs(!showConvs)}>
                <Icon name="chat" size={16} />
              </button>
              <span className="composer-hint">Enter — отправить · Shift+Enter — новая строка</span>
              <div className="spacer" />
              {running ? (
                <button className="send-btn stop" title="Остановить" onClick={() => window.api.chat.stop(conversationId)}>
                  <Icon name="stop" size={15} />
                </button>
              ) : (
                <button className="send-btn" title="Отправить" disabled={!input.trim() || sending} onClick={send}>
                  {sending ? <Spinner size={14} /> : <Icon name="send" size={15} />}
                </button>
              )}
            </div>
          </div>
        </div>
      </div>

      {activityOpen && (
        <ActivityPanel events={activity} running={running} current={currentActivity} pendingCount={pending.length} />
      )}
    </div>
  )
}
