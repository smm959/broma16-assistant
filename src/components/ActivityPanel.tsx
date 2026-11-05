import React from 'react'
import type { ActivityEvent } from '@shared/types'
import { Icon } from './ui'
import { timeAgo } from '../lib/format'

const ICONS: Record<string, string> = {
  tool: 'search',
  success: 'check',
  error: 'x',
  warning: 'x',
  approval: 'clock',
  source: 'book',
  thinking: 'sparkle',
  info: 'sparkle',
}

export default function ActivityPanel({
  events,
  running,
  current,
  pendingCount,
}: {
  events: ActivityEvent[]
  running: boolean
  current?: string
  pendingCount: number
}) {
  return (
    <div className="activity">
      <div className="activity-head">
        <span className="activity-title">Действия агента</span>
        {running && <span className="badge badge-lime">работает</span>}
      </div>
      <div className={`runtime ${running ? 'active' : ''}`}>
        <span className="pulse" />
        <span style={{ flex: 1 }}>{running ? current || 'Выполняю задачу…' : pendingCount ? 'Жду вашего подтверждения' : 'Готов к работе'}</span>
      </div>
      <div className="act-list">
        {events.length === 0 && (
          <div className="act-empty">
            Здесь будет видно, что делает агент: какие сайты открывает, что ищет,
            какие письма готовит. Технические логи скрыты — только понятные шаги.
          </div>
        )}
        {events.map((e) => (
          <div className="act-item" key={e.id}>
            <div className="act-rail">
              <span className={`act-dot ${e.kind}`} />
            </div>
            <div className="act-body">
              <div className="act-name">{e.title}</div>
              {e.detail && <div className="act-detail">{e.detail}</div>}
              <div className="act-meta">
                <span>{new Date(e.createdAt).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}</span>
                {e.durationMs ? <span>· {(e.durationMs / 1000).toFixed(1)} с</span> : null}
                {e.tool ? <span>· {e.tool}</span> : null}
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
