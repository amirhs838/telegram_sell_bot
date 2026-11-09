/**
 * bot-service — the bot's own messenger API client (Telegram + Bale).
 *
 * Bale's Bot API is a clone of Telegram's Bot API hosted at tapi.bale.ai with
 * two real differences: NO parse_mode (every message is rendered as
 * Bale-flavored Markdown) and a slightly smaller method list. Everything the
 * shop bot uses (sendMessage/sendPhoto/getFile/long-polling/inline keyboards/
 * chat actions/commands) exists on both platforms with identical payloads.
 *
 * Every function takes an explicit `platform` — except the customer-facing
 * senders, which AUTO-ROUTE by chat-id prefix: Bale customers live in the DB
 * as `bale:<numeric-id>`, Telegram customers as the raw numeric id. That keeps
 * the engine (platform-agnostic) and the whole schema untouched.
 *
 * Two modes per platform (resolved dynamically, panel/DB config wins over env):
 *  - REAL  (a bot token exists in DB Setting or env && not mock-forced): real HTTP
 *          calls (errors logged to ActivityLog, never thrown).
 *  - MOCK  (no token anywhere, or env TELEGRAM_MOCK/BALE_MOCK === 'true' with
 *          no panel token): every outgoing call is recorded as an ActivityLog
 *          row (types 'telegram_out' / 'bale_out').
 *
 * The config is re-read from the Setting table every ~15s, so connecting a bot
 * from the admin panel takes effect without restarting this service.
 */
import type { InlineButton } from '../../src/lib/telegram-render'
import { db } from './db'

export type Platform = 'telegram' | 'bale'
export const PLATFORMS: Platform[] = ['telegram', 'bale']

const API_BASE: Record<Platform, string> = {
  telegram: 'https://api.telegram.org',
  bale: 'https://tapi.bale.ai',
}

/** Setting-table keys per platform (DB wins over env, same as before). */
const PLATFORM_KEYS: Record<Platform, { token: string; username: string; channel: string; admin: string }> = {
  telegram: {
    token: 'telegramBotToken',
    username: 'telegramBotUsername',
    channel: 'telegramChannelId',
    admin: 'telegramAdminChatId',
  },
  bale: {
    token: 'baleBotToken',
    username: 'baleBotUsername',
    channel: 'baleChannelId',
    admin: 'baleAdminChatId',
  },
}

const ENV_NAMES: Record<Platform, { token: string; username: string; channel: string; admin: string; mock: string }> = {
  telegram: {
    token: 'TELEGRAM_BOT_TOKEN',
    username: 'TELEGRAM_BOT_USERNAME',
    channel: 'TELEGRAM_CHANNEL_ID',
    admin: 'TELEGRAM_ADMIN_CHAT_ID',
    mock: 'TELEGRAM_MOCK',
  },
  bale: {
    token: 'BALE_BOT_TOKEN',
    username: 'BALE_BOT_USERNAME',
    channel: 'BALE_CHANNEL_ID',
    admin: 'BALE_ADMIN_CHAT_ID',
    mock: 'BALE_MOCK',
  },
}

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

// ─── Bale text conversion (HTML → Bale-flavored Markdown) ────────────────────

/**
 * Bale renders EVERY message as Markdown (no parse_mode): `*bold*`,
 * `_italic_`, `[text](url)`, ```code``` — and the docs require a space
 * before/after the markers. Our engine emits Telegram HTML, so outgoing
 * messages are converted here, once, at the transport boundary.
 */
