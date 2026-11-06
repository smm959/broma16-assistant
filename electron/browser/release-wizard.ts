import type { BrowserAutomation } from './automation.js'

/**
 * Детерминированный сценарий загрузки релиза в Broma 16.
 *
 * В отличие от «агент тыкает по тексту», шаги зашиты: какие поля, какие кнопки,
 * что должно измениться после шага. LLM только передаёт данные.
 * Финальную кнопку «Отправить на модерацию» скрипт не нажимает никогда.
 */
export interface WizardSpec {
  title: string
  artist: string
  performers?: string[]
  label: string
  type?: string
  genres: string[]
  releaseDate?: string
  creationDate?: string
  upc?: string
  catalog?: string
  isrc?: string
  explicit?: boolean
  lyrics?: string
  coverId?: string
  audioIds?: string[]
  /** Прямые пути к файлам (например, скачанные Telegram-ботом). */
  audioPaths?: string[]
  coverPath?: string
  stores?: 'all' | string[]
  from?: WizardStep
}

export type WizardStep = 'release' | 'files' | 'tracks' | 'authors' | 'lyrics' | 'cover' | 'distribution' | 'review'

export interface WizardResult {
  ok: boolean
  step: string
  url: string
  notes: string[]
  failure?: { step: string; reason: string; fields?: unknown[]; text?: string }
}

const STEP_URL: Record<WizardStep, RegExp> = {
  release: /\/release\/(?:create|\d+)\/?$/,
  files: /\/release\/\d+\/file/,
  tracks: /\/release\/\d+\/tracks/,
  authors: /\/release\/\d+\/authors/,
  lyrics: /\/release\/\d+\/lyrics/,
  cover: /\/release\/\d+\/cover/,
  distribution: /\/release\/\d+\/distribution/,
  review: /\/release\/\d+\/confirm/,
}

const ORDER: WizardStep[] = ['release', 'files', 'tracks', 'authors', 'lyrics', 'cover', 'distribution']

