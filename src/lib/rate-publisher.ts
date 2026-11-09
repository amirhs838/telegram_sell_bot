import 'server-only'

import { db } from '@/lib/db'
import { logEvent } from '@/lib/logger'
import { getSettings, getTelegramConfig, getBaleConfig } from '@/lib/settings'
import { isMockMode, sendMessage, tgRequest } from '@/lib/telegram'
import { isBaleMockMode } from '@/lib/bale'
import { renderSilverRatePost } from '@/lib/telegram-render'

/**
 * Daily silver-rate channel publishing — mirrored to BOTH messengers.
 *
 * Rules (Master prompt §14):
 *  - each NEW rate row gets its own post, published ONCE per platform
 *  - re-publishing the SAME record EDITS the existing message — never a duplicate
 *  - rate persistence never depends on messenger success; failures stay visible
 *    in the panel (publishStatus='failed' + Persian publishError) and can be retried
 *  - AI is never involved: the numbers are rendered straight from the DB record
 *
 * Bale gets the same post on the bale channel when configured (chat_id carries
 * the `bale:` routing prefix; text is converted to Bale Markdown at the
 * transport). Telegram stays the primary channel for the row's status fields.
 */
export type RatePublishResult = {
  ok: boolean
  status: 'published' | 'failed' | 'pending'
  messageId?: number | null
  error?: string
}

/** One platform's edit-or-create cycle for a rate post. Returns messageId. */
async function publishRateToChannel(args: {
  platform: 'telegram' | 'bale'
  channelId: string // raw id (bale WITHOUT prefix) — prefixed internally for bale
  existingMessageId: number | null
  existingChannelId: string | null
  rate: { id: string; telegramMessageId: number | null }
  text: string
  keyboard: { text: string; callback_data?: string; url?: string }[][]
}): Promise<number> {
  const { platform, channelId, existingMessageId, existingChannelId, rate, text, keyboard } = args
  const target = platform === 'bale' ? `bale:${channelId}` : channelId
  const samePost = existingMessageId && existingChannelId === channelId

  if (samePost) {
    // same record already has a post → EDIT it (idempotent retry)
    const mock = platform === 'bale' ? await isBaleMockMode() : await isMockMode()
    if (mock) {
      await logEvent(
        platform === 'bale' ? 'bale_out' : 'telegram_out',
        `[حالت شبیه‌سازی] editMessageText → ${target} (پست نرخ)`,
        { messageId: existingMessageId, preview: text.slice(0, 400) },
      )
      return existingMessageId
    }
    try {
      await tgRequest('editMessageText', {
        chat_id: target,
        message_id: existingMessageId,
        text,
        parse_mode: 'HTML',
        reply_markup: { inline_keyboard: keyboard },
      })
    } catch (e) {
      // Both APIs reject an edit whose content is IDENTICAL («message is not
      // modified») — that is exactly the idempotent-retry case → treat as done.
      const msg = e instanceof Error ? e.message : String(e)
      if (!msg.includes('message is not modified')) throw e
      await logEvent(
        platform === 'bale' ? 'bale.sync' : 'telegram.sync',
        'پست نرخ در کانال از قبل به‌روز است — بدون پست تکراری',
        { rateId: rate.id, messageId: existingMessageId },
      )
    }
    return existingMessageId
  }

  // fresh post for a new rate record
  const r = await sendMessage(target, text, keyboard)
  return r.messageId ?? 0
}

export async function publishSilverRate(rateId: string): Promise<RatePublishResult> {
  const rate = await db.silverRate.findUnique({ where: { id: rateId } })
  if (!rate) return { ok: false, status: 'failed', error: 'نرخ یافت نشد' }

  const tgCfg = await getTelegramConfig()
  const baleCfg = await getBaleConfig()
  const settings = await getSettings()
  const timeZone = process.env.STORE_TIMEZONE || 'Asia/Tehran'

  // Channel not configured yet → keep pending (not failed); the seller can
  // connect the channel later and retry from the panel.
  if (!tgCfg.channelId && !baleCfg.channelId) {
    return { ok: false, status: 'pending', error: 'شناسه کانال تنظیم نشده است' }
  }

  let primaryMessageId: number | null = null
  const errors: string[] = []

  // ── Telegram (primary; owns the row's publishStatus) ──────────────────────
  if (tgCfg.channelId) {
    const { text, keyboard } = renderSilverRatePost(
      rate,
      tgCfg.botUsername || 'my_store_bot',
      settings.storeName || 'SILVER LOVE',
      timeZone,
      'telegram',
    )
    try {
      const messageId = await publishRateToChannel({
        platform: 'telegram',
        channelId: tgCfg.channelId,
        existingMessageId: rate.telegramMessageId,
        existingChannelId: rate.telegramChannelId,
        rate,
        text,
        keyboard,
      })
      primaryMessageId = messageId
      await logEvent(
        'silver_rate.published',
        `پست نرخ روز نقره (${rate.ratePerGram.toLocaleString('fa-IR')} تومان) در کانال منتشر شد`,
        { rateId: rate.id, channelId: tgCfg.channelId, messageId },
      )
    } catch (e) {
      errors.push(`تلگرام: ${(e as Error).message}`)
    }
  }

  // ── Bale mirror (best-effort; never blocks the telegram result) ───────────
  let baleMessageId: number | null = rate.baleMessageId ?? null
  let baleChannelId: string | null = rate.baleChannelId
  if (baleCfg.channelId) {
    const { text, keyboard } = renderSilverRatePost(
      rate,
      baleCfg.botUsername || 'my_store_bot',
      settings.storeName || 'SILVER LOVE',
      timeZone,
      'bale',
    )
    try {
      const messageId = await publishRateToChannel({
        platform: 'bale',
        channelId: baleCfg.channelId,
        existingMessageId: rate.baleMessageId,
        existingChannelId: rate.baleChannelId,
        rate,
        text,
        keyboard,
      })
      baleMessageId = messageId
      baleChannelId = baleCfg.channelId
      await logEvent(
        'bale.publish',
        `پست نرخ روز نقره در کانال بله منتشر شد`,
        { rateId: rate.id, channelId: baleCfg.channelId, messageId },
      )
    } catch (e) {
      errors.push(`بله: ${(e as Error).message}`)
    }
  }

  // ── Persist state: published when the primary channel succeeded ───────────
  const primaryOk = primaryMessageId !== null || (!tgCfg.channelId && baleMessageId !== null)
  if (primaryOk) {
    const updated = await db.silverRate.update({
      where: { id: rate.id },
      data: {
        publishStatus: 'published',
        publishError: errors.length ? errors.join(' | ').slice(0, 500) : null,
        telegramMessageId: primaryMessageId ?? rate.telegramMessageId,
        telegramChannelId: tgCfg.channelId ?? rate.telegramChannelId,
        baleMessageId,
        baleChannelId,
        publishedAt: new Date(),
      },
    })
    if (errors.length) {
      await logEvent(
        'telegram_error',
        `انتشار پست نرخ ناقص بود: ${errors.join(' | ')}`,
        { rateId: rate.id },
        'warn',
      )
    }
    return { ok: true, status: 'published', messageId: updated.telegramMessageId }
  }

  const message = errors.join(' | ') || 'unknown error'
  await db.silverRate.update({
    where: { id: rate.id },
    data: { publishStatus: 'failed', publishError: message.slice(0, 500) },
  })
  await logEvent(
    'telegram_error',
    `انتشار پست نرخ نقره در کانال ناموفق بود: ${message}`,
    { rateId: rate.id },
    'error',
  )
  return { ok: false, status: 'failed', error: message }
}
