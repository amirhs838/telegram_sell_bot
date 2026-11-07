import 'server-only'

import { db } from '@/lib/db'
import { logEvent } from '@/lib/logger'
import { getSettings, getTelegramConfig } from '@/lib/settings'
import { isMockMode, sendMessage, tgRequest } from '@/lib/telegram'
import { renderSilverRatePost } from '@/lib/telegram-render'

/**
 * Daily silver-rate channel publishing.
 *
 * Rules (Master prompt §14):
 *  - each NEW rate row gets its own post, published ONCE
 *  - re-publishing the SAME record EDITS the existing message — never a duplicate
 *  - rate persistence never depends on Telegram success; failures stay visible
 *    in the panel (publishStatus='failed' + Persian publishError) and can be retried
 *  - AI is never involved: the numbers are rendered straight from the DB record
 */
export type RatePublishResult = {
  ok: boolean
  status: 'published' | 'failed' | 'pending'
  messageId?: number | null
  error?: string
}

export async function publishSilverRate(rateId: string): Promise<RatePublishResult> {
  const rate = await db.silverRate.findUnique({ where: { id: rateId } })
  if (!rate) return { ok: false, status: 'failed', error: 'نرخ یافت نشد' }

  const cfg = await getTelegramConfig()
  const channelId = cfg.channelId
  const botUsername = cfg.botUsername || 'my_store_bot'

  // Channel not configured yet → keep pending (not failed); the seller can
  // connect the channel later and retry from the panel.
  if (!channelId) {
    return { ok: false, status: 'pending', error: 'شناسه کانال تنظیم نشده است' }
  }

  const settings = await getSettings()
  const timeZone = process.env.STORE_TIMEZONE || 'Asia/Tehran'
  const { text, keyboard } = renderSilverRatePost(
    rate,
    botUsername,
    settings.storeName || 'SILVER LOVE',
    timeZone,
  )

  try {
    let messageId: number
    if (rate.telegramMessageId && rate.telegramChannelId === channelId) {
      // same record already has a post → EDIT it (idempotent retry)
      if (await isMockMode()) {
        await logEvent(
          'telegram_out',
          `[حالت شبیه‌سازی] editMessageText → ${channelId} (پست نرخ)`,
          { messageId: rate.telegramMessageId, preview: text.slice(0, 400) },
        )
        messageId = rate.telegramMessageId
      } else {
        try {
          await tgRequest('editMessageText', {
            chat_id: channelId,
            message_id: rate.telegramMessageId,
            text,
            parse_mode: 'HTML',
            reply_markup: { inline_keyboard: keyboard },
          })
        } catch (e) {
          // Telegram rejects an edit whose content is IDENTICAL («message is not
          // modified») — that is exactly the idempotent-retry case → treat as done.
          const msg = e instanceof Error ? e.message : String(e)
          if (!msg.includes('message is not modified')) throw e
          await logEvent(
            'telegram.sync',
            'پست نرخ در کانال از قبل به‌روز است — بدون پست تکراری',
            { rateId: rate.id, messageId: rate.telegramMessageId },
          )
        }
        messageId = rate.telegramMessageId
      }
    } else {
      // fresh post for a new rate record
      const r = await sendMessage(channelId, text, keyboard)
      messageId = r.messageId ?? 0
    }

    const updated = await db.silverRate.update({
      where: { id: rate.id },
      data: {
        publishStatus: 'published',
        publishError: null,
        telegramMessageId: messageId || null,
        telegramChannelId: channelId,
        publishedAt: new Date(),
      },
    })
    await logEvent(
      'silver_rate.published',
      `پست نرخ روز نقره (${updated.ratePerGram.toLocaleString('fa-IR')} تومان) در کانال منتشر شد`,
      { rateId: rate.id, channelId, messageId },
    )
    return { ok: true, status: 'published', messageId }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
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
}
