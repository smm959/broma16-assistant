import React from 'react'
import type { ChatMessage, PendingAction, SourceRef } from '@shared/types'
import { mdToHtml, fmtBytes, timeAgo } from '../lib/format'
import { Icon, Spinner } from './ui'

export function AttachmentList({ attachments }: { attachments: NonNullable<ChatMessage['attachments']> }) {
  return (
    <div className="attachments">
      {attachments.map((a) => (
        <div className="att" key={a.id} title={a.filename}>
          {a.kind === 'image' && a.path ? (
            <img src={`attachment://local${encodeURI(a.path)}`} alt={a.filename} />
          ) : (
            <div className="att-ico"><Icon name={a.kind === 'audio' ? 'audio' : 'image'} size={16} /></div>
          )}
          <div style={{ minWidth: 0 }}>
            <div className="att-name">{a.filename}</div>
            <div className="att-size">{fmtBytes(a.size)}</div>
          </div>
        </div>
      ))}
    </div>
  )
}

export function SourceChips({ sources }: { sources: SourceRef[] }) {
  if (!sources?.length) return null
  return (
    <div className="sources">
      {sources.map((s, i) => (
        <button
          key={i}
          className="source-chip"
          title={`${s.title}${s.verifiedAt ? `\nПроверено: ${new Date(s.verifiedAt).toLocaleDateString('ru-RU')}` : ''}`}
          onClick={() => s.url && window.api.system.openExternal(s.url)}
        >
          <span className="sc-dot" />
          {s.title.length > 58 ? s.title.slice(0, 58) + '…' : s.title}
          {s.url && <Icon name="external" size={11} />}
        </button>
      ))}
    </div>
  )
}

export function MessageView({ message, streaming }: { message: ChatMessage; streaming?: boolean }) {
  const isUser = message.role === 'user'
  const [copied, setCopied] = React.useState(false)

  const copy = async () => {
    await navigator.clipboard.writeText(message.content)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  return (
    <div className={`msg ${isUser ? 'msg-user' : 'msg-assistant'} ${message.error ? 'error' : ''}`}>
      <div className="msg-head">
        <div className="msg-avatar">{isUser ? 'Я' : 'B'}</div>
        <span>{isUser ? 'Вы' : 'Broma 16 Assistant'}</span>
        <span>·</span>
        <span>{timeAgo(message.createdAt)}</span>
        {!isUser && (
          <div className="msg-actions" style={{ marginLeft: 'auto' }}>
            <button className="icon-btn" onClick={copy} title="Скопировать">
              <Icon name={copied ? 'check' : 'copy'} size={14} />
            </button>
          </div>
        )}
      </div>
      {isUser ? (
        <div className="bubble">{message.content}</div>
      ) : (
        <div className="bubble">
          {message.content ? (
            <div className="md" dangerouslySetInnerHTML={{ __html: mdToHtml(message.content) }} />
          ) : streaming ? (
            <div className="typing"><i /><i /><i /></div>
          ) : null}
          {streaming && message.content && <span className="stream-caret" />}
          {message.sources?.length ? <SourceChips sources={message.sources} /> : null}
        </div>
      )}
      {message.attachments?.length ? <AttachmentList attachments={message.attachments} /> : null}
    </div>
  )
}

export function ActionCard({ action, onApprove, onReject }: { action: PendingAction; onApprove: () => Promise<void>; onReject: () => Promise<void> }) {
  const [busy, setBusy] = React.useState<'approve' | 'reject' | null>(null)
  const pending = action.status === 'pending'
  const done = action.status === 'done'
  const failed = action.status === 'failed'
  const rejected = action.status === 'rejected'

  return (
    <div className={`action-card ${done ? 'done' : ''} ${failed ? 'failed' : ''} ${rejected ? 'rejected' : ''}`}>
      <div className="action-head">
        <Icon name={done ? 'check' : rejected || failed ? 'x' : 'sparkle'} size={15} />
        {action.title}
        <span className={`badge ${done ? 'green' : rejected ? 'red' : failed ? 'red' : 'amber'}`}>
          {done ? 'выполнено' : rejected ? 'отклонено' : failed ? 'ошибка' : action.status === 'executing' ? 'выполняется' : 'нужно подтверждение'}
        </span>
      </div>
      {action.preview ? (
        <div className="action-preview">
          {action.preview.to && (
            <div className="pv-row"><span className="pv-label">Кому</span><span>{action.preview.to}</span></div>
          )}
          {action.preview.subject && (
            <div className="pv-row"><span className="pv-label">Тема</span><span>{action.preview.subject}</span></div>
          )}
          {action.preview.details?.map((d, i) => (
            <div className="pv-row" key={i}><span className="pv-label">{d.label}</span><span>{d.value}</span></div>
          ))}
          {action.preview.body && <pre className="pv-body">{action.preview.body}</pre>}
        </div>
      ) : (
        <p className="action-desc">{action.description}</p>
      )}
      {action.result && <div className="action-result">{action.result.split('\n')[0]}</div>}
      {action.error && <div className="action-result" style={{ color: '#ff9b9b' }}>{action.error}</div>}
      {pending && (
        <div className="action-actions">
          <button
            className="btn btn-primary btn-sm"
            disabled={busy !== null}
            onClick={async () => {
              setBusy('approve')
              await onApprove()
              setBusy(null)
            }}
          >
            {busy === 'approve' ? <Spinner /> : <Icon name="check" size={13} />} Подтвердить и выполнить
          </button>
          <button
            className="btn btn-sm"
            disabled={busy !== null}
            onClick={async () => {
              setBusy('reject')
              await onReject()
              setBusy(null)
            }}
          >
            Отменить
          </button>
        </div>
      )}
    </div>
  )
}
