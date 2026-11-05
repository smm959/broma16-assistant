import React from 'react'
import type { ProviderConnection, ProviderId, ProviderPreset } from '@shared/types'
import { Modal, Field, Icon, Spinner } from './ui'

export default function ConnectAIModal({
  connection,
  initialSetup,
  onClose,
  onSaved,
}: {
  connection: ProviderConnection | null
  initialSetup: boolean
  onClose: () => void
  onSaved: (c: ProviderConnection) => void
}) {
  const [presets, setPresets] = React.useState<ProviderPreset[]>([])
  const [providerId, setProviderId] = React.useState<ProviderId>(connection?.provider ?? 'deepseek')
  const [model, setModel] = React.useState(connection?.model ?? 'deepseek-chat')
  const [apiKey, setApiKey] = React.useState('')
  const [baseUrl, setBaseUrl] = React.useState(connection?.baseUrl ?? '')
  const [showKey, setShowKey] = React.useState(false)
  const [customModel, setCustomModel] = React.useState(false)
  const [models, setModels] = React.useState<string[]>([])
  const [busy, setBusy] = React.useState<null | 'test' | 'save'>(null)
  const [error, setError] = React.useState<string | null>(null)
  const [ok, setOk] = React.useState<string | null>(null)

  const preset = presets.find((p) => p.id === providerId)

  React.useEffect(() => {
    void window.api.bootstrap().then((b) => setPresets(b.providers))
  }, [])

  React.useEffect(() => {
    if (!preset) return
    const known = preset.models.map((m) => m.id)
    if (!known.includes(model)) {
      const current = preset.models[0]?.id ?? ''
      setModel(current)
    }
    setBaseUrl(connection?.provider === providerId ? connection.baseUrl ?? '' : preset.baseUrl)
    setError(null)
    setOk(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [providerId, presets.length])

  const modelOptions = React.useMemo(() => {
    const presetIds = preset?.models.map((m) => m.id) ?? []
    return [...new Set([...presetIds, ...models])]
  }, [preset, models])

  const doTest = async () => {
    setBusy('test')
    setError(null)
    setOk(null)
    try {
      const res = await window.api.provider.test({ provider: providerId, model, apiKey: apiKey || undefined, baseUrl: baseUrl || undefined })
      if (!res.ok) {
        setError(res.error ?? 'Не удалось подключиться')
      } else {
        if (res.models?.length) {
          setModels(res.models)
          if (!res.models.includes(model)) {
            const preferred = res.models.find((m) => /chat|sonnet|gpt-4|flash|deepseek/i.test(m) && !/embed|whisper|tts|image/i.test(m))
            if (preferred) setModel(preferred)
          }
        }
        setOk('Соединение установлено — провайдер ответил корректно')
      }
    } catch (e: any) {
      setError(e?.message ?? String(e))
    } finally {
      setBusy(null)
    }
  }

  const doSave = async () => {
    setBusy('save')
    setError(null)
    try {
      const c = await window.api.provider.save({ provider: providerId, model, apiKey: apiKey || undefined, baseUrl: baseUrl || undefined })
      onSaved(c)
    } catch (e: any) {
      setError(e?.message ?? String(e))
    } finally {
      setBusy(null)
    }
  }

  return (
    <Modal title={connection ? 'Подключение AI' : 'Подключите AI, чтобы начать'} onClose={onClose} wide>
      {initialSetup && (
        <p style={{ marginTop: 0, color: 'var(--text-2)', fontSize: 12.8 }}>
          Вставьте API-ключ любого поддерживаемого провайдера. Ключ хранится только в системном хранилище секретов
          (Keychain / DPAPI / libsecret) и никогда не попадает в файлы, логи или базу данных.
        </p>
      )}

      <div className="field">
        <span className="field-label">Провайдер</span>
        <div className="provider-grid">
          {presets.map((p) => (
            <button
              key={p.id}
              className={`provider-card ${p.id === providerId ? 'active' : ''}`}
              onClick={() => setProviderId(p.id)}
              type="button"
            >
              <b>{p.name}</b>
              <span>{p.description}</span>
            </button>
          ))}
        </div>
      </div>

      <div className="row2">
        <Field label="Модель" hint={preset ? `Актуальные модели ${preset.name}` : ''}>
          {customModel ? (
            <input className="input" value={model} onChange={(e) => setModel(e.target.value)} placeholder="например, deepseek-reasoner" />
          ) : (
            <select className="input" value={model} onChange={(e) => setModel(e.target.value)}>
              {modelOptions.map((m) => (
                <option key={m} value={m}>{preset?.models.find((x) => x.id === m)?.label ?? m}</option>
              ))}
            </select>
          )}
          <button type="button" className="btn btn-ghost btn-sm" style={{ alignSelf: 'flex-start', paddingLeft: 0 }} onClick={() => setCustomModel(!customModel)}>
            {customModel ? '← выбрать из списка' : 'указать вручную'}
          </button>
        </Field>

        <Field
          label="API-ключ"
          hint={connection?.hasKey && connection.provider === providerId ? `Уже сохранён: ${connection.keyHint}. Оставьте пустым, чтобы не менять.` : 'Ключ шифруется системным хранилищем ОС'}
        >
          <div style={{ position: 'relative' }}>
            <input
              className="input"
              type={showKey ? 'text' : 'password'}
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder={preset?.keyPlaceholder ?? 'sk-…'}
              autoComplete="off"
              spellCheck={false}
              style={{ paddingRight: 64 }}
            />
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              style={{ position: 'absolute', right: 4, top: 4, height: 26 }}
              onClick={() => setShowKey(!showKey)}
            >
              {showKey ? 'скрыть' : 'показать'}
            </button>
          </div>
        </Field>
      </div>

      {(preset?.customBaseUrl || providerId === 'compatible') && (
        <Field label="Base URL" hint="Например: http://localhost:11434/v1 (Ollama), https://openrouter.ai/api/v1">
          <input className="input" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://…/v1" spellCheck={false} />
        </Field>
      )}

      {error && <div className="banner error"><Icon name="x" size={15} /><div className="grow">{error}</div></div>}
      {ok && <div className="banner" style={{ borderColor: '#24402e', background: '#121a15' }}><Icon name="check" size={15} /><div className="grow">{ok}</div></div>}

      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 4 }}>
        <button className="btn" onClick={doTest} disabled={busy !== null || (!apiKey && !connection?.hasKey)}>
          {busy === 'test' ? <Spinner /> : <Icon name="refresh" size={14} />} Проверить соединение
        </button>
        <div style={{ flex: 1 }} />
        {connection && (
          <button
            className="btn btn-danger"
            onClick={async () => {
              await window.api.provider.disconnect()
              onClose()
              location.reload()
            }}
          >
            Отключить ключ
          </button>
        )}
        <button className="btn btn-primary" onClick={doSave} disabled={busy !== null || (!apiKey && !connection?.hasKey)}>
          {busy === 'save' ? <Spinner /> : <Icon name="check" size={14} />} Сохранить
        </button>
      </div>

      {preset && (
        <p style={{ color: 'var(--muted)', fontSize: 11.2, margin: '14px 0 0' }}>
          Где взять ключ: <a href="#" onClick={(e) => { e.preventDefault(); void window.api.system.openExternal(preset.docsUrl) }}>{preset.docsUrl}</a>
        </p>
      )}
    </Modal>
  )
}
