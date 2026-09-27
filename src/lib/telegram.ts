import 'server-only'
import crypto from 'node:crypto'
import { db } from '@/lib/db'
import { logEvent } from '@/lib/logger'
import {
  renderProductPost,
  hashContent,
  type InlineButton,
  type RenderProduct,
} from '@/lib/telegram-render'
import {
  getSettings,
  getTelegramConfig,
  resetTelegramConfigCache,
} from '@/lib/settings'

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

async function tgRequest<T>(method: string, payload: unknown): Promise<T> {
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
  await logEvent(
    'telegram_out',
    `[حالت شبیه‌سازی] ${method} → ${chatId}`,
    { method, chatId, preview: text.slice(0, 600), payloadKeys: Object.keys(payload) },
  )
  if (method === 'sendMessage' || method === 'sendPhoto') {
    return { message_id: mockMessageId() }
  }
  return {}
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
  if (await isMockMode()) {
    const r = await mockCall('sendMessage', chatId, payload)
    return { messageId: r.message_id ?? null }
  }
  const result = await tgRequest<{ message_id: number }>('sendMessage', payload)
  await logEvent('telegram_out', `پیام ارسال شد به ${chatId}`, {
    method: 'sendMessage',
    chatId,
    preview: text.slice(0, 300),
  })
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
  if (await isMockMode()) {
    const r = await mockCall('sendPhoto', chatId, payload)
    return { messageId: r.message_id ?? null }
  }
  const result = await tgRequest<{ message_id: number }>('sendPhoto', payload)
  await logEvent('telegram_out', `پست تصویری ارسال شد به ${chatId}`, {
    method: 'sendPhoto',
    chatId,
    preview: caption.slice(0, 300),
  })
  return { messageId: result.message_id }
}

/** Seller notification (order alerts etc.). Best-effort — never throws. */
export async function sendSellerNotification(text: string, keyboard?: InlineButton[][]) {
  const chatId = await getAdminChatId()
  if (!chatId) {
    await logEvent('telegram_warn', 'ارسال اعلان به فروشنده ناموفق بود: شناسه چت مدیر تنظیم نشده است — از بخش «تلگرام و ربات» پنل تنظیم کنید', { text: text.slice(0, 200) }, 'warn')
    return { ok: false }
  }
  try {
    await sendMessage(chatId, text, keyboard)
    return { ok: true }
  } catch (e) {
    await logEvent('telegram_error', `خطای ارسال اعلان به فروشنده: ${(e as Error).message}`, undefined, 'error')
    return { ok: false }
  }
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

async function publishOrSync(product: TgProduct, mode: 'publish' | 'sync') {
  const channelId = await getChannelId()
  if (!channelId) {
    throw new TelegramApiError('شناسه کانال تنظیم نشده است — از بخش «تلگرام و ربات» پنل تنظیم کنید', 'sendMessage')
  }
  const settings = await getSettings()
  const botUsername = await getBotUsername()
  const { text, keyboard } = renderProductPost(product, botUsername, settings.currency === 'IRT' ? 'تومان' : settings.currency)
  const contentHash = hashContent(text, keyboard)

  const existing = await db.telegramProduct.findUnique({
    where: { productId_channelId: { productId: product.id, channelId } },
  })

  // Never create duplicate posts unnecessarily.
  if (existing && existing.lastContentHash === contentHash) {
    return { messageId: existing.messageId, channelId, unchanged: true }
  }

  let messageId: number
  if (existing && mode === 'sync') {
    messageId = await editChannelPost(existing.channelId, existing.messageId, text, keyboard, product)
  } else {
    const absImage = absoluteImageUrl(product.imageUrl)
    if (absImage) {
      const r = await sendPhoto(channelId, absImage, text, keyboard)
      messageId = r.messageId ?? mockMessageId()
    } else {
      const r = await sendMessage(channelId, text, keyboard)
      messageId = r.messageId ?? mockMessageId()
    }
    await logEvent('telegram.publish', `محصول «${product.name}» در کانال منتشر شد`, {
      productId: product.id,
      channelId,
      messageId,
    })
  }

  await db.telegramProduct.upsert({
    where: { productId_channelId: { productId: product.id, channelId } },
    create: { productId: product.id, channelId, messageId, lastContentHash: contentHash },
    update: { messageId, lastContentHash: contentHash, updatedAt: new Date() },
  })
  return { messageId, channelId, unchanged: false }
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

/** Remove the channel post + mapping. Best-effort. */
export async function unpublishProduct(product: TgProduct) {
  const channelId = await getChannelId()
  const mapping = await db.telegramProduct.findUnique({
    where: { productId_channelId: { productId: product.id, channelId: channelId || '-' } },
  }).catch(() => null)
  const m =
    mapping ??
    (await db.telegramProduct.findFirst({ where: { productId: product.id } }))
  if (m) {
    if (!(await isMockMode())) {
      await tgRequest('deleteMessage', { chat_id: m.channelId, message_id: m.messageId }).catch(
        async (e) => {
          await logEvent('telegram_error', `حذف پست کانال ناموفق بود: ${(e as Error).message}`, { productId: product.id }, 'warn')
        },
      )
    } else {
      await logEvent('telegram_out', `[حالت شبیه‌سازی] deleteMessage → ${m.channelId}`, {
        method: 'deleteMessage',
        chatId: m.channelId,
        messageId: m.messageId,
      })
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
  product: TgProduct,
): Promise<number> {
  if (await isMockMode()) {
    await mockCall(product.imageUrl ? 'editMessageCaption' : 'editMessageText', channelId, {
      text,
      message_id: messageId,
    })
    return messageId
  }
  const replyMarkup = { inline_keyboard: keyboard }
  const absImage = absoluteImageUrl(product.imageUrl)
  const attempts: Array<() => Promise<unknown>> = absImage
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

function absoluteImageUrl(url?: string | null): string | null {
  if (!url) return null
  // Only absolute http(s) URLs can be fetched by Telegram servers.
  if (/^https?:\/\//i.test(url)) return url
  return null
}

export function newId() {
  return crypto.randomBytes(12).toString('hex')
}
