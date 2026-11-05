import { BrowserWindow, session, app } from 'electron'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { BrowserAccountState } from '../../shared/types.js'

const PARTITION = 'persist:broma16'
export const LOGIN_URL = 'https://rod.broma16.com/login'
export const PORTAL_URL = 'https://rod.broma16.com/'
export const SIGNUP_URL = 'https://africa.broma16.com/proceed'
export const SITE_URL = 'https://broma16.com/'

/**
 * Управляемый браузер (Chromium внутри Electron, отдельная постоянная сессия).
 * Пользователь может войти сам, пройти 2FA/CAPTCHA — агент не обходит защиту.
 */
export class BrowserAutomation {
  private win: BrowserWindow | null = null
  private lastUrl = ''
  private lastTitle = ''
  private lastText = ''

  constructor(private readonly userDataDir: string) {}

  private ensureWindow(show = true): BrowserWindow {
    if (this.win && !this.win.isDestroyed()) {
      if (show && !this.win.isVisible()) this.win.show()
      return this.win
    }
    mkdirSync(this.userDataDir, { recursive: true })
    this.win = new BrowserWindow({
      width: 1180,
      height: 820,
      title: 'Broma 16 — аккаунт',
      show,
      autoHideMenuBar: true,
      webPreferences: {
        partition: PARTITION,
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        spellcheck: false,
      },
    })
    this.win.on('closed', () => {
      this.win = null
    })
    // Портал может открывать вход/оплату через window.open — ведём всё в этом же окне,
    // иначе появляется «новое окно» без сохранённой сессии и автозаполнения.
    this.win.webContents.setWindowOpenHandler(({ url }) => {
      if (/^https?:/i.test(url)) setTimeout(() => void this.open(url, true), 50)
      return { action: 'deny' }
    })
    this.win.webContents.setUserAgent(
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36',
    )
    return this.win
  }

  async open(url: string = PORTAL_URL, show = true): Promise<{ url: string; title: string }> {
    const win = this.ensureWindow(show)
    if (show) win.show()
    await win.loadURL(url)
    this.lastUrl = win.webContents.getURL()
    this.lastTitle = win.getTitle()
    return { url: this.lastUrl, title: this.lastTitle }
  }

  async read(options: { maxChars?: number } = {}): Promise<{
    url: string
    title: string
    text: string
    loggedIn: boolean
    hasPasswordField: boolean
    hasOtpField: boolean
    links: { text: string; href: string }[]
  }> {
    const win = this.ensureWindow(false)
    if (win.webContents.isLoading()) {
      await new Promise<void>((resolve) => win.webContents.once('did-stop-loading', () => resolve()))
    }
    const data = (await win.webContents.executeJavaScript(
      `(() => {
        const text = document.body ? document.body.innerText : ''
        const links = [...document.querySelectorAll('a[href]')].slice(0, 80).map(a => ({ text: (a.innerText||'').trim().slice(0,80), href: a.href }))
        const visible = (el) => {
          const r = el.getBoundingClientRect()
          const st = getComputedStyle(el)
          return r.width > 0 && r.height > 0 && st.visibility !== 'hidden' && st.display !== 'none'
        }
        const visibleInputs = [...document.querySelectorAll('input')].filter(visible)
        const hasPasswordField = visibleInputs.some((el) => el.type === 'password')
        const otpRe = /(code|otp|2fa|verif|token|код|подтвержд)/i
        const hasOtpField = visibleInputs.some((el) =>
          el.type === 'tel' || el.inputMode === 'numeric' ||
          otpRe.test((el.name || '') + (el.id || '') + (el.placeholder || '') + (el.autocomplete || '') + ((el.labels && el.labels[0] && el.labels[0].innerText) || '')),
        )
        return { url: location.href, title: document.title, text, links, hasPasswordField, hasOtpField }
      })()`,
      true,
    )) as any
    this.lastUrl = data.url
    this.lastTitle = data.title
    this.lastText = data.text ?? ''
    const text = String(this.lastText)
    const url = String(data.url)
    const loginUrl = /(login|sign[-_]?in|signin|\/auth|войти)/i.test(url)
    const accountSignals = /(logout|log out|sign out|выйти|выход|my releases|мои релизы|dashboard|личный кабинет|account settings|профиль|statistics|статистик)/i.test(
      text.slice(0, 20000),
    )
    const accountUrl = /(dashboard|\/account|\/releases|cabinet|\/profile)/i.test(url)
    const marketing = /(proceed to sign up|create an account|создать аккаунт|регистрац)/i.test(text.slice(0, 800))
    const loggedIn =
      !data.hasPasswordField &&
      !data.hasOtpField &&
      !loginUrl &&
      (accountSignals || accountUrl) &&
      !(marketing && !/logout|выйти/i.test(text.slice(0, 20000)))
    return {
      url: data.url,
      title: data.title,
      text: String(this.lastText).slice(0, options.maxChars ?? 30_000),
      loggedIn,
      hasPasswordField: Boolean(data.hasPasswordField),
      hasOtpField: Boolean(data.hasOtpField),
      links: data.links ?? [],
    }
  }

