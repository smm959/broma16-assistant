import React from 'react'
import type { ProviderId, ProviderPreset, VisionState } from '@shared/types'
import { Modal, Field, Icon, Spinner } from './ui'

const VISION_IDS: ProviderId[] = ['gemini', 'openai', 'anthropic', 'compatible']

export default function VisionModal({
  current,
  presets,
  onClose,
  onSaved,
}: {
  current: VisionState | null
  presets: ProviderPreset[]
  onClose: () => void
  onSaved: (v: VisionState) => void
}) {
  const list = presets.filter((p) => VISION_IDS.includes(p.id))
  const [provider, setProvider] = React.useState<ProviderId>(current?.provider ?? 'gemini')
  const [model, setModel] = React.useState(current?.model ?? 'gemini-2.5-flash')
  const [apiKey, setApiKey] = React.useState('')
  const [baseUrl, setBaseUrl] = React.useState('')
  const [busy, setBusy] = React.useState<null | 'save' | 'test'>(null)
  const [result, setResult] = React.useState<string | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const preset = list.find((p) => p.id === provider)

  const save = async (thenTest: boolean) => {
    setBusy(thenTest ? 'test' : 'save')
    setError(null)
    setResult(null)
    try {
      const saved = await window.api.vision.save({ provider, model, apiKey: apiKey || undefined, baseUrl: baseUrl || undefined })
      onSaved(saved)
      if (thenTest) {
        const res = await window.api.vision.test()
        if (res.ok) setResult(`Модель ответила: «${res.sample || 'ok'}»`)
        else setError(res.error ?? 'Проверка не удалась')
      } else {
        setResult('Сохранено. Нажмите «Проверить», чтобы убедиться, что модель видит картинки.')
      }
    } catch (e: any) {
      setError(e?.message ?? String(e))
    } finally {
      setBusy(null)
    }
  }

  return (
    <Modal title="Анализ изображений (vision)" onClose={onClose}>
      <p style={{ marginTop: 0, color: 'var(--text-2)', fontSize: 12.6 }}>
        Основная модель может быть текстовой (например, DeepSeek). Для картинок подключите отдельную
        мультимодальную модель — она будет описывать обложки и скриншоты, а основная модель получит готовый текст.
      </p>

      <div className="field">
        <span className="field-label">Провайдер</span>
        <div className="provider-grid">
          {list.map((p) => (
            <button
              key={p.id}
              type="button"
              className={`provider-card ${p.id === provider ? 'active' : ''}`}
              onClick={() => {
                setProvider(p.id)
                setModel(p.models[0]?.id ?? '')
              }}
            >
              <b>{p.name}</b>
              <span>{p.models.map((m) => m.label).slice(0, 3).join(' · ')}</span>
            </button>
          ))}
        </div>
      </div>

      <div className="row2">
        <Field label="Модель" hint={preset ? `Например: ${preset.models[0]?.id}` : ''}>
          <input className="input" value={model} onChange={(e) => setModel(e.target.value)} list="vision-models" spellCheck={false} />
          <datalist id="vision-models">
            {(preset?.models ?? []).map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
          </datalist>
        </Field>
        <Field
          label="API-ключ"
          hint={current?.hasKey && current.provider === provider ? `Уже сохранён: ${current.keyHint}` : 'Хранится в системном хранилище секретов'}
        >
          <input className="input" type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder="вставьте ключ провайдера" autoComplete="off" />
        </Field>
      </div>

      {provider === 'compatible' && (
        <Field label="Base URL" hint="Например, http://localhost:11434/v1 для Ollama с vision-моделью (llava, qwen2.5-vl)">
          <input className="input" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://…/v1" spellCheck={false} />
        </Field>
      )}

      {error && <div className="banner error"><Icon name="x" size={15} /><div className="grow">{error}</div></div>}
      {result && <div className="banner" style={{ borderColor: '#24402e', background: '#121a15' }}><Icon name="check" size={15} /><div className="grow">{result}</div></div>}

      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <button className="btn" onClick={() => save(true)} disabled={busy !== null || !model.trim() || (!apiKey && !current?.hasKey)}>
          {busy === 'test' ? <Spinner /> : <Icon name="refresh" size={14} />} Сохранить и проверить
        </button>
        <div style={{ flex: 1 }} />
        <button
          className="btn btn-danger"
          onClick={async () => {
            await window.api.vision.clear()
            onClose()
            location.reload()
          }}
          disabled={!current}
        >
          Отключить
        </button>
        <button className="btn btn-primary" onClick={() => save(false)} disabled={busy !== null || !model.trim() || (!apiKey && !current?.hasKey)}>
          {busy === 'save' ? <Spinner /> : <Icon name="check" size={14} />} Сохранить
        </button>
      </div>
    </Modal>
  )
}
