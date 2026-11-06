import { createWriteStream } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { basename, extname, join } from 'node:path'

/**
 * Telegram-бот «Broma 16»: пошагово собирает данные релиза и запускает
 * детерминированный визард загрузки. Ничего не отправляет на модерацию —
 * останавливается на «Обзоре».
 *
 * Использует обычный long polling (fetch), без внешних зависимостей.
 */
export interface BotReleaseSpec {
  title: string
  artist: string
  label: string
  genres: string[]
  releaseDate: string
  explicit: boolean
  audioPath: string
  coverPath: string
}

export interface BotReleaseResult {
  ok: boolean
  text: string
}

type Field = 'title' | 'artist' | 'label' | 'genres' | 'releaseDate' | 'explicit' | 'author' | 'audio' | 'cover' | 'confirm'

interface ChatState {
  field: Field
  data: Partial<BotReleaseSpec> & { author?: string; audioTitle?: string; coverTitle?: string }
}

const QUESTIONS: Record<Field, string> = {
  title: '1/9. Как называется релиз? (например: Open my eyes)',
  artist: '2/9. Кто исполнитель? (например: ELLIWAY)',
  label: '3/9. Какой лейбл? Отправьте «-», если Music 959.',
  genres: '4/9. Жанры через запятую (например: Rap, Alternative Rap).',
  releaseDate:
    '5/9. Дата релиза в формате ДД.ММ.ГГГГ (не раньше чем через 7 дней).\nНапример: 21.11.2026',
  explicit: '6/9. В треке есть ненормативная лексика? Ответьте «да» или «нет».',
  author:
    '7/9. Автор слов и музыки?\nОтправьте имя и долю через запятую (например: ELLIWAY, 100).\nЕсли автор — исполнитель и доля 100%, отправьте «-».',
  audio: '8/9. Пришлите WAV-файл.\nТребования: WAV, 44100 или 48000 Гц (16/24/32 бита).\nЕсли файл больше 20 МБ, Telegram не отдаст его боту — пришлите ссылку или путь к файлу.',
  cover: '9/9. Пришлите обложку PNG 3000×3000 px (1:1, без логотипов и ссылок).',
  confirm: 'Проверьте данные и отправьте «да», чтобы я собрал релиз в кабинете. «нет» — отменить.',
}

const KEY = (chatId: number) => `tg:state:${chatId}`

export interface BotDeps {
  db: { get<T>(sql: string, ...params: unknown[]): T | undefined; run(sql: string, ...params: unknown[]): unknown }
  dir: string
  runRelease: (spec: BotReleaseSpec) => Promise<BotReleaseResult>
  log: (msg: string) => void
}

export class TelegramBot {
  private offset = 0
  private running = false
  private readonly states = new Map<number, ChatState>()
  private readonly base: string

  constructor(
    private readonly token: string,
    private readonly deps: BotDeps,
  ) {
    this.base = `https://api.telegram.org/bot${token}`
  }

