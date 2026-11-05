import React from 'react'
import { AppCtx, type Screen, type ToastItem } from './store'
import type { AppBootstrap, AppSettings, Conversation, KnowledgeStatus, ProviderConnection } from '@shared/types'
import Sidebar from './components/Sidebar'
import TopBar from './components/TopBar'
import ChatScreen from './screens/ChatScreen'
import FaqScreen from './screens/FaqScreen'
import TicketsScreen from './screens/TicketsScreen'
import ReleasesScreen from './screens/ReleasesScreen'
import EmailScreen from './screens/EmailScreen'
import SettingsScreen from './screens/SettingsScreen'
import ConnectAIModal from './components/ConnectAIModal'

export default function App() {
  const [boot, setBoot] = React.useState<AppBootstrap | null>(null)
  const [screen, setScreen] = React.useState<Screen>('chat')
  const [conversations, setConversations] = React.useState<Conversation[]>([])
  const [connection, setConnection] = React.useState<ProviderConnection | null>(null)
  const [knowledge, setKnowledge] = React.useState<KnowledgeStatus | null>(null)
  const [settings, setSettings] = React.useState<AppSettings | null>(null)
  const [conversationId, setConversationId] = React.useState<string | undefined>()
  const [running, setRunning] = React.useState(false)
  const [connectOpen, setConnectOpen] = React.useState(false)
  const [activityOpen, setActivityOpen] = React.useState(true)
  const [toasts, setToasts] = React.useState<ToastItem[]>([])

  const toast = React.useCallback((text: string, tone?: 'success' | 'error') => {
    const id = Date.now() + Math.random()
    setToasts((t) => [...t, { id, text, tone }])
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 4600)
  }, [])

  const load = React.useCallback(async () => {
    const b = await window.api.bootstrap()
    setBoot(b)
    setConversations(b.conversations)
    setConnection(b.connection)
    setKnowledge(b.knowledge)
    setSettings(b.settings)
    setRunning(b.runtime.running)
    setConversationId((prev) => prev ?? b.conversations[0]?.id)
    return b
  }, [])

  React.useEffect(() => {
    void load().then((b) => {
      if (!b.connection) setConnectOpen(true)
    })
  }, [load])

  React.useEffect(() => {
    const offRuntime = window.api.events.onRuntime((s) => setRunning(s.running))
    const offKb = window.api.events.onKbStatus((k) => setKnowledge(k))
    const offConvs = window.api.events.onConversations(() => {
      void window.api.conv.list().then(setConversations)
    })
    const offNotify = window.api.events.onNotify((p) => toast(`${p.title} — ${p.body}`))
    const offNewChat = window.api.events.onNewChat(() => {
      setScreen('chat')
      void window.api.conv.create().then((c) => {
        setConversationId(c.id)
        void window.api.conv.list().then(setConversations)
      })
    })
    return () => {
      offRuntime()
      offKb()
      offConvs()
      offNotify()
      offNewChat?.()
    }
  }, [])

  const refreshConversations = React.useCallback(async () => {
    setConversations(await window.api.conv.list())
  }, [])

  const onSettings = React.useCallback(async (patch: Partial<AppSettings>) => {
    const next = await window.api.settings.save(patch)
    setSettings(next)
  }, [])

  const value = {
    boot,
    connection,
    knowledge,
    conversations,
    settings,
    screen,
    setScreen,
    conversationId,
    setConversationId,
    running,
    setRunning,
    connectOpen,
    setConnectOpen,
    toast,
    refresh: async () => {
      await load()
    },
    refreshConversations,
    onSettings,
    onConnection: (c: ProviderConnection | null) => setConnection(c),
    onKnowledge: setKnowledge,
    activityOpen,
    setActivityOpen,
  }

  if (!boot || !settings) {
    return (
      <div style={{ display: 'grid', placeItems: 'center', height: '100%' }}>
        <span className="spinner" style={{ width: 22, height: 22 }} />
      </div>
    )
  }

  const needsSetup = !connection

  return (
    <AppCtx.Provider value={value}>
      <div className="app">
        <Sidebar />
        <div className="main">
          <TopBar />
          {screen === 'chat' && (
            <ChatScreen
              connection={connection}
              onConnect={() => setConnectOpen(true)}
              activityOpen={activityOpen}
              setActivityOpen={setActivityOpen}
            />
          )}
          {screen === 'faq' && <FaqScreen />}
          {screen === 'tickets' && <TicketsScreen />}
          {screen === 'releases' && <ReleasesScreen />}
          {screen === 'email' && <EmailScreen />}
          {screen === 'settings' && <SettingsScreen />}
        </div>
      </div>
      {connectOpen && (
        <ConnectAIModal
          connection={connection}
          initialSetup={needsSetup}
          onClose={() => setConnectOpen(false)}
          onSaved={(c) => {
            setConnection(c)
            setConnectOpen(false)
            toast('AI подключён — можно работать', 'success')
          }}
        />
      )}
      <div className="toast-wrap">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.tone ?? ''}`}>{t.text}</div>
        ))}
      </div>
    </AppCtx.Provider>
  )
}
