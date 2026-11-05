import { ipcMain, dialog, shell, app } from 'electron'
import { readFileSync } from 'node:fs'
import { basename } from 'node:path'
import type { Services } from './services.js'
import type { ProviderId } from '../shared/types.js'
import { PROVIDERS } from './llm/presets.js'
import { EMAIL_PRESETS } from './email/index.js'
import { createHash } from 'node:crypto'

export function registerIpc(svc: Services, getWindow: () => Electron.BrowserWindow | null) {
  const { db, kb, llm, email, agent, browser, files } = svc

  const handle = (channel: string, fn: (...args: any[]) => any) => {
    ipcMain.removeHandler(channel)
    ipcMain.handle(channel, async (_e, ...args) => fn(...args))
  }

  /* -------------------------------- bootstrap -------------------------------- */

  handle('app:bootstrap', () => {
    const conversations = agent.listConversations()
    const dbPath = db.path
    return {
      version: app.getVersion(),
      settings: normalizeSettings(svc.settings()),
      providers: PROVIDERS,
      connection: llm.connection(),
      conversations,
      knowledge: kb.status(),
      accounts: email.accounts(),
      runtime: { running: agent.isRunning(), pendingActions: 0 },
      dbPath,
      isFirstRun: svc.settings().onboardingDone !== 'true',
    }
  })

  handle('settings:save', (patch: Record<string, unknown>) => normalizeSettings(svc.saveSettings(patch)))

  handle('provider:save', async (input: any) => llm.saveConnection(input))
  handle('provider:test', async (input: any) => llm.testConnection(input))
  handle('provider:models', async (provider: ProviderId, baseUrl?: string) => llm.listModels(provider, baseUrl))
  handle('provider:disconnect', async () => llm.disconnect())

  /* ---------------------------------- чат ----------------------------------- */

  handle('conv:list', () => agent.listConversations())
  handle('conv:create', () => agent.ensureConversation())
  handle('conv:rename', (id: string, title: string) => agent.renameConversation(id, title))
  handle('conv:remove', (id: string) => agent.deleteConversation(id))
  handle('conv:messages', (id: string) => agent.messages(id))

  handle('chat:send', (input: any) => agent.sendUserMessage(input))
  handle('chat:stop', (conversationId?: string) => {
    agent.stop(conversationId)
  })

  handle('attachment:fromPaths', async (paths: string[]) => {
    const out = []
    for (const p of paths.slice(0, 10)) {
      if (!p) continue
      const data = readFileSync(p)
      out.push(await files.saveUpload(basename(p), new Uint8Array(data)))
    }
    return out
  })

  handle('attachment:fromBytes', async (name: string, mime: string, bytes: Uint8Array) => {
    return files.saveUpload(name || `pasted-${Date.now()}.png`, new Uint8Array(bytes))
  })

  handle('attachment:pick', async () => {
    const win = getWindow()
    const result = await dialog.showOpenDialog(win ?? undefined as any, {
      title: 'Прикрепить файлы',
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: 'Все поддерживаемые', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'pdf', 'txt', 'md', 'docx', 'xlsx', 'csv', 'json'] },
        { name: 'Все файлы', extensions: ['*'] },
      ],
    })
    if (result.canceled) return []
    const out = []
    for (const p of result.filePaths.slice(0, 10)) {
      const data = readFileSync(p)
      out.push(await files.saveUpload(basename(p), new Uint8Array(data)))
    }
    return out
  })

  handle('actions:list', (conversationId?: string) => agent.actions(conversationId))
  handle('actions:approve', (id: string) => agent.approve(id))
  handle('actions:reject', (id: string) => agent.reject(id))
  handle('activity:list', (conversationId?: string) => agent.activity(conversationId))

  /* -------------------------------- знания ---------------------------------- */

  handle('kb:status', () => kb.status())
  handle('kb:sync', async () => {
    const status = await kb.sync()
    svc.emit('event:kb-status', status)
    return status
  })
  handle('kb:search', (query: string, limit?: number) =>
    kb.index.search(String(query ?? ''), Math.min(20, Number(limit) || 8)).map((h) => ({
      id: h.article.id,
      title: h.article.title,
      category: h.article.category,
      url: h.article.url,
      snippet: h.article.snippet,
      lastVerified: h.article.lastVerified,
    })),
  )
  handle('kb:articles', (filter: any) => kb.articles(filter))
  handle('kb:article', (id: string) => kb.index.getArticle(id))

  /* -------------------------------- релизы ---------------------------------- */

  const listReleases = () =>
    db.all<any>(`SELECT * FROM releases ORDER BY updated_at DESC`).map((r) => ({
      id: r.id,
      artist: r.artist ?? '',
      title: r.title,
      releaseDate: r.release_date ?? '',
      upc: r.upc ?? '',
      isrc: r.isrc ?? '',
      status: r.status,
      platformLinks: safeJson(r.platform_links, {}),
      notes: r.notes ?? '',
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    }))

  handle('releases:list', listReleases)
  handle('releases:save', (input: any) => {
    const id = input.id || `rel_${Date.now().toString(36)}`
    const existing = db.get<any>(`SELECT * FROM releases WHERE id = ?`, id)
    const links = { ...safeJson(existing?.platform_links, {}), ...(input.platformLinks ?? {}) }
    if (existing) {
      db.run(
        `UPDATE releases SET title=?, artist=?, release_date=?, upc=?, isrc=?, status=?, platform_links=?, notes=?, updated_at=? WHERE id=?`,
        input.title, input.artist ?? '', input.releaseDate ?? '', input.upc ?? '', input.isrc ?? '',
        input.status ?? 'unknown', JSON.stringify(links), input.notes ?? '', Date.now(), id,
      )
    } else {
      db.run(
        `INSERT INTO releases (id, artist, title, release_date, upc, ean, isrc, status, platform_links, notes, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?)`,
        id, input.artist ?? '', input.title, input.releaseDate ?? null, input.upc ?? null,
        input.isrc ?? null, input.status ?? 'unknown', JSON.stringify(links), input.notes ?? '', Date.now(), Date.now(),
      )
    }
    return listReleases()
  })
  handle('releases:remove', (id: string) => {
    db.run(`DELETE FROM releases WHERE id = ?`, id)
    return listReleases()
  })

  /* ------------------------------- обращения -------------------------------- */

  const listTickets = () =>
    db.all<any>(`SELECT * FROM tickets ORDER BY updated_at DESC`).map(mapTicket)

  handle('tickets:create', (input: any) => {
    const id = `tkt_${Date.now().toString(36)}`
    db.run(
      `INSERT INTO tickets (id, subject, category, artist, release_id, recipient, status, created_at, updated_at, last_message_at)
       VALUES (?, ?, ?, ?, ?, ?, 'ready', ?, ?, ?)`,
      id, input.subject, input.category ?? 'other', input.artist ?? null, input.releaseId ?? null,
      input.recipient ?? null, Date.now(), Date.now(), Date.now(),
    )
    if (input.body) {
      db.run(
        `INSERT INTO ticket_messages (id, ticket_id, direction, sender, recipient, subject, body, timestamp)
         VALUES (?, ?, 'outgoing', 'me', ?, ?, ?, ?)`,
        `tm_${Date.now().toString(36)}`, id, input.recipient ?? '', input.subject, input.body, Date.now(),
      )
    }
    return listTickets()
  })
  handle('tickets:list', listTickets)
  handle('tickets:get', (id: string) => {
    const t = db.get<any>(`SELECT * FROM tickets WHERE id = ?`, id)
    if (!t) return null
    const messages = db.all<any>(`SELECT * FROM ticket_messages WHERE ticket_id = ? ORDER BY timestamp`, id)
    return { ticket: mapTicket(t), messages }
  })
  handle('tickets:update', (id: string, patch: any) => {
    const t = db.get<any>(`SELECT * FROM tickets WHERE id = ?`, id)
    if (!t) return listTickets()
    db.run(
      `UPDATE tickets SET subject=?, category=?, status=?, recipient=?, artist=?, external_ticket_id=?, follow_up_at=?, updated_at=? WHERE id=?`,
      patch.subject ?? t.subject, patch.category ?? t.category, patch.status ?? t.status,
      patch.recipient ?? t.recipient, patch.artist ?? t.artist,
      patch.externalTicketId ?? t.external_ticket_id, patch.followUpAt ?? t.follow_up_at,
      Date.now(), id,
    )
    return listTickets()
  })
  handle('tickets:remove', (id: string) => {
    db.run(`DELETE FROM tickets WHERE id = ?`, id)
    return listTickets()
  })

  /* --------------------------------- почта ---------------------------------- */

  const listAccounts = () => email.accounts()
  handle('email:accounts', listAccounts)
  handle('email:save', async (input: any) => {
    await email.saveAccount(input)
    return listAccounts()
  })
  handle('email:remove', (id: string) => {
    email.deleteAccount(id)
    return listAccounts()
  })
  handle('email:test', (id: string) => email.test(id))
  handle('email:sync', async (id: string) => {
    const res = await email.sync(id)
    svc.emit('event:email-sync', { accountId: id })
    return res
  })
  handle('email:messages', (opts: any) => email.messages(opts))
  handle('email:message', (id: string) => email.message(id))
  handle('email:send', async (input: any) => {
    const res = await email.send(input)
    svc.emit('event:email-sync', { accountId: input.accountId })
    return res
  })
  handle('email:presets', () => EMAIL_PRESETS)

  /* --------------------------------- черновики ------------------------------- */

  const listDrafts = () =>
    db.all<any>(`SELECT * FROM drafts ORDER BY updated_at DESC`).map((d) => ({
      id: d.id, ticketId: d.ticket_id ?? undefined, accountId: d.account_id ?? undefined,
      to: d.recipient, cc: d.cc ?? undefined, subject: d.subject, body: d.body,
      attachments: safeJson(d.attachments, []), createdAt: d.created_at, updatedAt: d.updated_at,
    }))
  handle('drafts:list', listDrafts)
  handle('drafts:save', (draft: any) => {
    const id = draft.id || `draft_${Date.now().toString(36)}`
    const existing = db.get<any>(`SELECT id FROM drafts WHERE id = ?`, id)
    if (existing) {
      db.run(`UPDATE drafts SET recipient=?, subject=?, body=?, attachments=?, updated_at=? WHERE id=?`,
        draft.to, draft.subject, draft.body, JSON.stringify(draft.attachments ?? []), Date.now(), id)
    } else {
      db.run(`INSERT INTO drafts (id, ticket_id, account_id, recipient, cc, subject, body, attachments, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        id, draft.ticketId ?? null, draft.accountId ?? null, draft.to, draft.cc ?? null, draft.subject, draft.body,
        JSON.stringify(draft.attachments ?? []), Date.now(), Date.now())
    }
    return listDrafts()
  })
  handle('drafts:remove', (id: string) => {
    db.run(`DELETE FROM drafts WHERE id = ?`, id)
    return listDrafts()
  })

  handle('contacts:list', () =>
    db.all<any>(`SELECT * FROM contacts ORDER BY department`).map((c) => ({
      id: c.id, email: c.email, department: c.department, purpose: c.purpose,
      verificationStatus: c.verification_status, sourceUrl: c.source_url ?? undefined,
      lastVerified: c.last_verified ?? undefined, supportedIssueTypes: safeJson(c.supported_issue_types, []),
    })),
  )

  /* --------------------------------- браузер -------------------------------- */

  handle('browser:open', (url?: string) => browser.open(url))
  handle('browser:read', () => browser.read())
  handle('browser:screenshot', () => browser.screenshot())
  handle('browser:state', () => browser.state())
  handle('browser:clear', () => browser.clearSession())
  handle('browser:show', () => browser.showWindow())

  /* --------------------------------- система -------------------------------- */

  handle('system:openExternal', (url: string) => shell.openExternal(url))
  handle('system:showItemInFolder', (path: string) => shell.showItemInFolder(path))
  handle('system:clearData', async () => {
    db.exec(`DELETE FROM messages; DELETE FROM conversations; DELETE FROM activity_events; DELETE FROM pending_actions; DELETE FROM chat_attachments; DELETE FROM email_messages; DELETE FROM drafts;`)
    await browser.clearSession()
  })
  handle('system:logoutAccount', async () => {
    await browser.clearSession()
  })
  handle('system:logs', () =>
    db.all<any>(`SELECT * FROM activity_events ORDER BY created_at DESC LIMIT 200`).map((r) => ({
      id: r.id,
      action: r.title,
      result: r.detail,
      error: r.kind === 'error' ? r.detail : null,
      createdAt: r.created_at,
    })),
  )
}

function mapTicket(r: any) {
  return {
    id: r.id,
    subject: r.subject,
    category: r.category,
    artist: r.artist ?? undefined,
    releaseId: r.release_id ?? undefined,
    recipient: r.recipient ?? undefined,
    status: r.status,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    lastMessageAt: r.last_message_at ?? undefined,
    followUpAt: r.follow_up_at ?? undefined,
    externalTicketId: r.external_ticket_id ?? undefined,
  }
}

function normalizeSettings(raw: Record<string, string>) {
  return {
    ...raw,
    autoFollowUpDays: Number(raw.autoFollowUpDays ?? 14),
    autoSendFollowUp: raw.autoSendFollowUp === 'true',
    confirmEverything: raw.confirmEverything !== 'false',
    reduceMotion: raw.reduceMotion === 'true',
  }
}

function safeJson<T>(value: unknown, fallback: T): T {
  try {
    return typeof value === 'string' && value ? (JSON.parse(value) as T) : fallback
  } catch {
    return fallback
  }
}