  async click(selectorOrText: string): Promise<{ ok: boolean; note: string }> {
    const win = this.ensureWindow(false)
    const result = await win.webContents.executeJavaScript(
      `(() => {
        const sel = ${JSON.stringify(selectorOrText)}
        let el = null
        try { el = document.querySelector(sel) } catch {}
        if (!el) {
          const all = [...document.querySelectorAll('a,button,[role=button],input[type=submit]')]
          el = all.find(e => (e.innerText||e.value||'').trim().toLowerCase().includes(sel.toLowerCase())) || null
        }
        if (!el) return { ok: false, note: 'Элемент не найден' }
        el.scrollIntoView({ block: 'center' })
        el.click()
        return { ok: true, note: (el.innerText||el.value||'').trim().slice(0,120) }
      })()`,
      true,
    )
    await new Promise((r) => setTimeout(r, 1200))
    return result
  }

  async fill(selector: string, value: string, submit = false): Promise<{ ok: boolean; note: string }> {
    const win = this.ensureWindow(false)
    const result = await win.webContents.executeJavaScript(
      `(() => {
        const el = document.querySelector(${JSON.stringify(selector)})
        if (!el) return { ok: false, note: 'Поле не найдено: ' + ${JSON.stringify(selector)} }
        const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
        const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set
        setter ? setter.call(el, ${JSON.stringify(value)}) : (el.value = ${JSON.stringify(value)})
        el.dispatchEvent(new Event('input', { bubbles: true }))
        el.dispatchEvent(new Event('change', { bubbles: true }))
        ${submit ? 'el.form && el.form.requestSubmit ? el.form.requestSubmit() : el.form && el.form.submit()' : ''}
        return { ok: true, note: 'Заполнено' }
      })()`,
      true,
    )
    if (submit) await new Promise((r) => setTimeout(r, 1500))
    return result
  }

  async navigateToLinkByText(text: string): Promise<{ ok: boolean; url?: string; note: string }> {
    const win = this.ensureWindow(false)
    const href = await win.webContents.executeJavaScript(
      `(() => {
        const t = ${JSON.stringify(text.toLowerCase())}
        const a = [...document.querySelectorAll('a[href]')].find(x => ((x.innerText||'') + ' ' + (x.href||'')).toLowerCase().includes(t))
        return a ? a.href : null
      })()`,
      true,
    )
    if (!href) return { ok: false, note: 'Ссылка не найдена' }
    await this.open(href, false)
    return { ok: true, url: href, note: 'Перешли по ссылке' }
  }

  async screenshot(): Promise<{ path: string }> {
    const win = this.ensureWindow(false)
    const image = await win.webContents.capturePage()
    const dir = join(this.userDataDir, 'screenshots')
    mkdirSync(dir, { recursive: true })
    const path = join(dir, `broma-${Date.now()}.png`)
    writeFileSync(path, image.toPNG())
    return { path }
  }

