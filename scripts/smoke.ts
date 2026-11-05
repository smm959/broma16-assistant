/*
 * Интеграционный smoke-тест. Запуск: node scripts/smoke.mjs
 * Проверяет БД, базу знаний, поиск, инструменты, разбор файлов и стриминг LLM
 * на локальном фейковом OpenAI-совместимом сервере (без реальных ключей).
 */
import { app } from 'electron'
import { createServer } from 'node:http'
import { createServer as createTcpServer } from 'node:net'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildServices } from '../electron/services.js'
import { OpenAiCompatibleAdapter } from '../electron/llm/providers/openai.js'

const results: { name: string; ok: boolean; info?: string }[] = []
const check = (name: string, ok: boolean, info?: string) => {
  results.push({ name, ok, info })
  console.log(`${ok ? 'PASS' : 'FAIL'} — ${name}${info ? ` :: ${info}` : ''}`)
}

app.setPath('userData', mkdtempSync(join(tmpdir(), 'broma-smoke-')))

app.whenReady().then(async () => {
  try {
    const svc = buildServices(() => undefined)
    const { db, kb, files, agent } = svc

    /* ---------------- база знаний ---------------- */
    const status = kb.status()
    check('FAQ загружен', status.articles >= 40, `${status.articles} статей, ${status.categories} категорий`)

    const hits = kb.index.search('питчинг маркетинг релиз', 3)
    check('Поиск по FAQ (рус.)', hits.length > 0, hits[0]?.article.title)
    check('Найден официальный URL', Boolean(hits[0]?.article.url?.startsWith('https://broma16nlbv.freshdesk.com')), hits[0]?.article.url)

    const hitsEn = kb.index.search('invoice template payment', 3)
    check('Поиск по FAQ (англ.)', hitsEn.length > 0, hitsEn[0]?.article.title)

    const article = kb.index.getArticle('150000133571')
    check('Чтение статьи по external id', Boolean(article?.contentText.includes('Excel')), article?.title?.slice(0, 60))

    /* ---------------- контакты ---------------- */
    const contacts = db.all<any>(`SELECT * FROM contacts`)
    check('Контакты Broma 16', contacts.length >= 2, `${contacts.map((c) => `${c.email}:${c.verification_status}`).join(', ')} | err=${svc.kb.status().lastError ?? ''}`)

    /* ---------------- релизы / обращения ---------------- */
    db.run(
      `INSERT INTO releases (id, artist, title, release_date, upc, isrc, status, platform_links, created_at, updated_at) VALUES ('rel_test', 'Music 959', 'Night Drive', '2026-12-01', '1234567890123', 'RUAAA2400001', 'planned', '{}', ?, ?)`,
      Date.now(), Date.now(),
    )
    check('Релиз сохранён', db.all(`SELECT * FROM releases`).length === 1)

    /* ---------------- инструменты ---------------- */
    const { toolMap } = await import('../electron/agent/tools.js')
    const kbSearchTool = toolMap().get('kb_search')!
    const ctx = {
      db, kb, files,
      email: svc.email,
      browser: svc.browser,
      settings: () => svc.settings(),
      attachments: new Map(),
    }
    const toolRes = await kbSearchTool.run({ query: 'content id youtube claim' }, ctx as any)
    check('Инструмент kb_search', toolRes.content.includes('http'), toolRes.sources?.[0]?.title)

    /* ---------------- разбор файлов ---------------- */
    for (const name of ['sample.pdf', 'sample.docx', 'sample.xlsx']) {
      const ref = await files.saveUpload(name, new Uint8Array(require('node:fs').readFileSync(join(process.cwd(), 'test-fixtures', name))))
      check(`Разбор ${name}`, Boolean(ref.extractedText && ref.extractedText.length > 10), ref.extractedText?.slice(0, 60).replace(/\s+/g, ' '))
    }

    /* ---------------- LLM стриминг + tool calls ---------------- */
    let callIndex = 0
    const server = createServer((req, res) => {
      if (req.url?.endsWith('/chat/completions')) {
        callIndex++
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        const send = (obj: unknown) => res.write(`data: ${JSON.stringify(obj)}\n\n`)
        if (callIndex === 1) {
          send({ choices: [{ delta: { content: 'Ищу в базе… ' } }] })
          send({
            choices: [{
              delta: {
                tool_calls: [{ index: 0, id: 'call_1', function: { name: 'kb_search', arguments: '{"query":"pitch' } }],
              },
            }],
          })
          send({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'ing"}' } }] } }] })
          send({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] })
        } else {
          send({ choices: [{ delta: { content: 'Готово: питчинг отправляется на marketing@broma16.com.' } }] })
          send({ choices: [{ delta: {}, finish_reason: 'stop' }] })
        }
        res.write('data: [DONE]\n\n')
        res.end()
        return
      }
      res.writeHead(404).end()
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    const port = (server.address() as any).port
    const adapter = new OpenAiCompatibleAdapter('compatible')
    const deltas: string[] = []
    const first = await adapter.streamChat(
      {
        model: 'test-model',
        messages: [{ role: 'user', content: 'Куда отправлять питчинг?' }],
        tools: [{ name: 'kb_search', description: 'search', parameters: { type: 'object', properties: {} } }],
        onText: (d) => deltas.push(d),
      },
      'test-key',
      `http://127.0.0.1:${port}/v1`,
    )
    check('SSE-стриминг текста', deltas.join('') === 'Ищу в базе… ', deltas.join('') || '(пусто)')
    check('Сборка tool_call из дельт', first.toolCalls[0]?.name === 'kb_search' && first.toolCalls[0]?.arguments === '{"query":"pitching"}', JSON.stringify(first.toolCalls))

    const second = await adapter.streamChat(
      {
        model: 'test-model',
        messages: [{ role: 'user', content: 'ok' }, { role: 'assistant', content: '', toolCalls: first.toolCalls }],
      },
      'test-key',
      `http://127.0.0.1:${port}/v1`,
    )
    check('Второй шаг без tools', second.text.includes('marketing@broma16.com'), second.text.slice(0, 50))
    server.close()

    /* ---------------- классификация писем ---------------- */
    const { classifyEmail, extractTicketId } = await import('../electron/email/index.js')
    check('Классификация: инвойс', classifyEmail('Invoice for Q3', 'Please find attached invoice', 'Reports / Payments') === 'invoice', classifyEmail('Invoice for Q3', 'Please find attached invoice', 'Reports / Payments'))
    check('Классификация: питчинг', classifyEmail('Marketing kit', 'We submit a pitching kit', 'Marketing / Pitching') === 'marketing')
    check('Извлечение Ticket ID', extractTicketId('Re: [#98765] Your request') === '98765', extractTicketId('Re: [#98765] Your request'))

    /* ---------------- агент: подтверждение действия ---------------- */
    let agentCall = 0
    const emailServer = createServer((req, res) => {
      req.resume()
      req.on('end', () => {
        agentCall++
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        const send = (o: unknown) => res.write(`data: ${JSON.stringify(o)}\n\n`)
        if (agentCall === 1) {
          send({ choices: [{ delta: { content: 'Готовлю письмо в Broma 16.' } }] })
          send({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_mail', function: { name: 'email_send', arguments: JSON.stringify({ to: 'marketing@broma16.com', subject: 'Marketing Pitching — Test', body: 'Hello,\nTest' }) } }] } }] })
          send({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] })
        } else {
          send({ choices: [{ delta: { content: 'Хорошо, письмо не отправляю.' } }] })
          send({ choices: [{ delta: {}, finish_reason: 'stop' }] })
        }
        res.write('data: [DONE]\n\n')
        res.end()
      })
    })
    await new Promise<void>((r) => emailServer.listen(0, '127.0.0.1', r))
    const emailPort = (emailServer.address() as any).port
    await svc.llm.saveConnection({ provider: 'compatible', model: 'test-model', apiKey: 'sk-smoke', baseUrl: `http://127.0.0.1:${emailPort}/v1` })
    const sent = await agent.sendUserMessage({ text: 'Отправь письмо в Broma 16 про питчинг' })
    let pendingActions: any[] = []
    for (let i = 0; i < 40; i++) {
      pendingActions = agent.actions(sent.conversationId).filter((a) => a.status === 'pending')
      if (pendingActions.length) break
      await new Promise((r) => setTimeout(r, 100))
    }
    check('Агент создал действие на подтверждение', pendingActions.length === 1, pendingActions[0]?.title)
    check('Предпросмотр письма корректен', pendingActions[0]?.preview?.to === 'marketing@broma16.com' && pendingActions[0]?.preview?.subject?.includes('Marketing Pitching'))
    if (pendingActions[0]) agent.reject(pendingActions[0].id)
    await new Promise((r) => setTimeout(r, 500))
    const rejected = agent.actions(sent.conversationId).find((a) => a.id === pendingActions[0]?.id)
    check('Отклонение действия работает', rejected?.status === 'rejected')
    emailServer.close()

    /* ---------------- отправка письма (локальный SMTP) ---------------- */
    const received: string[] = []
    const smtp = createTcpServer((socket) => {
      socket.write('220 smoke-smtp ready\r\n')
      let dataMode = false
      let dataEnded = false
      let buffer = ''
      socket.on('data', (chunk) => {
        buffer += chunk.toString('utf8')
        let idx: number
        while ((idx = buffer.indexOf('\r\n')) >= 0) {
          const line = buffer.slice(0, idx)
          buffer = buffer.slice(idx + 2)
          if (dataMode) {
            if (line === '.') {
              dataMode = false
              dataEnded = true
              socket.write('250 2.0.0 queued\r\n')
            } else {
              received.push(line)
            }
            continue
          }
          if (/^EHLO|^HELO/i.test(line)) socket.write('250-smoke\r\n250-AUTH PLAIN LOGIN\r\n250 OK\r\n')
          else if (/^AUTH PLAIN/i.test(line)) socket.write('235 2.7.0 authenticated\r\n')
          else if (/^AUTH LOGIN/i.test(line)) socket.write('334 VXNlcm5hbWU6\r\n')
          else if (/^MAIL FROM/i.test(line) || /^RCPT TO/i.test(line)) socket.write('250 OK\r\n')
          else if (/^DATA/i.test(line)) { dataMode = true; socket.write('354 end with .\r\n') }
          else if (/^[A-Za-z0-9+/=]+$/.test(line) && line.length) socket.write('235 2.7.0 authenticated\r\n')
          else if (/^QUIT/i.test(line)) { socket.write('221 bye\r\n'); socket.end() }
          else if (/^RSET|^NOOP/i.test(line)) socket.write('250 OK\r\n')
          else socket.write('250 OK\r\n')
        }
      })
    })
    await new Promise<void>((r) => smtp.listen(0, '127.0.0.1', r))
    const smtpPort = (smtp.address() as any).port
    const account = await svc.email.saveAccount({
      label: 'Smoke Mail',
      email: 'smoke@example.com',
      username: 'smoke@example.com',
      imapHost: '127.0.0.1',
      imapPort: 1993,
      smtpHost: '127.0.0.1',
      smtpPort,
      password: 'smoke-pass',
    })
    const sendRes = await svc.email.send({
      accountId: account.id,
      to: 'marketing@broma16.com',
      subject: 'Marketing Pitching — Smoke — Test',
      body: 'Hello,\n\nSmoke body.\n\nBest regards,\nMusic 959',
    })
    check('Письмо отправлено через SMTP', Boolean(sendRes.messageId), sendRes.messageId)
    const flat = received.join('\n')
    check('SMTP получил тело письма', flat.includes('Smoke body'), flat.slice(0, 120).replace(/\s+/g, ' '))
    check('Письмо сохранено в истории', svc.db.all(`SELECT * FROM email_messages WHERE direction = 'outgoing'`).length === 1)
    smtp.close()

    /* ---------------- состояние агента ---------------- */
    check('База создана', Boolean(db.path))

    const failed = results.filter((r) => !r.ok)
    console.log(`\nИТОГО: ${results.length - failed.length}/${results.length} проверок пройдено`)
    app.exit(failed.length ? 1 : 0)
  } catch (e) {
    console.error('SMOKE ERROR', e)
    app.exit(2)
  }
})