const today = () => {
  const d = new Date()
  return `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}.${d.getFullYear()}`
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export class ReleaseWizard {
  constructor(
    private readonly browser: BrowserAutomation,
    private readonly resolveFiles: (ids: string[]) => { id: string; path: string; filename: string }[],
  ) {}

  private async state(): Promise<{ url: string; step: WizardStep | null; text: string }> {
    const page = await this.browser.read({ maxChars: 30_000 })
    const step = (Object.entries(STEP_URL).find(([, re]) => re.test(page.url))?.[0] as WizardStep) ?? null
    return { url: page.url, step, text: page.text }
  }

  private async stepOf(): Promise<WizardStep | null> {
    return (await this.state()).step
  }

  private async fields(): Promise<any[]> {
    return (await this.browser.formFields()) as any[]
  }

  private async fill(key: string, value: string): Promise<boolean> {
    const res = await this.browser.fillField(key, value)
    if (!res.ok) return false
    await sleep(150)
    return true
  }

  private async select(key: string, option: string): Promise<boolean> {
    const res = await this.browser.chooseOption(key, option)
    return res.ok
  }

  private async clickNext(expect: WizardStep, timeoutMs = 24_000): Promise<boolean> {
    for (let attempt = 0; attempt < 3; attempt++) {
      // Ждём, пока кнопка станет активной (после загрузки файла она бывает disabled).
      const btnStart = Date.now()
      while (Date.now() - btnStart < timeoutMs / 2) {
        const info = await this.browser.describeTarget('Далее').catch(() => null)
        if (info?.found && !info.disabled) break
        await sleep(500)
      }
      await this.browser.click('Далее')
      const started = Date.now()
      while (Date.now() - started < timeoutMs / 2) {
        if ((await this.stepOf()) === expect) return true
        await sleep(400)
      }
    }
    return (await this.stepOf()) === expect
  }

  private async fail(step: string, reason: string): Promise<WizardResult> {
    const s = await this.state()
    let fields: unknown[] = []
    try {
      fields = (await this.fields()).filter((f) => f.visible)
    } catch {
      /* ignore */
    }
    let errors: string[] = []
    try {
      errors = await this.browser.validationErrors()
    } catch {
      /* ignore */
    }
    return {
      ok: false,
      step,
      url: s.url,
      notes: [],
      failure: { step, reason: `${reason}${errors.length ? ` Ошибки: ${errors.join('; ')}` : ''}`, fields, text: s.text.slice(0, 600) },
    }
  }

  async run(spec: WizardSpec): Promise<WizardResult> {
    const notes: string[] = []
    if (spec.from === 'release') {
      // «С нуля»: идём через дашборд и кнопку «Добавить релиз» — прямой /release/create даёт 404.
      const accountId = (await this.browser.evaluateRaw('localStorage.getItem("accountId") || "870645"').catch(() => '870645')) || '870645'
      await this.browser.open(`https://rod.broma16.ru/accounts/${accountId}/dashboard`).catch(() => undefined)
      await sleep(1500)
      await this.browser.click('Добавить релиз').catch(() => undefined)
      await sleep(3000)
    }
    let current = await this.stepOf()
    if (!current) {
      // Визард можно звать откуда угодно: сами открываем создание релиза.
      await this.browser.open('https://rod.broma16.ru/release/create').catch(() => undefined)
      await sleep(3000)
      current = await this.stepOf()
    }
    if (!current) return this.fail('start', 'Не удалось открыть создание релиза в кабинете.')

    const startIdx = spec.from ? ORDER.indexOf(spec.from) : ORDER.indexOf(current)
    const fromIdx = Math.max(startIdx, ORDER.indexOf(current))
    const year = (spec.releaseDate || spec.creationDate || today()).split('.').pop() || String(new Date().getFullYear())
    const creation = spec.creationDate || today()

    for (let i = fromIdx; i < ORDER.length; i++) {
      const step = ORDER[i]!
      if (i > fromIdx && !(await this.waitForStep(step))) {
        return this.fail(step, `Не удалось перейти к шагу «${step}» (остались на предыдущем).`)
      }
      notes.push(`Шаг ${step}`)

      if (step === 'release') {
        const f = await this.fields()
        const has = (k: string) => f.some((x) => x.key === k)
        if (has('ph:Название')) await this.fill('ph:Название', spec.title)
        if (has('ph:p-дата*')) await this.fill('ph:p-дата*', year)
        if (has('ph:p-line')) await this.fill('ph:p-line', spec.label)
        if (has('ph:c-дата*')) await this.fill('ph:c-дата*', year)
        if (has('ph:c-line')) await this.fill('ph:c-line', spec.label)
        if (spec.type && has('wrap:release_type_id')) await this.select('wrap:release_type_id', spec.type)
        for (const g of spec.genres) {
          if (has('ph:Жанры')) await this.select('ph:Жанры', g)
        }
        if (has('id:auto-ean-checkbox') && !spec.upc) await this.fill('id:auto-ean-checkbox', 'true')
        if (has('id:auto-catalog-checkbox') && !spec.catalog) await this.fill('id:auto-catalog-checkbox', 'true')
        if (spec.upc) await this.fill('ph:UPC', spec.upc)
        if (spec.catalog) await this.fill('ph:Каталожный номер', spec.catalog)
        if (!(await this.clickNext('files'))) return this.fail('release', 'Кнопка «Далее» не переключила шаг. Проверь обязательные поля (UPC/каталог — авто, жанры, тип).')
        continue
      }

      if (step === 'files') {
        const files = spec.audioPaths?.length
          ? spec.audioPaths.map((p) => ({ id: p, path: p, filename: p.split('/').pop() ?? 'audio.wav' }))
          : this.resolveFiles(spec.audioIds ?? [])
        if (!files.length) return this.fail('files', 'Нет аудиофайла (ни вложения, ни пути не переданы).')
        const inputs = await this.browser.listFileInputs()
        const idx = inputs.findIndex((x) => /wav|flac|audio/i.test(x.accept ?? '')) ?? 0
        const up = await this.browser.uploadFiles(idx < 0 ? 0 : idx, files.map((f) => f.path))
        if (!up.ok) {
          // Сайт часто забирает файл в свою модель и очищает input — проверяем по странице.
          const page = await this.browser.read({ maxChars: 5000 })
          const seen = files.some((f) => page.text.includes(f.filename.split('/').pop() ?? ''))
          if (!seen) return this.fail('files', `Не удалось прикрепить аудио: ${up.note}`)
        }
        notes.push(`Аудио: ${files.map((f) => f.filename).join(', ')}`)
        if (!(await this.clickNext('tracks'))) return this.fail('files', 'После загрузки аудио «Далее» не сработала.')
        continue
      }

      if (step === 'tracks') {
        // Редактор трека открывается шевроном в списке.
        const beforeFields = await this.fields()
        if (!beforeFields.some((x) => x.key === 'ph:Исполнитель' || x.placeholder === 'Исполнитель')) {
          await this.browser.click('button[class*="_chevron_"]').catch(() => undefined)
          await sleep(1200)
        }
        const f = await this.fields()
        const has = (k: string) => f.some((x) => x.key === k)
        if (has('ph:Название')) await this.fill('ph:Название', spec.title)
        if (has('ph:Дата создания')) await this.fill('ph:Дата создания', creation)
        for (const g of spec.genres) {
          if (has('ph:Жанры')) await this.select('ph:Жанры', g)
        }
        if (has('id:isrc_checkbox') && !spec.isrc) await this.fill('id:isrc_checkbox', 'true')
        if (has('id:catalog_number_checkbox') && !spec.catalog) await this.fill('id:catalog_number_checkbox', 'true')
        if (spec.isrc) await this.fill('ph:ISRC', spec.isrc)

        // Исполнители — по порядку, каждый новой строкой через «+».
        const performers = (spec.performers?.length ? spec.performers : [spec.artist]).map((x) => String(x).trim()).filter(Boolean)
        for (let i = 0; i < performers.length; i++) {
          if (i > 0) {
            await this.browser.click('button[class*="_gray_"]').catch(() => undefined)
            await sleep(900)
          }
          await this.browser.fillField(`id:artist-ac-main_performer-${i}`, performers[i]!).catch(() => undefined)
          await sleep(250)
        }
        notes.push(`Исполнители: ${performers.join(', ')}`)

        await this.browser.click('Сохранить').catch(() => undefined)
        await sleep(1500)
        if (!(await this.clickNext('authors'))) return this.fail('tracks', '«Далее» на «Фонограммах» не сработала после сохранения трека.')
        continue
      }

      if (step === 'authors') {
        // Редактор авторов, как и лирика, открывается стрелкой у трека.
        const beforeAuthors = await this.fields()
        if (!beforeAuthors.some((x) => x.key === 'ph:Автор #1')) {
          await this.browser
            .evaluateRaw(`(() => { const t = document.querySelector('img[class*="_toogleMenu_"]'); if (t) { t.click(); return true } return false })()`)
            .catch(() => undefined)
          await sleep(1200)
        }
        // В «Авторах» — только первый исполнитель: CA, 100%, доля контролируется мной.
        const authors = [String((spec.performers?.[0] ?? spec.artist) || spec.artist).trim()].filter(Boolean)
        const shares = [100]
        for (let i = 0; i < authors.length; i++) {
          const n = i + 1
          if (i > 0) {
            await this.browser.click('Добавить автора')
            await sleep(900)
          }
          await this.fill(`ph:Автор #${n}`, authors[i]!)
          await this.browser.chooseOption(`ph:Роль автора #${n}`, 'CA - Автор слов и музыки').catch(() => undefined)
          await this.browser.fillByLabel(`Доля автора #${n}`, String(shares[i])).catch(() => undefined)
          if (i === 0) await this.browser.fillField('id:controlled_by_submitter_0', 'true').catch(() => undefined)
          await sleep(300)
        }
        notes.push(`Авторы: ${authors.join(', ')} (${shares.join('/')})`)
        await sleep(400)
        await this.browser.click('Сохранить')
        await sleep(1200)
        if (!(await this.clickNext('lyrics'))) return this.fail('authors', '«Далее» на «Авторах» не сработала. Проверь авторов, роли и доли.')
        continue
      }

      if (step === 'lyrics') {
        // Редактор лирики открывается кликом по стрелке у трека.
        const before = await this.fields()
        if (!before.some((x) => x.key === 'wrap:language')) {
          await this.browser
            .evaluateRaw(
              `(() => { const t = document.querySelector('img[class*="_toogleMenu_"]'); if (t) { t.click(); return true } return false })()`,
            )
            .catch(() => undefined)
          await sleep(1200)
        }
        await this.browser.chooseOption('wrap:language', 'Русский').catch(() => undefined)
        await this.browser.chooseOption('wrap:parental_warning_type', spec.explicit ? 'Присутствует' : 'Отсутствует').catch(() => undefined)
        await this.browser.fillField('id:responsibility', 'true').catch(() => undefined)
        if (spec.lyrics) {
          const typed = await this.browser.typeRichText(spec.lyrics).catch(() => ({ ok: false, note: 'ошибка' }))
          if (!typed.ok) return this.fail('lyrics', `Не удалось ввести текст песни: ${typed.note}`)
          notes.push(`Текст песни: ${spec.lyrics.length} симв.`)
        }
        await sleep(500)
        await this.browser.click('Сохранить')
        await sleep(1200)
        if (!(await this.clickNext('cover'))) return this.fail('lyrics', '«Далее» на «Лирике» не сработала (язык/ненормативная лексика/225-ФЗ).')
        continue
      }

      if (step === 'cover') {
        const inputs = await this.browser.listFileInputs()
        const page = await this.browser.read({ maxChars: 3000 })
        const alreadyUploaded = inputs.length === 0 || /Удалить/.test(page.text)
        if (!alreadyUploaded) {
          const files = spec.coverPath
            ? [{ id: spec.coverPath, path: spec.coverPath, filename: spec.coverPath.split('/').pop() ?? 'cover.png' }]
            : this.resolveFiles(spec.coverId ? [spec.coverId] : [])
          if (!files.length) return this.fail('cover', 'Нет обложки (ни вложения, ни пути не переданы).')
          const idx = inputs.findIndex((x) => /jpg|jpeg|png|image/i.test(x.accept ?? '')) ?? 0
          const up = await this.browser.uploadFiles(idx < 0 ? 0 : idx, files.map((f) => f.path))
          if (!up.ok) {
            // Сайт обрабатывает файл несколько секунд — ждём появления «Удалить».
            const done = await this.waitText(/Удалить/, 25_000)
            if (!done) return this.fail('cover', `Не удалось прикрепить обложку: ${up.note}`)
          }
          notes.push(`Обложка: ${files[0]!.filename}`)
        } else {
          notes.push('Обложка уже загружена')
        }
        if (!(await this.clickNext('distribution'))) return this.fail('cover', 'После загрузки обложки «Далее» не сработала.')
        continue
      }

      if (step === 'distribution') {
        const relId = /\/release\/(\d+)/.exec((await this.state()).url)?.[1]
        // Новый релиз: «Релиз ранее уже был опубликован» — снять, дату первой публикации не трогать.
        const f0 = await this.fields()
        const pub = f0.find((x) => x.key === 'id:is_published_before')
        if (pub?.checked) await this.browser.fillField('id:is_published_before', 'false').catch(() => undefined)
        if (relId) {
          const data = await this.browser.apiFetch(`/repertoire/release/${relId}/data`).catch(() => null)
          const created = (() => {
            try {
              return data ? (JSON.parse(data.text)?.data?.created_date ?? JSON.parse(data.text)?.created_date) : null
            } catch {
              return null
            }
          })()
          if (created) {
            // Дата первой публикации осталась от чужого релиза — чистим через форму.
            await this.browser.fillField('id:is_published_before', 'true').catch(() => undefined)
            await sleep(400)
            await this.browser.fillField('ph:Дата первой публикации релиза', '').catch(() => undefined)
            await this.browser.fillField('id:is_published_before', 'false').catch(() => undefined)
            await sleep(400)
          }
        }
        if (spec.releaseDate) {
          // Минимум 7 дней от сегодня.
          const m = /^(\d{1,2})[.\-/](\d{1,2})[.\-/](\d{4})$/.exec(spec.releaseDate)
          if (m) {
            const target = new Date(Number(m[3]), Number(m[2]) - 1, Number(m[1]))
            const min = new Date()
            min.setHours(0, 0, 0, 0)
            min.setDate(min.getDate() + 7)
            if (target < min) {
              return this.fail('distribution', `Дата релиза ${spec.releaseDate} слишком близко: сайт требует минимум 7 дней (не раньше ${min.toLocaleDateString('ru-RU')}).`)
            }
          }
          await this.browser.click('Выбор желаемой даты')
          await sleep(800)
          const f = await this.fields()
          const dateKey = f.find((x) => /Дата начала продаж/i.test(x.placeholder ?? ''))?.key
          if (dateKey) {
            const r = await this.browser.fillField(dateKey, spec.releaseDate)
            if (!r.ok) return this.fail('distribution', `Не удалось выставить дату релиза: ${r.note}`)
          } else {
            return this.fail('distribution', 'Не появилось поле «Дата начала продаж» после выбора желаемой даты.')
          }
        }
        await this.browser.click('На всех доступных витринах')
        if (!(await this.clickNext('review'))) return this.fail('distribution', '«Далее» на «Дистрибуции» не сработала.')
        continue
      }
    }

    const s = await this.state()
    return { ok: true, step: s.step ?? 'review', url: s.url, notes }
  }

  /**
   * Сохраняет данные трека через внутренний API кабинета.
   * UI не коммитит исполнителя (main_performer остаётся null) — поэтому пишем напрямую.
   */
  private async syncTrackViaApi(releaseId: string, spec: WizardSpec): Promise<boolean> {
    const data = await this.browser.apiFetch(`/repertoire/release/${releaseId}/data`)
    if (data.status !== 200) return false
    let rel: any
    try {
      rel = JSON.parse(data.text)?.data ?? JSON.parse(data.text)
    } catch {
      return false
    }
    const track = (rel.tracks || [])[0]
    if (!track?.id) return false
    const isoToday = (() => {
      const d = new Date()
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    })()
    const list = (spec.performers?.length ? spec.performers : [spec.artist]).map((x) => String(x).trim()).filter(Boolean)
    const payload = {
      ...track,
      title: spec.title,
      created_country_id: track.created_country_id ?? 1,
      main_performer: [list[0] ?? spec.artist],
      performers: list,
      created_date: isoToday,
      genres: spec.genres.length ? spec.genres : track.genres,
      generate_isrc: !spec.isrc,
      generate_catalog_number: !spec.catalog,
      ...(spec.isrc ? { isrc: spec.isrc } : {}),
      ...(spec.catalog ? { catalog_number: spec.catalog } : {}),
    }
    const put = await this.browser.apiFetch(`/repertoire/release/${releaseId}/recording/${track.id}`, { method: 'PUT', body: payload })
    return put.status === 200
  }

  /** Ждём, пока на странице появится текст (например, «Удалить» после загрузки файла). */
  private async waitText(re: RegExp, timeoutMs = 20_000): Promise<boolean> {
    const started = Date.now()
    while (Date.now() - started < timeoutMs) {
      const page = await this.browser.read({ maxChars: 4000 }).catch(() => null)
      if (page && re.test(page.text)) return true
      await sleep(1000)
    }
    return false
  }

  private async waitForStep(step: WizardStep, timeoutMs = 8000): Promise<boolean> {
    const started = Date.now()
    while (Date.now() - started < timeoutMs) {
      if ((await this.stepOf()) === step) return true
      await sleep(400)
    }
    return false
  }

  /** Нажимает «+» в строке исполнителя, чтобы добавить введённое имя в форму. */
  private async clickAddPerformer(): Promise<boolean> {
    const added = (await this.browser.evaluateRaw?.(
      `(() => {
        const inputs = [...document.querySelectorAll('input')].filter((i) => /Исполнитель/i.test(i.placeholder || ''))
        for (const input of inputs) {
          if (!input.value) continue
          const row = input.closest('._performerItem_1hm8u_1') || input.closest('div')
          const btn = row && [...row.querySelectorAll('button')].find((b) => /_gray_/.test(b.className))
          if (btn) { btn.click(); return true }
        }
        return false
      })()`,
    )) as boolean | undefined
    await sleep(800)
    return Boolean(added)
  }

  private async fillAuthor(name: string): Promise<void> {
    const f = await this.fields()
    const input = f.find((x) => /Автор|Author/i.test(`${x.placeholder} ${x.label} ${x.key}`) && (x.tag === 'input' || x.tag === 'SELECT'))
    if (input) await this.browser.fillField(input.key, name)
    await sleep(300)
  }

  private async checkExplicit(): Promise<void> {
    const f = await this.fields()
    for (const x of f) {
      if (x.type === 'checkbox' && /ненорматив|explicit|мат|присутств/i.test(`${x.label} ${x.key}`)) {
        await this.browser.fillField(x.key, 'true')
      }
    }
    await sleep(300)
  }
}
