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

    /* ---------------- аудио и загрузка файлов ---------------- */
    const wavRef = await files.saveUpload('sample.wav', new Uint8Array(require('node:fs').readFileSync(join(process.cwd(), 'test-fixtures', 'sample.wav'))))
    check('WAV распознан как аудио', wavRef.kind === 'audio' && wavRef.mimeType === 'audio/wav', `${wavRef.kind}/${wavRef.mimeType}`)

    await svc.browser.open('file://' + join(process.cwd(), 'test-fixtures', 'upload.html'))
    const inputs = await svc.browser.listFileInputs()
    check('Поля загрузки найдены', inputs.length === 2 && inputs[1]?.accept === 'audio/*', JSON.stringify(inputs))

    const uploaded = await svc.browser.uploadFiles(1, [join(process.cwd(), 'test-fixtures', 'sample.wav')])
    check(
      'Файл прикреплён через CDP в input[type=file]',
      uploaded.ok && uploaded.files?.[0]?.name === 'sample.wav',
      JSON.stringify(uploaded.files ?? uploaded.note),
    )

    const { toolMap: tools2 } = await import('../electron/agent/tools.js')
    const uploadTool = tools2().get('account_upload_files')!
    const attMap = new Map([[wavRef.id, wavRef]])
    const upRes = await uploadTool.run(
      { attachment_ids: [wavRef.id], input_index: 1 },
      { ...ctx, attachments: attMap } as any,
    )
    check('Инструмент account_upload_files работает', /прикреплены/i.test(upRes.content), upRes.content.slice(0, 90))

    /* ---------------- политика подтверждений ---------------- */
    const { isFinalSubmit, toolMap: tools3 } = await import('../electron/agent/tools.js')
    const clickRisk = tools3().get('account_click')!.risk as (a: any) => string
    const fillRisk = tools3().get('account_fill')!.risk as (a: any) => string
    check('Заполнение полей — без подтверждения', fillRisk({ selector: '#title', value: 'X' }) === 'safe', fillRisk({ selector: '#title', value: 'X' }))
    check('Отправка формы (submit) — с подтверждением', fillRisk({ selector: '#title', value: 'X', submit: true }) === 'confirm')
    check('Клик «Далее» — без подтверждения', clickRisk({ selector_or_text: 'Далее' }) === 'safe')
    check('Клик «Отправить на релиз» — с подтверждением', clickRisk({ selector_or_text: 'Отправить на релиз' }) === 'confirm')
    check('isFinalSubmit распознаёт публикацию', isFinalSubmit('Publish') && !isFinalSubmit('Обложка'))

    /* ---------------- сохранённый вход в кабинет ---------------- */
    await svc.browser.open('file://' + join(process.cwd(), 'test-fixtures', 'login.html'))
    const filled = await svc.browser.fillLogin('music959@example.com', 'super-secret-pass')
    await new Promise((r) => setTimeout(r, 200))
    const loginPage = await svc.browser.read()
    check(
      'Автовход заполняет логин и пароль',
      filled.ok && filled.fields === 2 && loginPage.text.includes('music959@example.com') && loginPage.text.includes('super-secret-pass'),
      filled.note,
    )
    svc.saveSettings({ accountLogin: 'music959@example.com', rememberAccount: true })
    const { secrets: secretsMod } = await import('../electron/security/secrets.js')
    secretsMod().set('broma:password', 'super-secret-pass')
    check('Пароль кабинета хранится в секретах', secretsMod().get('broma:password') === 'super-secret-pass' && Boolean(secretsMod().hint('broma:password')?.includes('pass')))
    check('Логин сохранён в настройках', svc.settings().accountLogin === 'music959@example.com' && svc.settings().rememberAccount === 'true')

    /* ---------------- полный автовход с кодом из почты ---------------- */
    const { autoLogin } = await import('../electron/browser/login.js')
    svc.db.run(
      `INSERT INTO email_messages (id, account_id, uid, folder, direction, sender, sender_name, recipient, subject, body_text, body_html, date, department, category, is_broma16, flags, attachments, created_at)
       VALUES ('em_test_code', 'acc_test', '1', 'INBOX', 'incoming', 'no-reply@broma16.com', 'Broma 16', 'me@example.com', 'Код подтверждения', 'Ваш код для входа: 123456. Действует 10 минут.', '', ?, 'Support', 'account', 1, '[]', '[]', ?)`,
      Date.now(),
      Date.now(),
    )
    await svc.email.saveAccount({
      label: 'Smoke Inbox',
      email: 'smoke@example.com',
      username: 'smoke@example.com',
      imapHost: '127.0.0.1',
      imapPort: 1993,
      smtpHost: '127.0.0.1',
      smtpPort: 2525,
      password: 'smoke-pass',
    })
    const codeFound = svc.email.findVerificationCode(30)
    check('Код подтверждения найден в письме', codeFound?.code === '123456', codeFound?.subject)
    const loginFlow = await autoLogin(
      { browser: svc.browser, email: svc.email, credentials: { login: 'music959@example.com', password: 'super-secret-pass' } },
      { url: 'file://' + join(process.cwd(), 'test-fixtures', 'login-flow.html'), show: false, waitMs: 1200 },
    )
    await new Promise((r) => setTimeout(r, 1500))
    check(
      'Автовход проходит логин и код подтверждения',
      loginFlow.loggedIn && loginFlow.steps.some((x) => /код/i.test(x)),
      `${loginFlow.note} :: ${loginFlow.steps.join('; ')}`,
    )

    /* ---------------- формы: дамп, заполнение, календарь, дропдауны ---------------- */
    await svc.browser.open('file://' + join(process.cwd(), 'test-fixtures', 'form.html'))
    const formFields = (await svc.browser.formFields()) as any[]
    check('account_form_fields видит поля', formFields.length >= 4 && formFields.some((f) => f.datepicker), `${formFields.length} полей`)
    const filledTitle = await svc.browser.fillField('Название', 'ТОБОЙ НЕ ПОНЯТ')
    check(
      'account_fill возвращает подробности и подтверждает значение',
      Boolean(filledTitle.ok && filledTitle.verified && filledTitle.after === 'ТОБОЙ НЕ ПОНЯТ' && filledTitle.field?.id === 'f-title'),
      JSON.stringify({ after: filledTitle.after, id: filledTitle.field?.id }),
    )
    const filledDate = await svc.browser.fillField('date_p_line', '2026')
    check('Дата выбирается через календарь', filledDate.ok && filledDate.after === '2026', filledDate.note)
    const genre = await svc.browser.chooseOption('genre_dd', 'Pop')
    check('account_select выбирает опцию кастомного дропдауна', genre.ok && genre.after === 'Pop', genre.note)
    const native = await svc.browser.chooseOption('f-type', 'Сингл')
    check('account_select работает с нативным select', native.ok && native.after === 'Сингл', native.note)

    /* ---------------- vision fallback ---------------- */
    const visionServer = createServer((req, res) => {
      req.resume()
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        const send = (o: unknown) => res.write(`data: ${JSON.stringify(o)}\n\n`)
        send({ choices: [{ delta: { content: 'На изображении обложка релиза: тёмный фон, лаймовый круг, буква B.' } }] })
        send({ choices: [{ delta: {}, finish_reason: 'stop' }] })
        res.write('data: [DONE]\n\n')
        res.end()
      })
    })
    await new Promise<void>((r) => visionServer.listen(0, '127.0.0.1', r))
    const visionPort = (visionServer.address() as any).port
    svc.vision.save({ provider: 'compatible', model: 'vision-test', apiKey: 'sk-vision', baseUrl: `http://127.0.0.1:${visionPort}/v1` })
    const description = await svc.vision.describeImage(join(process.cwd(), 'resources', 'icon.png'), 'image/png', 'что это?')
    check('Vision-модель описывает картинку', description.includes('обложка'), description.slice(0, 80))
    const visionTest = await svc.vision.test()
    check('Проверка vision-подключения', visionTest.ok, visionTest.sample ?? visionTest.error)
    visionServer.close()

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
