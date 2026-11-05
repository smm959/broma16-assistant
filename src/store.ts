import React from 'react'
import type { AppBootstrap, AppSettings, Conversation, KnowledgeStatus, ProviderConnection } from '@shared/types'

export type Screen = 'chat' | 'faq' | 'tickets' | 'releases' | 'email' | 'settings'

export interface ToastItem {
  id: number
  text: string
  tone?: 'success' | 'error'
}

interface AppState {
  boot: AppBootstrap | null
  connection: ProviderConnection | null
  knowledge: KnowledgeStatus | null
  conversations: Conversation[]
  settings: AppSettings | null
  screen: Screen
  setScreen: (s: Screen) => void
  conversationId?: string
  setConversationId: (id?: string) => void
  running: boolean
  setRunning: (v: boolean) => void
  connectOpen: boolean
  setConnectOpen: (v: boolean) => void
  toast: (text: string, tone?: 'success' | 'error') => void
  refresh: () => Promise<void>
  refreshConversations: () => Promise<void>
  onSettings: (patch: Partial<AppSettings>) => Promise<void>
  onConnection: (c: ProviderConnection | null) => void
  onKnowledge: (k: KnowledgeStatus) => void
  activityOpen: boolean
  setActivityOpen: (v: boolean) => void
}

export const AppCtx = React.createContext<AppState>(null as any)
export const useApp = () => React.useContext(AppCtx)
