/**
 * bot-service — the bot's own Telegram API client.
 *
 * Two modes (resolved dynamically, panel/DB config wins over env):
 *  - REAL  (a bot token exists in DB Setting or env && not mock-forced): real HTTP
 *          calls to api.telegram.org (12s timeout, errors logged to ActivityLog,
 *          never thrown).
 *  - MOCK  (no token anywhere, or env TELEGRAM_MOCK === 'true' with no panel
 *          token): every outgoing call is recorded as an ActivityLog row
 *          (type 'telegram_out', clearly labeled simulation).
 *
 * The config is re-read from the Setting table every ~15s, so connecting a bot
 * from the admin panel takes effect without restarting this service.
 */
import type { InlineButton } from '../../src/lib/telegram-render'
import { db } from './db'

const TG_API = 'https://api.telegram.org'
const HTTP_TIMEOUT_MS = 12_000
const CONFIG_TTL_MS = 15_000

type TgRuntimeConfig = {
  botToken: string
  botUsername: string
  channelId: string
  adminChatId: string
  /** token stored by the admin panel (Setting table) */
  dbConfigured: boolean
  at: number
}

let cachedConfig: TgRuntimeConfig | null = null

export async function loadConfig(force = false): Promise<TgRuntimeConfig> {
  if (cachedConfig && !force && Date.now() - cachedConfig.at < CONFIG_TTL_MS) {
    return cachedConfig
  }
  const env = {
    botToken: (process.env.TELEGRAM_BOT_TOKEN ?? '').trim(),
    botUsername: (process.env.TELEGRAM_BOT_USERNAME ?? '').trim(),
    channelId: (process.env.TELEGRAM_CHANNEL_ID ?? '').trim(),
    adminChatId: (process.env.TELEGRAM_ADMIN_CHAT_ID ?? '').trim(),
  }
  const value: TgRuntimeConfig = { ...env, dbConfigured: false, at: Date.now() }
  try {
    const rows = await db.setting.findMany({
      where: {
        key: {
          in: ['telegramBotToken', 'telegramBotUsername', 'telegramChannelId', 'telegramAdminChatId'],
        },
      },
    })
    const map = Object.fromEntries(rows.map((r) => [r.key, r.value]))
    const dbToken = (map['telegramBotToken'] ?? '').trim()
    value.botToken = dbToken || env.botToken
    value.botUsername = (map['telegramBotUsername'] ?? '').trim() || env.botUsername
    value.channelId = (map['telegramChannelId'] ?? '').trim() || env.channelId
    value.adminChatId = (map['telegramAdminChatId'] ?? '').trim() || env.adminChatId
    value.dbConfigured = Boolean(dbToken)
  } catch {
    // DB unavailable → env fallback
  }
  cachedConfig = value
  return value
}

export function isMockMode(): boolean {
  if (!cachedConfig) return true // before the first load — be conservative
  if (cachedConfig.dbConfigured) return false // explicit panel connection → real
  return !cachedConfig.botToken || process.env.TELEGRAM_MOCK === 'true'
}

/** Resolved mock mode after (re)loading the config. */
export async function resolveMode(): Promise<'mock' | 'real'> {
  await loadConfig()
  return isMockMode() ? 'mock' : 'real'
}

/** Current bot token from the (re)loaded config — used by the polling supervisor. */
export async function currentBotToken(): Promise<string> {
  const cfg = await loadConfig()
  return cfg.botToken
}

export async function botUsername(): Promise<string> {
  const cfg = await loadConfig()
  return cfg.botUsername || ''
}

async function logEvent(
  level: 'info' | 'warn' | 'error',
  type: string,
  message: string,
  data?: unknown,
): Promise<void> {
  try {
    await db.activityLog.create({
      data: {
        level,
        type,
        message,
        data: data === undefined ? null : JSON.stringify(data),
      },
    })
  } catch {
    // logging must never break the bot
  }
}

export type TgResult = { ok: boolean; result?: unknown; error?: string }

async function callTelegramApi(
  method: string,
  payload: Record<string, unknown>,
): Promise<TgResult> {
  const cfg = await loadConfig()
  const token = cfg.botToken
  if (!token) return { ok: false, error: 'no token' }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS)
  try {
    const res = await fetch(`${TG_API}/bot${token}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    })
    const json = (await res.json().catch(() => null)) as
      | { ok: boolean; result?: unknown; description?: string }
      | null
    if (!json) return { ok: false, error: `bad response (${res.status})` }
    if (!json.ok) return { ok: false, error: json.description || `telegram ${res.status}` }
    return { ok: true, result: json.result }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    await logEvent('error', 'telegram_error', `${method} failed: ${msg}`)
    return { ok: false, error: msg }
  } finally {
    clearTimeout(timer)
  }
}

/** Send an HTML message. Mock mode → ActivityLog row. Never throws. */
export async function send(
  chatId: string | number,
  text: string,
  keyboard?: InlineButton[][],
): Promise<TgResult> {
  await loadConfig()
  if (isMockMode()) {
    await logEvent('info', 'telegram_out', `[حالت شبیه‌سازی] sendMessage → ${chatId}`, {
      chatId: String(chatId),
      preview: text.slice(0, 600),
      hasKeyboard: Array.isArray(keyboard) && keyboard.length > 0,
    })
    return { ok: true }
  }
  const payload: Record<string, unknown> = {
    chat_id: chatId,
    text,
    parse_mode: 'HTML',
    disable_web_page_preview: true,
  }
  if (keyboard && keyboard.length > 0) {
    payload.reply_markup = { inline_keyboard: keyboard }
  }
  const result = await callTelegramApi('sendMessage', payload)
  if (!result.ok) {
    await logEvent('error', 'telegram_error', `sendMessage → ${chatId} failed: ${result.error}`)
  }
  return result
}

/** Acknowledge a callback query (removes the loading spinner on the button). */
export async function answerCallback(cbId: string, text?: string): Promise<TgResult> {
  await loadConfig()
  if (isMockMode()) {
    await logEvent('info', 'telegram_out', `[حالت شبیه‌سازی] answerCallbackQuery → ${cbId}`, {
      callbackId: cbId,
      text: text ?? null,
    })
    return { ok: true }
  }
  const payload: Record<string, unknown> = { callback_query_id: cbId }
  if (text) payload.text = text
  return callTelegramApi('answerCallbackQuery', payload)
}

// ─── Long polling (real mode only) ───────────────────────────────────────────

export type TelegramUpdate = {
  update_id: number
  message?: {
    chat: { id: number | string; type: string }
    from?: { id: number; first_name?: string; username?: string }
    text?: string
  }
  callback_query?: {
    id: string
    data?: string
    from: { id: number; first_name?: string; username?: string }
  }
}

export async function getUpdatesPolling(
  offset: number,
  timeoutSeconds = 30,
): Promise<TelegramUpdate[] | null> {
  await loadConfig()
  const result = await callTelegramApi('getUpdates', {
    offset,
    timeout: timeoutSeconds,
    allowed_updates: ['message', 'callback_query'],
  })
  if (!result.ok) return null
  return (result.result as TelegramUpdate[]) ?? []
}
