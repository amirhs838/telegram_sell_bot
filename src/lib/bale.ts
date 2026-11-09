/**
 * Panel-side Bale Bot API client — mirrors src/lib/telegram.ts.
 *
 * Bale's Bot API is a Telegram clone hosted at tapi.bale.ai (same payload
 * shapes, same {ok, result, description} envelope) with two differences:
 * no parse_mode (every message renders as Bale-flavored Markdown) and a
 * slightly smaller method list. Outgoing text/captions are converted from
 * the Telegram HTML this codebase emits, once, at the transport boundary.
 */
import 'server-only'
import { db } from '@/lib/db'
import { logEvent } from '@/lib/logger'
import { getBaleConfig, resetBaleConfigCache } from '@/lib/settings'

const BALE_API = 'https://tapi.bale.ai'

export async function isBaleMockMode() {
  const cfg = await getBaleConfig()
  if (cfg.dbConfigured) return false // explicit panel connection → always real
  return !cfg.botToken || process.env.BALE_MOCK === 'true'
}

export async function getBaleStatus() {
  const cfg = await getBaleConfig()
  return {
    botConfigured: Boolean(cfg.botToken),
    channelConfigured: Boolean(cfg.channelId),
    adminChatConfigured: Boolean(cfg.adminChatId),
    mockMode: await isBaleMockMode(),
    botUsername: cfg.botUsername || 'my_store_bot',
    source: cfg.dbConfigured ? ('panel' as const) : ('env' as const),
  }
}

/** Invalidate every in-process cache after a panel config change. */
export async function resetBaleCaches() {
  resetBaleConfigCache()
}

// ─── HTML → Bale-flavored Markdown (mirror of the bot-service converter) ─────

function stripTags(s: string): string {
  return s.replace(/<[^>]+>/g, '')
}

