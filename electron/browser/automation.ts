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
    const tokenRoot = el.closest('.p-autocomplete-multiple-container')
    const tokens = tokenRoot ? [...tokenRoot.querySelectorAll('.p-autocomplete-token-label')].map((x) => x.innerText.trim()).filter(Boolean) : []
    const invalid = el.getAttribute('aria-invalid') === 'true' || el.classList.contains('p-invalid') || !!el.closest('.p-invalid')
    const placeholder = el.getAttribute('placeholder') || ''
    let key = ''
    if (placeholder) key = 'ph:' + placeholder
    else if (el.id && !/^ti-/.test(el.id) && el.id !== 'scrollable-layout') key = 'id:' + el.id
    else if (wrap && wrap.id) key = 'wrap:' + wrap.id
    else key = 'idx:' + index
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
      placeholder,
      ariaLabel: el.getAttribute('aria-label') || '',
      formcontrolname: el.getAttribute('formcontrolname') || el.getAttribute('formControlName') || '',
      required,
      disabled: !!el.disabled,
      readOnly: !!el.readOnly,
      value: (el.value || '').toString().slice(0, 80),
      checked: el.type === 'checkbox' || el.type === 'radio' ? Boolean(el.checked) : undefined,
      tokens,
      invalid,
      key,
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
  if (/^ph:/i.test(s)) {
    const k = norm(s.slice(3))
    const el = all.find((e) => norm(e.getAttribute('placeholder')) === k) || all.find((e) => norm(e.getAttribute('placeholder')).includes(k))
    return el ? done(el, 'key-placeholder') : { reason: 'Поле с placeholder «' + s.slice(3) + '» не найдено' }
  }
  if (/^wrap:/i.test(s)) {
    const k = norm(s.slice(5))
    const el = all.find((e) => { const w = e.parentElement && e.parentElement.closest('[id]'); return w && norm(w.id) === k })
    return el ? done(el, 'key-wrapper') : { reason: 'Поле с wrapper «' + s.slice(5) + '» не найдено' }
  }
  if (/^id:/i.test(s)) {
    const el = document.getElementById(s.slice(3))
    return el && idxOf(el) >= 0 ? done(el, 'key-id') : { reason: 'Поле с id «' + s.slice(3) + '» не найдено' }
  }
  if (/^idx:/i.test(s)) {
    const i = Number(s.slice(4))
    return all[i] ? { index: i, via: 'key-index' } : { reason: 'Индекс ' + i + ' вне диапазона' }
  }
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

const STAB_JS = `(() => {
  if (window.__bromaStab) return true
  window.__bromaStab = true
  window.__bromaMut = 0
  window.__bromaMutAt = Date.now()
  window.__bromaNet = 0
  try {
    new MutationObserver(() => { window.__bromaMut++; window.__bromaMutAt = Date.now() })
      .observe(document.documentElement || document, { subtree: true, childList: true, characterData: true, attributes: true })
  } catch (e) {}
  try {
    const of = window.fetch
    if (of) {
      window.fetch = function (...args) {
        window.__bromaNet++
        return of.apply(this, args).finally(() => { window.__bromaNet--; window.__bromaMutAt = Date.now() })
      }
    }
  } catch (e) {}
  try {
    const send = XMLHttpRequest.prototype.send
    XMLHttpRequest.prototype.send = function (...args) {
      window.__bromaNet++
      this.addEventListener('loadend', () => { window.__bromaNet--; window.__bromaMutAt = Date.now() })
      return send.apply(this, args)
    }
  } catch (e) {}
  return true
})()`

