import type { SilverRate } from '@prisma/client'

/** Shared serialization for SilverRate rows (contract for the panel UI). */
export function serializeRate(r: SilverRate) {
  return {
    id: r.id,
    ratePerGram: r.ratePerGram,
    unit: r.unit,
    note: r.note,
    active: r.active,
    createdBy: r.createdBy,
    createdByName: r.createdByName,
    createdAt: r.createdAt,
    // channel publishing state (daily rate post)
    publishStatus: r.publishStatus,
    telegramMessageId: r.telegramMessageId,
    telegramChannelId: r.telegramChannelId,
    publishError: r.publishError,
    publishedAt: r.publishedAt,
  }
}
