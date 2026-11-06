import React from 'react'
import { useApp } from '../store'
import { Icon } from './ui'

const NAV = [
  { id: 'chat', icon: 'chat', label: 'Чат с агентом' },
  { id: 'inbox', icon: 'inbox', label: 'Заявки' },
  { id: 'faq', icon: 'book', label: 'FAQ Broma 16' },
  { id: 'tickets', icon: 'ticket', label: 'Обращения' },
  { id: 'releases', icon: 'disc', label: 'Мои релизы' },
  { id: 'email', icon: 'mail', label: 'Почта' },
] as const

export default function Sidebar() {
  const { screen, setScreen } = useApp()
  return (
    <div className="rail">
      <div className="rail-logo">B</div>
      {NAV.map((n) => (
        <button
          key={n.id}
          className={`rail-item ${screen === n.id ? 'active' : ''}`}
          onClick={() => setScreen(n.id)}
          aria-label={n.label}
        >
          <Icon name={n.icon} size={19} />
          <span className="rail-label">{n.label}</span>
        </button>
      ))}
      <div className="rail-bottom">
        <button
          className={`rail-item ${screen === 'settings' ? 'active' : ''}`}
          onClick={() => setScreen('settings')}
          aria-label="Настройки"
        >
          <Icon name="settings" size={19} />
          <span className="rail-label">Настройки</span>
        </button>
      </div>
    </div>
  )
}