const READ_JS = `(() => {
  const text = document.body ? document.body.innerText : ''
  const links = [...document.querySelectorAll('a[href]')].slice(0, 80).map((a) => ({ text: (a.innerText || '').trim().slice(0, 80), href: a.href }))
  const visible = (el) => {
    const r = el.getBoundingClientRect()
    const st = getComputedStyle(el)
    return r.width > 0 && r.height > 0 && st.visibility !== 'hidden' && st.display !== 'none'
  }
  const visibleInputs = [...document.querySelectorAll('input')].filter(visible)
  const hasPasswordField = visibleInputs.some((el) => el.type === 'password')
  const otpRe = /(code|otp|2fa|verif|token|код|подтвержд)/i
  const hasOtpField = visibleInputs.some(
    (el) =>
      el.type === 'tel' ||
      el.inputMode === 'numeric' ||
      otpRe.test((el.name || '') + (el.id || '') + (el.placeholder || '') + (el.autocomplete || '') + ((el.labels && el.labels[0] && el.labels[0].innerText) || '')),
  )
  const logout = [...document.querySelectorAll('a,button')].some((el) => /^(выйти|выход|log ?out|sign ?out)$/i.test((el.innerText || '').trim()))
  const wizard = /(Дистрибуция|Обзор)/.test(text) && /(Файлы|Фонограммы|Релиз)/.test(text)
  return { url: location.href, title: document.title, text, links, hasPasswordField, hasOtpField, logout, wizard }
})()`

const RU_MONTHS = ['январ', 'феврал', 'март', 'апрел', 'ма', 'июн', 'июл', 'август', 'сентябр', 'октябр', 'ноябр', 'декабр']
function monthIndexFromRussian(text: string): number {
  const t = String(text || '').toLowerCase()
  const i = RU_MONTHS.findIndex((m) => m !== 'ма' && t.includes(m))
  if (i >= 0) return i + 1
  if (t.includes('май') || t.includes('мая')) return 5
  return -1
}

