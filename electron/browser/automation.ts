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

const FORM_FIELDS_JS = String.raw`(() => {
  const all = [...document.querySelectorAll('input,select,textarea')]
  const visible = (el) => {
    const r = el.getBoundingClientRect()
    const st = getComputedStyle(el)
    return r.width > 0 && r.height > 0 && st.visibility !== 'hidden' && st.display !== 'none'
  }
  return all.map((el, index) => {
    const wrap = (el.parentElement && el.parentElement.closest('[id]')) || null
    const labelEl = el.closest('label') || (el.labels && el.labels[0])
    const labelText = labelEl ? labelEl.innerText : ''
    const parentText = (el.parentElement && el.parentElement.innerText) || ''
    const required = !!el.required || /\*/.test(labelText) || (parentText.match(/\*/) ? el.closest('label') !== null : false)
    const tag = el.tagName.toLowerCase()
    let selector = ''
    if (el.id) selector = '#' + el.id
    else if (wrap && wrap.id) selector = '#' + wrap.id + ' ' + tag
    else if (el.getAttribute('placeholder')) selector = tag + '[placeholder="' + el.getAttribute('placeholder') + '"]'
    return {
      index,
      tag,
      type: el.type || '',
      name: el.getAttribute('name') || '',
      id: el.id || '',
      placeholder: el.getAttribute('placeholder') || '',
      ariaLabel: el.getAttribute('aria-label') || '',
      formcontrolname: el.getAttribute('formcontrolname') || el.getAttribute('formControlName') || '',
      required,
      disabled: !!el.disabled,
      readOnly: !!el.readOnly,
      value: (el.value || '').toString().slice(0, 80),
      visible: visible(el),
      wrapper: wrap ? wrap.id : '',
      label: labelText.replace(/\s+/g, ' ').trim().slice(0, 80),
      datepicker: !!el.closest('.p-calendar'),
      options: tag === 'select' ? [...el.options].slice(0, 40).map((o) => o.text.trim()) : undefined,
      selector,
    }
  })
})()`

const RESOLVE_JS = (target: string | number) => String.raw`(() => {
  const t = ${JSON.stringify(target)}
  const all = [...document.querySelectorAll('input,select,textarea')]
  const visible = (el) => {
    const r = el.getBoundingClientRect()
    const st = getComputedStyle(el)
    return r.width > 0 && r.height > 0 && st.visibility !== 'hidden' && st.display !== 'none'
  }
  const norm = (x) => String(x || '').toLowerCase().replace(/\s+/g, ' ').trim()
  const idxOf = (el) => all.indexOf(el)
  const done = (el, via) => ({ index: idxOf(el), via })
  if (typeof t === 'number' || /^\d+$/.test(String(t))) {
    const i = Number(t)
    return all[i] ? { index: i, via: 'index' } : { reason: 'Индекс ' + i + ' вне диапазона (полей: ' + all.length + ')' }
  }
  const s = String(t).trim()
  if (!s) return { reason: 'Пустой target' }
  // 1. CSS-селектор
  try {
    const els = [...document.querySelectorAll(s)]
    const idx = els.map(idxOf).filter((i) => i >= 0)
    if (idx.length === 1) return { index: idx[0], via: 'css' }
    if (idx.length > 1) return { candidates: idx, via: 'css' }
    if (els.length > 0) return { reason: 'Селектор нашёл элементы, но это не поля формы' }
  } catch (e) { /* не селектор */ }
  const key = norm(s)
  const exactPh = all.map((el, i) => ({ el, i })).filter(({ el }) => norm(el.getAttribute('placeholder')) === key)
  if (exactPh.length === 1) return done(exactPh[0].el, 'placeholder')
  const containsPh = all.map((el, i) => ({ el, i })).filter(({ el }) => norm(el.getAttribute('placeholder')).includes(key))
  if (containsPh.length === 1) return done(containsPh[0].el, 'placeholder-contains')
  const attrCandidates = all.map((el, i) => ({ el, i })).filter(({ el }) =>
    norm(el.id).includes(key) || norm(el.getAttribute('name')).includes(key) || norm(el.getAttribute('aria-label')).includes(key) || norm(el.getAttribute('formcontrolname')).includes(key),
  )
  if (attrCandidates.length === 1) return done(attrCandidates[0].el, 'attribute')
  const wrapCandidates = all.map((el, i) => ({ el, i })).filter(({ el }) => {
    const w = el.parentElement && el.parentElement.closest('[id]')
    return w && norm(w.id).includes(key)
  })
  if (wrapCandidates.length === 1) return done(wrapCandidates[0].el, 'wrapper-id')
  const labelCandidates = all.map((el, i) => ({ el, i })).filter(({ el }) => {
    const l = el.closest('label') || (el.labels && el.labels[0])
    return l && norm(l.innerText).includes(key)
  })
  if (labelCandidates.length === 1) return done(labelCandidates[0].el, 'label')
  const merge = (list) => {
    const seen = new Set()
    return list.filter(({ i }) => (seen.has(i) ? false : (seen.add(i), true)))
  }
  const narrowed = merge([...exactPh, ...containsPh, ...attrCandidates, ...wrapCandidates, ...labelCandidates]).filter(({ el }) => visible(el) && el.type !== 'hidden')
  if (narrowed.length === 1) return done(narrowed[0].el, 'unique-visible')
  if (narrowed.length > 1) {
    const sel = narrowed.find(({ el }) => el.tagName === 'SELECT')
    if (sel) return done(sel.el, 'unique-select')
    const writable = narrowed.find(({ el }) => !el.readOnly && el.type !== 'checkbox')
    if (writable) return done(writable.el, 'unique-writable')
  }
  const vis = all.map((el, i) => ({ el, i })).filter(({ el }) => visible(el) && el.type !== 'hidden')
  if (vis.length === 1) return done(vis[0].el, 'single-visible')
  return {
    reason: 'Поле не найдено',
    candidates: [...exactPh, ...containsPh, ...attrCandidates, ...wrapCandidates, ...labelCandidates].map(({ el, i }) => ({
      index: i, tag: el.tagName.toLowerCase(), type: el.type, placeholder: el.getAttribute('placeholder') || '', id: el.id || '',
    })).slice(0, 12),
  }
})()`

