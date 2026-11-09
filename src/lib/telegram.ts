import 'server-only'
import crypto from 'node:crypto'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { db } from '@/lib/db'
import { logEvent } from '@/lib/logger'
import {
  renderProductPost,
  hashContent,
  type InlineButton,
  type RenderProduct,
  type PostPlatform,
} from '@/lib/telegram-render'
import {
  getSettings,
  getTelegramConfig,
  resetTelegramConfigCache,
} from '@/lib/settings'
import { getBaleConfig } from '@/lib/settings'
import {
  baleRequest,
  callBaleApiForm,
  isBaleMockMode,
  sendBaleSellerNotification,
} from '@/lib/bale'

// ─── Configuration ───────────────────────────────────────────────────────────

// Runtime config is resolved per-call: panel connection (DB) takes priority
// over environment variables. Mock mode only applies when no panel token exists.

export async function getBotToken() {
  return (await getTelegramConfig()).botToken
}
export async function getChannelId() {
  return (await getTelegramConfig()).channelId
}
export async function getAdminChatId() {
  return (await getTelegramConfig()).adminChatId
}
/**
 * Mock mode = no usable bot token, or env-forced simulation (TELEGRAM_MOCK=true)
 * that has NOT been overridden by a panel connection.
 */
export async function isMockMode() {
  const cfg = await getTelegramConfig()
  if (cfg.dbConfigured) return false // explicit panel connection → always real
  return !cfg.botToken || process.env.TELEGRAM_MOCK === 'true'
}

export async function getTelegramStatus() {
  const cfg = await getTelegramConfig()
  return {
    botConfigured: Boolean(cfg.botToken),
    channelConfigured: Boolean(cfg.channelId),
    adminChatConfigured: Boolean(cfg.adminChatId),
    mockMode: await isMockMode(),
    botUsername: cfg.botUsername || 'my_store_bot',
    source: cfg.dbConfigured ? ('panel' as const) : ('env' as const),
  }
}

/** Invalidate every in-process cache after a panel config change. */
export async function resetTelegramCaches() {
  resetTelegramConfigCache()
  cachedBotUsername = null
}

// ─── Low-level API ───────────────────────────────────────────────────────────

export class TelegramApiError extends Error {
  constructor(
    message: string,
    public method: string,
  ) {
    super(message)
  }
}

type TgResponse<T> = { ok: boolean; result?: T; description?: string }

/**
 * Dual-platform routing: any chat_id carrying the `bale:` prefix goes to the
 * Bale Bot API (prefix stripped, text converted, parse_mode dropped). This is
 * the single choke point — every sender/editer above inherits it, so channel
 * posts and notifications can address either messenger transparently.
 */
async function tgRequest<T>(method: string, payload: unknown): Promise<T> {
  const chatId = String((payload as { chat_id?: unknown } | null)?.chat_id ?? '')
  if (chatId.startsWith('bale:')) {
    return baleRequest<T>(method, payload)
  }
  const token = await getBotToken()
  if (!token) throw new TelegramApiError('توکن ربات تنظیم نشده است', method)
  let res: Response
  try {
    res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(12_000),
    })
  } catch (e) {
    throw new TelegramApiError(
      `network error: ${(e as Error).message}`,
      method,
    )
  }
  const json = (await res.json().catch(() => ({ ok: false, description: 'invalid response' }))) as TgResponse<T>
  if (!json.ok || json.result === undefined) {
    throw new TelegramApiError(json.description ?? `HTTP ${res.status}`, method)
  }
  return json.result
}

export { tgRequest }

/**
 * Multipart/form-data Bot API call (for file uploads like sendPhoto).
 * Uses the same token resolution as tgRequest. Mock mode is handled by the
 * callers (same pattern as sendMessage/sendPhoto) so no external request is
 * ever made while simulating.
 * NOTE: no explicit Content-Type header — fetch sets the multipart boundary.
 */