  /**
   * Заполняет форму входа сохранёнными логином и паролем (без отправки).
   * Пароль никогда не покидает main-процесс и в renderer не возвращается.
   */
  async fillLogin(login: string, password: string): Promise<{ ok: boolean; note: string; fields: number }> {
    const win = this.ensureWindow(false)
    if (win.webContents.isLoading()) {
      await new Promise<void>((resolve) => win.webContents.once('did-stop-loading', () => resolve()))
    }
    const result = (await win.webContents.executeJavaScript(
      `(() => {
        const loginValue = ${JSON.stringify(login)}
        const passwordValue = ${JSON.stringify(password)}
        const setValue = (el, value) => {
          const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
          const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set
          setter ? setter.call(el, value) : (el.value = value)
          el.dispatchEvent(new Event('input', { bubbles: true }))
          el.dispatchEvent(new Event('change', { bubbles: true }))
        }
        const visible = (el) => {
          const r = el.getBoundingClientRect()
          const style = getComputedStyle(el)
          return r.width > 0 && r.height > 0 && style.visibility !== 'hidden' && style.display !== 'none'
        }
        const inputs = [...document.querySelectorAll('input')].filter(visible)
        const pass = inputs.find((el) => el.type === 'password')
        const loginEl =
          inputs.find((el) => el.type === 'email') ||
          inputs.find((el) => /email|login|user|логин|почт/i.test((el.name || '') + (el.id || '') + (el.placeholder || ''))) ||
          inputs.find((el) => el.type === 'text')
        let fields = 0
        if (loginEl) { setValue(loginEl, loginValue); fields++ }
        if (pass) { setValue(pass, passwordValue); fields++ }
        return { fields, hasPassword: !!pass, hasLogin: !!loginEl }
      })()`,
      true,
    )) as { fields: number; hasPassword: boolean; hasLogin: boolean }
    if (!result.fields) return { ok: false, note: 'Поля входа не найдены на странице', fields: 0 }
    return {
      ok: true,
      note: `Заполнено полей: ${result.fields}${result.hasPassword ? ' (логин и пароль)' : ' (пароль не найден)'}`,
      fields: result.fields,
    }
  }

  /** Заполняет поле(я) кода подтверждения (OTP), включая формы из нескольких однозначных ячеек. */
  async fillOtp(code: string): Promise<{ ok: boolean; note: string; fields: number }> {
    const win = this.ensureWindow(false)
    if (win.webContents.isLoading()) {
      await new Promise<void>((resolve) => win.webContents.once('did-stop-loading', () => resolve()))
    }
    const result = (await win.webContents.executeJavaScript(
      `(() => {
        const code = ${JSON.stringify(code)}
        const visible = (el) => {
          const r = el.getBoundingClientRect()
          const st = getComputedStyle(el)
          return r.width > 0 && r.height > 0 && st.visibility !== 'hidden' && st.display !== 'none'
        }
        const setValue = (el, value) => {
          const proto = HTMLInputElement.prototype
          const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set
          setter ? setter.call(el, value) : (el.value = value)
          el.dispatchEvent(new Event('input', { bubbles: true }))
          el.dispatchEvent(new Event('change', { bubbles: true }))
        }
        const otpRe = /(code|otp|2fa|verif|token|код|подтвержд)/i
        const inputs = [...document.querySelectorAll('input')].filter(visible).filter((el) =>
          el.type === 'tel' || el.inputMode === 'numeric' ||
          otpRe.test((el.name || '') + (el.id || '') + (el.placeholder || '') + (el.autocomplete || '') + ((el.labels && el.labels[0] && el.labels[0].innerText) || '')),
        )
        if (!inputs.length) return { fields: 0, multi: false }
        if (inputs.length > 1) {
          inputs.forEach((el, i) => setValue(el, code[i] || ''))
          inputs[0].focus()
          return { fields: inputs.length, multi: true }
        }
        setValue(inputs[0], code)
        inputs[0].focus()
        return { fields: 1, multi: false }
      })()`,
      true,
    )) as { fields: number; multi: boolean }
    if (!result.fields) return { ok: false, note: 'Поле кода не найдено', fields: 0 }
    return { ok: true, note: result.multi ? `Код распределён по ${result.fields} ячейкам` : 'Код подставлен', fields: result.fields }
  }

