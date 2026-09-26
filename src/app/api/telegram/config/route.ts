import { z } from 'zod'
import { ok, readJson, requireAuth, route } from '@/lib/api'
import { logEvent } from '@/lib/logger'
import {
  TelegramApiError,
  getTelegramStatus,
  resetTelegramCaches,
} from '@/lib/telegram'
import {
  deleteTelegramConfig,
  getTelegramConfig,
  updateTelegramConfig,
} from '@/lib/settings'

// ─── GET: current telegram connection (token masked, never returned in full) ──

export const GET = route(async () => {
  await requireAuth()
  const status = await getTelegramStatus()
  const cfg = await getTelegramConfig()
  return ok({
    source: status.source,
    mockMode: status.mockMode,
    botUsername: cfg.botUsername,
    channelId: cfg.channelId,
    adminChatId: cfg.adminChatId,
    // Masked preview only — the full token never leaves the server.
    botTokenMasked: cfg.botToken ? `••••••${cfg.botToken.slice(-4)}` : null,
  })
})

// ─── PUT: save connection from the panel (with best-effort live verification) ─

const configSchema = z.object({
  botToken: z
    .string()
    .trim()
    .regex(/^\d{6,}:[A-Za-z0-9_-]{25,}$/, 'قالب توکن ربات معتبر نیست — توکن از @BotFather چیزی شبیه «123456789:AAE…» است'),
  channelId: z
    .string()
    .trim()
    .regex(/^(-?\d{5,}|@[\w]{3,64})$/, 'شناسه کانال باید عددی مثل ‎-1001234567890 یا یوزرنیم کانال مثل @mychannel باشد'),
  adminChatId: z
    .string()
    .trim()
    .regex(/^-?\d{3,}$/, 'شناسه چت مدیر باید عددی باشد (مثلاً 123456789)'),
  botUsername: z
    .string()
    .trim()
    .transform((v) => v.replace(/^@/, ''))
    .pipe(z.string().regex(/^[A-Za-z0-9_]{3,64}$/, 'یوزرنیم ربات فقط حروف انگلیسی، عدد و زیرخط است (بدون @)')),
})

type CheckResult = { key: string; label: string; ok: boolean; message: string }

async function tgCall<T>(token: string, method: string, payload: Record<string, unknown>): Promise<T> {
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(8_000),
  })
  const json = (await res.json().catch(() => null)) as { ok: boolean; result?: T; description?: string } | null
  if (!json || !json.ok) {
    throw new TelegramApiError(json?.description ?? `HTTP ${res.status}`, method)
  }
  return json.result as T
}

export const PUT = route(async (req) => {
  await requireAuth()

  const body = configSchema.parse(await readJson(req))

  // Save first — the seller keeps their input even if live verification is
  // impossible right now (e.g. no outbound network). Verification results
  // are reported back as warnings, never silently swallowed.
  await updateTelegramConfig({
    botToken: body.botToken,
    channelId: body.channelId,
    adminChatId: body.adminChatId,
    botUsername: body.botUsername,
  })
  await resetTelegramCaches()

  const warnings: string[] = []
  const checks: CheckResult[] = []

  // Live verification against the real Bot API (best-effort, 8s each).
  try {
    const me = await tgCall<{ id: number; username?: string; first_name?: string }>(body.botToken, 'getMe', {})
    checks.push({
      key: 'bot',
      label: 'ربات',
      ok: true,
      message: `ربات «${me.first_name ?? me.username ?? '?'}» شناسایی شد`,
    })
    if (me.username && me.username !== body.botUsername) {
      warnings.push(`یوزرنیم واقعی ربات «@${me.username}» است و به‌جای مقدار وارد‌شده ذخیره شد`)
      await updateTelegramConfig({ botUsername: me.username })
      await resetTelegramCaches()
    }
  } catch (e) {
    const msg = (e as Error).message
    checks.push({ key: 'bot', label: 'ربات', ok: false, message: `تأیید توکن ناموفق بود: ${msg}` })
    warnings.push(
      msg.includes('Unauthorized') || msg.includes('401') || msg.includes('Not Found')
        ? 'توکن ربات نامعتبر است — دوباره از @BotFather بررسی کنید'
        : 'دسترسی به سرورهای تلگرام برقرار نشد؛ توکن ذخیره شد ولی «تست اتصال» را بعداً امتحان کنید',
    )
  }

  try {
    const chat = await tgCall<{ title?: string; username?: string }>(body.botToken, 'getChat', { chat_id: body.channelId })
    checks.push({
      key: 'channel',
      label: 'کانال',
      ok: true,
      message: `کانال «${chat.title ?? chat.username ?? body.channelId}» در دسترس است`,
    })
  } catch (e) {
    checks.push({ key: 'channel', label: 'کانال', ok: false, message: `کانال تأیید نشد: ${(e as Error).message}` })
    warnings.push(
      'کانال تأیید نشد — مطمئن شوید ربات «مدیر» کانال است و شناسه کانال درست است (کانال خصوصی: عدد ‎-100…)',
    )
  }

  try {
    const chat = await tgCall<{ first_name?: string; title?: string }>(body.botToken, 'getChat', {
      chat_id: body.adminChatId,
    })
    checks.push({
      key: 'admin',
      label: 'چت مدیر',
      ok: true,
      message: `چت «${chat.first_name ?? chat.title ?? body.adminChatId}» در دسترس است`,
    })
  } catch (e) {
    checks.push({ key: 'admin', label: 'چت مدیر', ok: false, message: `چت مدیر تأیید نشد: ${(e as Error).message}` })
    warnings.push(
      'چت مدیر تأیید نشد — یک‌بار به ربات خودتان /start بدهید تا بتواند اعلان سفارش‌ها را برایتان بفرستد',
    )
  }

  await logEvent(
    'telegram.config_updated',
    'اتصال ربات و کانال تلگرام از پنل ذخیره شد',
    { verified: checks.filter((c) => c.ok).length, total: checks.length },
  )

  return ok({ ok: true, checks, warnings })
})

// ─── DELETE: disconnect (remove panel config → env / mock fallback) ──────────

export const DELETE = route(async () => {
  await requireAuth()
  await deleteTelegramConfig()
  await resetTelegramCaches()
  await logEvent('telegram.config_removed', 'اتصال ربات و کانال تلگرام از پنل حذف شد')
  const status = await getTelegramStatus()
  return ok({ ok: true, status })
})
