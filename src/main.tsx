import React from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import './styles.css'

class ErrorBoundary extends React.Component<{ children: React.ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null }

  static getDerivedStateFromError(error: Error) {
    return { error }
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error('UI error', error, info.componentStack)
  }

  render() {
    if (!this.state.error) return this.props.children
    return (
      <div style={{ padding: 40, fontFamily: 'system-ui', color: '#ececf0' }}>
        <h2 style={{ marginTop: 0 }}>Что-то пошло не так</h2>
        <p style={{ color: '#8b8b94', maxWidth: 560 }}>
          Интерфейс столкнулся с ошибкой. Данные и история сохранены локально — перезапустите окно.
        </p>
        <pre style={{ background: '#17171a', padding: 12, borderRadius: 8, overflow: 'auto', maxWidth: 720, fontSize: 12 }}>
          {String(this.state.error?.message ?? this.state.error)}
        </pre>
        <button
          onClick={() => location.reload()}
          style={{ background: '#e8ff47', color: '#15160c', border: 0, padding: '10px 16px', borderRadius: 9, fontWeight: 600, cursor: 'pointer' }}
        >
          Перезагрузить
        </button>
      </div>
    )
  }
}

const root = createRoot(document.getElementById('root')!)
root.render(
  <React.StrictMode>
    <ErrorBoundary>
      {typeof window !== 'undefined' && (window as any).api ? (
        <App />
      ) : (
        <div style={{ padding: 40, color: '#ececf0' }}>
          <h2>Приложение не инициализировалось</h2>
          <p style={{ color: '#8b8b94' }}>Не удалось загрузить системный мост (preload). Перезапустите приложение.</p>
        </div>
      )}
    </ErrorBoundary>
  </React.StrictMode>,
)
