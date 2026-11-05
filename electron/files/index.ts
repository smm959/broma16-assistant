import { mkdirSync, readFileSync, writeFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { extname, join, basename } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { AttachmentRef } from '../../shared/types.js'

const TEXT_EXT = new Set(['.txt', '.md', '.csv', '.json', '.log', '.srt', '.rtf'])
const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp'])
const AUDIO_EXT = new Set(['.wav', '.mp3', '.aiff', '.aif', '.flac', '.m4a', '.ogg'])

export const MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.pdf': 'application/pdf',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.doc': 'application/msword',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.xls': 'application/vnd.ms-excel',
  '.csv': 'text/csv',
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.json': 'application/json',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.flac': 'audio/flac',
  '.aiff': 'audio/aiff',
  '.aif': 'audio/aiff',
  '.m4a': 'audio/mp4',
  '.ogg': 'audio/ogg',
}

export class FileService {
  constructor(private readonly filesDir: string) {
    mkdirSync(filesDir, { recursive: true })
  }

  async saveUpload(filename: string, data: Uint8Array): Promise<AttachmentRef> {
    const id = `att_${randomUUID().slice(0, 10)}`
    const ext = extname(filename).toLowerCase()
    const dir = join(this.filesDir, id)
    mkdirSync(dir, { recursive: true })
    const path = join(dir, sanitizeName(filename) || `file${ext}`)
    writeFileSync(path, data)
    const mime = MIME_BY_EXT[ext] ?? 'application/octet-stream'
    const kind: 'image' | 'document' | 'audio' =
      IMAGE_EXT.has(ext) || mime.startsWith('image/') ? 'image' : AUDIO_EXT.has(ext) || mime.startsWith('audio/') ? 'audio' : 'document'
    const ref: AttachmentRef = { id, filename, mimeType: mime, size: data.byteLength, kind, path }
    if (kind === 'document') {
      try {
        ref.extractedText = (await this.extractText(path, mime, ext)).slice(0, 200_000)
      } catch (e) {
        ref.extractedText = `[Не удалось извлечь текст: ${(e as Error).message}]`
      }
    }
    return ref
  }

  async extractText(path: string, mime: string, ext = extname(path).toLowerCase()): Promise<string> {
    if (TEXT_EXT.has(ext) || mime.startsWith('text/')) {
      return readFileSync(path, 'utf8')
    }
    if (ext === '.docx') {
      const mammoth = await import('mammoth')
      const result = await (mammoth as any).extractRawText({ path })
      return result.value as string
    }
    if (ext === '.pdf' || mime === 'application/pdf') {
      const unpdf: any = await import('unpdf')
      const buffer = new Uint8Array(readFileSync(path))
      const doc = await unpdf.getDocumentProxy(buffer)
      const { text } = await unpdf.extractText(doc, { mergePages: true })
      return Array.isArray(text) ? text.join('\n') : String(text)
    }
    if (ext === '.xlsx' || ext === '.xls' || mime.includes('spreadsheet') || mime.includes('ms-excel')) {
      const ExcelJS: any = await import('exceljs')
      const wb = new (ExcelJS.default ?? ExcelJS).Workbook()
      await wb.xlsx.readFile(path)
      const out: string[] = []
      wb.eachSheet((sheet: any) => {
        out.push(`### Лист: ${sheet.name}`)
        sheet.eachRow((row: any, rowNumber: number) => {
          const values = (row.values as any[]).slice(1).map((v) => {
            if (v == null) return ''
            if (typeof v === 'object') {
              if (v.text) return v.text
              if (v.result != null) return String(v.result)
              if (v.richText) return v.richText.map((r: any) => r.text).join('')
              if (v.hyperlink) return v.hyperlink
            }
            return String(v)
          })
          out.push(`${rowNumber}: ${values.join(' | ')}`)
        })
      })
      return out.join('\n')
    }
    if (ext === '.doc') {
      return '[Формат .doc (старый Word) не поддерживается напрямую — сохраните файл как .docx]'
    }
    return `[Формат ${ext || mime} не поддерживается для извлечения текста]`
  }

  base64ForVision(path: string): { mimeType: string; dataBase64: string } {
    const ext = extname(path).toLowerCase()
    const mime = MIME_BY_EXT[ext] ?? 'image/png'
    return { mimeType: mime, dataBase64: readFileSync(path).toString('base64') }
  }

  /** Сохраняет подготовленный агентом текст в «Документы/Broma 16 Assistant». */
  exportText(filename: string, content: string): string {
    const dir = join(homedir(), 'Documents', 'Broma 16 Assistant')
    mkdirSync(dir, { recursive: true })
    const safe = sanitizeName(filename) || `document-${Date.now()}.txt`
    const path = join(dir, safe)
    writeFileSync(path, content, 'utf8')
    return path
  }

  info(path: string) {
    const st = statSync(path)
    return { size: st.size, name: basename(path) }
  }
}

function sanitizeName(name: string): string {
  return name.replace(/[^\p{L}\p{N}._ -]/gu, '_').slice(0, 120)
}