  private async api<T = any>(method: string, payload?: Record<string, unknown>): Promise<T> {
    const res = await fetch(`${this.base}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: payload ? JSON.stringify(payload) : undefined,
    })
    const json: any = await res.json().catch(() => ({}))
    if (!json.ok) throw new Error(`Telegram ${method}: ${json.description ?? res.status}`)
    return json.result as T
  }

  async start(): Promise<void> {
    if (this.running) return
    this.running = true
    const me = await this.api<{ username?: string }>('getMe').catch((e) => {
      this.deps.log(`[telegram] не удалось стартовать: ${String(e).slice(0, 120)}`)
      return null
    })
    if (!me) {
      this.running = false
      return
    }
    this.deps.log(`[telegram] бот @${me.username} запущен`)
    void this.loop()
  }

  stop(): void {
    this.running = false
  }

  private async loop(): Promise<void> {
    while (this.running) {
      try {
        const updates = await this.api<any[]>('getUpdates', {
          offset: this.offset,
          timeout: 25,
          allowed_updates: ['message'],
        })
        for (const u of updates) {
          this.offset = Math.max(this.offset, Number(u.update_id) + 1)
          if (u.message) await this.handle(u.message).catch((e) => this.deps.log(`[telegram] ошибка: ${String(e).slice(0, 200)}`))
        }
      } catch (e) {
        this.deps.log(`[telegram] polling: ${String(e).slice(0, 160)}`)
        await new Promise((r) => setTimeout(r, 3000))
      }
    }
  }

  private loadState(chatId: number): ChatState {
    const cached = this.states.get(chatId)
    if (cached) return cached
    const row = this.deps.db.get<{ value: string }>(`SELECT value FROM kv WHERE key = ?`, KEY(chatId))
    const state: ChatState = row ? (JSON.parse(row.value) as ChatState) : { field: 'title', data: {} }
    this.states.set(chatId, state)
    return state
  }

  private saveState(chatId: number, state: ChatState): void {
    this.states.set(chatId, state)
    this.deps.db.run(
      `INSERT INTO kv(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      KEY(chatId),
      JSON.stringify(state),
    )
  }

  private reset(chatId: number): void {
    this.states.delete(chatId)
    this.deps.db.run(`DELETE FROM kv WHERE key = ?`, KEY(chatId))
  }

  private async say(chatId: number, text: string): Promise<void> {
    await this.api('sendMessage', { chat_id: chatId, text, disable_web_page_preview: true }).catch((e) =>
      this.deps.log(`[telegram] send: ${String(e).slice(0, 120)}`),
    )
  }

  private async handle(msg: any): Promise<void> {
    const chatId = Number(msg.chat?.id)
    if (!chatId) return
    const text = String(msg.text ?? '').trim()
    const kind = msg.document ? 'document' : msg.audio ? 'audio' : msg.photo ? 'photo' : 'text'
    this.deps.log(`[telegram] ${chatId}: ${kind}`)

    if (/^\/(start|new)$/i.test(text)) {
      this.reset(chatId)
      this.saveState(chatId, { field: 'title', data: {} })
      await this.say(chatId, 'Привет! Соберу релиз в Broma 16.\n\n' + QUESTIONS.title)
      return
    }
    if (/^\/(cancel|stop)$/i.test(text)) {
      this.reset(chatId)
      await this.say(chatId, 'Отменил. /start — начать заново.')
      return
    }
    if (/^\/status$/i.test(text)) {
      const s = this.loadState(chatId)
      await this.say(chatId, `Текущий шаг: ${s.field}. /cancel — отменить, /start — заново.`)
      return
    }

    const state = this.loadState(chatId)
    const data = state.data

    const next = (field: Field) => {
      state.field = field
      this.saveState(chatId, state)
      void this.say(chatId, QUESTIONS[field])
    }

    if (state.field === 'title') {
      if (!text) return void this.say(chatId, 'Нужно название текстом.')
      data.title = text.slice(0, 120)
      return next('artist')
    }

    if (state.field === 'artist') {
      if (!text) return void this.say(chatId, 'Нужно имя исполнителя текстом.')
      data.artist = text.slice(0, 80)
      return next('label')
    }

    if (state.field === 'label') {
      data.label = !text || text === '-' ? 'Music 959' : text.slice(0, 80)
      return next('genres')
    }

    if (state.field === 'genres') {
      const genres = text
        .split(/[,;/]+/)
        .map((g) => g.trim())
        .filter(Boolean)
        .slice(0, 3)
      if (!genres.length) return void this.say(chatId, 'Пришлите хотя бы один жанр.')
      data.genres = genres
      return next('releaseDate')
    }

    if (state.field === 'releaseDate') {
      const m = /^(\d{1,2})[.\-/](\d{1,2})[.\-/](\d{4})$/.exec(text)
      if (!m) return void this.say(chatId, 'Формат: ДД.ММ.ГГГГ, например 21.11.2026.')
      const date = new Date(Number(m[3]), Number(m[2]) - 1, Number(m[1]))
      const days = Math.ceil((date.getTime() - Date.now()) / 86_400_000)
      if (days < 7) return void this.say(chatId, `Сайт требует минимум 7 дней до релиза. Сейчас до даты ${days} дн. Пришлите другую.`)
      data.releaseDate = `${String(m[1]).padStart(2, '0')}.${String(m[2]).padStart(2, '0')}.${m[3]}`
      return next('explicit')
    }

    if (state.field === 'explicit') {
      if (!/^(да|yes|есть|1)$/i.test(text) && !/^(нет|no|0)$/i.test(text)) {
        return void this.say(chatId, 'Ответьте «да» или «нет».')
      }
      data.explicit = /^(да|yes|есть|1)$/i.test(text)
      return next('author')
    }

    if (state.field === 'author') {
      if (!text || text === '-') {
        data.author = `${data.artist ?? ''}, 100`
      } else {
        data.author = text.slice(0, 120)
      }
      return next('audio')
    }

    if (state.field === 'audio') {
      const doc = msg.document ?? msg.audio ?? null
      // Ссылка на файл — обход лимита Telegram в 20 МБ на скачивание ботом.
      // Локальный путь — удобно, когда бот и файл на одной машине.
      if (!doc && /^(\/|~\/)/.test(text)) {
        const p = text.startsWith('~') ? text.replace('~', process.env.HOME ?? '') : text
        try {
          const path = await this.useLocalFile(p)
          const info = await checkWav(path)
          if (!info.ok) return void this.say(chatId, info.reason)
          data.audioPath = path
          data.audioTitle = basename(path)
          return next('cover')
        } catch (e) {
          return void this.say(chatId, `Не нашёл файл: ${String(e).slice(0, 120)}`)
        }
      }
      if (!doc && /^https?:\/\//i.test(text)) {
        try {
          const path = await this.downloadUrl(text)
          const info = await checkWav(path)
          if (!info.ok) return void this.say(chatId, info.reason)
          data.audioPath = path
          data.audioTitle = basename(path)
          return next('cover')
        } catch (e) {
          return void this.say(chatId, `Не смог скачать по ссылке: ${String(e).slice(0, 120)}`)
        }
      }
      if (!doc) return void this.say(chatId, 'Пришлите WAV файлом/аудио или ссылкой на файл.')
      const name = String(doc.file_name ?? (doc.mime_type === 'audio/wav' ? 'audio.wav' : 'audio'))
      if (!/\.wav$/i.test(name)) return void this.say(chatId, 'Нужен именно WAV-файл (44100/48000 Гц, 16/24/32 бита).')
      if (Number(doc.file_size ?? 0) > 20 * 1024 * 1024) {
        return void this.say(
          chatId,
          'Файл больше 20 МБ — Telegram не отдаёт такие файлы ботам.\nПришлите ссылку на WAV (Google Drive/Dropbox/Яндекс.Диск с прямой ссылкой) — скачаю сам.',
        )
      }
      const path = await this.download(doc.file_id, name)
      const info = await checkWav(path)
      this.deps.log(`[telegram] wav ${name}: ${info.ok ? 'ok ' : 'fail '}${info.reason}`)
      if (!info.ok) return void this.say(chatId, info.reason)
      data.audioPath = path
      data.audioTitle = name
      return next('cover')
    }

    if (state.field === 'cover') {
      const doc = msg.document ?? (msg.photo ? { file_id: msg.photo[msg.photo.length - 1].file_id, file_name: 'cover.png' } : null)
      if (!doc) return void this.say(chatId, 'Нужна обложка PNG 3000×3000.')
      const name = String(doc.file_name ?? 'cover.png')
      if (!/\.png$/i.test(name)) return void this.say(chatId, 'Обложка должна быть PNG 3000×3000 px.')
      const path = await this.download(doc.file_id, name)
      const dim = await checkPng(path)
      if (!dim.ok) return void this.say(chatId, dim.reason)
      data.coverPath = path
      data.coverTitle = name
      return next('confirm')
    }

    if (state.field === 'confirm') {
      if (/^(нет|no|отмена)$/i.test(text)) {
        this.reset(chatId)
        return void this.say(chatId, 'Отменил. /start — заново.')
      }
      if (!/^(да|yes|ок|ok)$/i.test(text)) return void this.say(chatId, 'Отправьте «да» для сборки или «нет» для отмены.')
      await this.say(chatId, 'Собираю релиз в кабинете… Это займёт пару минут.')
      const spec: BotReleaseSpec = {
        title: data.title!,
        artist: data.artist!,
        label: data.label!,
        genres: data.genres!,
        releaseDate: data.releaseDate!,
        explicit: Boolean(data.explicit),
        audioPath: data.audioPath!,
        coverPath: data.coverPath!,
      }
      const res = await this.deps.runRelease(spec).catch((e) => ({ ok: false, text: String(e).slice(0, 300) }))
      this.reset(chatId)
      await this.say(chatId, res.text)
      return
    }
  }

  private async useLocalFile(path: string): Promise<string> {
    const dir = join(this.deps.dir, 'telegram')
    await mkdir(dir, { recursive: true })
    const buf = await readFile(path)
    if (buf.length > 120 * 1024 * 1024) throw new Error('файл больше 120 МБ')
    const dest = join(dir, `${Date.now()}-${basename(path).replace(/[^\w.\-а-яА-Я]+/gu, '_')}`)
    await writeFile(dest, buf)
    return dest
  }

  private async downloadUrl(rawUrl: string): Promise<string> {
    const dir = join(this.deps.dir, 'telegram')
    await mkdir(dir, { recursive: true })
    let url = rawUrl
    // Приводим популярные «страницы» к прямым ссылкам.
    const drive = /drive\.google\.com\/file\/d\/([^/?#]+)/.exec(url)
    if (drive) url = `https://drive.google.com/uc?export=download&id=${drive[1]}`
    if (/dropbox\.com/.test(url)) url = url.replace(/[?&]dl=0/, '?dl=1')
    const yandex = /^https?:\/\/disk\.yandex\.[a-z]+\/d\/([^/?#]+)/.exec(url)
    if (yandex) {
      const meta = await fetch(`https://cloud-api.yandex.net/v1/disk/public/resources/download?public_key=${encodeURIComponent(url)}`)
      const j: any = await meta.json().catch(() => ({}))
      if (j?.href) url = j.href
    }
    const res = await fetch(url, { redirect: 'follow' })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const buf = Buffer.from(await res.arrayBuffer())
    if (buf.length > 120 * 1024 * 1024) throw new Error('файл больше 120 МБ')
    const path = join(dir, `${Date.now()}-remote.wav`)
    await writeFile(path, buf)
    return path
  }

  private async download(fileId: string, filename: string): Promise<string> {
    const file = await this.api<{ file_path: string }>('getFile', { file_id: fileId })
    const dir = join(this.deps.dir, 'telegram')
    await mkdir(dir, { recursive: true })
    const safe = `${Date.now()}-${basename(filename).replace(/[^\w.\-а-яА-Я]+/gu, '_')}`
    const path = join(dir, safe)
    const res = await fetch(`https://api.telegram.org/file/bot${this.token}/${file.file_path}`)
    if (!res.ok) throw new Error(`Не удалось скачать файл (${res.status})`)
    await new Promise<void>(async (resolve, reject) => {
      const out = createWriteStream(path)
      const body = Buffer.from(await res.arrayBuffer())
      out.write(body, (err) => (err ? reject(err) : out.end(resolve)))
    })
    return path
  }
}

export async function checkWav(path: string): Promise<{ ok: boolean; reason: string }> {
  const buf = await readFile(path)
  if (buf.length < 44 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
    return { ok: false, reason: 'Файл не похож на WAV. Пришлите WAV 44100/48000 Гц (16/24/32 бита).' }
  }
  let pos = 12
  while (pos + 8 <= buf.length) {
    const id = buf.toString('ascii', pos, pos + 4)
    const size = buf.readUInt32LE(pos + 4)
    if (id === 'fmt ') {
      const channels = buf.readUInt16LE(pos + 10)
      const rate = buf.readUInt32LE(pos + 12)
      const bits = buf.readUInt16LE(pos + 22)
      if (![44100, 48000].includes(rate)) return { ok: false, reason: `Частота ${rate} Гц — нужны 44100 или 48000 Гц.` }
      // 32-bit float мастера тоже принимаем: портал их берёт.
      if (![16, 24, 32].includes(bits)) return { ok: false, reason: `Битность ${bits} — нужны 16, 24 или 32 бита.` }
      if (channels < 1) return { ok: false, reason: 'В файле нет аудиоканалов.' }
      return { ok: true, reason: `${bits} бит / ${rate} Гц` }
    }
    pos += 8 + size + (size % 2)
  }
  return { ok: false, reason: 'Не нашёл параметры WAV. Пришлите WAV 44100/48000 Гц (16/24/32 бита).' }
}

export async function checkPng(path: string): Promise<{ ok: boolean; reason: string }> {
  const buf = await readFile(path)
  if (buf.length < 24 || buf.toString('ascii', 1, 4) !== 'PNG') {
    return { ok: false, reason: 'Нужен PNG-файл 3000×3000.' }
  }
  const w = buf.readUInt32BE(16)
  const h = buf.readUInt32BE(20)
  if (w < 3000 || h < 3000) return { ok: false, reason: `Обложка ${w}×${h} — нужна 3000×3000 px или больше.` }
  return { ok: true, reason: `${w}×${h}` }
}
