import React from 'react'
import type { AppSettings, EmailAccount } from '@shared/types'
import { useApp } from '../store'
import { Icon, Field, Badge, Spinner } from '../components/ui'
import { fmtDate } from '../lib/format'

const SECTIONS = [
  ['ai', 'AI и модели'],
  ['profile', 'Профиль'],
  ['mail', 'Почта'],
  ['account', 'Аккаунт Broma 16'],
  ['data', 'Данные и безопасность'],
  ['about', 'О приложении'],
] as const

export default function SettingsScreen() {
  const app = useApp()
  const [section, setSection] = React.useState<string>('ai')
  const [form, setForm] = React.useState<Partial<AppSettings>>(app.settings ?? {})
  const [accounts, setAccounts] = React.useState<EmailAccount[]>([])
  const [saved, setSaved] = React.useState(false)
  const [browserState, setBrowserState] = React.useState<any>(null)

  React.useEffect(() => {
    void window.api.email.accounts().then(setAccounts)
    void window.api.browser.state().then(setBrowserState)
  }, [])

  const saveProfile = async () => {
    await app.onSettings(form)
    setSaved(true)
    setTimeout(() => setSaved(false), 1800)
  }

  const set = (k: keyof AppSettings, v: any) => setForm((f) => ({ ...f, [k]: v }))

  return (
    <div className="screen">
      <div className="screen-head">
        <div>
          <h1>Настройки</h1>
          <p>Версия {app.boot?.version} · данные хранятся локально на этом компьютере</p>
        </div>
      </div>
      <div className="screen-body">
        <div className="settings-grid">
          <div className="settings-nav">
            {SECTIONS.map(([id, label]) => (
              <button key={id} className={section === id ? 'active' : ''} onClick={() => setSection(id)}>{label}</button>
            ))}
          </div>

          <div style={{ maxWidth: 720 }}>
            {section === 'ai' && (
              <div className="settings-section">
                <h3>Нейросеть</h3>
                <p className="sub">LLM — «мозг» приложения, но все инструменты, база знаний и действия работают независимо от модели.</p>
                <div className="card card-pad">
                  {app.connection ? (
                    <>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                        <Badge tone="green">подключено</Badge>
                        <b style={{ fontSize: 13.5 }}>{app.connection.model}</b>
                        <span style={{ color: 'var(--muted)', fontSize: 12 }}>· {app.connection.provider}</span>
                        <div style={{ flex: 1 }} />
                        <button className="btn btn-sm" onClick={() => app.setConnectOpen(true)}>Изменить</button>
                      </div>
                      <div className="hr" />
                      <div style={{ fontSize: 12, color: 'var(--muted)', display: 'grid', gap: 6 }}>
                        <div>Ключ: {app.connection.keyHint ?? '—'} (хранится в системном хранилище секретов)</div>
                        <div>Base URL: {app.connection.baseUrl}</div>
                        <div>
                          Проверка: {app.connection.lastTestedAt ? `${app.connection.lastTestOk ? 'успешно' : 'ошибка'} · ${fmtDate(app.connection.lastTestedAt, true)}` : 'не выполнялась'}
                        </div>
                        {app.connection.lastTestError && <div style={{ color: '#ff9b9b' }}>{app.connection.lastTestError}</div>}
                      </div>
                    </>
                  ) : (
                    <>
                      <p style={{ margin: 0, color: 'var(--text-2)', fontSize: 12.8 }}>
                        AI ещё не подключён. Поддерживаются DeepSeek, OpenAI, Anthropic, Google Gemini и любой OpenAI-совместимый endpoint (OpenRouter, Ollama, LM Studio).
                      </p>
                      <button className="btn btn-primary" style={{ marginTop: 12 }} onClick={() => app.setConnectOpen(true)}>
                        <Icon name="sparkle" size={14} /> Подключить AI / API
                      </button>
                    </>
                  )}
                </div>
                <div className="hr" />
                <h3>База знаний</h3>
                <p className="sub">{app.knowledge?.articles ?? 0} статей · синхронизация {app.knowledge?.lastSync ? fmtDate(app.knowledge.lastSync, true) : 'не выполнялась'}</p>
                <button
                  className="btn"
                  onClick={async () => {
                    try {
                      const s = await window.api.kb.sync()
                      app.onKnowledge(s)
                      app.toast(`FAQ обновлён: ${s.articles} статей`, 'success')
                    } catch (e: any) {
                      app.toast(e?.message ?? 'Ошибка обновления', 'error')
                    }
                  }}
                >
                  <Icon name="refresh" size={14} /> Обновить FAQ из Help Center
                </button>
              </div>
            )}

            {section === 'profile' && (
              <div className="settings-section">
                <h3>Профиль</h3>
                <p className="sub">Эти данные агент подставляет в письма и использует в работе.</p>
                <div className="row2">
                  <Field label="Ваше имя"><input className="input" value={form.userName ?? ''} onChange={(e) => set('userName', e.target.value)} /></Field>
                  <Field label="Аккаунт / лейбл"><input className="input" value={form.accountName ?? ''} onChange={(e) => set('accountName', e.target.value)} /></Field>
                </div>
                <div className="row2">
                  <Field label="Название лейбла"><input className="input" value={form.labelName ?? ''} onChange={(e) => set('labelName', e.target.value)} /></Field>
                  <Field label="Email для ответов"><input className="input" value={form.contactEmail ?? ''} onChange={(e) => set('contactEmail', e.target.value)} /></Field>
                </div>
                <Field label="Подпись в письмах"><textarea className="input" value={form.signature ?? ''} onChange={(e) => set('signature', e.target.value)} placeholder="Best regards, Music 959" /></Field>
                <div className="switch">
                  <div>
                    <div className="sw-title">Всегда подтверждать действия</div>
                    <div className="sw-hint">Отправка писем, клики и заполнение форм в аккаунте выполняются только после вашего подтверждения. Отключать не рекомендуется.</div>
                  </div>
                  <button className={`toggle ${form.confirmEverything !== false ? 'on' : ''}`} onClick={() => set('confirmEverything', !(form.confirmEverything !== false))} />
                </div>
                <div className="switch">
                  <div>
                    <div className="sw-title">Автоматические follow-up</div>
                    <div className="sw-hint">Напоминать о неотвеченных обращениях через {form.autoFollowUpDays ?? 14} дней. Отправка всё равно требует подтверждения.</div>
                  </div>
                  <button className={`toggle ${form.autoSendFollowUp ? 'on' : ''}`} onClick={() => set('autoSendFollowUp', !form.autoSendFollowUp)} />
                </div>
                <button className="btn btn-primary" onClick={saveProfile} style={{ marginTop: 14 }}>
                  {saved ? <Icon name="check" size={14} /> : null} {saved ? 'Сохранено' : 'Сохранить'}
                </button>
              </div>
            )}

            {section === 'mail' && (
              <div className="settings-section">
                <h3>Почтовые аккаунты</h3>
                <p className="sub">IMAP/SMTP с паролем приложения. Пароли хранятся в Keychain / DPAPI.</p>
                {accounts.length === 0 && <p style={{ color: 'var(--muted)' }}>Почта не подключена.</p>}
                <div className="list">
                  {accounts.map((a) => (
                    <div key={a.id} className="list-row" style={{ cursor: 'default' }}>
                      <div className="grow">
                        <div className="t">{a.email}</div>
                        <div className="s">{a.imapHost} · {a.smtpHost} · {a.lastSyncAt ? `синх. ${fmtDate(a.lastSyncAt, true)}` : 'не синхронизировано'}</div>
                      </div>
                      <Badge tone={a.status === 'connected' ? 'green' : 'red'}>{a.status === 'connected' ? 'подключено' : 'ошибка'}</Badge>
                      <button className="icon-btn" title="Удалить" onClick={async () => {
                        if (!confirm(`Отключить ${a.email}?`)) return
                        setAccounts(await window.api.email.remove(a.id))
                      }}><Icon name="trash" size={14} /></button>
                    </div>
                  ))}
                </div>
                <button className="btn" style={{ marginTop: 12 }} onClick={() => app.setScreen('email')}>
                  <Icon name="plus" size={14} /> Подключить почту
                </button>
              </div>
            )}

            {section === 'account' && (
              <div className="settings-section">
                <h3>Личный кабинет Broma 16</h3>
                <p className="sub">
                  Агент открывает кабинет в отдельном управляемом браузере. Вход и 2FA выполняете вы — приложение не обходит защиту и не хранит пароль от аккаунта.
                </p>
                <div className="card card-pad">
                  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                    <button className="btn btn-primary" onClick={() => window.api.browser.open('https://africa.broma16.com/proceed')}>
                      <Icon name="external" size={14} /> Открыть кабинет
                    </button>
                    <button className="btn" onClick={() => window.api.browser.open('https://broma16.com/ru/contact/')}>
                      Контактная форма
                    </button>
                    <button className="btn btn-danger" onClick={async () => {
                      if (!confirm('Очистить сохранённую сессию Broma 16 (куки и кэш)?')) return
                      await window.api.system.logoutAccount()
                      app.toast('Сессия кабинета очищена', 'success')
                    }}>
                      <Icon name="trash" size={14} /> Очистить сессию
                    </button>
                  </div>
                  <div className="hr" />
                  <div style={{ fontSize: 12, color: 'var(--muted)', display: 'grid', gap: 5 }}>
                    <div>Последняя страница: {browserState?.url ?? '—'}</div>
                    <div>Заголовок: {browserState?.title ?? '—'}</div>
                  </div>
                </div>
              </div>
            )}

            {section === 'data' && (
              <div className="settings-section">
                <h3>Данные и безопасность</h3>
                <p className="sub">Всё хранится локально. Ключи и пароли — только в зашифрованном виде.</p>
                <div className="card card-pad" style={{ fontSize: 12.5, color: 'var(--text-2)', display: 'grid', gap: 8 }}>
                  <div>База данных: <span className="mono">{app.boot?.dbPath}</span></div>
                  <div>Диалоги: {app.conversations.length} · FAQ: {app.knowledge?.articles ?? 0} статей · Почта: {accounts.length} аккаунт(ов)</div>
                </div>
                <div className="hr" />
                <button
                  className="btn btn-danger"
                  onClick={async () => {
                    if (!confirm('Удалить всю историю диалогов, сообщений и кэш писем? FAQ и релизы останутся.')) return
                    await window.api.system.clearData()
                    app.toast('История очищена', 'success')
                    await app.refresh()
                  }}
                >
                  <Icon name="trash" size={14} /> Очистить историю диалогов
                </button>
                <div className="hr" />
                <button
                  className="btn btn-danger"
                  onClick={async () => {
                    if (!confirm('Отключить аккаунт Broma 16 и удалить сессию браузера?')) return
                    await window.api.system.logoutAccount()
                    app.toast('Аккаунт отключён', 'success')
                  }}
                >
                  Disconnect Account
                </button>
              </div>
            )}

            {section === 'about' && (
              <div className="settings-section">
                <h3>Broma 16 Assistant</h3>
                <p className="sub">Персональный AI-менеджер для работы с дистрибьютором Broma 16.</p>
                <div className="card card-pad" style={{ fontSize: 12.5, color: 'var(--text-2)', lineHeight: 1.7 }}>
                  <div>Версия: {app.boot?.version}</div>
                  <div>Официальные источники: broma16.com, Help Center (Freshdesk), портал дистрибуции.</div>
                  <div>Агент не выдумывает контакты и правила: неподтверждённые адреса помечены как UNVERIFIED.</div>
                  <div style={{ marginTop: 8 }}>
                    <button className="btn btn-ghost btn-sm" onClick={() => window.api.system.openExternal('https://broma16nlbv.freshdesk.com/support/solutions')}>
                      <Icon name="external" size={13} /> Help Center
                    </button>
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