export async function callTelegramApiForm<T = unknown>(
  method: string,
  form: FormData,
): Promise<T> {
  const chatId = String(form.get('chat_id') ?? '')
  if (chatId.startsWith('bale:')) {
    return callBaleApiForm<T>(method, form)
  }
  const token = await getBotToken()
  if (!token) throw new TelegramApiError('توکن ربات تنظیم نشده است', method)
  let res: Response
  try {
    res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: 'POST',
      body: form,
      signal: AbortSignal.timeout(30_000), // uploads may take longer than JSON calls
    })
  } catch (e) {
    throw new TelegramApiError(`network error: ${(e as Error).message}`, method)
  }
  const json = (await res.json().catch(() => ({ ok: false, description: 'invalid response' }))) as TgResponse<T>
  if (!json.ok || json.result === undefined) {
    throw new TelegramApiError(json.description ?? `HTTP ${res.status}`, method)
  }
  return json.result
}

// ─── Connection probe (used by the panel «تست اتصال» button) ────────────────

export type TelegramProbeCheck = {
  key: string
  label: string
  ok: boolean
  message: string
}

/**
 * Full connectivity self-check:
 *  - mock mode → config-completeness only (no external calls)
 *  - real mode → live Bot API probes: getMe, getChat(channel), getChatMember,
 *    getChat(admin chat). Each probe reports a Persian, user-actionable message.
 */
