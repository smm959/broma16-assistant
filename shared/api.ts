import type {
  ActivityEvent,
  AppBootstrap,
  AppSettings,
  AttachmentRef,
  BrowserAccountState,
  ChatMessage,
  Conversation,
  Contact,
  DraftEmail,
  EmailAccount,
  EmailMessage,
  FaqArticle,
  KnowledgeStatus,
  PendingAction,
  ProviderConnection,
  ProviderId,
  Release,
  Ticket,
  VisionState,
} from './types'

export interface SendResult {
  conversationId: string
  message: ChatMessage
}

export interface Api {
  bootstrap(): Promise<AppBootstrap>
  settings: {
    save(patch: Partial<AppSettings>): Promise<AppSettings>
  }
  provider: {
    save(input: { provider: ProviderId; model: string; apiKey?: string; baseUrl?: string }): Promise<ProviderConnection>
    test(input?: { provider?: ProviderId; model?: string; apiKey?: string; baseUrl?: string }): Promise<{ ok: boolean; models?: string[]; error?: string }>
    models(provider: ProviderId, baseUrl?: string): Promise<string[]>
    disconnect(): Promise<void>
  }
  account: {
    state(): Promise<{
      login: string
      remember: boolean
      openOnStart: boolean
      hasPassword: boolean
      passwordHint?: string
      session: BrowserAccountState
    }>
    save(input: { login: string; password?: string; remember: boolean; openOnStart: boolean }): Promise<any>
    forget(): Promise<any>
    autoLogin(): Promise<{ ok: boolean; loggedIn: boolean; steps: string[]; note: string; needsUser?: boolean }>
  }
  vision: {
    get(): Promise<VisionState | null>
    save(input: { provider: ProviderId; model: string; apiKey?: string; baseUrl?: string }): Promise<VisionState>
    test(): Promise<{ ok: boolean; error?: string; sample?: string }>
    clear(): Promise<void>
  }
  conv: {
    list(): Promise<Conversation[]>
    create(): Promise<Conversation>
    rename(id: string, title: string): Promise<void>
    remove(id: string): Promise<void>
    messages(id: string): Promise<ChatMessage[]>
  }
  chat: {
    send(input: { conversationId?: string; text: string; attachments?: AttachmentRef[] }): Promise<SendResult>
    stop(conversationId?: string): Promise<void>
  }
  attachment: {
    fromPaths(paths: string[]): Promise<AttachmentRef[]>
    fromBytes(name: string, mime: string, bytes: Uint8Array): Promise<AttachmentRef>
    pick(): Promise<AttachmentRef[]>
    pathFor(file: File): string
  }
  actions: {
    list(conversationId?: string): Promise<PendingAction[]>
    approve(id: string): Promise<{ ok: boolean; error?: string }>
    reject(id: string): Promise<{ ok: boolean }>
  }
  activity: {
    list(conversationId?: string): Promise<ActivityEvent[]>
  }
  kb: {
    status(): Promise<KnowledgeStatus>
    sync(): Promise<KnowledgeStatus>
    search(query: string, limit?: number): Promise<{ id: string; title: string; category: string; url: string; snippet: string; lastVerified: number }[]>
    articles(filter?: { category?: string; query?: string }): Promise<any[]>
    article(id: string): Promise<FaqArticle | null>
  }
  releases: {
    list(): Promise<Release[]>
    save(input: Partial<Release> & { title: string }): Promise<Release[]>
    remove(id: string): Promise<Release[]>
  }
  tickets: {
    list(): Promise<Ticket[]>
    create(input: { subject: string; category?: string; artist?: string; releaseId?: string; recipient?: string; body?: string }): Promise<Ticket[]>
    get(id: string): Promise<{ ticket: Ticket; messages: any[] } | null>
    update(id: string, patch: Partial<Ticket>): Promise<Ticket[]>
    remove(id: string): Promise<Ticket[]>
  }
  email: {
    accounts(): Promise<EmailAccount[]>
    save(input: any): Promise<EmailAccount[]>
    remove(id: string): Promise<EmailAccount[]>
    test(id: string): Promise<{ imap: string; smtp: string }>
    sync(id: string): Promise<{ added: number; scanned: number }>
    messages(opts?: { query?: string; bromaOnly?: boolean; limit?: number }): Promise<EmailMessage[]>
    message(id: string): Promise<EmailMessage | null>
    send(input: { accountId: string; to: string; cc?: string; subject: string; body: string; ticketId?: string; attachments?: { filename: string; path: string }[] }): Promise<{ messageId: string; accepted: string[] }>
    presets(): Promise<any[]>
  }
  drafts: {
    list(): Promise<DraftEmail[]>
    save(draft: Partial<DraftEmail> & { to: string; subject: string; body: string }): Promise<DraftEmail[]>
    remove(id: string): Promise<DraftEmail[]>
  }
  contacts(): Promise<Contact[]>
  browser: {
    open(url?: string): Promise<{ url: string; title: string }>
    read(): Promise<{ url: string; title: string; text: string; loggedIn: boolean; links: { text: string; href: string }[] }>
    screenshot(): Promise<{ path: string }>
    state(): Promise<BrowserAccountState>
    clear(): Promise<void>
    show(): Promise<void>
  }
  system: {
    openExternal(url: string): Promise<void>
    showItemInFolder(path: string): Promise<void>
    clearData(): Promise<void>
    logoutAccount(): Promise<void>
    logs(): Promise<any[]>
  }
  events: {
    onDelta(cb: (p: { conversationId: string; messageId: string; text: string }) => void): () => void
    onMessage(cb: (m: ChatMessage) => void): () => void
    onActivity(cb: (e: ActivityEvent) => void): () => void
    onAction(cb: (a: PendingAction) => void): () => void
    onRuntime(cb: (s: { running: boolean; conversationId?: string; phase?: string; currentActivity?: string }) => void): () => void
    onConversations(cb: () => void): () => void
    onKbStatus(cb: (s: KnowledgeStatus) => void): () => void
    onEmailSync(cb: (p: { accountId: string }) => void): () => void
    onFollowupDue(cb: (p: { count: number; tickets: { id: string; subject: string; lastMessageAt?: number }[] }) => void): () => void
    onNotify(cb: (p: { title: string; body: string }) => void): () => void
    onNewChat(cb: () => void): () => void
  }
}

declare global {
  interface Window {
    api: Api
  }
}