const FIELD_BY_INDEX = (index: number) => `document.querySelectorAll('input,select,textarea')[${index}]`


/** executeJavaScript с таймаутом: зависший/упавший renderer не должен блокировать агента. */
async function execJs(wc: Electron.WebContents, script: string, gesture?: boolean): Promise<any> {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      wc.executeJavaScript(script, gesture as boolean),
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('Страница кабинета не отвечает (таймаут 20 с). Переоткрой кабинет через account_open и повтори.')),
          20_000,
        )
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

export class BrowserAutomation {
  private win: BrowserWindow | null = null
  private lastUrl = ''
  private lastTitle = ''
  private lastText = ''

  constructor(private readonly userDataDir: string) {}

  /** Ждём, пока SPA отрисует содержимое (loadURL резолвится раньше, чем Angular). */
  private async waitForContent(win: BrowserWindow, minLen = 20, timeoutMs = 10_000): Promise<void> {
    const started = Date.now()
    while (Date.now() - started < timeoutMs) {
      try {
        const len = (await execJs(win.webContents, 'document.body ? document.body.innerText.length : 0')) as number
        if (Number(len) >= minLen) return
      } catch (e) {
        this.resetWindow()
        throw e
      }
      await new Promise((r) => setTimeout(r, 400))
    }
  }

  /** Сбросить окно кабинета: следующее действие создаст чистое окно. */
  resetWindow() {
    const w = this.win
    this.win = null
    try {
      w?.destroy()
    } catch {
      /* ignore */
    }
  }

  /** Выполнение JS с автосбросом окна при зависании/падении renderer. */
  private async ev(win: BrowserWindow, script: string, gesture?: boolean): Promise<any> {
    try {
      return await execJs(win.webContents, script, gesture)
    } catch (e) {
      this.resetWindow()
      throw e
    }
  }

