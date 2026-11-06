import { DatabaseSync, type StatementSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { SCHEMA } from './schema.js'

export type Row = Record<string, unknown>

/**
 * Тонкая обёртка над встроенным в Node/Electron SQLite.
 * Никаких нативных модулей — приложение ставится без компиляции.
 */
export class Db {
  readonly raw: DatabaseSync

  constructor(public readonly path: string) {
    mkdirSync(dirname(path), { recursive: true })
    this.raw = new DatabaseSync(path)
    this.raw.exec(SCHEMA)
    this.migrate()
  }

  private migrate() {
    // Мягкие миграции: добавляем колонки, если их нет в старой базе.
    const cols = this.all<{ name: string }>(`PRAGMA table_info(messages)`)
    const names = new Set(cols.map((c) => c.name))
    if (!names.has('sources')) this.raw.exec(`ALTER TABLE messages ADD COLUMN sources TEXT`)
    if (!names.has('tool_calls')) this.raw.exec(`ALTER TABLE messages ADD COLUMN tool_calls TEXT`)
    if (!names.has('tool_call_id')) this.raw.exec(`ALTER TABLE messages ADD COLUMN tool_call_id TEXT`)
    const actionCols = new Set(this.all<{ name: string }>(`PRAGMA table_info(pending_actions)`).map((c) => c.name))
    if (!actionCols.has('placeholder_id')) this.raw.exec(`ALTER TABLE pending_actions ADD COLUMN placeholder_id TEXT`)
    const subCols = new Set(this.all<{ name: string }>(`PRAGMA table_info(tg_submissions)`).map((c) => c.name))
    if (subCols.size && !subCols.has('lyrics')) this.raw.exec(`ALTER TABLE tg_submissions ADD COLUMN lyrics TEXT`)
    if (subCols.size && !subCols.has('authors')) this.raw.exec(`ALTER TABLE tg_submissions ADD COLUMN authors TEXT`)
    if (subCols.size && !subCols.has('performers')) this.raw.exec(`ALTER TABLE tg_submissions ADD COLUMN performers TEXT`)
  }

  all<T = Row>(sql: string, ...params: unknown[]): T[] {
    return this.raw.prepare(sql).all(...(params as never[])) as T[]
  }

  get<T = Row>(sql: string, ...params: unknown[]): T | undefined {
    return this.raw.prepare(sql).get(...(params as never[])) as T | undefined
  }

  run(sql: string, ...params: unknown[]): { changes: number; lastInsertRowid: number | bigint } {
    try {
      const r = this.raw.prepare(sql).run(...(params as never[]))
      return { changes: Number(r.changes), lastInsertRowid: r.lastInsertRowid as number | bigint }
    } catch (e) {
      throw new Error(`${(e as Error).message} [SQL: ${sql.replace(/\s+/g, ' ').slice(0, 160)} | params: ${params.length}]`)
    }
  }

  exec(sql: string) {
    this.raw.exec(sql)
  }

  prepare(sql: string): StatementSync {
    return this.raw.prepare(sql)
  }

  transaction<T>(fn: () => T): T {
    this.raw.exec('BEGIN')
    try {
      const out = fn()
      this.raw.exec('COMMIT')
      return out
    } catch (e) {
      try {
        this.raw.exec('ROLLBACK')
      } catch {
        /* ignore */
      }
      throw e
    }
  }

  close() {
    try {
      this.raw.close()
    } catch {
      /* ignore */
    }
  }
}

export const bool = (v: unknown) => (v ? 1 : 0)
export const now = () => Date.now()