export function htmlToBale(html: string): string {
  let out = html
  // <br> → newline
  out = out.replace(/<br\s*\/?>/gi, '\n')
  // <a href="URL">TEXT</a> → [TEXT](URL)  (must run before generic tag stripping)
  out = out.replace(
    /<a\s+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi,
    (_m, url: string, text: string) => {
      const label = stripTags(text).trim() || url
      return `[${label}](${url})`
    },
  )
  // <b>/<strong> → *text* with the documented padding spaces
  out = out.replace(/<(b|strong)>([\s\S]*?)<\/\1>/gi, (_m, _t, inner: string) => {
    const body = stripTags(inner).trim()
    return body ? ` *${body}* ` : ''
  })
  // <i>/<em> → _text_
  out = out.replace(/<(i|em)>([\s\S]*?)<\/\1>/gi, (_m, _t, inner: string) => {
    const body = stripTags(inner).trim()
    return body ? ` _${body}_ ` : ''
  })
  // <code>/<pre> → triple-backtick block (Bale's only documented code format)
  out = out.replace(/<(code|pre)>([\s\S]*?)<\/\1>/gi, (_m, _t, inner: string) => {
    return `\n\`\`\`\n${stripTags(inner).trim()}\n\`\`\`\n`
  })
  // <blockquote> → quoted line («…» keeps the intent without Bale markup)
  out = out.replace(/<blockquote>([\s\S]*?)<\/blockquote>/gi, (_m, inner: string) => {
    return `\n«${stripTags(inner).trim()}»\n`
  })
  // strip any remaining tags, unescape HTML entities, collapse padding
  out = stripTags(out)
  out = out
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
  return out.trim()
}

function stripTags(s: string): string {
  return s.replace(/<[^>]+>/g, '')
}

// ─── Chat-id helpers ─────────────────────────────────────────────────────────

/** Bale customers are stored as `bale:<id>`; strip the prefix for API calls. */
export function normalizeChatId(platform: Platform, chatId: string | number): string | number {
  const raw = String(chatId)
  if (platform === 'bale' && raw.startsWith('bale:')) return raw.slice(5) || raw
  return chatId
}

/**
 * Customer-facing auto-routing: a prefixed id (`bale:…`) belongs to Bale,
 * everything else is Telegram. Used by engine/orders code paths that only
 * know the customer id (panel confirm flows, seller notifications, …).
 */
export function platformOfChatId(chatId: string | number): Platform {
  return String(chatId).startsWith('bale:') ? 'bale' : 'telegram'
}

// ─── Config (per platform) ───────────────────────────────────────────────────

type PlatformConfig = {
  botToken: string
  botUsername: string
  channelId: string
  adminChatId: string
  /** token stored by the admin panel (Setting table) */
  dbConfigured: boolean
  at: number
}

const configCache = new Map<Platform, PlatformConfig>()

export async function loadConfig(platform: Platform, force = false): Promise<PlatformConfig> {
  const cached = configCache.get(platform)
  if (cached && !force && Date.now() - cached.at < CONFIG_TTL_MS) {
    return cached
  }
  const envNames = ENV_NAMES[platform]
  const env = {
    botToken: (process.env[envNames.token] ?? '').trim(),
    botUsername: (process.env[envNames.username] ?? '').trim(),
    channelId: (process.env[envNames.channel] ?? '').trim(),
    adminChatId: (process.env[envNames.admin] ?? '').trim(),
  }
  const value: PlatformConfig = { ...env, dbConfigured: false, at: Date.now() }
  try {
    const keys = Object.values(PLATFORM_KEYS[platform])
    const rows = await db.setting.findMany({ where: { key: { in: keys } } })
    const map = Object.fromEntries(rows.map((r) => [r.key, r.value]))
    const dbToken = (map[PLATFORM_KEYS[platform].token] ?? '').trim()
    value.botToken = dbToken || env.botToken
    value.botUsername = (map[PLATFORM_KEYS[platform].username] ?? '').trim() || env.botUsername
    value.channelId = (map[PLATFORM_KEYS[platform].channel] ?? '').trim() || env.channelId
    value.adminChatId = (map[PLATFORM_KEYS[platform].admin] ?? '').trim() || env.adminChatId
    value.dbConfigured = Boolean(dbToken)
  } catch {
    // DB unavailable → env fallback
  }
  configCache.set(platform, value)
  return value
}

export function isMockMode(platform: Platform): boolean {
  const cached = configCache.get(platform)
  if (!cached) return true // before the first load — be conservative
  if (cached.dbConfigured) return false // explicit panel connection → real
  const mockEnv = ENV_NAMES[platform].mock
  // TELEGRAM_MOCK=true forces telegram mock; BALE_MOCK only affects bale.
  return !cached.botToken || process.env[mockEnv] === 'true'
}