export async function probeTelegramConnection(): Promise<{
  ok: boolean
  mode: 'mock' | 'real'
  checks: TelegramProbeCheck[]
}> {
  const cfg = await getTelegramConfig()
  const checks: TelegramProbeCheck[] = []

  if (await isMockMode()) {
    checks.push({
      key: 'simulation',
      label: 'حالت شبیه‌سازی',
      ok: true,
      message:
        'شبیه‌سازی فعال است — پیام‌ها به‌صورت محلی ساخته می‌شوند و در لاگ همین بخش قابل مشاهده‌اند؛ هیچ درخواستی به تلگرام ارسال نمی‌شود',
    })
    checks.push({
      key: 'token',
      label: 'توکن ربات',
      ok: Boolean(cfg.botToken),
      message: cfg.botToken
        ? 'توکن تنظیم شده است؛ با ذخیره اتصال واقعی، ربات به‌صورت زنده بررسی می‌شود'
        : 'توکن ربات تنظیم نشده — برای اتصال واقعی، توکن را از @BotFather بگیرید و در فرم «اتصال ربات» وارد کنید',
    })
    checks.push({
      key: 'channel',
      label: 'شناسه کانال',
      ok: Boolean(cfg.channelId),
      message: cfg.channelId
        ? `شناسه کانال تنظیم شده (${cfg.channelId})`
        : 'شناسه کانال تنظیم نشده — بدون آن، انتشار محصولات در کانال کار نمی‌کند',
    })
    checks.push({
      key: 'adminChat',
      label: 'شناسه چت مدیر',
      ok: Boolean(cfg.adminChatId),
      message: cfg.adminChatId
        ? `شناسه چت مدیر تنظیم شده (${cfg.adminChatId})`
        : 'شناسه چت مدیر تنظیم نشده — اعلان سفارش‌های جدید برایتان ارسال نمی‌شود',
    })
    checks.push({
      key: 'botUsername',
      label: 'یوزرنیم ربات',
      ok: Boolean(cfg.botUsername),
      message: cfg.botUsername
        ? `یوزرنیم ربات تنظیم شده (@${cfg.botUsername}) — لینک مستقیم محصولات ساخته می‌شود`
        : 'یوزرنیم ربات تنظیم نشده — دکمه «خرید» زیر پست‌های کانال ساخته نمی‌شود',
    })
    return { ok: checks.every((c) => c.ok), mode: 'mock', checks }
  }

  // ── Real mode: live Bot API probes ────────────────────────────────────────
  let botId: number | null = null
  try {
    const me = await tgRequest<{ id: number; username?: string; first_name?: string }>('getMe', {})
    botId = me.id
    checks.push({
      key: 'token',
      label: 'توکن ربات',
      ok: true,
      message: `توکن معتبر است — ربات «${me.first_name ?? '?'}${me.username ? ` (@${me.username})` : ''}» پاسخ داد`,
    })
  } catch (e) {
    checks.push({
      key: 'token',
      label: 'توکن ربات',
      ok: false,
      message: `توکن نامعتبر است یا دسترسی به سرورهای تلگرام برقرار نشد: ${(e as Error).message}`,
    })
    return { ok: false, mode: 'real', checks }
  }

  if (cfg.channelId) {
    try {
      const chat = await tgRequest<{ title?: string; username?: string }>('getChat', {
        chat_id: cfg.channelId,
      })
      checks.push({
        key: 'channel',
        label: 'دسترسی به کانال',
        ok: true,
        message: `کانال «${chat.title ?? chat.username ?? cfg.channelId}» در دسترس ربات است`,
      })
      if (botId !== null) {
        try {
          const member = await tgRequest<{ status: string }>('getChatMember', {
            chat_id: cfg.channelId,
            user_id: botId,
          })
          const admin = member.status === 'administrator'
          checks.push({
            key: 'channelAdmin',
            label: 'مدیر بودن ربات در کانال',
            ok: admin,
            message: admin
              ? 'ربات مدیر کانال است و اجازه انتشار و ویرایش پست دارد'
              : `وضعیت ربات در کانال «${member.status}» است — برای انتشار پست، ربات باید «مدیر (administrator)» باشد`,
          })
        } catch (e) {
          checks.push({
            key: 'channelAdmin',
            label: 'مدیر بودن ربات در کانال',
            ok: false,
            message: `بررسی وضعیت ربات در کانال ناموفق بود: ${(e as Error).message}`,
          })
        }
      }
    } catch (e) {
      checks.push({
        key: 'channel',
        label: 'دسترسی به کانال',
        ok: false,
        message: `ربات نمی‌تواند کانال را ببیند — ربات را «مدیر» کانال کنید و شناسه کانال را بررسی کنید (${(e as Error).message})`,
      })
    }
  } else {
    checks.push({
      key: 'channel',
      label: 'دسترسی به کانال',
      ok: false,
      message: 'شناسه کانال تنظیم نشده است — انتشار محصولات به کانال کار نمی‌کند',
    })
  }

  if (cfg.adminChatId) {
    try {
      const chat = await tgRequest<{ first_name?: string; title?: string }>('getChat', {
        chat_id: cfg.adminChatId,
      })
      checks.push({
        key: 'adminChat',
        label: 'چت مدیر (اعلان‌ها)',
        ok: true,
        message: `چت مدیر «${chat.first_name ?? chat.title ?? cfg.adminChatId}» در دسترس است — اعلان سفارش‌ها به همین‌جا ارسال می‌شود`,
      })
    } catch (e) {
      checks.push({
        key: 'adminChat',
        label: 'چت مدیر (اعلان‌ها)',
        ok: false,
        message: `ربات به چت مدیر دسترسی ندارد — یک بار در تلگرام به ربات /start بدهید (${(e as Error).message})`,
      })
    }
  } else {
    checks.push({
      key: 'adminChat',
      label: 'چت مدیر (اعلان‌ها)',
      ok: false,
      message: 'شناسه چت مدیر تنظیم نشده است — اعلان سفارش‌ها ارسال نمی‌شود',
    })
  }

  checks.push({
    key: 'botUsername',
    label: 'یوزرنیم ربات',
    ok: Boolean(cfg.botUsername),
    message: cfg.botUsername
      ? `یوزرنیم ربات تنظیم شده (@${cfg.botUsername})`
      : 'یوزرنیم ربات تنظیم نشده — دکمه «خرید» زیر پست‌های کانال ساخته نمی‌شود',
  })

  return { ok: checks.every((c) => c.ok), mode: 'real', checks }
}

