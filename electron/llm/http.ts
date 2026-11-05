import { LlmError } from './types.js'

export function friendlyHttpError(status: number, body: string, provider: string): LlmError {
  let detail = body
  try {
    const json = JSON.parse(body)
    detail = json?.error?.message ?? json?.message ?? json?.error ?? body
    if (typeof detail !== 'string') detail = JSON.stringify(detail)
  } catch {
    /* plain text */
  }
  detail = String(detail).slice(0, 500)

  if (status === 401 || status === 403) {
    return new LlmError(`Ключ ${provider} отклонён (${status}). Проверьте, что ключ скопирован полностью и активен. ${detail}`, 'auth', status)
  }
  if (status === 402 || /insufficient|balance|quota|credit/i.test(detail)) {
    return new LlmError(`Недостаточно средств или исчерпана квота ${provider}. Пополните баланс в личном кабинете провайдера. ${detail}`, 'quota', status)
  }
  if (status === 429) {
    return new LlmError(`Слишком много запросов к ${provider} (429). Подождите минуту и повторите. ${detail}`, 'rate_limit', status)
  }
  if (status === 404) {
    return new LlmError(`Модель или endpoint не найден у ${provider} (404). Проверьте название модели и base URL. ${detail}`, 'model', status)
  }
  if (status === 400 || status === 422) {
    return new LlmError(`${provider} отклонил запрос (${status}): ${detail}`, 'bad_request', status)
  }
  if (status >= 500) {
    return new LlmError(`Сервер ${provider} временно недоступен (${status}). Повторите попытку позже. ${detail}`, 'network', status)
  }
  return new LlmError(`Ошибка ${provider} (${status}): ${detail}`, 'unknown', status)
}

export async function readSse(
  response: Response,
  onEvent: (event: string | null, data: string) => void,
): Promise<void> {
  if (!response.body) throw new LlmError('Пустой поток ответа от провайдера', 'network')
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let eventName: string | null = null

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    let idx: number
    while ((idx = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, idx).replace(/\r$/, '')
      buffer = buffer.slice(idx + 1)
      if (line === '') {
        eventName = null
        continue
      }
      if (line.startsWith(':')) continue
      if (line.startsWith('event:')) {
        eventName = line.slice(6).trim()
        continue
      }
      if (line.startsWith('data:')) {
        const data = line.slice(5).replace(/^ /, '')
        if (data === '[DONE]') {
          onEvent('done', data)
          continue
        }
        onEvent(eventName, data)
      }
    }
  }
}

export async function httpJson(
  url: string,
  init: RequestInit,
  timeoutMs = 60_000,
): Promise<{ status: number; ok: boolean; text: string; json: any }> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(url, { ...init, signal: init.signal ?? controller.signal })
    const text = await res.text()
    let json: any = null
    try {
      json = text ? JSON.parse(text) : null
    } catch {
      /* not json */
    }
    return { status: res.status, ok: res.ok, text, json }
  } catch (e: any) {
    if (e?.name === 'AbortError') {
      throw new LlmError('Превышено время ожидания ответа от провайдера. Проверьте интернет или попробуйте другую модель.', 'network')
    }
    throw new LlmError(
      `Не удалось подключиться к провайдеру: ${e?.message ?? e}. Проверьте интернет, VPN или base URL.`,
      'network',
    )
  } finally {
    clearTimeout(timer)
  }
}