/** Resolved mock mode after (re)loading the config. */
export async function resolveMode(platform: Platform): Promise<'mock' | 'real'> {
  await loadConfig(platform)
  return isMockMode(platform) ? 'mock' : 'real'
}

/** Current bot token from the (re)loaded config — used by the polling supervisor. */
export async function currentBotToken(platform: Platform): Promise<string> {
  const cfg = await loadConfig(platform)
  return cfg.botToken
}

export async function botUsername(platform: Platform): Promise<string> {
  const cfg = await loadConfig(platform)
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

function logType(platform: Platform, kind: 'out' | 'error'): string {
  return platform === 'bale' ? `bale_${kind}` : `telegram_${kind}`
}

export type TgResult = { ok: boolean; result?: unknown; error?: string }

async function callMessengerApi(
  platform: Platform,
  method: string,
  payload: Record<string, unknown>,
  timeoutMs = HTTP_TIMEOUT_MS,
  opts?: { signal?: AbortSignal; quietAbort?: boolean },
): Promise<TgResult> {
  const cfg = await loadConfig(platform)
  const token = cfg.botToken
  if (!token) return { ok: false, error: 'no token' }
  const body = { ...payload }
  if (platform === 'bale') {
    // Bale has no parse_mode (always Markdown) and no web-page-preview flag.
    delete body['parse_mode']
    delete body['disable_web_page_preview']
    if (typeof body['text'] === 'string') body['text'] = htmlToBale(body['text'])
    if (typeof body['caption'] === 'string') body['caption'] = htmlToBale(body['caption'])
  }
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
    const res = await fetch(`${API_BASE[platform]}/bot${token}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    })
    const json = (await res.json().catch(() => null)) as
      | { ok: boolean; result?: unknown; description?: string }
      | null
    if (!json) return { ok: false, error: `bad response (${res.status})` }
    if (!json.ok) return { ok: false, error: json.description || `${platform} ${res.status}` }
    return { ok: true, result: json.result }
  } catch (e) {
    // A deliberate abort (polling handover) is normal — stay quiet, no log row.
    if (controller.signal.aborted && opts?.quietAbort) {
      return { ok: false, error: 'aborted' }
    }
    const msg = e instanceof Error ? e.message : String(e)
    await logEvent('error', logType(platform, 'error'), `${method} failed: ${msg}`)
    return { ok: false, error: msg }
  } finally {
    clearTimeout(timer)
    external?.removeEventListener('abort', onExternalAbort)
  }
}

/**
 * Register the bot's public menu (per platform):
 *  1. setMyCommands → the / command list
 *  2. setChatMenuButton → Telegram-only (not part of the Bale API) — the ☰
 *     button in the input's left corner opens that list.
 * Safe to call repeatedly; in mock mode it only logs. Never throws.
 */
export async function registerBotMenu(platform: Platform): Promise<{ ok: boolean; error?: string }> {
  await loadConfig(platform)
  if (isMockMode(platform)) return { ok: false, error: 'mock mode' }
  const cfg = await loadConfig(platform)
  if (!cfg.botToken) return { ok: false, error: 'no token' }
  const commands = await callMessengerApi(platform, 'setMyCommands', { commands: BOT_COMMANDS })
  if (commands.ok && platform === 'bale') {
    console.log(`[bot-service] ${platform} bot menu registered: ${BOT_COMMANDS.length} commands`)
    return { ok: true }
  }
  const menuButton =
    platform === 'bale'
      ? { ok: true }
      : await callMessengerApi(platform, 'setChatMenuButton', {
          menu_button: { type: 'commands' },
        })
  if (commands.ok && menuButton.ok) {
    console.log(
      `[bot-service] ${platform} bot menu registered: ${BOT_COMMANDS.length} commands + chat menu button (commands)`,
    )
    return { ok: true }
  }
  const error = `setMyCommands=${commands.ok ? 'ok' : commands.error} setChatMenuButton=${menuButton.ok ? 'ok' : menuButton.error}`
  console.error(`[bot-service] ${platform} bot menu registration failed: ${error}`)
  return { ok: false, error }
}

/**
 * Show «typing…» in the chat (chat action: ~5s Telegram / ~6s Bale).
 * Fire-and-forget: a sales bot never cares whether it failed. Mock mode →
 * silent no-op so the keep-alive loop in index.ts cannot spam the ActivityLog.
 */
export async function sendTyping(platform: Platform, chatId: string | number): Promise<void> {
  await loadConfig(platform)
  if (isMockMode(platform)) return
  await callMessengerApi(platform, 'sendChatAction', {
    chat_id: normalizeChatId(platform, chatId),
    action: 'typing',
  })
}

/** Send an HTML message (converted per platform). Mock mode → ActivityLog row. */
export async function send(
  platform: Platform,
  chatId: string | number,
  text: string,
  keyboard?: InlineButton[][],
  bottom?: ReplyKeyboardMarkup,
): Promise<TgResult> {
  await loadConfig(platform)
  const target = normalizeChatId(platform, chatId)
  if (isMockMode(platform)) {
    await logEvent('info', logType(platform, 'out'), `[حالت شبیه‌سازی] sendMessage → ${target}`, {
      chatId: String(target),
      preview: text.slice(0, 600),
      hasKeyboard: Array.isArray(keyboard) && keyboard.length > 0,
    })
    return { ok: true }
  }
  const payload: Record<string, unknown> = {
    chat_id: target,
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
  const result = await callMessengerApi(platform, 'sendMessage', payload)
  if (!result.ok) {
    await logEvent('error', logType(platform, 'error'), `sendMessage → ${target} failed: ${result.error}`)
  }
  return result
}

/** Customer-facing send with auto platform routing by chat-id prefix. */
export async function sendToCustomer(
  chatId: string | number,
  text: string,
  keyboard?: InlineButton[][],
  bottom?: ReplyKeyboardMarkup,
): Promise<TgResult> {
  return send(platformOfChatId(chatId), chatId, text, keyboard, bottom)
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
 * Send a photo with a caption + optional inline keyboard.
 * `source` is either an http(s) URL string or {buffer, filename} (multipart upload).
 * Mock mode → ActivityLog row with type 'photo' instead of a real call.
 * Never throws.
 */
export async function sendPhoto(
  platform: Platform,
  chatId: string | number,
  source: PhotoSource,
  caption: string,
  keyboard?: InlineButton[][],
  bottom?: ReplyKeyboardMarkup,
): Promise<TgResult> {
  await loadConfig(platform)
  const target = normalizeChatId(platform, chatId)
  const describe = typeof source === 'string' ? source : source.filename
  if (isMockMode(platform)) {
    await logEvent('info', logType(platform, 'out'), `[حالت شبیه‌سازی] sendPhoto → ${target}`, {
      chatId: String(target),
      type: 'photo',
      source: describe,
      captionPreview: caption.slice(0, 600),
      hasKeyboard: Array.isArray(keyboard) && keyboard.length > 0,
    })
    return { ok: true }
  }
  const cfg = await loadConfig(platform)
  if (!cfg.botToken) return { ok: false, error: 'no token' }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS)
  try {
    const form = new FormData()
    form.append('chat_id', String(target))
    form.append('caption', platform === 'bale' ? htmlToBale(caption) : caption)
    if (platform !== 'bale') form.append('parse_mode', 'HTML')
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
    const res = await fetch(`${API_BASE[platform]}/bot${cfg.botToken}/sendPhoto`, {
      method: 'POST',
      body: form,
      signal: controller.signal,
    })
    const json = (await res.json().catch(() => null)) as
      | { ok: boolean; result?: unknown; description?: string }
      | null
    if (!json) {
      await logEvent('error', logType(platform, 'error'), `sendPhoto → ${target} bad response (${res.status})`)
      return { ok: false, error: `bad response (${res.status})` }
    }
    if (!json.ok) {
      await logEvent('error', logType(platform, 'error'), `sendPhoto → ${target} failed: ${json.description}`)
      return { ok: false, error: json.description || `${platform} ${res.status}` }
    }
    return { ok: true, result: json.result }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    await logEvent('error', logType(platform, 'error'), `sendPhoto → ${target} failed: ${msg}`)
    return { ok: false, error: msg }
  } finally {
    clearTimeout(timer)
  }
}

/** Resolve a file_id → file_path on the given platform. Never throws. */
export async function getFileInfo(platform: Platform, fileId: string): Promise<TgResult> {
  await loadConfig(platform)
  if (isMockMode(platform)) {
    await logEvent('info', logType(platform, 'out'), `[حالت شبیه‌سازی] getFile → ${fileId}`, {
      type: 'file_info',
      fileId,
    })
    return { ok: false, error: 'mock mode: no real file to download' }
  }
  return callMessengerApi(platform, 'getFile', { file_id: fileId })
}

/**
 * Download a file by its file_path (from getFile).
 * URL pattern is identical on both platforms:
 *   …/file/bot<token>/<file_path>
 * Never throws; returns the raw Buffer on success.
 */
export async function downloadFile(
  platform: Platform,
  filePath: string,
): Promise<{ ok: boolean; buffer?: Buffer; error?: string }> {
  const cfg = await loadConfig(platform)
  const token = cfg.botToken
  if (!token) return { ok: false, error: 'no token' }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS)
  try {
    const res = await fetch(`${API_BASE[platform]}/file/bot${token}/${filePath}`, {
      signal: controller.signal,
    })
    if (!res.ok) {
      const msg = `download failed (${res.status})`
      await logEvent('error', logType(platform, 'error'), `downloadFile failed: ${msg}`)
      return { ok: false, error: msg }
    }
    const buf = Buffer.from(await res.arrayBuffer())
    return { ok: true, buffer: buf }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    await logEvent('error', logType(platform, 'error'), `downloadFile failed: ${msg}`)
    return { ok: false, error: msg }
  } finally {
    clearTimeout(timer)
  }
}

/** Acknowledge a callback query (removes the loading spinner on the button). */
export async function answerCallback(
  platform: Platform,
  cbId: string,
  text?: string,
): Promise<TgResult> {
  await loadConfig(platform)
  if (isMockMode(platform)) {
    await logEvent('info', logType(platform, 'out'), `[حالت شبیه‌سازی] answerCallbackQuery → ${cbId}`, {
      callbackId: cbId,
      text: text ?? null,
    })
    return { ok: true }
  }
  const payload: Record<string, unknown> = { callback_query_id: cbId }
  if (text) payload.text = text
  return callMessengerApi(platform, 'answerCallbackQuery', payload)
}

// ─── Seller / admin notifications (fan-out to every connected platform) ──────

/**
 * Notify the store owner on BOTH messengers, best-effort: Telegram via
 * telegramAdminChatId, Bale via baleAdminChatId — each only when that
 * platform has a token and an admin chat id. Order alerts, receipt alerts
 * and seller buttons use this; a press from either platform works.
 */
export async function notifyAdmin(text: string, keyboard?: InlineButton[][]): Promise<void> {
  for (const platform of PLATFORMS) {
    try {
      const cfg = await loadConfig(platform)
      if (!cfg.botToken || !cfg.adminChatId) continue
      await send(platform, cfg.adminChatId, text, keyboard)
    } catch {
      // a notification must never break the flow that triggered it
    }
  }
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
  platform: Platform,
  offset: number,
  timeoutSeconds = 25,
  signal?: AbortSignal,
): Promise<PollResult> {
  await loadConfig(platform)
  const payload: Record<string, unknown> = { offset, timeout: timeoutSeconds }
  // Bale's getUpdates documents offset/limit/timeout only — no allowed_updates.
  if (platform !== 'bale') {
    payload['allowed_updates'] = ['message', 'callback_query']
  }
  const result = await callMessengerApi(platform, 'getUpdates', payload, LONG_POLL_TIMEOUT_MS, {
    signal,
    quietAbort: true,
  })
  if (!result.ok) return { error: result.error || `unknown ${platform} error` }
  return { updates: (result.result as TelegramUpdate[]) ?? [] }
}