export function htmlToBale(html: string): string {
  let out = html
  out = out.replace(/<br\s*\/?>/gi, '\n')
  out = out.replace(
    /<a\s+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi,
    (_m, url: string, text: string) => {
      const label = stripTags(text).trim() || url
      return `[${label}](${url})`
    },
  )
  out = out.replace(/<(b|strong)>([\s\S]*?)<\/\1>/gi, (_m, _t, inner: string) => {
    const body = stripTags(inner).trim()
    return body ? ` *${body}* ` : ''
  })
  out = out.replace(/<(i|em)>([\s\S]*?)<\/\1>/gi, (_m, _t, inner: string) => {
    const body = stripTags(inner).trim()
    return body ? ` _${body}_ ` : ''
  })
  out = out.replace(/<(code|pre)>([\s\S]*?)<\/\1>/gi, (_m, _t, inner: string) => {
    return `\n\`\`\`\n${stripTags(inner).trim()}\n\`\`\`\n`
  })
  out = out.replace(/<blockquote>([\s\S]*?)<\/blockquote>/gi, (_m, inner: string) => {
    return `\n«${stripTags(inner).trim()}»\n`
  })
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

// ─── Low-level API ───────────────────────────────────────────────────────────

export class BaleApiError extends Error {
  constructor(
    message: string,
    public method: string,
  ) {
    super(message)
  }
}

type BaleResponse<T> = { ok: boolean; result?: T; description?: string }

/** Convert a payload for Bale: strip parse_mode, convert HTML text/caption. */
function forBale(payload: Record<string, unknown>): Record<string, unknown> {
  const body = { ...payload }
  delete body['parse_mode']
  delete body['disable_web_page_preview']
  if (typeof body['text'] === 'string') body['text'] = htmlToBale(body['text'])
  if (typeof body['caption'] === 'string') body['caption'] = htmlToBale(body['caption'])
  return body
}

/**
 * JSON Bot API call. Accepts an optional explicit token (panel verification
 * before a connection is saved); otherwise uses the stored config.
 */
export async function baleRequest<T>(
  method: string,
  payload: unknown,
  explicitToken?: string,
): Promise<T> {
  const token = explicitToken ?? (await getBaleConfig()).botToken
  if (!token) throw new BaleApiError('توکن ربات بله تنظیم نشده است', method)
  let res: Response
  try {
    res = await fetch(`${BALE_API}/bot${token}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(forBale((payload ?? {}) as Record<string, unknown>)),
      signal: AbortSignal.timeout(12_000),
    })
  } catch (e) {
    throw new BaleApiError(`network error: ${(e as Error).message}`, method)
  }
  const json = (await res.json().catch(() => ({ ok: false, description: 'invalid response' }))) as BaleResponse<T>
  if (!json.ok || json.result === undefined) {
    throw new BaleApiError(json.description ?? `HTTP ${res.status}`, method)
  }
  return json.result
}

/**
 * Multipart/form-data Bot API call (file uploads like sendPhoto).
 * NOTE: no explicit Content-Type header — fetch sets the multipart boundary.
 */
export async function callBaleApiForm<T = unknown>(
  method: string,
  form: FormData,
  explicitToken?: string,
): Promise<T> {
  const token = explicitToken ?? (await getBaleConfig()).botToken
  if (!token) throw new BaleApiError('توکن ربات بله تنظیم نشده است', method)
  const caption = form.get('caption')
  if (typeof caption === 'string') form.set('caption', htmlToBale(caption))
  let res: Response
  try {
    res = await fetch(`${BALE_API}/bot${token}/${method}`, {
      method: 'POST',
      body: form,
      signal: AbortSignal.timeout(30_000), // uploads may take longer than JSON calls
    })
  } catch (e) {
    throw new BaleApiError(`network error: ${(e as Error).message}`, method)
  }
  const json = (await res.json().catch(() => ({ ok: false, description: 'invalid response' }))) as BaleResponse<T>
  if (!json.ok || json.result === undefined) {
    throw new BaleApiError(json.description ?? `HTTP ${res.status}`, method)
  }
  return json.result
}

// ─── Connection probe (used by the panel «تست اتصال» button) ────────────────

export type BaleProbeCheck = {
  key: string
  label: string
  ok: boolean
  message: string
}

export async function probeBaleConnection(): Promise<{
  ok: boolean
  mode: 'mock' | 'real'
  checks: BaleProbeCheck[]
}> {
  const cfg = await getBaleConfig()
  const checks: BaleProbeCheck[] = []

  if (await isBaleMockMode()) {
    checks.push({
      key: 'simulation',
      label: 'حالت شبیه‌سازی',
      ok: true,
      message:
        'شبیه‌سازی فعال است — پیام‌ها به‌صورت محلی ساخته می‌شوند و در لاگ همین بخش قابل مشاهده‌اند؛ هیچ درخواستی به بله ارسال نمی‌شود',
    })
    checks.push({
      key: 'token',
      label: 'توکن ربات',
      ok: Boolean(cfg.botToken),
      message: cfg.botToken
        ? 'توکن تنظیم شده است؛ با ذخیره اتصال واقعی، ربات به‌صورت زنده بررسی می‌شود'
        : 'توکن ربات تنظیم نشده — برای اتصال واقعی، توکن را از @BotFather در خود بله بگیرید و در فرم «اتصال ربات بله» وارد کنید',
    })
    checks.push({
      key: 'channel',
      label: 'شناسه کانال',
      ok: Boolean(cfg.channelId),
      message: cfg.channelId
        ? `شناسه کانال تنظیم شده (${cfg.channelId})`
        : 'شناسه کانال تنظیم نشده — بدون آن، انتشار محصولات در کانال بله کار نمی‌کند',
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
    const me = await baleRequest<{ id: number; username?: string; first_name?: string }>('getMe', {})
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
      message: `توکن نامعتبر است یا دسترسی به سرورهای بله برقرار نشد: ${(e as Error).message}`,
    })
    return { ok: false, mode: 'real', checks }
  }

  if (cfg.channelId) {
    try {
      const chat = await baleRequest<{ title?: string; username?: string }>('getChat', {
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
          const member = await baleRequest<{ status: string }>('getChatMember', {
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
      message: 'شناسه کانال تنظیم نشده است — انتشار محصولات به کانال بله کار نمی‌کند',
    })
  }

  if (cfg.adminChatId) {
    try {
      const chat = await baleRequest<{ first_name?: string; title?: string }>('getChat', {
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
        message: `ربات به چت مدیر دسترسی ندارد — یک بار در بله به ربات /start بدهید (${(e as Error).message})`,
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

function baleMockMessageId() {
  return 1000 + Math.floor(Math.random() * 89_000)
}

async function baleMockCall(
  method: string,
  chatId: string,
  payload: Record<string, unknown>,
): Promise<{ message_id?: number }> {
  const text = String(payload['text'] ?? payload['caption'] ?? '')
  await logEvent(
    'bale_out',
    `[حالت شبیه‌سازی بله] ${method} → ${chatId}`,
    { method, chatId, preview: text.slice(0, 600), payloadKeys: Object.keys(payload) },
  )
  if (method === 'sendMessage' || method === 'sendPhoto') {
    return { message_id: baleMockMessageId() }
  }
  return {}
}

// ─── Public helpers (bale-prefixed chat ids) ──────────────────────────────────

/**
 * Send a message on Bale. `chatId` may carry the `bale:` routing prefix —
 * it is stripped here before the API call.
 */
export async function sendBaleMessage(
  chatId: string,
  text: string,
  keyboard?: { text: string; callback_data?: string; url?: string }[][],
): Promise<{ messageId: number | null }> {
  const target = chatId.replace(/^bale:/, '')
  const payload = {
    chat_id: target,
    text,
    ...(keyboard?.length ? { reply_markup: { inline_keyboard: keyboard } } : {}),
  }
  if (await isBaleMockMode()) {
    const r = await baleMockCall('sendMessage', target, payload)
    return { messageId: r.message_id ?? null }
  }
  const result = await baleRequest<{ message_id: number }>('sendMessage', payload)
  await logEvent('bale_out', `پیام بله ارسال شد به ${target}`, {
    method: 'sendMessage',
    chatId: target,
    preview: text.slice(0, 300),
  })
  return { messageId: result.message_id }
}

/** Direct message to a Bale customer. Best-effort (never throws). */
export async function notifyBaleCustomer(telegramUserId: string, text: string, keyboard?: { text: string; callback_data?: string; url?: string }[][]) {
  try {
    await sendBaleMessage(telegramUserId, text, keyboard)
    return { ok: true }
  } catch (e) {
    await logEvent('bale_error', `اطلاع‌رسانی به مشتری بله ${telegramUserId} ناموفق بود: ${(e as Error).message}`, undefined, 'warn')
    return { ok: false }
  }
}

/** Seller notification on Bale (order alerts etc.). Best-effort — never throws. */
export async function sendBaleSellerNotification(text: string, keyboard?: { text: string; callback_data?: string; url?: string }[][]) {
  const chatId = (await getBaleConfig()).adminChatId
  if (!chatId) return { ok: false }
  try {
    await sendBaleMessage(chatId, text, keyboard)
    return { ok: true }
  } catch (e) {
    await logEvent('bale_error', `خطای ارسال اعلان بله به فروشنده: ${(e as Error).message}`, undefined, 'error')
    return { ok: false }
  }
}
