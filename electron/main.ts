import { app, BrowserWindow, Tray, Menu, nativeImage, shell, session, protocol, net } from 'electron'
import { join } from 'node:path'
import { appendFileSync, mkdirSync } from 'node:fs'
import { buildServices, type Services } from './services.js'
import { registerIpc } from './ipc.js'
import { initScheduler } from './scheduler.js'
import { LOGIN_URL } from './browser/automation.js'
import { autoLogin } from './browser/login.js'
import { secrets } from './security/secrets.js'

let mainWindow: BrowserWindow | null = null
let tray: Tray | null = null
let services: Services | null = null
let quitting = false

const isDev = Boolean(process.env.VITE_DEV_SERVER_URL)
const APP_NAME = 'Broma 16 Assistant'

app.setName(APP_NAME)

function logCrash(kind: string, error: unknown) {
  try {
    const dir = app.getPath('userData')
    mkdirSync(dir, { recursive: true })
    appendFileSync(join(dir, 'crash.log'), `\n[${new Date().toISOString()}] ${kind}\n${(error as Error)?.stack ?? String(error)}\n`)
  } catch {
    /* ignore */
  }
  console.error(kind, error)
}

process.on('uncaughtException', (e) => logCrash('uncaughtException', e))
process.on('unhandledRejection', (e) => logCrash('unhandledRejection', e))

// Локальные вложения (скриншоты, обложки) отдаём рендереру через безопасную схему.
protocol.registerSchemesAsPrivileged([
  { scheme: 'attachment', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
])

function resourcePath(...parts: string[]) {
  return app.isPackaged ? join(process.resourcesPath, ...parts) : join(app.getAppPath(), ...parts)
}

function createWindow() {
  const iconPath = resourcePath('resources', 'icon.png')
  mainWindow = new BrowserWindow({
    width: 1240,
    height: 820,
    minWidth: 980,
    minHeight: 640,
    show: false,
    title: APP_NAME,
    backgroundColor: '#0e0e10',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    trafficLightPosition: process.platform === 'darwin' ? { x: 16, y: 18 } : undefined,
    icon: process.platform === 'darwin' ? undefined : iconPath,
    webPreferences: {
      preload: join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: true,
    },
  })

  mainWindow.once('ready-to-show', () => mainWindow?.show())

  if (isDev) {
    void mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL!)
  } else {
    void mainWindow.loadFile(join(app.getAppPath(), 'dist', 'index.html'))
  }

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })

  mainWindow.webContents.on('will-navigate', (event, url) => {
    const current = mainWindow?.webContents.getURL() ?? ''
    if (url !== current && /^https?:/i.test(url) && !url.startsWith(process.env.VITE_DEV_SERVER_URL ?? '\u0000')) {
      event.preventDefault()
      void shell.openExternal(url)
    }
  })

  mainWindow.on('close', (event) => {
    if (!quitting && process.platform !== 'darwin') {
      event.preventDefault()
      mainWindow?.hide()
    }
  })

  mainWindow.on('closed', () => {
    mainWindow = null
  })
}

function createTray() {
  const image = nativeImage.createFromPath(resourcePath('resources', 'trayTemplate.png'))
  if (process.platform === 'darwin') image.setTemplateImage(true)
  tray = new Tray(image.isEmpty() ? nativeImage.createEmpty() : image)
  tray.setToolTip(APP_NAME)
  const menu = Menu.buildFromTemplate([
    {
      label: 'Открыть Broma 16 Assistant',
      click: () => {
        if (!mainWindow) createWindow()
        mainWindow?.show()
        mainWindow?.focus()
      },
    },
    {
      label: 'Новый чат',
      click: () => {
        if (!mainWindow) createWindow()
        mainWindow?.show()
        mainWindow?.webContents.send('event:new-chat')
      },
    },
    { type: 'separator' },
    {
      label: 'Выход',
      click: () => {
        quitting = true
        app.quit()
      },
    },
  ])
  tray.setContextMenu(menu)
  tray.on('click', () => {
    if (!mainWindow) createWindow()
    mainWindow?.isVisible() ? mainWindow.hide() : mainWindow?.show()
  })
}

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.show()
      mainWindow.focus()
    }
  })

  app.whenReady().then(() => {
    try {
      boot()
    } catch (e) {
      logCrash('boot', e)
      throw e
    }
  })

  function boot() {
    services = buildServices((channel, payload) => {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload)
    })
    registerIpc(services, () => mainWindow)
    protocol.handle('attachment', (request) => {
      try {
        const url = new URL(request.url)
        const filePath = decodeURIComponent(url.pathname)
        const root = app.getPath('userData')
        if (!filePath.startsWith(root)) return new Response('forbidden', { status: 403 })
        return net.fetch(`file://${encodeURI(filePath)}`)
      } catch {
        return new Response('bad request', { status: 400 })
      }
    })

    createWindow()
    createTray()
    initScheduler(services, () => {
      if (!mainWindow) createWindow()
      mainWindow?.show()
      mainWindow?.focus()
    })
    void autoOpenCabinet(services)

    // Разрешаем только нужные разрешения (микрофон/камера не требуются)
    session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false))

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
      else mainWindow?.show()
    })
  }
}

/** Если включено «Открывать кабинет при запуске» — заходим в аккаунт заранее. */
async function autoOpenCabinet(svc: Services) {
  if (svc.settings().openCabinetOnStart !== 'true') return
  setTimeout(async () => {
    try {
      const st = svc.settings()
      const password = secrets().get('broma:password')
      const res = await autoLogin(
        { browser: svc.browser, email: svc.email, credentials: { login: st.accountLogin ?? '', password } },
        { url: LOGIN_URL, show: false },
      )
      if (res.needsUser) {
        svc.browser.showWindow()
        svc.emit('event:notify', { title: 'Вход в кабинет Broma 16', body: res.note })
      } else if (res.loggedIn) {
        svc.emit('event:notify', { title: 'Кабинет Broma 16', body: 'Вошли автоматически — можно работать' })
      }
    } catch {
      /* нет сети — попробуем в следующий запуск */
    }
  }, 6000)
}

app.on('before-quit', () => {
  quitting = true
})

app.on('window-all-closed', () => {
  // Приложение продолжает работать в трее (агент может выполнять задачи).
  if (process.platform === 'darwin') return
})
