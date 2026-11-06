import { ipcMain, dialog, shell, app } from 'electron'
import { readFileSync } from 'node:fs'
import { basename } from 'node:path'
import type { Services } from './services.js'
import type { ProviderId } from '../shared/types.js'
import { PROVIDERS } from './llm/presets.js'
import { EMAIL_PRESETS } from './email/index.js'
import { LOGIN_URL } from './browser/automation.js'
import { autoLogin } from './browser/login.js'
import { ReleaseWizard } from './browser/release-wizard.js'
import { secrets } from './security/secrets.js'
import { createHash } from 'node:crypto'
import { statSync } from 'node:fs'

export function registerIpc(svc: Services, getWindow: () => Electron.BrowserWindow | null) {
  const { db, kb, llm, email, agent, browser, files } = svc

  const handle = (channel: string, fn: (...args: any[]) => any) => {
    ipcMain.removeHandler(channel)
    ipcMain.handle(channel, async (_e, ...args) => fn(...args))
  }

  /* ------------------------------ заявки из бота ------------------------------ */

  const emitSubmissions = () => {
    try {
      getWindow()?.webContents.send('submissions:changed')
    } catch {
      /* окно закрыто */
    }
  }

  const mapSubmission = (r: any) => ({
    id: r.id,
    chatId: r.chat_id,
    username: r.username,
    title: r.title,
    artist: r.artist,
    label: r.label,
    genres: JSON.parse(r.genres || '[]'),
    releaseDate: r.release_date,
    explicit: Boolean(r.explicit),
    author: r.author,
    authors: r.authors,
    description: r.description,
    lyrics: r.lyrics,
    audioPath: r.audio_path,
    audioName: r.audio_name,
    coverPath: r.cover_path,
    coverName: r.cover_name,
    status: r.status,
    createdAt: r.created_at,
    decidedAt: r.decided_at,
    result: r.result,
  })

  handle('submissions:list', () =>
    db
      .all<any>(
        `SELECT * FROM tg_submissions ORDER BY CASE status WHEN 'pending' THEN 0 ELSE 1 END, created_at DESC LIMIT 100`,
      )
      .map(mapSubmission),
  )

  handle('submissions:get', (id: string) => {
    const r = db.get<any>(`SELECT * FROM tg_submissions WHERE id = ?`, id)
    return r ? mapSubmission(r) : null
  })

  handle('submissions:reject', (id: string) => {
    db.run(`UPDATE tg_submissions SET status = 'rejected', decided_at = ? WHERE id = ?`, Date.now(), id)
    emitSubmissions()
    return { ok: true }
  })

  handle('submissions:delete', (id: string) => {
    db.run(`DELETE FROM tg_submissions WHERE id = ?`, id)
    emitSubmissions()
    return { ok: true }
  })

  handle('submissions:approve', async (id: string) => {
    const row = db.get<any>(`SELECT * FROM tg_submissions WHERE id = ?`, id)
    if (!row) return { ok: false, text: 'Заявка не найдена' }
    const sub = mapSubmission(row)
    const text = [
      'Собери релиз из заявки (Telegram).',
      `Название: ${sub.title}`,
      `Исполнитель: ${sub.artist}`,
      `Лейбл: ${sub.label || 'Music 959'}`,
      `Жанры: ${sub.genres.join(', ')}`,
      `Дата релиза: ${sub.releaseDate ?? 'не указана'}`,
      `Ненормативная лексика: ${sub.explicit ? 'да' : 'нет'}`,
      `Авторы (в этом порядке): ${sub.authors || sub.author || sub.artist}`,
      'Первый автор — автор слов и музыки, доля контролируется мной; доли суммарно 100.',
      sub.description ? `Описание: ${sub.description}` : '',
      sub.lyrics ? `Текст песни:\n${sub.lyrics}` : '',
      '',
      'Аудио и обложка — во вложениях. Прогони release_wizard до экрана «Обзор», кнопку «Отправить на модерацию» не нажимай.',
    ]
      .filter(Boolean)
      .join('\n')

    const attachments = []
    try {
      const audioStat = statSync(sub.audioPath)
      attachments.push({
        id: `att_tg_${createHash('sha1').update(sub.audioPath).digest('hex').slice(0, 10)}`,
        filename: sub.audioName,
        mimeType: 'audio/wav',
        size: audioStat.size,
        kind: 'audio' as const,
        path: sub.audioPath,
      })
      const coverStat = statSync(sub.coverPath)
      attachments.push({
        id: `att_tg_${createHash('sha1').update(sub.coverPath).digest('hex').slice(0, 10)}`,
        filename: sub.coverName,
        mimeType: /\.png$/i.test(sub.coverName) ? 'image/png' : 'image/jpeg',
        size: coverStat.size,
        kind: 'image' as const,
        path: sub.coverPath,
      })
    } catch {
      return { ok: false, text: 'Файлы заявки не найдены на диске' }
    }

    const sent = await agent.sendUserMessage({ text, attachments })
    try {
      agent.renameConversation(sent.conversationId, `${sub.artist} — ${sub.title}`)
    } catch {
      /* не критично */
    }
    db.run(
      `UPDATE tg_submissions SET status = 'approved', decided_at = ?, result = ? WHERE id = ?`,
      Date.now(),
      `Передано в чат ${sent.conversationId}`,
      id,
    )
    emitSubmissions()
    return { ok: true, conversationId: sent.conversationId, text: 'Передал в новый чат — агент собирает релиз.' }
  })

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

  const accountState = () => {
    const st = svc.settings()
    return {
      login: st.accountLogin ?? '',
      remember: st.rememberAccount === 'true',
      openOnStart: st.openCabinetOnStart === 'true',
      hasPassword: secrets().has('broma:password'),
      passwordHint: secrets().hint('broma:password'),
      session: browser.state(),
    }
  }

  handle('account:state', accountState)
  handle('account:save', (input: any) => {
    svc.saveSettings({
      accountLogin: String(input.login ?? '').trim(),
      rememberAccount: Boolean(input.remember),
      openCabinetOnStart: Boolean(input.openOnStart),
    })
    if (typeof input.password === 'string' && input.password.length) {
      secrets().set('broma:password', input.password)
    }
    if (!input.remember) secrets().delete('broma:password')
    return accountState()
  })
  handle('account:forget', () => {
    secrets().delete('broma:password')
    svc.saveSettings({ rememberAccount: false })
    return accountState()
  })
  handle('account:auto-login', async (url?: string) => {
    const st = svc.settings()
    const res = await autoLogin(
      { browser, email, credentials: { login: st.accountLogin ?? '', password: secrets().get('broma:password') } },
      { url: typeof url === 'string' && url.startsWith('http') ? url : LOGIN_URL, show: true },
    )
    if (res.needsUser) browser.showWindow()
    return res
  })

  handle('provider:save', async (input: any) => llm.saveConnection(input))

  handle('vision:get', () => {
    const cfg = svc.vision.config()
    if (!cfg) return null
    return {
      provider: cfg.provider,
      model: cfg.model,
      hasKey: svc.vision.hasKey(cfg.provider),
      keyHint: svc.vision.hint(cfg.provider),
      updatedAt: cfg.updatedAt,
    }
  })
  handle('vision:save', (input: any) => {
    const cfg = svc.vision.save(input)
    return {
      provider: cfg.provider,
      model: cfg.model,
      hasKey: svc.vision.hasKey(cfg.provider),
      keyHint: svc.vision.hint(cfg.provider),
      updatedAt: cfg.updatedAt,
    }
  })
  handle('vision:test', () => svc.vision.test())
  handle('vision:clear', () => svc.vision.clear())

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
        { name: 'Все поддерживаемые', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'pdf', 'txt', 'md', 'docx', 'xlsx', 'csv', 'json', 'wav', 'mp3', 'aiff', 'flac', 'm4a'] },
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
  handle('actions:dismiss', (id: string) => {
    const row = db.get<any>(`SELECT status FROM pending_actions WHERE id = ?`, id)
    if (!row) return { ok: true }
    if (row.status === 'pending') return { ok: false, error: 'Действие ещё ждёт решения — сначала подтвердите или отмените его' }
    db.run(`DELETE FROM pending_actions WHERE id = ?`, id)
    return { ok: true }
  })
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
  handle('browser:click', (target: string) => browser.click(target))
  handle('release:wizard', async (input: any) => {
    const conversationId = String(input?.conversationId ?? '')
    const rows = db.all<any>(
      `SELECT a.id, a.filename, a.path, a.kind FROM chat_attachments a JOIN messages m ON m.id = a.message_id WHERE m.conversation_id = ?`,
      conversationId,
    )
    const map = new Map<string, { id: string; filename: string; path: string; kind: string }>()
    for (const r of rows) if (r.path) map.set(r.id, r)
    const wizard = new ReleaseWizard(browser, (ids) =>
      ids
        .map((id) => map.get(id))
        .filter((a): a is NonNullable<typeof a> => Boolean(a?.path))
        .map((a) => ({ id: a.id, path: a.path, filename: a.filename })),
    )
    return wizard.run(input.spec)
  })
  handle('browser:form-fields', () => browser.formFields())
  handle('browser:fill-field', (target: any, value: string) => browser.fillField(target, value))
  handle('browser:choose-option', (target: any, option: string) => browser.chooseOption(target, option))
  handle('browser:press', (key: string) => browser.pressKey(key))
  handle('browser:scroll', (y: number) => browser.scrollBy(Number(y)))
  handle('browser:validation-errors', () => browser.validationErrors())
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
    accountLogin: raw.accountLogin ?? '',
    rememberAccount: raw.rememberAccount === 'true',
    openCabinetOnStart: raw.openCabinetOnStart === 'true',
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
