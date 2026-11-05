import { LOGIN_URL, type BrowserAutomation } from './automation.js'
import type { EmailService } from '../email/index.js'

export interface AutoLoginCredentials {
  login: string
  password: string | null
}

export interface AutoLoginResult {
  ok: boolean
  loggedIn: boolean
  steps: string[]
  note: string
  /** Требуется ручной ввод (код не найден, капча, 2FA-приложение) */
  needsUser?: boolean
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/**
 * Полный вход в кабинет: открыть страницу, подставить сохранённые логин/пароль,
 * при запросе кода — взять его из подключённой почты и заполнить.
 * Код подтверждения никогда не возвращается наружу и не уходит в LLM.
 */
export async function autoLogin(
  deps: { browser: BrowserAutomation; email: EmailService; credentials: AutoLoginCredentials },
  opts: { url?: string; show?: boolean; submit?: boolean; waitMs?: number } = {},
): Promise<AutoLoginResult> {
  const { browser, email, credentials } = deps
  const steps: string[] = []
  const submit = opts.submit !== false

  try {
    await browser.open(opts.url ?? LOGIN_URL, opts.show ?? true)
  } catch (e) {
    return { ok: false, loggedIn: false, steps, note: `Не удалось открыть кабинет: ${(e as Error).message}`, needsUser: true }
  }

  let page = await browser.read({ maxChars: 20_000 })
  if (page.loggedIn) {
    steps.push('Сессия уже активна')
    return { ok: true, loggedIn: true, steps, note: 'Сессия кабинета уже активна — вход не требуется.' }
  }

  if (!page.hasPasswordField) {
    // Иногда портал сначала показывает лендинг с кнопкой «Войти» — идём по ней.
    for (const label of ['войти', 'вход', 'sign in', 'log in', 'login']) {
      const clicked = await browser.click(label)
      if (!clicked.ok) continue
      await sleep(1800)
      page = await browser.read({ maxChars: 20_000 })
      if (page.hasPasswordField) break
    }
  }

  if (!page.hasPasswordField) {
    if (page.loggedIn) {
      steps.push('Сессия активна')
      return { ok: true, loggedIn: true, steps, note: 'Кабинет уже открыт, вход не требуется.' }
    }
    steps.push('Форма входа не найдена')
    return {
      ok: false,
      loggedIn: false,
      steps,
      note: `Страница открыта (${page.title || page.url}), поле пароля не найдено и признаков кабинета тоже. Прочитай страницу (account_read): возможно, вход уже выполнен или нужен другой экран.`,
      needsUser: true,
    }
  }

  if (!credentials.login || !credentials.password) {
    steps.push('Нет сохранённых данных')
    return {
      ok: false,
      loggedIn: false,
      steps,
      note: 'Сохранённого входа нет. Включи в настройках «Запоминать вход» и сохрани логин с паролем.',
      needsUser: true,
    }
  }

  const attemptStartedAt = Date.now()
  const filled = await browser.fillLogin(credentials.login, credentials.password)
  steps.push(filled.note)
  if (!filled.ok) {
    return { ok: false, loggedIn: false, steps, note: `Не удалось заполнить форму входа: ${filled.note}`, needsUser: true }
  }

  if (submit) {
    const sent = await browser.submitForm('login')
    steps.push(sent.note)
    const waited = await browser.waitForLoggedIn(opts.waitMs ?? 12_000)
    page = waited.page
    if (page.loggedIn) {
      steps.push('Вход выполнен')
      return { ok: true, loggedIn: true, steps, note: 'Вход в кабинет выполнен автоматически.' }
    }
    if (/неверн|incorrect|invalid|неправильн/i.test(page.text.slice(0, 4000))) {
      steps.push('Сайт сообщил о неверных данных')
      return {
        ok: false,
        loggedIn: false,
        steps,
        note: 'Сайт сообщил, что логин или пароль неверны. Проверь сохранённые данные в настройках.',
        needsUser: true,
      }
    }
  }

  // Код подтверждения
  const otpVisible = page.hasOtpField || !page.hasPasswordField
  if (!otpVisible) {
    return {
      ok: true,
      loggedIn: page.loggedIn,
      steps,
      note: page.loggedIn ? 'Вход выполнен.' : 'Данные подставлены — заверши вход в открытом окне.',
      needsUser: !page.loggedIn,
    }
  }

  let code: string | null = null
  let source = ''
  const accounts = email.accounts()
  if (accounts.length) {
    for (let attempt = 0; attempt < 3 && !code; attempt++) {
      try {
        await email.sync(accounts[0]!.id, 25)
      } catch {
        /* почта может быть недоступна — не блокируем вход */
      }
      const found = email.findVerificationCode(15, attemptStartedAt - 30_000)
      if (found) {
        code = found.code
        source = `${found.from || 'письмо'}${found.subject ? ` — «${found.subject.slice(0, 60)}»` : ''}`
        break
      }
      if (attempt < 2) await sleep(4000)
    }
  }

  if (!code) {
    steps.push('Код не найден в почте')
    return {
      ok: false,
      loggedIn: false,
      steps,
      note: accounts.length
        ? 'Кабинет запросил код, но в свежих письмах его нет. Проверь почту вручную и введи код в открытом окне (в чат не отправляй).'
        : 'Кабинет запросил код подтверждения, а почта не подключена. Подключи почту в разделе «Почта» или введи код вручную в открытом окне.',
      needsUser: true,
    }
  }

  const otpFilled = await browser.fillOtp(code)
  steps.push(`${otpFilled.note} (источник: ${source})`)
  if (otpFilled.ok && submit) {
    const sent = await browser.submitForm('otp')
    steps.push(sent.note)
    const waited = await browser.waitForLoggedIn(opts.waitMs ?? 12_000)
    page = waited.page
  }

  return {
    ok: page.loggedIn || otpFilled.ok,
    loggedIn: page.loggedIn,
    steps,
    note: page.loggedIn
      ? 'Вход выполнен, включая код подтверждения из почты.'
      : otpFilled.ok
        ? `Код из письма подставлен (${source}) — заверши вход в открытом окне, если сайт ещё просит подтверждение.`
        : 'Код получен, но подставить не удалось — введи его вручную в открытом окне.',
    needsUser: !page.loggedIn,
  }
}