// ─── Mock transport (dev simulation — clearly labeled, recorded to ActivityLog) ──

function mockMessageId() {
  return 1000 + Math.floor(Math.random() * 89_000)
}

async function mockCall(
  method: string,
  chatId: string,
  payload: Record<string, unknown>,
): Promise<{ message_id?: number }> {
  const text = String(payload['text'] ?? payload['caption'] ?? '')
  const bale = chatId.startsWith('bale:')
  await logEvent(
    bale ? 'bale_out' : 'telegram_out',
    bale
      ? `[حالت شبیه‌سازی بله] ${method} → ${chatId.replace(/^bale:/, '')}`
      : `[حالت شبیه‌سازی] ${method} → ${chatId}`,
    { method, chatId, preview: text.slice(0, 600), payloadKeys: Object.keys(payload) },
  )
  if (method === 'sendMessage' || method === 'sendPhoto') {
    return { message_id: mockMessageId() }
  }
  return {}
}

/** Mock check per routed platform (bale-prefixed ids consult the Bale config). */
async function isMockForChat(chatId: string): Promise<boolean> {
  return chatId.startsWith('bale:') ? isBaleMockMode() : isMockMode()
}

// ─── Public helpers ──────────────────────────────────────────────────────────

let cachedBotUsername: string | null = null

export async function getBotUsername(): Promise<string> {
  if (cachedBotUsername) return cachedBotUsername
  const cfg = await getTelegramConfig()
  const fallback = cfg.botUsername || 'my_store_bot'
  if (await isMockMode()) {
    cachedBotUsername = fallback
    return fallback
  }
  try {
    const me = await tgRequest<{ username?: string }>('getMe', {})
    cachedBotUsername = me.username ?? fallback
  } catch {
    cachedBotUsername = fallback
  }
  return cachedBotUsername
}

export async function sendMessage(
  chatId: string,
  text: string,
  keyboard?: InlineButton[][],
): Promise<{ messageId: number | null }> {
  const payload = {
    chat_id: chatId,
    text,
    parse_mode: 'HTML',
    ...(keyboard?.length ? { reply_markup: { inline_keyboard: keyboard } } : {}),
  }
  if (await isMockForChat(chatId)) {
    const r = await mockCall('sendMessage', chatId, payload)
    return { messageId: r.message_id ?? null }
  }
  const result = await tgRequest<{ message_id: number }>('sendMessage', payload)
  await logEvent(
    chatId.startsWith('bale:') ? 'bale_out' : 'telegram_out',
    `پیام ارسال شد به ${chatId}`,
    {
      method: 'sendMessage',
      chatId,
      preview: text.slice(0, 300),
    },
  )
  return { messageId: result.message_id }
}

export async function sendPhoto(
  chatId: string,
  photoUrl: string,
  caption: string,
  keyboard?: InlineButton[][],
): Promise<{ messageId: number | null }> {
  const payload = {
    chat_id: chatId,
    photo: photoUrl,
    caption,
    parse_mode: 'HTML',
    ...(keyboard?.length ? { reply_markup: { inline_keyboard: keyboard } } : {}),
  }
  if (await isMockForChat(chatId)) {
    const r = await mockCall('sendPhoto', chatId, payload)
    return { messageId: r.message_id ?? null }
  }
  const result = await tgRequest<{ message_id: number }>('sendPhoto', payload)
  await logEvent(
    chatId.startsWith('bale:') ? 'bale_out' : 'telegram_out',
    `پست تصویری ارسال شد به ${chatId}`,
    {
      method: 'sendPhoto',
      chatId,
      preview: caption.slice(0, 300),
    },
  )
  return { messageId: result.message_id }
}

/**
 * sendPhoto with a local file buffer (multipart upload).
 * Used for relative /api/uploads/… product images that Telegram servers
 * cannot fetch by URL — the file is streamed from the local upload dir.
 */
