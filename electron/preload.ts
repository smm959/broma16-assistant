import { contextBridge, ipcRenderer, webUtils } from 'electron'

const invoke = (channel: string, ...args: unknown[]) => ipcRenderer.invoke(channel, ...args)

const on = (channel: string) => (cb: (payload: any) => void) => {
  const listener = (_e: Electron.IpcRendererEvent, payload: any) => cb(payload)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

const api = {
  bootstrap: () => invoke('app:bootstrap'),
  settings: {
    save: (patch: any) => invoke('settings:save', patch),
  },
  provider: {
    save: (input: any) => invoke('provider:save', input),
    test: (input?: any) => invoke('provider:test', input),
    models: (provider: string, baseUrl?: string) => invoke('provider:models', provider, baseUrl),
    disconnect: () => invoke('provider:disconnect'),
  },
  conv: {
    list: () => invoke('conv:list'),
    create: () => invoke('conv:create'),
    rename: (id: string, title: string) => invoke('conv:rename', id, title),
    remove: (id: string) => invoke('conv:remove', id),
    messages: (id: string) => invoke('conv:messages', id),
  },
  chat: {
    send: (input: any) => invoke('chat:send', input),
    stop: () => invoke('chat:stop'),
  },
  attachment: {
    fromPaths: (paths: string[]) => invoke('attachment:fromPaths', paths),
    fromBytes: (name: string, mime: string, bytes: Uint8Array) => invoke('attachment:fromBytes', name, mime, bytes),
    pick: () => invoke('attachment:pick'),
    pathFor: (file: File) => {
      try {
        return webUtils.getPathForFile(file)
      } catch {
        return ''
      }
    },
  },
  actions: {
    list: (conversationId?: string) => invoke('actions:list', conversationId),
    approve: (id: string) => invoke('actions:approve', id),
    reject: (id: string) => invoke('actions:reject', id),
  },
  activity: {
    list: (conversationId?: string) => invoke('activity:list', conversationId),
  },
  kb: {
    status: () => invoke('kb:status'),
    sync: () => invoke('kb:sync'),
    search: (query: string, limit?: number) => invoke('kb:search', query, limit),
    articles: (filter?: any) => invoke('kb:articles', filter),
    article: (id: string) => invoke('kb:article', id),
  },
  releases: {
    list: () => invoke('releases:list'),
    save: (input: any) => invoke('releases:save', input),
    remove: (id: string) => invoke('releases:remove', id),
  },
  tickets: {
    list: () => invoke('tickets:list'),
    create: (input: any) => invoke('tickets:create', input),
    get: (id: string) => invoke('tickets:get', id),
    update: (id: string, patch: any) => invoke('tickets:update', id, patch),
    remove: (id: string) => invoke('tickets:remove', id),
  },
  email: {
    accounts: () => invoke('email:accounts'),
    save: (input: any) => invoke('email:save', input),
    remove: (id: string) => invoke('email:remove', id),
    test: (id: string) => invoke('email:test', id),
    sync: (id: string) => invoke('email:sync', id),
    messages: (opts?: any) => invoke('email:messages', opts),
    message: (id: string) => invoke('email:message', id),
    send: (input: any) => invoke('email:send', input),
    presets: () => invoke('email:presets'),
  },
  drafts: {
    list: () => invoke('drafts:list'),
    save: (draft: any) => invoke('drafts:save', draft),
    remove: (id: string) => invoke('drafts:remove', id),
  },
  contacts: () => invoke('contacts:list'),
  browser: {
    open: (url?: string) => invoke('browser:open', url),
    read: () => invoke('browser:read'),
    screenshot: () => invoke('browser:screenshot'),
    state: () => invoke('browser:state'),
    clear: () => invoke('browser:clear'),
    show: () => invoke('browser:show'),
  },
  system: {
    openExternal: (url: string) => invoke('system:openExternal', url),
    showItemInFolder: (path: string) => invoke('system:showItemInFolder', path),
    clearData: () => invoke('system:clearData'),
    logoutAccount: () => invoke('system:logoutAccount'),
    logs: () => invoke('system:logs'),
  },
  events: {
    onDelta: on('event:delta'),
    onMessage: on('event:message'),
    onActivity: on('event:activity'),
    onAction: on('event:action'),
    onRuntime: on('event:runtime'),
    onConversations: on('event:conversations'),
    onKbStatus: on('event:kb-status'),
    onEmailSync: on('event:email-sync'),
    onNewChat: on('event:new-chat'),
    onFollowupDue: on('event:followup-due'),
    onNotify: on('event:notify'),
  },
}

contextBridge.exposeInMainWorld('api', api)
