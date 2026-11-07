/**
 * bot-service — the bot's own Telegram API client.
 *
 * Two modes (resolved dynamically, panel/DB config wins over env):
 *  - REAL  (a bot token exists in DB Setting or env && not mock-forced): real HTTP
 *          calls to api.telegram.org (errors logged to ActivityLog, never thrown).
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
/** Long-poll uses a 25s server-side wait; the HTTP timeout must exceed it. */
const LONG_POLL_TIMEOUT_MS = 35_000
const DOWNLOAD_TIMEOUT_MS = 30_000
const CONFIG_TTL_MS = 15_000

/** Photo source for sendPhoto: an http(s) URL string, or an in-memory file. */
export type PhotoSource = string | { buffer: Buffer; filename: string }

/**
 * ReplyKeyboardMarkup — the PERSISTENT bottom keyboard (the shop menu that
 * always sits above the input field). Text buttons submit their label as a
 * normal message, so the engine matches those texts.
 */
export type ReplyKeyboardMarkup = {
  keyboard: { text: string }[][]
  resize_keyboard?: boolean
  is_persistent?: boolean
  selective?: boolean
}

/** The command list shown in the bot's menu (left corner ☰ button) — photo order. */
export const BOT_COMMANDS: { command: string; description: string }[] = [
  { command: 'start', description: 'شروع و ثبت‌نام' },
  { command: 'menu', description: 'منوی اصلی' },
  { command: 'products', description: '🛍 محصولات' },
  { command: 'cart', description: '🛒 سبد خرید' },
  { command: 'orders', description: '📦 سفارش‌های من' },
  { command: 'faq', description: '❓ سوالات متداول' },
  { command: 'support', description: '💬 گفتگو با ادمین' },
]

/**
 * Register the bot's public menu with Telegram:
 *  1. setMyCommands → the / command list (photos 2-3 order)
 *  2. setChatMenuButton → the ☰ button in the input's left corner opens that list
 * Safe to call repeatedly; in mock mode it only logs. Never throws.
 */
export async function registerBotMenu(): Promise<{ ok: boolean; error?: string }> {
  await loadConfig()
  if (isMockMode()) return { ok: false, error: 'mock mode' }
  const cfg = await loadConfig()
  if (!cfg.botToken) return { ok: false, error: 'no token' }
  const commands = await callTelegramApi('setMyCommands', { commands: BOT_COMMANDS })
  const menuButton = await callTelegramApi('setChatMenuButton', {
    menu_button: { type: 'commands' },
  })
  if (commands.ok && menuButton.ok) {
    console.log(
      `[bot-service] bot menu registered: ${BOT_COMMANDS.length} commands + chat menu button (commands)`,
    )
    return { ok: true }
  }
  const error = `setMyCommands=${commands.ok ? 'ok' : commands.error} setChatMenuButton=${menuButton.ok ? 'ok' : menuButton.error}`
  console.error(`[bot-service] bot menu registration failed: ${error}`)
  return { ok: false, error }
}

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
  timeoutMs = HTTP_TIMEOUT_MS,
  opts?: { signal?: AbortSignal; quietAbort?: boolean },
): Promise<TgResult> {
  const cfg = await loadConfig()
  const token = cfg.botToken
  if (!token) return { ok: false, error: 'no token' }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  // external signal (polling-loop handover) → abort the in-flight request too
  const external = opts?.signal
  const onExternalAbort = (): void => controller.abort()
  if (external) {
    if (external.aborted) controller.abort()
    else external.addEventListener('abort', onExternalAbort, { once: true })
  }
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
    // A deliberate abort (polling handover) is normal — stay quiet, no log row.
    if (controller.signal.aborted && opts?.quietAbort) {
      return { ok: false, error: 'aborted' }
    }
    const msg = e instanceof Error ? e.message : String(e)
    await logEvent('error', 'telegram_error', `${method} failed: ${msg}`)
    return { ok: false, error: msg }
  } finally {
    clearTimeout(timer)
    external?.removeEventListener('abort', onExternalAbort)
  }
}

/** Send an HTML message. Mock mode → ActivityLog row. Never throws. */
export async function send(
  chatId: string | number,
  text: string,
  keyboard?: InlineButton[][],
  bottom?: ReplyKeyboardMarkup,
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
  } else if (bottom) {
    // no inline buttons → (re)assert the persistent bottom keyboard
    payload.reply_markup = bottom
  }
  const result = await callTelegramApi('sendMessage', payload)
  if (!result.ok) {
    await logEvent('error', 'telegram_error', `sendMessage → ${chatId} failed: ${result.error}`)
  }
  return result
}

function mimeFor(filename: string): string {
  const ext = filename.toLowerCase().split('.').pop() ?? ''
  if (ext === 'png') return 'image/png'
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg'
  if (ext === 'webp') return 'image/webp'
  if (ext === 'gif') return 'image/gif'
  return 'application/octet-stream'
}

/**
 * Send a photo with an HTML caption + optional inline keyboard.
 * `source` is either an http(s) URL string or {buffer, filename} (multipart upload).
 * Mock mode → ActivityLog row with type 'photo' instead of a real call.
 * Never throws.
 */