  /** Нажимает кнопку отправки формы входа/кода (или Enter), чтобы завершить шаг. */
  async submitForm(kind: 'login' | 'otp' = 'login'): Promise<{ ok: boolean; note: string }> {
    const win = this.ensureWindow(false)
    if (win.webContents.isLoading()) {
      await new Promise<void>((resolve) => win.webContents.once('did-stop-loading', () => resolve()))
    }
    const result = (await win.webContents.executeJavaScript(
      `(() => {
        const kind = ${JSON.stringify(kind)}
        const visible = (el) => {
          const r = el.getBoundingClientRect()
          const st = getComputedStyle(el)
          return r.width > 0 && r.height > 0 && st.visibility !== 'hidden' && st.display !== 'none'
        }
        const otpRe = /(code|otp|2fa|verif|token|код|подтвержд)/i
        const inputs = [...document.querySelectorAll('input')].filter(visible)
        const target = kind === 'login'
          ? inputs.find((el) => el.type === 'password') || inputs.find((el) => el.type === 'email')
          : inputs.find((el) => otpRe.test((el.name || '') + (el.id || '') + (el.placeholder || '') + (el.autocomplete || '')) || el.inputMode === 'numeric')
        const form = target && target.closest('form')
        const submitRe = /(войти|вход|продолж|подтверд|далее|log ?in|sign ?in|continue|submit|verify|confirm|next)/i
        const buttons = [...document.querySelectorAll('button, input[type=submit], [role=button]')].filter(visible)
        const submitBtn = buttons.find((b) => submitRe.test((b.innerText || b.value || '').trim()))
        if (form && form.requestSubmit) { form.requestSubmit(submitBtn || undefined); return { ok: true, note: 'Форма отправлена' } }
        if (submitBtn) { submitBtn.click(); return { ok: true, note: 'Нажата кнопка ' + (submitBtn.innerText || submitBtn.value || '').trim().slice(0, 40) } }
        if (form && form.submit) { form.submit(); return { ok: true, note: 'Форма отправлена' } }
        if (target) {
          target.focus()
          for (const type of ['keydown', 'keypress', 'keyup']) {
            target.dispatchEvent(new KeyboardEvent(type, { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }))
          }
          return { ok: true, note: 'Нажат Enter' }
        }
        return { ok: false, note: 'Кнопка входа не найдена' }
      })()`,
      true,
    )) as { ok: boolean; note: string }
    await new Promise((r) => setTimeout(r, 2500))
    return result
  }

  /** Ждёт завершения входа: опрашивает страницу, пока не появится кабинет или ошибка. */
  async waitForLoggedIn(timeoutMs = 12_000): Promise<{
    loggedIn: boolean
    page: Awaited<ReturnType<BrowserAutomation['read']>>
  }> {
    const started = Date.now()
    let page = await this.read({ maxChars: 20_000 })
    while (!page.loggedIn && Date.now() - started < timeoutMs) {
      if (page.hasOtpField && !page.hasPasswordField) break
      if (/неверн|incorrect|invalid|ошибк|error/i.test(page.text.slice(0, 1200))) break
      await new Promise((r) => setTimeout(r, 700))
      page = await this.read({ maxChars: 20_000 })
    }
    return { loggedIn: page.loggedIn, page }
  }

  /** Ждёт, пока страница изменится (навигация/перерисовка) или истечёт таймаут. */
  async waitForChange(previousUrl: string, previousTextHash: number, timeoutMs = 8000): Promise<boolean> {
    const started = Date.now()
    while (Date.now() - started < timeoutMs) {
      const page = await this.read({ maxChars: 4000 })
      const hash = page.text.length + page.text.charCodeAt(0) * 31
      if (page.url !== previousUrl || hash !== previousTextHash) return true
      await new Promise((r) => setTimeout(r, 500))
    }
    return false
  }