function detectAuth(data: {
  url?: string
  text?: string
  hasPasswordField?: boolean
  logout?: boolean
  wizard?: boolean
}): 'in' | 'out' | 'unknown' {
  const url = String(data.url ?? '')
  const text = String(data.text ?? '')
  if (data.logout || data.wizard || /\/accounts\//i.test(url)) return 'in'
  if (data.hasPasswordField || /(login|sign[-_]?in|signin|\/auth)/i.test(url)) return 'out'
  if (text.trim().length < 20) return 'unknown'
  // Нет ни формы входа, ни признаков кабинета — честно «не удалось определить»,
  // отсутствие поля пароля само по себе не означает разлогин.
  return 'unknown'
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

  /** Если окно открыто без страницы (после сброса), загружаем вход, чтобы renderer ожил. */
  private async ensurePage(win: BrowserWindow): Promise<void> {
    if (win.webContents.getURL()) return
    try {
      await win.loadURL(LOGIN_URL)
    } catch {
      /* нет сети — ниже просто подождём */
    }
    await this.waitReady(win, 5000).catch(() => undefined)
    await this.waitForContent(win, 5, 8000).catch(() => undefined)
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

  /** Ставим счётчики мутаций DOM и сетевых запросов (fetch/XHR), чтобы понять, когда страница успокоилась. */
  private async waitForStable(win: BrowserWindow, timeoutMs = 10_000, quietMs = 350): Promise<void> {
    await execJs(win.webContents, STAB_JS).catch(() => undefined)
    const started = Date.now()
    while (Date.now() - started < timeoutMs) {
      const state = (await execJs(
        win.webContents,
        `({ mutAt: window.__bromaMutAt || 0, net: window.__bromaNet || 0, len: document.body ? document.body.innerText.length : 0 })`,
      ).catch(() => null)) as { mutAt: number; net: number; len: number } | null
      if (!state) return
      const quiet = Date.now() - Number(state.mutAt || 0)
      if (Number(state.net) === 0 && quiet > quietMs && Number(state.len) > 0) return
      await new Promise((r) => setTimeout(r, 150))
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
    auth: 'in' | 'out' | 'unknown'
    hasPasswordField: boolean
    hasOtpField: boolean
    links: { text: string; href: string }[]
  }> {
    const win = this.ensureWindow(false)
    await this.ensurePage(win)
    await this.waitReady(win)
    await this.waitForStable(win).catch(() => undefined)

    let data: any = null
    let auth: 'in' | 'out' | 'unknown' = 'unknown'
    for (let attempt = 0; attempt < 3; attempt++) {
      data = (await this.ev(win, READ_JS)) as any
      auth = detectAuth(data)
      if (auth !== 'unknown') break
      await new Promise((r) => setTimeout(r, 650))
      await this.waitForStable(win, 4000).catch(() => undefined)
    }
    if (!data) data = { url: '', title: '', text: '', links: [], hasPasswordField: false, hasOtpField: false }

    this.lastUrl = data.url
    this.lastTitle = data.title
    this.lastText = data.text ?? ''
    return {
      url: data.url,
      title: data.title,
      text: String(this.lastText).slice(0, options.maxChars ?? 30_000),
      loggedIn: auth === 'in',
      auth,
      hasPasswordField: Boolean(data.hasPasswordField),
      hasOtpField: Boolean(data.hasOtpField),
      links: data.links ?? [],
    }
  }

  /** Запрос к внутреннему API кабинета с токеном из localStorage (детерминированные сценарии). */
  async apiFetch(path: string, init?: { method?: string; body?: unknown }): Promise<{ status: number; text: string }> {
    const method = init?.method ?? 'GET'
    const bodyLiteral = init?.body === undefined ? 'undefined' : JSON.stringify(JSON.stringify(init.body))
    return this.evaluateRaw(
      `(async () => {
        const token = localStorage.getItem('token')
        const res = await fetch('https://api-rod.broma16.ru/api' + ${JSON.stringify(path)}, {
          method: ${JSON.stringify(method)},
          headers: {
            accept: 'application/json',
            'content-type': 'application/json',
            'x-access-token': token,
            'x-client-version': '1.0',
            'x-requested-with': 'XMLHttpRequest',
          },
          body: ${bodyLiteral},
        })
        const text = await res.text()
        return { status: res.status, text }
      })()`,
    )
  }

  /** Выполнить произвольный JS на текущей странице (для сценарных шагов). */
  async evaluateRaw(script: string): Promise<any> {
    const win = this.ensureWindow(false)
    await this.ensurePage(win)
    await this.waitReady(win)
    return this.ev(win, script, true)
  }

  /** Что за элемент будет нажат: текст, тег, disabled. Нужно для защиты финальной кнопки. */
  async describeTarget(selectorOrText: string): Promise<{
    found: boolean
    text?: string
    tag?: string
    disabled?: boolean
    html?: string
  }> {
    const win = this.ensureWindow(false)
    await this.ensurePage(win)
    return (await this.ev(win,
      `(() => {
        const sel = ${JSON.stringify(selectorOrText)}
        const visible = (el) => {
          const r = el.getBoundingClientRect()
          const st = getComputedStyle(el)
          return r.width > 0 && r.height > 0 && st.visibility !== 'hidden' && st.display !== 'none'
        }
        let el = null
        try {
          const found = [...document.querySelectorAll(sel)].filter(visible)
          el = found[0] || null
        } catch (e) {}
        if (!el) {
          const all = [...document.querySelectorAll('a,button,[role=button],input[type=submit],label,[role=radio],[role=checkbox],.p-radiobutton,.p-checkbox')].filter(visible)
          el = all.find((e) => ((e.innerText || e.value || '').trim().toLowerCase().includes(sel.toLowerCase()))) || null
        }
        if (!el) {
          const generic = [...document.querySelectorAll('div,span,li,p')]
            .filter((e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && (e.innerText || '').trim().length > 0 && (e.innerText || '').trim().length < 220 })
            .filter((e) => (e.innerText || '').trim().toLowerCase().includes(sel.toLowerCase()))
            .sort((a, b) => (a.innerText || '').length - (b.innerText || '').length)
          el = generic[0] || null
        }
        if (!el) return { found: false }
        return {
          found: true,
          text: ((el.innerText || el.value || el.getAttribute('aria-label') || '').trim()).slice(0, 200),
          tag: el.tagName.toLowerCase(),
          disabled: Boolean(el.disabled) || el.getAttribute('aria-disabled') === 'true',
          html: el.outerHTML.slice(0, 200),
        }
      })()`,
      true,
    )) as any
  }

  async click(selectorOrText: string): Promise<{ ok: boolean; note: string }> {
    const win = this.ensureWindow(false)
    const result = await this.ev(win, 
      `(() => {
        const sel = ${JSON.stringify(selectorOrText)}
        let el = null
        try { el = document.querySelector(sel) } catch {}
        if (!el) {
          const all = [...document.querySelectorAll('a,button,[role=button],input[type=submit],label,[role=radio],[role=checkbox],.p-radiobutton,.p-checkbox')]
          el = all.find(e => (e.innerText||e.value||'').trim().toLowerCase().includes(sel.toLowerCase())) || null
        }
        if (!el) {
          // Кастомные радио/чекбоксы бывают обычными div/span — берём самый маленький подходящий.
          const generic = [...document.querySelectorAll('div,span,li,p')]
            .filter((e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && (e.innerText||'').trim().length > 0 && (e.innerText||'').trim().length < 220 })
            .filter((e) => (e.innerText||'').trim().toLowerCase().includes(sel.toLowerCase()))
            .sort((a, b) => (a.innerText||'').length - (b.innerText||'').length)
          el = generic[0] || null
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

  async screenshot(): Promise<{ path: string; degraded: boolean; note?: string }> {
    const win = this.ensureWindow(false)
    await this.ensurePage(win)
    const grab = async () => {
      let timer: NodeJS.Timeout | undefined
      try {
        return await Promise.race([
          win.webContents.capturePage(),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error('Скриншот не получен за 45 секунд')), 45_000)
          }),
        ])
      } finally {
        if (timer) clearTimeout(timer)
      }
    }
    let image: Electron.NativeImage
    try {
      image = await grab()
    } catch {
      try {
        await this.waitForContent(win, 5, 5000).catch(() => undefined)
        image = await grab()
      } catch (e) {
        return { path: '', degraded: true, note: `Скриншот недоступен: ${(e as Error).message}. Страницу можно проверить через account_read.` }
      }
    }
    const dir = join(this.userDataDir, 'screenshots')
    mkdirSync(dir, { recursive: true })
    const path = join(dir, `broma-${Date.now()}.png`)
    writeFileSync(path, image.toPNG())
    return { path, degraded: false }
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
    await this.ensurePage(win)
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
    await this.ensurePage(win)
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
    await this.ensurePage(win)
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
    await this.ensurePage(win)
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
    let typedValue = String(value).trim()
    const todayDdMmYyyy = () => {
      const d = new Date()
      return `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}.${d.getFullYear()}`
    }
    if (/^(сегодня|today|\{\{today\}\})$/i.test(typedValue)) typedValue = todayDdMmYyyy()
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
    // «Дата создания» всегда сегодняшняя — сайт не принимает будущую дату.
    if (/дата создания/i.test(String(before.placeholder ?? '')) && /\d{1,2}[.\-/]\d{1,2}[.\-/]\d{4}/.test(typedValue)) {
      typedValue = todayDdMmYyyy()
    }
    if (before.datepicker) {
      const dateResult = await this.pickDate(index, typedValue)
      const after = await this.ev(win, `(${FIELD_BY_INDEX(index)}).value`, true)
      return {
        ok: dateResult.ok,
        note: dateResult.note,
        field: before,
        before: before.value,
        after: String(after ?? ''),
        verified: String(after ?? '') === String(value).trim(),
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

    // PrimeNG AutoComplete игнорирует синтетические события — вводим как человек.
    const isAutocomplete = await this.ev(win, `!!(${FIELD_BY_INDEX(index)}).closest('.p-autocomplete')`, true).catch(() => false)
    if (isAutocomplete) {
      const typed = await this.typeInto(index, String(value))
      return {
        ok: typed.ok,
        note: typed.ok ? `Введено с клавиатуры: «${typed.value}»` : `Не удалось ввести значение (в поле «${typed.value}»)`,
        field: before,
        before: before.value,
        after: typed.value,
        verified: typed.ok,
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
    await this.ensurePage(win)
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
    if (!picked.ok) {
      // Закрываем чужой оверлей, иначе следующее поле увидит не свои опции.
      await this.pressKey('Escape').catch(() => undefined)
      await new Promise((r) => setTimeout(r, 250))
      return {
        ok: false,
        note: `Опция «${optionText}» не найдена. Доступно: ${(picked.options ?? []).slice(0, 8).join(' | ')}`,
        before: String(before.value || before.text),
        after: String(before.value || before.text),
        options: picked.options,
      }
    }

    await new Promise((r) => setTimeout(r, 500))
    const verify = () => this.verifyOption(index, optionText)
    let check = await verify()

    // Fallback: клик → ввод текста → ArrowDown → Enter, затем снова проверяем.
    if (picked.ok && !check.ok) {
      await this.ev(win,
        `(() => {
          const el = ${FIELD_BY_INDEX(index)}
          el.focus()
          const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
          setter ? setter.call(el, ${JSON.stringify(optionText)}) : (el.value = ${JSON.stringify(optionText)})
          el.dispatchEvent(new InputEvent('input', { bubbles: true, data: ${JSON.stringify(optionText)}, inputType: 'insertText' }))
          return true
        })()`,
        true,
      )
      await new Promise((r) => setTimeout(r, 600))
      await this.pressKey('ArrowDown').catch(() => undefined)
      await this.pressKey('Enter').catch(() => undefined)
      await new Promise((r) => setTimeout(r, 600))
      check = await verify()
    }

    const evidence = check.evidence || before.value || before.text
    return {
      ok: Boolean(picked.ok) && check.ok,
      note: !picked.ok
        ? `Опция не найдена. Доступно: ${(picked.options ?? []).slice(0, 8).join(' | ')}`
        : check.ok
          ? `Выбрано «${picked.matched ?? optionText}» — подтверждено в форме (${check.evidence.slice(0, 80)})`
          : `Опция нажата, но значение не применилось: в контроле «${evidence.slice(0, 80)}». Попробуй account_form_fields и другой target.`,
      before: String(before.value || before.text),
      after: String(evidence),
      options: picked.options,
    }
  }

  /** Проверяем, что выбранное значение реально попало в форму (значение, токен/чип, подпись dropdown). */
  private async verifyOption(
    index: number,
    option: string,
  ): Promise<{ ok: boolean; evidence: string; tokens: string[]; value: string; label: string }> {
    const win = this.ensureWindow(false)
    return (await this.ev(win,
      String.raw`(() => {
        const el = ${FIELD_BY_INDEX(index)}
        const want = ${JSON.stringify(option)}
        const norm = (x) => String(x || '').trim().toLowerCase()
        const control =
          el.closest('.p-select, .p-dropdown, .p-autocomplete, .p-multiselect, .p-treeselect') ||
          (el.parentElement && el.parentElement.closest('[id]')) ||
          el.parentElement ||
          el
        const tokenRoot = el.closest('.p-autocomplete-multiple-container') || control
        const tokens = [...tokenRoot.querySelectorAll('.p-autocomplete-token-label, .p-chip, .p-multiselect-token-label, .p-tag, .p-multiselect-item')]
          .map((x) => (x.innerText || '').replace(/\s+/g, ' ').trim())
          .filter(Boolean)
        const labelEl = control.querySelector('.p-dropdown-label, .p-select-label, .p-multiselect-label, .p-autocomplete-dropdown')
        const label = labelEl ? (labelEl.innerText || '').replace(/\s+/g, ' ').trim() : ''
        const hiddenSelect = control.querySelector('select')
        const hiddenText = hiddenSelect ? [...hiddenSelect.options].filter((o) => o.selected).map((o) => o.text.trim()).join(' ') : ''
        const value = (el.value || '').toString()
        const matches = (x) => { const n = norm(x); return n && (n === norm(want) || n.includes(norm(want))) }
        const ok = tokens.some(matches) || matches(value) || matches(label) || (hiddenText && matches(hiddenText))
        return { ok, evidence: tokens.join(' | ') || label || hiddenText || value, tokens, value, label, hiddenText }
      })()`,
      true,
    )) as any
  }

  /**
   * Выбор даты/года в p-calendar. Сначала пробуем прямой ввод (PrimeNG парсит его
   * и биндит модель), затем — клики по календарю с проверкой итогового значения.
   */
  private async pickDate(index: number, value: string): Promise<{ ok: boolean; note: string }> {
    const win = this.ensureWindow(false)
    const target = String(value).trim()
    const readValue = async () => String((await this.ev(win, `(${FIELD_BY_INDEX(index)}).value`, true)) ?? '')

    // 1. Ввод как человек (доверенные события): PrimeNG-календарь парсит строку.
    const typed = await this.typeInto(index, target)
    await this.pressKey('Enter').catch(() => undefined)
    await this.ev(win, `(() => { const el = ${FIELD_BY_INDEX(index)}; el.blur(); return true })()`, true).catch(() => undefined)
    await new Promise((r) => setTimeout(r, 700))
    let after = await readValue()
    if (after === target) {
      await this.pressKey('Escape').catch(() => undefined)
      return { ok: true, note: `Дата введена: «${target}»` }
    }

    // 2. Календарь: навигация по месяцам/десятилетиям и клик по точной дате.
    const m = /^(\d{1,2})[.\-/](\d{1,2})[.\-/](\d{4})$/.exec(target)
    const year = m ? m[3]! : /^\d{4}$/.test(target) ? target : undefined
    await this.ev(
      win,
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

    for (let attempt = 0; attempt < 26; attempt++) {
      const state = (await this.ev(
        win,
        `(() => {
          const panel = document.querySelector('.p-datepicker')
          if (!panel) return { open: false }
          return {
            open: true,
            years: [...panel.querySelectorAll('.p-yearpicker-year')].map((e) => e.innerText.trim()),
            days: [...panel.querySelectorAll('[aria-label]')].map((e) => e.getAttribute('aria-label')),
            head: panel.innerText.slice(0, 40),
          }
        })()`,
        true,
      )) as { open: boolean; years?: string[]; days?: string[]; head?: string }
      if (!state.open) break

      if (state.years?.length && year) {
        if (state.years.includes(year)) {
          await this.ev(
            win,
            `(() => { const p = document.querySelector('.p-datepicker'); const c = [...p.querySelectorAll('.p-yearpicker-year')].find((e) => e.innerText.trim() === ${JSON.stringify(year)}); c && c.click(); return true })()`,
            true,
          )
          await new Promise((r) => setTimeout(r, 400))
        } else {
          const min = Number(state.years[0])
          const max = Number(state.years[state.years.length - 1])
          const dir = Number(year) < min ? 'prev' : 'next'
          await this.ev(
            win,
            `(() => { const p = document.querySelector('.p-datepicker'); const b = p && (p.querySelector('.p-datepicker-' + ${JSON.stringify(dir)}) || p.querySelector('[class*=' + ${JSON.stringify(dir)} + ']')); b && b.click(); return !!b })()`,
            true,
          )
          await new Promise((r) => setTimeout(r, 300))
          continue
        }
      } else if (m && state.days?.length) {
        // Точная дата: ищем ячейку по aria-label «dd.mm.yyyy», иначе листаем месяцы.
        const clicked = await this.ev(
          win,
          `(() => {
            const p = document.querySelector('.p-datepicker')
            if (!p) return false
            const exact = [...p.querySelectorAll('[aria-label]')].find((e) => (e.getAttribute('aria-label') || '').trim() === ${JSON.stringify(`${m[1]!.padStart(2, '0')}.${m[2]!.padStart(2, '0')}.${m[3]}`)})
            if (exact) { (exact.closest('td') || exact).click(); return true }
            return false
          })()`,
          true,
        )
        await new Promise((r) => setTimeout(r, 400))
        if (clicked) {
          after = await readValue()
          if (after === target) return { ok: true, note: `Дата выбрана в календаре: «${after}»` }
          return { ok: false, note: `Календарь закрылся со значением «${after}» вместо «${target}»` }
        }
        // Листаем вперёд/назад в зависимости от того, раньше или позже текущий месяц.
        const head = String(state.head || '')
        const targetMonth = Number(m[2])
        const current = monthIndexFromRussian(head.split(/\d{4}/)[0] || '')
        const dir = current >= 0 && targetMonth < current ? 'prev' : 'next'
        await this.ev(
          win,
          `(() => { const p = document.querySelector('.p-datepicker'); const b = [...p.querySelectorAll('[aria-label]')].find((e) => (e.getAttribute('aria-label') || '').toLowerCase().includes(${JSON.stringify(dir === 'prev' ? 'предыдущий месяц' : 'следующий месяц')})); b && b.click(); return !!b })()`,
          true,
        )
        await new Promise((r) => setTimeout(r, 350))
      } else {
        break
      }

      if (year && !m) {
        after = await readValue()
        if (after === target) return { ok: true, note: `Выбран год ${target}` }
      }
    }
    after = await readValue()
    return { ok: after === target, note: `Значение в поле: «${after}»` }
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
