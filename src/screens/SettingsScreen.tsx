import React from 'react'
import type { AppSettings, EmailAccount } from '@shared/types'
import { useApp } from '../store'
import { Icon, Field, Badge, Spinner } from '../components/ui'
import { fmtDate } from '../lib/format'
import VisionModal from '../components/VisionModal'
import type { VisionState } from '@shared/types'

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
  const [vision, setVision] = React.useState<VisionState | null>(null)
  const [visionOpen, setVisionOpen] = React.useState(false)
  const [acc, setAcc] = React.useState<any>(null)
  const [accLogin, setAccLogin] = React.useState('')
  const [accPassword, setAccPassword] = React.useState('')
  const [accRemember, setAccRemember] = React.useState(false)
  const [accOpenOnStart, setAccOpenOnStart] = React.useState(false)
  const [accBusy, setAccBusy] = React.useState(false)

  React.useEffect(() => {
    void window.api.email.accounts().then(setAccounts)
    void window.api.browser.state().then(setBrowserState)
    void window.api.vision.get().then(setVision)
    void window.api.account.state().then((st) => {
      setAcc(st)
      setAccLogin(st.login ?? '')
      setAccRemember(st.remember)
      setAccOpenOnStart(st.openOnStart)
    })
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
                <h3>Анализ изображений</h3>
                <p className="sub">
                  Обложки, скриншоты кабинета и статистики. Если основная модель текстовая (DeepSeek), здесь нужна
                  мультимодальная модель — она опишет картинку, и агент продолжит работу.
                </p>
                <div className="card card-pad">
                  {vision ? (
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                      <Badge tone="green">подключено</Badge>
                      <b style={{ fontSize: 13 }}>{vision.model}</b>
                      <span style={{ color: 'var(--muted)', fontSize: 12 }}>· {vision.provider}</span>
                      <span style={{ color: 'var(--muted)', fontSize: 12 }}>· ключ {vision.keyHint ?? '—'}</span>
                      <div style={{ flex: 1 }} />
                      <button className="btn btn-sm" onClick={() => setVisionOpen(true)}>Изменить</button>
                    </div>
                  ) : (
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                      <span style={{ color: 'var(--text-2)', fontSize: 12.6, flex: 1 }}>
                        Не подключено — картинки пока не анализируются.
                      </span>
                      <button className="btn btn-primary btn-sm" onClick={() => setVisionOpen(true)}>
                        <Icon name="image" size={14} /> Подключить vision-модель
                      </button>
                    </div>
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
                  Агент работает с кабинетом в отдельном управляемом браузере. 2FA и CAPTCHA всегда проходите вы —
                  приложение не обходит защиту. Пароль (если включите галочку) хранится только в зашифрованном
                  виде в системном хранилище секретов и используется лишь для заполнения формы входа.
                </p>

                <div className="card card-pad">
                  <div className="switch" style={{ paddingTop: 0 }}>
                    <div>
                      <div className="sw-title">Запоминать вход в аккаунт</div>
                      <div className="sw-hint">
                        Логин и пароль сохраняются в Keychain/DPAPI. При запуске приложение само откроет кабинет,
                        подставит данные — вам останется подтвердить вход (и 2FA, если включена).
                      </div>
                    </div>
                    <button className={`toggle ${accRemember ? 'on' : ''}`} onClick={() => setAccRemember(!accRemember)} />
                  </div>

                  {accRemember && (
                    <div style={{ marginTop: 12 }}>
                      <div className="row2">
                        <Field label="Email / логин">
                          <input className="input" value={accLogin} onChange={(e) => setAccLogin(e.target.value)} placeholder="you@example.com" autoComplete="username" />
                        </Field>
                        <Field
                          label="Пароль"
                          hint={acc?.hasPassword ? `Сохранён: ${acc.passwordHint}. Оставьте пустым, чтобы не менять.` : 'Будет зашифрован системным хранилищем'}
                        >
                          <input className="input" type="password" value={accPassword} onChange={(e) => setAccPassword(e.target.value)} placeholder="••••••••" autoComplete="current-password" />
                        </Field>
                      </div>
                      <div className="switch" style={{ paddingTop: 4 }}>
                        <div>
                          <div className="sw-title">Открывать кабинет при запуске</div>
                          <div className="sw-hint">Через несколько секунд после старта — чтобы не жать «Открыть кабинет» вручную.</div>
                        </div>
                        <button className={`toggle ${accOpenOnStart ? 'on' : ''}`} onClick={() => setAccOpenOnStart(!accOpenOnStart)} />
                      </div>
                    </div>
                  )}

                  <div style={{ display: 'flex', gap: 8, marginTop: 14, flexWrap: 'wrap' }}>
                    <button
                      className="btn btn-primary"
                      disabled={accBusy || (accRemember && !accLogin.trim() && !acc?.hasPassword)}
                      onClick={async () => {
                        setAccBusy(true)
                        try {
                          const st = await window.api.account.save({
                            login: accLogin,
                            password: accPassword || undefined,
                            remember: accRemember,
                            openOnStart: accRemember ? accOpenOnStart : false,
                          })
                          setAcc(st)
                          setAccPassword('')
                          app.toast('Данные входа сохранены', 'success')
                        } catch (e: any) {
                          app.toast(e?.message ?? 'Не удалось сохранить', 'error')
                        } finally {
                          setAccBusy(false)
                        }
                      }}
                    >
                      <Icon name="check" size={14} /> Сохранить вход
                    </button>
                    <button
                      className="btn"
                      onClick={async () => {
                        const res = await window.api.account.autoLogin()
                        app.toast(res.note, res.ok ? 'success' : 'error')
                      }}
                    >
                      <Icon name="external" size={14} /> Войти сейчас
                    </button>
                    {acc?.hasPassword && (
                      <button
                        className="btn btn-ghost"
                        onClick={async () => {
                          if (!confirm('Удалить сохранённый пароль?')) return
                          const st = await window.api.account.forget()
                          setAcc(st)
                          setAccRemember(false)
                          setAccPassword('')
                          app.toast('Сохранённый пароль удалён', 'success')
                        }}
                      >
                        Забыть пароль
                      </button>
                    )}
                  </div>
                </div>

                <div className="hr" />
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  <button className="btn" onClick={() => window.api.browser.open('https://broma16.com/ru/contact/')}>
                    Контактная форма
                  </button>
                  <button className="btn btn-danger" onClick={async () => {
                    if (!confirm('Очистить сохранённую сессию Broma 16 (куки и кэш)? Пароль останется сохранённым.')) return
                    await window.api.system.logoutAccount()
                    app.toast('Сессия кабинета очищена', 'success')
                  }}>
                    <Icon name="trash" size={14} /> Очистить сессию
                  </button>
                </div>
                <div style={{ fontSize: 12, color: 'var(--muted)', display: 'grid', gap: 5, marginTop: 12 }}>
                  <div>Последняя страница: {acc?.session?.url ?? browserState?.url ?? '—'}</div>
                  <div>Заголовок: {acc?.session?.title ?? browserState?.title ?? '—'}</div>
                  <div>Сохранённый пароль: {acc?.hasPassword ? acc.passwordHint : 'нет'}</div>
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

      {visionOpen && (
        <VisionModal
          current={vision}
          presets={app.boot?.providers ?? []}
          onClose={() => setVisionOpen(false)}
          onSaved={(v) => {
            setVision(v)
            void window.api.vision.get().then(setVision)
          }}
        />
      )}
    </div>
  )
}