export async function sendPhoto(
  chatId: string | number,
  source: PhotoSource,
  caption: string,
  keyboard?: InlineButton[][],
  bottom?: ReplyKeyboardMarkup,
): Promise<TgResult> {
  await loadConfig()
  const describe = typeof source === 'string' ? source : source.filename
  if (isMockMode()) {
    await logEvent('info', 'telegram_out', `[حالت شبیه‌سازی] sendPhoto → ${chatId}`, {
      chatId: String(chatId),
      type: 'photo',
      source: describe,
      captionPreview: caption.slice(0, 600),
      hasKeyboard: Array.isArray(keyboard) && keyboard.length > 0,
    })
    return { ok: true }
  }
  const cfg = await loadConfig()
  if (!cfg.botToken) return { ok: false, error: 'no token' }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS)
  try {
    const form = new FormData()
    form.append('chat_id', String(chatId))
    form.append('caption', caption)
    form.append('parse_mode', 'HTML')
    if (keyboard && keyboard.length > 0) {
      form.append('reply_markup', JSON.stringify({ inline_keyboard: keyboard }))
    } else if (bottom) {
      // no inline buttons → (re)assert the persistent bottom keyboard
      form.append('reply_markup', JSON.stringify(bottom))
    }
    if (typeof source === 'string') {
      form.append('photo', source)
    } else {
      form.append(
        'photo',
        new Blob([new Uint8Array(source.buffer)], { type: mimeFor(source.filename) }),
        source.filename,
      )
    }
    const res = await fetch(`${TG_API}/bot${cfg.botToken}/sendPhoto`, {
      method: 'POST',
      body: form,
      signal: controller.signal,
    })
    const json = (await res.json().catch(() => null)) as
      | { ok: boolean; result?: unknown; description?: string }
      | null
    if (!json) {
      await logEvent('error', 'telegram_error', `sendPhoto → ${chatId} bad response (${res.status})`)
      return { ok: false, error: `bad response (${res.status})` }
    }
    if (!json.ok) {
      await logEvent('error', 'telegram_error', `sendPhoto → ${chatId} failed: ${json.description}`)
      return { ok: false, error: json.description || `telegram ${res.status}` }
    }
    return { ok: true, result: json.result }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    await logEvent('error', 'telegram_error', `sendPhoto → ${chatId} failed: ${msg}`)
    return { ok: false, error: msg }
  } finally {
    clearTimeout(timer)
  }
}

/** Resolve a Telegram file_id → (file_path). Mock mode → not-ok result. Never throws. */
export async function getFileInfo(fileId: string): Promise<TgResult> {
  await loadConfig()
  if (isMockMode()) {
    await logEvent('info', 'telegram_out', `[حالت شبیه‌سازی] getFile → ${fileId}`, {
      type: 'file_info',
      fileId,
    })
    return { ok: false, error: 'mock mode: no real file to download' }
  }
  return callTelegramApi('getFile', { file_id: fileId })
}

/**
 * Download a Telegram file by its file_path (from getFile).
 * URL: https://api.telegram.org/file/bot<token>/<file_path>
 * Never throws; returns the raw Buffer on success.
 */
export async function downloadFile(filePath: string): Promise<{ ok: boolean; buffer?: Buffer; error?: string }> {
  const cfg = await loadConfig()
  const token = cfg.botToken
  if (!token) return { ok: false, error: 'no token' }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS)
  try {
    const res = await fetch(`${TG_API}/file/bot${token}/${filePath}`, {
      signal: controller.signal,
    })
    if (!res.ok) {
      const msg = `download failed (${res.status})`
      await logEvent('error', 'telegram_error', `downloadFile failed: ${msg}`)
      return { ok: false, error: msg }
    }
    const buf = Buffer.from(await res.arrayBuffer())
    return { ok: true, buffer: buf }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    await logEvent('error', 'telegram_error', `downloadFile failed: ${msg}`)
    return { ok: false, error: msg }
  } finally {
    clearTimeout(timer)
  }
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
    photo?: { file_id: string; file_unique_id?: string; width: number; height: number }[]
    caption?: string
  }
  callback_query?: {
    id: string
    data?: string
    from: { id: number; first_name?: string; username?: string }
  }
}

/** Result of one getUpdates long-poll — carries the failure reason explicitly. */
export type PollResult =
  | { updates: TelegramUpdate[] }
  | { error: string }

/**
 * Long-poll getUpdates. `timeoutSeconds` is the server-side wait — the HTTP
 * timeout (35s) always exceeds it so the request is never aborted mid-poll.
 * `signal` lets the polling supervisor cancel an in-flight poll during a
 * hot-reload handover (quiet — no ActivityLog row).
 * Failures return `{ error }` instead of a silent null so the polling loop
 * can log WHY the bot stopped receiving (webhook conflict, network, 409…).
 */
export async function getUpdatesPolling(
  offset: number,
  timeoutSeconds = 25,
  signal?: AbortSignal,
): Promise<PollResult> {
  await loadConfig()
  const result = await callTelegramApi(
    'getUpdates',
    {
      offset,
      timeout: timeoutSeconds,
      allowed_updates: ['message', 'callback_query'],
    },
    LONG_POLL_TIMEOUT_MS,
    { signal, quietAbort: true },
  )
  if (!result.ok) return { error: result.error || 'unknown telegram error' }
  return { updates: (result.result as TelegramUpdate[]) ?? [] }
}