  /** Ждём загрузку страницы, но не дольше таймаута: SPA может «висеть» в загрузке вечно. */
  private async waitReady(win: BrowserWindow, timeoutMs = 8000) {
    if (!win.webContents.isLoading()) return
    await Promise.race([
      new Promise<void>((resolve) => win.webContents.once('did-stop-loading', () => resolve())),
      new Promise<void>((resolve) => setTimeout(resolve, timeoutMs)),
    ])
  }

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
    this.win.webContents.on('render-process-gone', () => {
      try {
        this.win?.destroy()
      } catch {
        /* ignore */
      }
      this.win = null
    })
    // Портал может открывать вход/оплату через window.open — ведём всё в этом же окне,
    // иначе появляется «новое окно» без сохранённой сессии и автозаполнения.
    this.win.webContents.setWindowOpenHandler(({ url }) => {
      if (/^https?:/i.test(url)) setTimeout(() => void this.open(url, true), 50)
      return { action: 'deny' }
    })
    // Автоматически закрываем нативные JS-диалоги (alert/confirm), иначе renderer
    // блокируется и любые действия агента «висят».
    try {
      const dbg = this.win.webContents.debugger
      dbg.attach('1.3')
      void dbg.sendCommand('Page.enable').catch(() => undefined)
      dbg.on('message', (_event, method, params: any) => {
        if (method === 'Page.javascriptDialogOpening') {
          void dbg.sendCommand('Page.handleJavaScriptDialog', { accept: Boolean(params?.type === 'alert' || params?.type === 'beforeunload') }).catch(() => undefined)
        }
      })
    } catch {
      /* debugger может быть занят DevTools — не критично */
    }
    this.win.webContents.setUserAgent(
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36',
    )
    return this.win
  }

  async open(url: string = PORTAL_URL, show = true): Promise<{ url: string; title: string }> {
    const win = this.ensureWindow(show)
    if (show) win.show()
    let timer: NodeJS.Timeout | undefined
    try {
      await Promise.race([
        win.loadURL(url),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error(`Страница ${url} не загрузилась за 25 секунд`)), 25_000)
        }),
      ])
    } catch (e) {
      this.resetWindow()
      throw e
    } finally {
      if (timer) clearTimeout(timer)
    }
    await this.waitForContent(win)
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
    await this.waitReady(win)
    await this.waitForContent(win, 10, 6000).catch(() => undefined)
    const data = (await this.ev(win, 
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
    const result = await this.ev(win, 
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
    const result = await this.ev(win, 
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
    const href = await this.ev(win, 
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
    await this.waitReady(win)
    const result = (await this.ev(win, 
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
    await this.waitReady(win)
    const result = (await this.ev(win, 
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
    await this.waitReady(win)
    const result = (await this.ev(win, 
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
    await this.waitReady(win)
    return this.ev(win, 
      String.raw`(() => [...document.querySelectorAll('input[type=file]')].map((el, index) => {
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
    await this.waitReady(win)
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
      const files = (await this.ev(win, 
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
      /* debugger оставляем подключённым: он ловит JS-диалоги и не блокирует окно */
    }
  }


  /** Все поля формы с семантикой: id, placeholder, wrapper, label, required, значение. */
  async formFields(): Promise<unknown[]> {
    const win = this.ensureWindow(false)
    await this.waitReady(win)
    return (await this.ev(win, FORM_FIELDS_JS, true)) as unknown[]
  }

  /** Ошибки валидации на странице (тексты) — для проверки «заполнил → прочитал». */
  async validationErrors(): Promise<string[]> {
    const win = this.ensureWindow(false)
    return (await this.ev(win, 
      `(() => {
        const nodes = [...document.querySelectorAll('.p-error, .p-invalid, [role=alert], .error, .invalid-feedback, [class*=error-message]')]
        const texts = nodes.map((n) => (n.innerText || '').trim()).filter((t) => t && t.length < 200)
        const invalid = [...document.querySelectorAll('input[aria-invalid=true], .ng-invalid.p-invalid')].length
        return [...new Set(texts)].slice(0, 20).concat(invalid ? ['полей с ошибкой: ' + invalid] : [])
      })()`,
      true,
    )) as string[]
  }

  /**
   * Заполнить поле по селектору/placeholder/подписи/id/номеру.
   * Возвращает подробности: что нашли, было/стало, сработало ли, и HTML элемента.
   */
  async fillField(
    target: string | number,
    value: string,
  ): Promise<{
    ok: boolean
    note: string
    field?: Record<string, unknown>
    before?: string
    after?: string
    verified?: boolean
    candidates?: unknown[]
    datepicker?: boolean
  }> {
    const win = this.ensureWindow(false)
    await this.waitReady(win)
    const resolved = (await this.ev(win, RESOLVE_JS(target), true)) as {
      index?: number
      via?: string
      reason?: string
      candidates?: unknown[]
    }
    if (resolved.index === undefined) {
      return { ok: false, note: resolved.reason ?? 'Поле не найдено', candidates: resolved.candidates }
    }

    const index = resolved.index
    const before = (await this.ev(win, 
      String.raw`(() => {
        const el = ${FIELD_BY_INDEX(index)}
        const wrap = el.closest('[id]')
        const label = el.closest('label')
        return {
          tag: el.tagName.toLowerCase(), type: el.type || '', id: el.id || '', name: el.getAttribute('name') || '',
          placeholder: el.getAttribute('placeholder') || '', ariaLabel: el.getAttribute('aria-label') || '',
          wrapper: wrap ? wrap.id : '', label: label ? label.innerText.replace(/\s+/g, ' ').trim().slice(0, 80) : '',
          value: (el.value || '').toString(), html: el.outerHTML.slice(0, 200),
          datepicker: !!el.closest('.p-calendar'), tagName: el.tagName,
        }
      })()`,
      true,
    )) as any

    // Календарь (p-calendar): используем сам виджет, иначе Angular не примет значение.
    if (before.datepicker) {
      const dateResult = await this.pickDate(index, String(value).trim())
      const after = await this.ev(win, `(${FIELD_BY_INDEX(index)}).value`, true)
      return {
        ok: dateResult.ok,
        note: dateResult.note,
        field: before,
        before: before.value,
        after: String(after ?? ''),
        verified: String(after ?? '') === String(value).trim() || dateResult.ok,
        datepicker: true,
      }
    }

    if (String(before.type) === 'checkbox' || String(before.type) === 'radio') {
      const want = /^(1|true|on|yes|да|checked|включ)/i.test(String(value).trim())
      const res = (await this.ev(win, 
        String.raw`(() => {
          const el = ${FIELD_BY_INDEX(index)}
          if (el.checked !== ${want}) el.click()
          if (el.checked !== ${want}) { el.checked = ${want}; el.dispatchEvent(new Event('change', { bubbles: true })) }
          return { ok: true, checked: !!el.checked }
        })()`,
        true,
      )) as { ok: boolean; checked: boolean }
      return {
        ok: res.checked === want,
        note: res.checked === want ? (want ? 'Флажок включён' : 'Флажок выключен') : `Состояние флажка: ${res.checked}`,
        field: before,
        before: String(before.value ?? ''),
        after: String(res.checked),
        verified: res.checked === want,
      }
    }

    const isSelect = String(before.tag) === 'select'
    const result = (await this.ev(win, 
      isSelect
        ? `(() => {
            const el = ${FIELD_BY_INDEX(index)}
            const want = ${JSON.stringify(String(value))};
            const norm = (x) => String(x || '').trim().toLowerCase();
            const opt = [...el.options].find((o) => norm(o.text) === norm(want) || norm(o.value) === norm(want))
              || [...el.options].find((o) => norm(o.text).includes(norm(want)));
            if (!opt) return { ok: false, note: 'Вариант не найден', options: [...el.options].map((o) => o.text) };
            el.value = opt.value;
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
            return { ok: true, note: 'Выбран вариант «' + opt.text.trim() + '»', after: el.value };
          })()`
        : `(() => {
            const el = ${FIELD_BY_INDEX(index)}
            const value = ${JSON.stringify(String(value))}
            el.focus()
            const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
            const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set
            setter ? setter.call(el, value) : (el.value = value)
            el.dispatchEvent(new InputEvent('input', { bubbles: true, data: value, inputType: 'insertText' }))
            el.dispatchEvent(new Event('change', { bubbles: true }))
            el.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', bubbles: true }))
            el.blur()
            return { ok: true, note: 'Значение установлено', after: el.value }
          })()`,
      true,
    )) as { ok: boolean; note: string; after?: string; options?: string[] }

    let after = String(result.after ?? '')
    let verified = after === String(value)
    // Если фреймворк не принял значение — пробуем реальный ввод через CDP.
    if (!verified && !isSelect) {
      const typed = await this.typeInto(index, String(value))
      if (typed.ok) {
        after = typed.value
        verified = after === String(value)
      }
    }
    return {
      ok: result.ok && verified,
      note: verified ? `Заполнено: «${after}»` : `Значение не подтвердилось (стало «${after || 'пусто'}»)`,
      field: before,
      before: before.value,
      after,
      verified,
      datepicker: false,
    }
  }

  /** Прокрутить страницу (для виртуализированных форм, где поля рендерятся по мере скролла). */
  async scrollBy(deltaY: number): Promise<{ ok: boolean; note: string }> {
    const win = this.ensureWindow(false)
    await this.ev(win, `(() => { window.scrollBy(0, ${Math.round(deltaY)}); return true })()`, true)
    await new Promise((r) => setTimeout(r, 400))
    return { ok: true, note: `Прокручено на ${Math.round(deltaY)}px` }
  }

  /** Нажать клавишу в текущем фокусе (Enter/Tab/Escape/ArrowDown/Backspace). */
  async pressKey(key: string): Promise<{ ok: boolean; note: string }> {
    const win = this.ensureWindow(false)
    const dbg = win.webContents.debugger
    const map: Record<string, { keyCode: number; code: string }> = {
      Enter: { keyCode: 13, code: 'Enter' },
      Tab: { keyCode: 9, code: 'Tab' },
      Escape: { keyCode: 27, code: 'Escape' },
      ArrowDown: { keyCode: 40, code: 'ArrowDown' },
      ArrowUp: { keyCode: 38, code: 'ArrowUp' },
      Backspace: { keyCode: 8, code: 'Backspace' },
    }
    const info = map[key] ?? { keyCode: key.length === 1 ? key.toUpperCase().charCodeAt(0) : 0, code: key }
    try {
      if (!dbg.isAttached()) dbg.attach('1.3')
      await dbg.sendCommand('Input.dispatchKeyEvent', { type: 'keyDown', key, code: info.code, windowsVirtualKeyCode: info.keyCode, nativeVirtualKeyCode: info.keyCode })
      await dbg.sendCommand('Input.dispatchKeyEvent', { type: 'keyUp', key, code: info.code, windowsVirtualKeyCode: info.keyCode, nativeVirtualKeyCode: info.keyCode })
      await new Promise((r) => setTimeout(r, 300))
      return { ok: true, note: `Нажата клавиша ${key}` }
    } catch (e) {
      return { ok: false, note: `Не удалось нажать ${key}: ${(e as Error).message}` }
    } finally {
      /* debugger оставляем подключённым: он ловит JS-диалоги и не блокирует окно */
    }
  }

  /** Реальный ввод с клавиатуры через CDP — для капризных SPA/масок. */
  private async typeInto(index: number, value: string): Promise<{ ok: boolean; value: string }> {
    const win = this.ensureWindow(false)
    const dbg = win.webContents.debugger
    try {
      if (!dbg.isAttached()) dbg.attach('1.3')
      await this.ev(win, 
        `(() => { const el = ${FIELD_BY_INDEX(index)}; el.focus(); el.select && el.select(); return true })()`,
        true,
      )
      await dbg.sendCommand('Input.insertText', { text: value })
      await this.ev(win, `(${FIELD_BY_INDEX(index)}).blur()`, true)
      const after = (await this.ev(win, `(${FIELD_BY_INDEX(index)}).value`, true)) as string
      return { ok: after === value, value: String(after ?? '') }
    } catch {
      return { ok: false, value: '' }
    } finally {
      /* debugger оставляем подключённым: он ловит JS-диалоги и не блокирует окно */
    }
  }

  /** Выбрать значение в кастомном выпадающем списке (PrimeNG select/dropdown/autocomplete) или нативном select. */
  async chooseOption(
    target: string | number,
    optionText: string,
  ): Promise<{ ok: boolean; note: string; before?: string; after?: string; options?: string[] }> {
    const win = this.ensureWindow(false)
    await this.waitReady(win)
    const resolved = (await this.ev(win, RESOLVE_JS(target), true)) as { index?: number; reason?: string; candidates?: unknown[] }
    if (resolved.index === undefined) {
      return { ok: false, note: resolved.reason ?? 'Поле не найдено' }
    }
    const index = resolved.index
    const before = (await this.ev(win, `(() => { const el = ${FIELD_BY_INDEX(index)}; return { value: (el.value || '').toString(), text: (el.closest('[id]') || el).innerText.trim().slice(0, 120), tag: el.tagName.toLowerCase() } })()`, true)) as any

    // Нативный select — просто ставим значение; если это лишь скрытый select
    // внутри PrimeNG-компонента, идём в оверлей.
    if (String(before.tag) === 'select') {
      const res = (await this.ev(win, 
        String.raw`(() => {
          const el = ${FIELD_BY_INDEX(index)}
          const want = ${JSON.stringify(optionText)}
          const norm = (x) => String(x || '').trim().toLowerCase()
          const opt = [...el.options].find((o) => norm(o.text) === norm(want)) || [...el.options].find((o) => norm(o.text).includes(norm(want)))
          if (!opt) return { ok: false, options: [...el.options].map((o) => o.text.trim()) }
          el.value = opt.value
          el.dispatchEvent(new Event('input', { bubbles: true }))
          el.dispatchEvent(new Event('change', { bubbles: true }))
          return { ok: true, after: opt.text.trim() }
        })()`,
        true,
      )) as any
      if (res.ok) return { ok: true, note: `Выбран вариант «${res.after}»`, before: before.value, after: res.after, options: res.options }
    }

    // Кастомный компонент: если оверлей уже открыт — не переключаем его закрытым.
    const alreadyOpen = (await this.ev(win, 
      String.raw`(() => [...document.querySelectorAll('.p-dropdown-panel [role=option], .p-select-overlay [role=option], .p-autocomplete-panel [role=option], .p-multiselect-panel [role=option], [role=listbox] [role=option]')].some((n) => n.getBoundingClientRect().width > 0))()`,
      true,
    )) as boolean
    if (!alreadyOpen) {
      await this.ev(win, 
        `(() => {
          const el = ${FIELD_BY_INDEX(index)}
          const control = el.closest('.p-select, .p-dropdown, .p-autocomplete, .p-multiselect, .p-treeselect') || el.parentElement || el
          const trigger = control.querySelector('button, .p-select-dropdown, .p-dropdown-trigger, .p-autocomplete-dropdown') || el
          trigger.click()
          el.focus()
          return true
        })()`,
        true,
      )
      await new Promise((r) => setTimeout(r, 450))
    }
    const picked = (await this.ev(win, 
      String.raw`(() => {
        const want = ${JSON.stringify(optionText)}
        const norm = (x) => String(x || '').trim().toLowerCase()
        const sels = ['.p-select-overlay [role=option]', '.p-dropdown-panel [role=option]', '.p-autocomplete-panel [role=option]', '.p-multiselect-panel [role=option]', '[role=listbox] [role=option]', '.p-select-overlay li', '.p-dropdown-items li', '.p-autocomplete-items li', '.p-overlay li']
        let nodes = []
        for (const sel of sels) { const found = [...document.querySelectorAll(sel)].filter((n) => n.getBoundingClientRect().width > 0); if (found.length) { nodes = found; break } }
        const texts = nodes.map((n) => (n.innerText || '').replace(/\s+/g, ' ').trim()).filter(Boolean)
        const exact = nodes.find((n) => norm(n.innerText) === norm(want))
        const partial = nodes.find((n) => norm(n.innerText).includes(norm(want)))
        const node = exact || partial
        if (!node) return { ok: false, options: texts.slice(0, 20) }
        node.click()
        return { ok: true, matched: (node.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 80), options: texts.slice(0, 20) }
      })()`,
      true,
    )) as any
    await new Promise((r) => setTimeout(r, 400))
    const after = (await this.ev(win, 
      `(() => { const el = ${FIELD_BY_INDEX(index)}; const control = el.closest('.p-select, .p-dropdown, .p-autocomplete, .p-multiselect'); return { value: (el.value || '').toString(), text: control ? control.innerText.trim().slice(0, 120) : (el.closest('[id]') || el).innerText.trim().slice(0, 120) } })()`,
      true,
    )) as any
    const ok = Boolean(picked.ok) && /[a-zа-я0-9]/i.test(String(after.value || after.text || ''))
    return {
      ok,
      note: picked.ok ? `Выбрано «${picked.matched ?? optionText}»; в контроле: «${String(after.value || after.text).slice(0, 60)}»` : `Опция не найдена. Доступно: ${(picked.options ?? []).slice(0, 8).join(' | ')}`,
      before: String(before.value || before.text),
      after: String(after.value || after.text),
      options: picked.options,
    }
  }

  /** Выбор значения в p-calendar: год или день, с навигацией по десятилетиям/месяцам. */
  private async pickDate(index: number, value: string): Promise<{ ok: boolean; note: string }> {
    const win = this.ensureWindow(false)
    const yearMatch = /^(\d{4})/.exec(value)
    const year = yearMatch?.[1]
    await this.ev(win, 
      `(() => {
        const el = ${FIELD_BY_INDEX(index)}
        const wrap = el.closest('.p-calendar') || el.parentElement
        const btn = wrap.querySelector('button')
        ;(btn || el).click()
        el.focus()
        return true
      })()`,
      true,
    )
    await new Promise((r) => setTimeout(r, 400))
    for (let attempt = 0; attempt < 14; attempt++) {
      const state = (await this.ev(win, 
        `(() => {
          const panel = document.querySelector('.p-datepicker')
          if (!panel) return { open: false }
          const years = [...panel.querySelectorAll('.p-yearpicker-year')].map((e) => e.innerText.trim())
          const days = [...panel.querySelectorAll('td')].filter((td) => td.innerText.trim()).length
          return { open: true, years, days, head: panel.innerText.slice(0, 40) }
        })()`,
        true,
      )) as { open: boolean; years?: string[]; days?: number; head?: string }
      if (!state.open) {
        const after = (await this.ev(win, `(${FIELD_BY_INDEX(index)}).value`, true)) as string
        return { ok: String(after ?? '') === value, note: `Значение в поле: «${after ?? ''}»` }
      }
      if (year && state.years?.length) {
        if (state.years.includes(year)) {
          await this.ev(win, 
            `(() => { const p = document.querySelector('.p-datepicker'); const c = [...p.querySelectorAll('.p-yearpicker-year')].find((e) => e.innerText.trim() === ${JSON.stringify(year)}); c && c.click(); return true })()`,
            true,
          )
          await new Promise((r) => setTimeout(r, 350))
          const after = (await this.ev(win, `(${FIELD_BY_INDEX(index)}).value`, true)) as string
          if (String(after ?? '') === year) return { ok: true, note: `Выбран год ${year}` }
          return { ok: false, note: `После выбора года в поле «${after ?? ''}»` }
        }
        const min = Number(state.years[0])
        const max = Number(state.years[state.years.length - 1])
        const dir = Number(year) < min ? 'prev' : 'next'
        await this.ev(win, 
          `(() => { const p = document.querySelector('.p-datepicker'); const b = p && (p.querySelector('.p-datepicker-' + ${JSON.stringify(dir)}) || p.querySelector('[class*=' + ${JSON.stringify(dir)} + ']')); b && b.click(); return !!b })()`,
          true,
        )
        await new Promise((r) => setTimeout(r, 300))
        continue
      }
      if (state.days) {
        // Полный календарь: ищем ячейку с нужным днём (dd.mm.yyyy).
        const m = /^(\d{1,2})[.\-/](\d{1,2})[.\-/](\d{4})$/.exec(value)
        if (m) {
          const day = m[1]
          const clicked = await this.ev(win, 
            `(() => {
              const p = document.querySelector('.p-datepicker')
              const cells = [...p.querySelectorAll('td')].filter((td) => td.innerText.trim())
              const cell = cells.find((td) => td.innerText.trim() === ${JSON.stringify(day)})
              if (!cell) return false
              cell.click(); return true
            })()`,
            true,
          )
          await new Promise((r) => setTimeout(r, 300))
          if (clicked) {
            const after = (await this.ev(win, `(${FIELD_BY_INDEX(index)}).value`, true)) as string
            return { ok: Boolean(after), note: `Выбрана дата: «${after ?? ''}»` }
          }
        }
        break
      }
      break
    }
    return { ok: false, note: 'Не удалось выбрать дату в календаре' }
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
