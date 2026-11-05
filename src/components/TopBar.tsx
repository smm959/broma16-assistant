import React from 'react'
import { useApp } from '../store'
import { Icon } from './ui'
import { timeAgo } from '../lib/format'

const TITLES: Record<string, [string, string]> = {
  chat: ['Broma 16 Assistant', 'Персональный AI-менеджер по релизам и дистрибуции'],
  faq: ['База знаний Broma 16', 'Официальные статьи Help Center с датой проверки'],
  tickets: ['Обращения', 'История писем и ответов поддержки'],
  releases: ['Мои релизы', 'UPC, ISRC, даты и статусы'],
  email: ['Почта', 'Входящие, ответы Broma 16 и отправка'],
  settings: ['Настройки', 'AI, профиль, безопасность'],
}

export default function TopBar() {
  const app = useApp()
  const { screen, connection, knowledge, running, setConnectOpen, activityOpen, setActivityOpen } = app
  const [title, sub] = (TITLES[screen] ?? TITLES.chat) as [string, string]
  const online = Boolean(connection?.hasKey)
  const providerName = app.boot?.providers.find((p) => p.id === connection?.provider)?.name ?? connection?.provider ?? ''

  return (
    <div className="topbar">
      <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
        <div className="topbar-title">{title}</div>
        <div className="topbar-sub">
          {screen === 'chat'
            ? running
              ? 'Агент работает…'
              : connection
                ? `${providerName} · ${connection.model}${knowledge?.lastSync ? ` · FAQ обновлён ${timeAgo(knowledge.lastSync)}` : ''}`
                : 'AI не подключён'
            : sub}
        </div>
      </div>
      <div className="topbar-spacer" />
      {screen === 'chat' && (
        <button className="btn btn-ghost btn-sm" onClick={() => setActivityOpen(!activityOpen)} title="Панель действий агента">
          <Icon name="sparkle" size={15} /> {activityOpen ? 'Скрыть действия' : 'Действия агента'}
        </button>
      )}
      <button
        className={`ai-chip ${online ? 'online' : 'offline'}`}
        onClick={() => setConnectOpen(true)}
        title={online ? 'Настроить AI' : 'Подключить AI'}
      >
        <span className="dot" />
        {online ? `${connection?.model}` : 'AI не подключён'}
      </button>
      <button className="btn btn-primary btn-sm" onClick={() => setConnectOpen(true)}>
        <Icon name="sparkle" size={14} /> Подключить AI / API
      </button>
    </div>
  )
}
