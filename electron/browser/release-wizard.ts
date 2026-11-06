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
  release: /\/release\/\d+\/?$/,
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

  private async clickNext(expect: WizardStep, timeoutMs = 12_000): Promise<boolean> {
    await this.browser.click('Далее')
    const started = Date.now()
    while (Date.now() - started < timeoutMs) {
      if ((await this.stepOf()) === expect) return true
      await sleep(400)
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
    let current = await this.stepOf()
    if (!current) return this.fail('start', 'Не удалось определить шаг визарда. Открой создание релиза в кабинете.')

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
        const files = this.resolveFiles(spec.audioIds ?? [])
        if (!files.length) return this.fail('files', 'Нет аудиофайла в диалоге (audioIds пусты).')
        const inputs = await this.browser.listFileInputs()
        const idx = inputs.findIndex((x) => /wav|flac|audio/i.test(x.accept ?? '')) ?? 0
        const up = await this.browser.uploadFiles(idx < 0 ? 0 : idx, files.map((f) => f.path))
        if (!up.ok) return this.fail('files', `Не удалось прикрепить аудио: ${up.note}`)
        notes.push(`Аудио: ${files.map((f) => f.filename).join(', ')}`)
        if (!(await this.clickNext('tracks'))) return this.fail('files', 'После загрузки аудио «Далее» не сработала.')
        continue
      }

      if (step === 'tracks') {
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
        if (has('ph:Исполнитель')) {
          await this.fill('ph:Исполнитель', spec.artist)
          await this.clickAddPerformer()
        }
        if (!(await this.clickNext('authors'))) {
          return this.fail('tracks', '«Далее» на «Фонограммах» не сработала даже после заполнения даты, ISRC/каталога и исполнителя.')
        }
        continue
      }

      if (step === 'authors') {
        await this.fillAuthor(spec.artist)
        if (!(await this.clickNext('lyrics'))) return this.fail('authors', '«Далее» на «Авторах» не сработала. Проверь автора и доли.')
        continue
      }

      if (step === 'lyrics') {
        if (spec.explicit) await this.checkExplicit()
        if (spec.lyrics) {
          const f = await this.fields()
          if (f.some((x) => x.key.startsWith('ph:'))) await this.fill('ph:Текст', spec.lyrics)
        }
        if (!(await this.clickNext('cover'))) return this.fail('lyrics', '«Далее» на «Лирике» не сработала.')
        continue
      }

      if (step === 'cover') {
        const files = this.resolveFiles(spec.coverId ? [spec.coverId] : [])
        if (!files.length) return this.fail('cover', 'Нет обложки в диалоге (coverId пуст).')
        const inputs = await this.browser.listFileInputs()
        const idx = inputs.findIndex((x) => /jpg|jpeg|png|image/i.test(x.accept ?? '')) ?? 0
        const up = await this.browser.uploadFiles(idx < 0 ? 0 : idx, files.map((f) => f.path))
        if (!up.ok) return this.fail('cover', `Не удалось прикрепить обложку: ${up.note}`)
        notes.push(`Обложка: ${files[0]!.filename}`)
        if (!(await this.clickNext('distribution'))) return this.fail('cover', 'После загрузки обложки «Далее» не сработала.')
        continue
      }

      if (step === 'distribution') {
        if (spec.releaseDate) {
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
