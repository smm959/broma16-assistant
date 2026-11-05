import { BrowserWindow, session, app } from 'electron'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { BrowserAccountState } from '../../shared/types.js'

const PARTITION = 'persist:broma16'
export const PORTAL_URL = 'https://africa.broma16.com/proceed'
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
    links: { text: string; href: string }[]
  }> {
    const win = this.ensureWindow(false)
    if (win.webContents.isLoading()) {
      await new Promise<void>((resolve) => win.webContents.once('did-stop-loading', () => resolve()))
    }
    const data = await win.webContents.executeJavaScript(
      `(() => {
        const text = document.body ? document.body.innerText : ''
        const links = [...document.querySelectorAll('a[href]')].slice(0, 80).map(a => ({ text: (a.innerText||'').trim().slice(0,80), href: a.href }))
        return { url: location.href, title: document.title, text, links }
      })()`,
      true,
    )
    this.lastUrl = data.url
    this.lastTitle = data.title
    this.lastText = data.text ?? ''
    const haystack = `${data.url} ${this.lastText.slice(0, 20000)}`.toLowerCase()
    const loggedIn =
      /logout|log out|выход|sign out|dashboard|личный кабинет|my releases|мои релизы/.test(haystack) &&
      !/sign in|log in|войти|password|пароль/.test(data.url.toLowerCase())
    return {
      url: data.url,
      title: data.title,
      text: String(this.lastText).slice(0, options.maxChars ?? 30_000),
      loggedIn,
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