export async function sendPhotoBuffer(
  chatId: string,
  buffer: Buffer,
  filename: string,
  caption: string,
  keyboard?: InlineButton[][],
): Promise<{ messageId: number | null }> {
  const payload = { caption, photo: `[file:${filename}]` }
  if (await isMockForChat(chatId)) {
    const r = await mockCall('sendPhoto', chatId, {
      ...payload,
      reply_markup: keyboard?.length ? { inline_keyboard: keyboard } : undefined,
    })
    return { messageId: r.message_id ?? null }
  }

  const form = new FormData()
  form.append('chat_id', chatId)
  form.append('caption', caption)
  form.append('parse_mode', 'HTML')
  if (keyboard?.length) {
    form.append('reply_markup', JSON.stringify({ inline_keyboard: keyboard }))
  }
  form.append('photo', new Blob([new Uint8Array(buffer)]), filename)

  const result = await callTelegramApiForm<{ message_id: number }>('sendPhoto', form)
  await logEvent('telegram_out', `پست تصویری (فایل محلی) ارسال شد به ${chatId}`, {
    method: 'sendPhoto',
    chatId,
    filename,
    preview: caption.slice(0, 300),
  })
  return { messageId: result.message_id }
}

/** Seller notification (order alerts etc.) — sent to EVERY connected platform. */
export async function sendSellerNotification(text: string, keyboard?: InlineButton[][]) {
  const chatId = await getAdminChatId()
  let any = false
  if (chatId) {
    try {
      await sendMessage(chatId, text, keyboard)
      any = true
    } catch (e) {
      await logEvent('telegram_error', `خطای ارسال اعلان به فروشنده: ${(e as Error).message}`, undefined, 'error')
    }
  } else {
    await logEvent('telegram_warn', 'ارسال اعلان به فروشنده ناموفق بود: شناسه چت مدیر تلگرام تنظیم نشده است — از بخش «تلگرام و ربات» پنل تنظیم کنید', { text: text.slice(0, 200) }, 'warn')
  }
  // Bale mirror — best-effort, only when a bale admin chat is configured
  try {
    const r = await sendBaleSellerNotification(text, keyboard)
    if (r.ok) any = true
  } catch {
    // best-effort
  }
  return { ok: any }
}

/** Direct message to a customer. Best-effort (user may have never started the bot). */
export async function notifyCustomer(telegramUserId: string, text: string, keyboard?: InlineButton[][]) {
  try {
    await sendMessage(telegramUserId, text, keyboard)
    return { ok: true }
  } catch (e) {
    await logEvent('telegram_error', `اطلاع‌رسانی به مشتری ${telegramUserId} ناموفق بود: ${(e as Error).message}`, undefined, 'warn')
    return { ok: false }
  }
}

// ─── Product → channel post lifecycle ────────────────────────────────────────

type TgProduct = RenderProduct & { id: string }

// ─── Product image resolution for channel posts ────────────────────────────

type ResolvedProductImage =
  | { kind: 'url'; url: string } // absolute http(s) — Telegram fetches it directly
  | { kind: 'buffer'; buffer: Buffer; filename: string } // local /api/uploads/… file

const UPLOAD_FILE_RE = /^[a-zA-Z0-9._-]+$/

/**
 * Resolves a product image for a channel post:
 *  a) absolute http(s) URL  → sent by reference
 *  b) relative /api/uploads/<name> → read from <cwd>/upload/<name> and uploaded
 *     as multipart (Telegram servers cannot reach local URLs)
 * Returns null (→ text-only post) when there is no image or the file is missing.
 */
