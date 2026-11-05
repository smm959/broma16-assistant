import { app } from 'electron'
import { join } from 'node:path'
import { Db } from './db/index.js'
import { KnowledgeBase } from './kb/index.js'
import { ProviderManager } from './llm/manager.js'
import { VisionService } from './llm/vision.js'
import { EmailService } from './email/index.js'
import { BrowserAutomation } from './browser/automation.js'
import { FileService } from './files/index.js'
import { AgentOrchestrator, type AgentEvents } from './agent/orchestrator.js'

export interface Services {
  db: Db
  kb: KnowledgeBase
  llm: ProviderManager
  email: EmailService
  browser: BrowserAutomation
  files: FileService
  vision: VisionService
  agent: AgentOrchestrator
  settings(): Record<string, string>
  saveSettings(patch: Record<string, unknown>): Record<string, string>
  emit: (channel: string, payload: unknown) => void
}

export const DEFAULT_SETTINGS = {
  language: 'ru',
  userName: '',
  accountName: '',
  labelName: '',
  contactEmail: '',
  signature: '',
  autoFollowUpDays: 14,
  autoSendFollowUp: false,
  confirmEverything: true,
  theme: 'system',
  reduceMotion: false,
  onboardingDone: false,
} as const

export function buildServices(emit: (channel: string, payload: unknown) => void): Services {
  const userData = app.getPath('userData')
  const db = new Db(join(userData, 'broma16.sqlite'))
  const files = new FileService(join(userData, 'files'))
  const kb = new KnowledgeBase(db, join(app.getAppPath(), 'resources'))
  const llm = new ProviderManager(db)
  const email = new EmailService(db)
  const browser = new BrowserAutomation(userData)
  const vision = new VisionService(db)

  const settings = () => {
    const rows = db.all<{ key: string; value: string }>(`SELECT key, value FROM settings`)
    const out: Record<string, string> = {}
    for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) out[k] = typeof v === 'string' ? v : String(v)
    for (const r of rows) out[r.key] = r.value
    return out
  }

  const saveSettings = (patch: Record<string, unknown>) => {
    for (const [k, v] of Object.entries(patch)) {
      db.run(
        `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
        k,
        typeof v === 'string' ? v : JSON.stringify(v),
        Date.now(),
      )
    }
    return settings()
  }

  const events: AgentEvents = {
    delta: (conversationId, messageId, text) => emit('event:delta', { conversationId, messageId, text }),
    message: (m) => emit('event:message', m),
    activity: (a) => emit('event:activity', a),
    action: (a) => emit('event:action', a),
    runtime: (s) => emit('event:runtime', s),
    conversations: () => emit('event:conversations', {}),
  }

  const agent = new AgentOrchestrator({ db, llm, kb, email, browser, files, vision }, events)

  kb.onStatus((s) => emit('event:kb-status', s))
  kb.seed()
  kb.index.rebuild()

  return { db, kb, llm, email, browser, files, vision, agent, settings, saveSettings, emit }
}