  /**
   * Список полей загрузки файлов на текущей странице (input[type=file]).
   * Нужен агенту, чтобы понять, куда прикладывать обложку и WAV.
   */
  async listFileInputs(): Promise<
    { index: number; accept?: string; multiple: boolean; visible: boolean; hint?: string }[]
  > {
    const win = this.ensureWindow(false)
    if (win.webContents.isLoading()) {
      await new Promise<void>((resolve) => win.webContents.once('did-stop-loading', () => resolve()))
    }
    return win.webContents.executeJavaScript(
      `(() => [...document.querySelectorAll('input[type=file]')].map((el, index) => {
        const rect = el.getBoundingClientRect()
        const label = el.closest('label')?.innerText || el.getAttribute('aria-label') || el.name || el.id || ''
        return {
          index,
          accept: el.accept || '',
          multiple: !!el.multiple,
          visible: rect.width > 0 && rect.height > 0,
          hint: String(label).replace(/\s+/g, ' ').trim().slice(0, 120),
        }
      }))()`,
      true,
    )
  }

  /**
   * Реальная загрузка файлов в поле формы через CDP (DOM.setFileInputFiles).
   * Работает и с невидимыми input[type=file], которые открываются кнопкой «Выбрать файл».
   */
  async uploadFiles(
    index: number,
    paths: string[],
  ): Promise<{ ok: boolean; note: string; files?: { name: string; size: number }[] }> {
    if (!paths.length) return { ok: false, note: 'Не переданы файлы' }
    const win = this.ensureWindow(false)
    if (win.webContents.isLoading()) {
      await new Promise<void>((resolve) => win.webContents.once('did-stop-loading', () => resolve()))
    }
    const dbg = win.webContents.debugger
    try {
      if (!dbg.isAttached()) dbg.attach('1.3')
      await dbg.sendCommand('DOM.enable').catch(() => undefined)
      await dbg.sendCommand('Runtime.enable').catch(() => undefined)
      await dbg.sendCommand('DOM.getDocument', { depth: -1 }).catch(() => undefined)
      const evaluated = (await dbg.sendCommand('Runtime.evaluate', {
        expression: `document.querySelectorAll('input[type=file]')[${index}] || null`,
        returnByValue: false,
      })) as { result?: { objectId?: string } }
      const objectId = evaluated?.result?.objectId
      if (!objectId) return { ok: false, note: `Поле загрузки №${index} не найдено на странице` }
      const requested = (await dbg.sendCommand('DOM.requestNode', { objectId })) as { nodeId?: number }
      if (!requested?.nodeId) return { ok: false, note: 'Не удалось получить узел поля загрузки' }
      await dbg.sendCommand('DOM.setFileInputFiles', { files: paths, nodeId: requested.nodeId })
      const files = (await win.webContents.executeJavaScript(
        `(() => { const el = document.querySelectorAll('input[type=file]')[${index}]; return el ? [...el.files].map(f => ({ name: f.name, size: f.size })) : [] })()`,
        true,
      )) as { name: string; size: number }[]
      return {
        ok: files.length > 0,
        note: files.length ? `Прикреплено файлов: ${files.length}` : 'Браузер не подтвердил прикрепление файлов',
        files,
      }
    } catch (e) {
      return { ok: false, note: `Ошибка загрузки: ${(e as Error).message}` }
    } finally {
      try {
        if (dbg.isAttached()) dbg.detach()
      } catch {
        /* ignore */
      }
    }
  }

  state(): BrowserAccountState {
    return {
      loggedIn: /dashboard|account|release|личный кабинет/i.test(this.lastUrl),
      lastCheck: Date.now(),
      url: this.lastUrl || undefined,
      title: this.lastTitle || undefined,
    }
  }

  showWindow() {
    const win = this.ensureWindow(true)
    win.show()
  }

  async clearSession(): Promise<void> {
    this.closeWindow()
    await session.fromPartition(PARTITION).clearStorageData()
    await session.fromPartition(PARTITION).clearCache()
  }

  closeWindow() {
    if (this.win && !this.win.isDestroyed()) this.win.close()
    this.win = null
  }
}