async function resolveProductImage(url?: string | null): Promise<ResolvedProductImage | null> {
  if (!url) return null
  if (/^https?:\/\//i.test(url)) return { kind: 'url', url }

  const name = url.replace(/^\/api\/uploads\//, '')
  if (name && !name.includes('/') && !name.includes('..') && UPLOAD_FILE_RE.test(name)) {
    try {
      const buffer = await readFile(path.join(process.cwd(), 'upload', name))
      return { kind: 'buffer', buffer, filename: name }
    } catch {
      return null // file missing → graceful text-only fallback
    }
  }
  return null
}

async function publishOrSync(product: TgProduct, mode: 'publish' | 'sync') {
  // Dual-channel publish: every CONFIGURED channel gets the post — Telegram
  // first (its result keeps the legacy return shape), Bale second with a
  // `bale:`-prefixed mapping id so edits/unpublish route correctly.
  const settings = await getSettings()
  const currency = settings.currency === 'IRT' ? 'تومان' : settings.currency
  const tgCfg = await getTelegramConfig()
  const tgUsername = await getBotUsername()
  const baleCfg = await getBaleConfig()

  type Target = { platform: PostPlatform; channelId: string; botUsername: string }
  const targets: Target[] = []
  if (tgCfg.channelId) {
    targets.push({ platform: 'telegram', channelId: tgCfg.channelId, botUsername: tgUsername })
  }
  if (baleCfg.channelId) {
    targets.push({
      platform: 'bale',
      channelId: `bale:${baleCfg.channelId}`,
      botUsername: baleCfg.botUsername || 'my_store_bot',
    })
  }
  if (targets.length === 0) {
    throw new TelegramApiError('شناسه کانال تنظیم نشده است — از بخش «تلگرام و ربات» پنل تنظیم کنید', 'sendMessage')
  }

  const image = await resolveProductImage(product.imageUrl)
  let first: { messageId: number; channelId: string; unchanged: boolean } | null = null

  for (const t of targets) {
    const { text, keyboard } = renderProductPost(product, t.botUsername, currency, t.platform)
    const contentHash = hashContent(text, keyboard)
    const existing = await db.telegramProduct.findUnique({
      where: { productId_channelId: { productId: product.id, channelId: t.channelId } },
    })

    // Never create duplicate posts unnecessarily.
    if (existing && existing.lastContentHash === contentHash) {
      first ??= { messageId: existing.messageId, channelId: t.channelId, unchanged: true }
      continue
    }

    let messageId: number
    if (existing && mode === 'sync') {
      messageId = await editChannelPost(t.channelId, existing.messageId, text, keyboard, Boolean(image), product)
    } else {
      if (image?.kind === 'url') {
        const r = await sendPhoto(t.channelId, image.url, text, keyboard)
        messageId = r.messageId ?? mockMessageId()
      } else if (image?.kind === 'buffer') {
        const r = await sendPhotoBuffer(t.channelId, image.buffer, image.filename, text, keyboard)
        messageId = r.messageId ?? mockMessageId()
      } else {
        // No usable image → text-only post (never crashes).
        const r = await sendMessage(t.channelId, text, keyboard)
        messageId = r.messageId ?? mockMessageId()
      }
      await logEvent(
        t.platform === 'bale' ? 'bale.publish' : 'telegram.publish',
        `محصول «${product.name}» در ${t.platform === 'bale' ? 'کانال بله' : 'کانال'} منتشر شد`,
        {
          productId: product.id,
          channelId: t.channelId,
          messageId,
        },
      )
    }

    await db.telegramProduct.upsert({
      where: { productId_channelId: { productId: product.id, channelId: t.channelId } },
      create: { productId: product.id, channelId: t.channelId, messageId, lastContentHash: contentHash },
      update: { messageId, lastContentHash: contentHash, updatedAt: new Date() },
    })
    first ??= { messageId, channelId: t.channelId, unchanged: false }
  }

  if (!first) {
    // every target unchanged — report the primary mapping as-is
    const primary = targets[0]
    const row = await db.telegramProduct.findUnique({
      where: { productId_channelId: { productId: product.id, channelId: primary.channelId } },
    })
    first = { messageId: row?.messageId ?? 0, channelId: primary.channelId, unchanged: true }
  }
  return first
}

/** Publish = create a fresh channel post (or update if one already exists). */
export async function publishProductToChannel(product: TgProduct) {
  return publishOrSync(product, 'publish')
}

/**
 * Keep the existing channel post in sync (price/stock/status/name/…).
 * Best-effort: failures are logged, never thrown to callers.
 */
export async function syncProductPost(product: TgProduct): Promise<{ synced: boolean; reason?: string }> {
  try {
    const r = await publishOrSync(product, 'sync')
    if (r.unchanged) return { synced: false, reason: 'unchanged' }
    return { synced: true }
  } catch (e) {
    await logEvent(
      'telegram_error',
      `همگام‌سازی پست کانال برای «${product.name}» ناموفق بود: ${(e as Error).message}`,
      { productId: product.id },
      'error',
    )
    return { synced: false, reason: (e as Error).message }
  }
}

/** Remove EVERY platform's channel post + mappings. Best-effort. */
export async function unpublishProduct(product: TgProduct) {
  const mappings = await db.telegramProduct.findMany({ where: { productId: product.id } })
  for (const m of mappings) {
    if (!(await isMockForChat(m.channelId))) {
      await tgRequest('deleteMessage', { chat_id: m.channelId, message_id: m.messageId }).catch(
        async (e) => {
          await logEvent(
            m.channelId.startsWith('bale:') ? 'bale_error' : 'telegram_error',
            `حذف پست کانال ناموفق بود: ${(e as Error).message}`,
            { productId: product.id },
            'warn',
          )
        },
      )
    } else {
      await logEvent(
        m.channelId.startsWith('bale:') ? 'bale_out' : 'telegram_out',
        `[حالت شبیه‌سازی] deleteMessage → ${m.channelId}`,
        {
          method: 'deleteMessage',
          chatId: m.channelId,
          messageId: m.messageId,
        },
      )
    }
    await db.telegramProduct.delete({ where: { id: m.id } }).catch(() => undefined)
  }
  await logEvent('telegram.unpublish', `انتشار محصول «${product.name}» در کانال لغو شد`, { productId: product.id })
}

async function editChannelPost(
  channelId: string,
  messageId: number,
  text: string,
  keyboard: InlineButton[][],
  hasImage: boolean,
  product: TgProduct,
): Promise<number> {
  if (await isMockMode()) {
    await mockCall(hasImage ? 'editMessageCaption' : 'editMessageText', channelId, {
      text,
      message_id: messageId,
    })
    return messageId
  }
  const replyMarkup = { inline_keyboard: keyboard }
  // Replacement strategy when the content type must switch (text ↔ photo):
  // try the matching edit first, then the other one — a failed edit falls
  // through to the next attempt so the sync never crashes.
  const attempts: Array<() => Promise<unknown>> = hasImage
    ? [
        () =>
          tgRequest('editMessageCaption', {
            chat_id: channelId,
            message_id: messageId,
            caption: text,
            parse_mode: 'HTML',
            reply_markup: replyMarkup,
          }),
        () =>
          tgRequest('editMessageText', {
            chat_id: channelId,
            message_id: messageId,
            text,
            parse_mode: 'HTML',
            reply_markup: replyMarkup,
          }),
      ]
    : [
        () =>
          tgRequest('editMessageText', {
            chat_id: channelId,
            message_id: messageId,
            text,
            parse_mode: 'HTML',
            reply_markup: replyMarkup,
          }),
        () =>
          tgRequest('editMessageCaption', {
            chat_id: channelId,
            message_id: messageId,
            caption: text,
            parse_mode: 'HTML',
            reply_markup: replyMarkup,
          }),
      ]
  let lastErr: unknown
  for (const attempt of attempts) {
    try {
      await attempt()
      await logEvent('telegram.sync', `پست کانال برای «${product.name}» به‌روزرسانی شد`, {
        productId: product.id,
        messageId,
      })
      return messageId
    } catch (e) {
      lastErr = e
    }
  }
  throw lastErr
}

export function newId() {
  return crypto.randomBytes(12).toString('hex')
}
