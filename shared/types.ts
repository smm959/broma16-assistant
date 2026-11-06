// Общие типы между main-процессом и renderer (UI).

export type ProviderId = 'deepseek' | 'openai' | 'anthropic' | 'gemini' | 'compatible'

export interface ModelInfo {
  id: string
  label: string
  contextWindow?: number
  supportsTools: boolean
  supportsVision: boolean
  kind: 'chat' | 'reasoning' | 'image'
}

export interface ProviderPreset {
  id: ProviderId
  name: string
  description: string
  baseUrl: string
  docsUrl: string
  keyPlaceholder: string
  models: ModelInfo[]
  /** true — пользователь может ввести собственный baseUrl (OpenAI-compatible) */
  customBaseUrl?: boolean
}

export interface ProviderConnection {
  provider: ProviderId
  model: string
  baseUrl?: string
  /** Ключ НИКОГДА не возвращается в renderer в открытом виде. */
  hasKey: boolean
  keyHint?: string
  lastTestedAt?: number
  lastTestOk?: boolean
  lastTestError?: string
  updatedAt: number
}

export interface VisionState {
  provider: ProviderId
  model: string
  hasKey: boolean
  keyHint?: string
  updatedAt: number
}

export interface AppSettings {
  language: 'ru'
  userName: string
  accountName: string
  labelName: string
  contactEmail: string
  replyToEmail: string
  signature: string
  autoFollowUpDays: number
  autoSendFollowUp: boolean
  /** Логин в кабинет Broma 16 (email), пароль хранится отдельно в keychain */
  accountLogin: string
  rememberAccount: boolean
  openCabinetOnStart: boolean
  confirmEverything: boolean
  theme: 'system' | 'light' | 'dark'
  reduceMotion: boolean
}

export type ChatRole = 'user' | 'assistant' | 'system' | 'tool'

export interface AttachmentRef {
  id: string
  filename: string
  mimeType: string
  size: number
  kind: 'image' | 'document' | 'audio'
  /** локальный путь в app data */
  path?: string
  /** текстовое извлечение / OCR для документов */
  extractedText?: string
}

export interface ChatMessage {
  id: string
  conversationId: string
  role: ChatRole
  content: string
  createdAt: number
  attachments?: AttachmentRef[]
  /** действия, предложенные агентом в этом сообщении */
  pendingActionIds?: string[]
  /** источники, на которые опирался ответ */
  sources?: SourceRef[]
  toolName?: string
  error?: string
}

export interface SourceRef {
  title: string
  url?: string
  quote?: string
  kind: 'faq' | 'web' | 'email' | 'account' | 'db' | 'document'
  confidence?: 'high' | 'medium' | 'low'
  verifiedAt?: number
}

export interface Conversation {
  id: string
  title: string
  createdAt: number
  updatedAt: number
  pinned?: boolean
}

/* ----------------------------- Агент / действия ----------------------------- */

export type RiskLevel = 'safe' | 'confirm' | 'dangerous'

export interface PendingAction {
  id: string
  conversationId?: string
  tool: string
  /** человекочитаемое описание на русском */
  title: string
  description: string
  risk: RiskLevel
  params: Record<string, unknown>
  /** предпросмотр (тема письма, получатель, тело) */
  preview?: {
    to?: string
    subject?: string
    body?: string
    details?: { label: string; value: string }[]
  }
  status: 'pending' | 'approved' | 'rejected' | 'executing' | 'done' | 'failed'
  createdAt: number
  result?: string
  error?: string
}

export interface ActivityEvent {
  id: string
  conversationId?: string
  kind: 'thinking' | 'tool' | 'info' | 'success' | 'warning' | 'error' | 'source' | 'approval'
  /** короткий статус на русском: «Изучаю FAQ Broma16» */
  title: string
  detail?: string
  tool?: string
  createdAt: number
  durationMs?: number
}

/* -------------------------------- Домен -------------------------------- */

export interface Contact {
  id: string
  email: string
  department: string
  purpose: string
  verificationStatus: 'VERIFIED' | 'UNVERIFIED' | 'OUTDATED' | 'DISABLED' | 'UNKNOWN'
  sourceUrl?: string
  lastVerified?: number
  supportedIssueTypes: string[]
}

export interface FaqArticle {
  id: string
  externalId?: string
  title: string
  category: string
  folder?: string
  content: string
  contentText: string
  url: string
  source: string
  lastVerified: number
  contentHash: string
  official: boolean
}

export interface Release {
  id: string
  artist: string
  title: string
  releaseDate?: string
  upc?: string
  isrc?: string
  status: string
  platformLinks: Record<string, string>
  notes?: string
  createdAt: number
  updatedAt: number
}

export interface Ticket {
  id: string
  subject: string
  category: string
  artist?: string
  releaseId?: string
  recipient?: string
  status: 'draft' | 'ready' | 'sent' | 'awaiting_reply' | 'answered' | 'resolved' | 'closed'
  createdAt: number
  updatedAt: number
  lastMessageAt?: number
  followUpAt?: number
  externalTicketId?: string
}

export interface EmailAccount {
  id: string
  label: string
  email: string
  provider: 'gmail' | 'imap'
  imapHost: string
  imapPort: number
  imapSecure: boolean
  smtpHost: string
  smtpPort: number
  smtpSecure: boolean
  username: string
  hasPassword: boolean
  lastSyncAt?: number
  status: 'connected' | 'not_configured' | 'error'
  lastError?: string
}

export interface EmailMessage {
  id: string
  accountId: string
  uid: string
  folder: string
  direction: 'incoming' | 'outgoing'
  from: string
  fromName?: string
  to: string
  subject: string
  bodyText: string
  bodyHtml?: string
  date: number
  ticketId?: string
  department?: string
  category?: string
  isBroma16: boolean
  flags: string[]
  attachments?: { filename: string; size: number; mimeType: string }[]
}

export interface DraftEmail {
  id: string
  ticketId?: string
  accountId?: string
  to: string
  cc?: string
  subject: string
  body: string
  attachments: { filename: string; path: string }[]
  createdAt: number
  updatedAt: number
}

export interface BrowserAccountState {
  loggedIn: boolean
  lastCheck?: number
  url?: string
  title?: string
  screenshotPath?: string
  note?: string
}

export interface KnowledgeStatus {
  articles: number
  categories: number
  lastSync?: number
  syncing: boolean
  lastError?: string
  staleDays: number
}

export interface AgentRuntimeState {
  running: boolean
  phase?: 'thinking' | 'tools' | 'awaiting_user' | 'idle'
  currentActivity?: string
  pendingActions: number
}

export interface AppBootstrap {
  version: string
  settings: AppSettings
  providers: ProviderPreset[]
  connection: ProviderConnection | null
  conversations: Conversation[]
  knowledge: KnowledgeStatus
  accounts: EmailAccount[]
  runtime: AgentRuntimeState
  dbPath: string
  isFirstRun: boolean
}


export interface TgSubmission {
  id: string
  chatId: string
  username: string
  title: string
  artist: string
  label: string
  genres: string[]
  releaseDate: string | null
  explicit: boolean
  author: string | null
  description: string | null
  lyrics: string | null
  audioPath: string
  audioName: string
  coverPath: string
  coverName: string
  status: 'pending' | 'approved' | 'rejected'
  createdAt: number
  decidedAt: number | null
  result: string | null
}
