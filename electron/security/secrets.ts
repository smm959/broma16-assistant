import { app, safeStorage } from 'electron'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

interface SecretFile {
  version: 1
  entries: Record<string, { cipher: string; hint: string; updatedAt: number }>
}

const FILE = 'secrets.json'

/**
 * Ключи API и пароли почты хранятся только в зашифрованном виде.
 * Шифрование — через системное хранилище секретов ОС (safeStorage:
 * Keychain на macOS, DPAPI на Windows, libsecret на Linux).
 */
export class SecretStore {
  private cache: SecretFile | null = null
  private readonly filePath: string

  constructor() {
    const dir = app.getPath('userData')
    mkdirSync(dir, { recursive: true })
    this.filePath = join(dir, FILE)
  }

  get encryptionAvailable(): boolean {
    try {
      return safeStorage.isEncryptionAvailable()
    } catch {
      return false
    }
  }

  private load(): SecretFile {
    if (this.cache) return this.cache
    try {
      if (existsSync(this.filePath)) {
        this.cache = JSON.parse(readFileSync(this.filePath, 'utf8')) as SecretFile
      }
    } catch {
      /* повреждённый файл перезапишем */
    }
    this.cache ??= { version: 1, entries: {} }
    return this.cache
  }

  private persist() {
    if (!this.cache) return
    writeFileSync(this.filePath, JSON.stringify(this.cache), { mode: 0o600 })
  }

  set(key: string, value: string) {
    if (!this.encryptionAvailable) {
      throw new Error(
        'Системное хранилище секретов недоступно. Приложение не сохраняет ключи в открытом виде — включите Keychain/DPAPI/libsecret и попробуйте снова.',
      )
    }
    const file = this.load()
    const cipher = safeStorage.encryptString(value).toString('base64')
    file.entries[key] = { cipher, hint: hintFor(value), updatedAt: Date.now() }
    this.persist()
  }

  get(key: string): string | null {
    const entry = this.load().entries[key]
    if (!entry) return null
    try {
      return safeStorage.decryptString(Buffer.from(entry.cipher, 'base64'))
    } catch {
      return null
    }
  }

  hint(key: string): string | undefined {
    return this.load().entries[key]?.hint
  }

  has(key: string): boolean {
    return Boolean(this.load().entries[key])
  }

  delete(key: string) {
    const file = this.load()
    delete file.entries[key]
    this.persist()
  }

  clear() {
    this.cache = { version: 1, entries: {} }
    this.persist()
  }
}

function hintFor(value: string): string {
  const clean = value.trim()
  if (clean.length <= 8) return '••••'
  return `${clean.slice(0, 3)}…${clean.slice(-4)}`
}

let store: SecretStore | null = null
export function secrets(): SecretStore {
  store ??= new SecretStore()
  return store
}
