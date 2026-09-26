import { db } from '@/lib/db'

export type StoreSettings = {
  storeName: string
  storeDescription: string
  supportUsername: string
  currency: string
}

const DEFAULTS: StoreSettings = {
  storeName: 'فروشگاه تلگرامی من',
  storeDescription: 'به فروشگاه ما خوش آمدید — خرید راحت از طریق تلگرام',
  supportUsername: '',
  currency: 'IRT',
}

export const SETTING_KEYS = [
  'storeName',
  'storeDescription',
  'supportUsername',
  'currency',
] as const

export async function getSettings(): Promise<StoreSettings> {
  const rows = await db.setting.findMany({
    where: { key: { in: [...SETTING_KEYS] } },
  })
  const map = Object.fromEntries(rows.map((r) => [r.key, r.value]))
  return {
    storeName: map['storeName'] ?? DEFAULTS.storeName,
    storeDescription: map['storeDescription'] ?? DEFAULTS.storeDescription,
    supportUsername: map['supportUsername'] ?? DEFAULTS.supportUsername,
    currency: map['currency'] ?? DEFAULTS.currency,
  }
}

export async function updateSettings(patch: Partial<StoreSettings>): Promise<StoreSettings> {
  const entries = Object.entries(patch).filter(([k]) =>
    (SETTING_KEYS as readonly string[]).includes(k),
  )
  for (const [key, value] of entries) {
    await db.setting.upsert({
      where: { key },
      create: { key, value: String(value ?? '') },
      update: { value: String(value ?? '') },
    })
  }
  return getSettings()
}

// ---------------------------------------------------------------------------
// Telegram runtime config — DB-first (panel connection) with env fallback.
// The seller connects their bot/channel from the admin panel; values are stored
// in the Setting table and take priority over environment variables.
// ---------------------------------------------------------------------------

export type TelegramRuntimeConfig = {
  botToken: string
  channelId: string
  adminChatId: string
  botUsername: string
  /** true when the token comes from the panel (DB) rather than env */
  dbConfigured: boolean
}

export const TELEGRAM_SETTING_KEYS = [
  'telegramBotToken',
  'telegramChannelId',
  'telegramAdminChatId',
  'telegramBotUsername',
] as const

// Short-lived cache — the config is read on every send/publish; a 5s TTL keeps
// it fresh for panel updates while avoiding redundant DB reads.
let tgCache: { at: number; value: TelegramRuntimeConfig } | null = null

function envTelegramConfig(): TelegramRuntimeConfig {
  return {
    botToken: (process.env.TELEGRAM_BOT_TOKEN ?? '').trim(),
    channelId: (process.env.TELEGRAM_CHANNEL_ID ?? '').trim(),
    adminChatId: (process.env.TELEGRAM_ADMIN_CHAT_ID ?? '').trim(),
    botUsername: (process.env.TELEGRAM_BOT_USERNAME ?? '').trim(),
    dbConfigured: false,
  }
}

export async function getTelegramConfig(): Promise<TelegramRuntimeConfig> {
  if (tgCache && Date.now() - tgCache.at < 5_000) return tgCache.value
  const env = envTelegramConfig()
  let value = env
  try {
    const rows = await db.setting.findMany({
      where: { key: { in: [...TELEGRAM_SETTING_KEYS] } },
    })
    const map = Object.fromEntries(rows.map((r) => [r.key, r.value]))
    const dbToken = (map['telegramBotToken'] ?? '').trim()
    value = {
      botToken: dbToken || env.botToken,
      channelId: (map['telegramChannelId'] ?? '').trim() || env.channelId,
      adminChatId: (map['telegramAdminChatId'] ?? '').trim() || env.adminChatId,
      botUsername: (map['telegramBotUsername'] ?? '').trim() || env.botUsername,
      dbConfigured: Boolean(dbToken),
    }
  } catch {
    // DB unavailable → fall back to env silently
  }
  tgCache = { at: Date.now(), value }
  return value
}

/** Force the next getTelegramConfig() to re-read from the DB. */
export function resetTelegramConfigCache() {
  tgCache = null
}

/** Runtime field name → Setting table key */
const TELEGRAM_FIELD_TO_KEY: Record<string, (typeof TELEGRAM_SETTING_KEYS)[number]> = {
  botToken: 'telegramBotToken',
  channelId: 'telegramChannelId',
  adminChatId: 'telegramAdminChatId',
  botUsername: 'telegramBotUsername',
}

export async function updateTelegramConfig(
  patch: Partial<Omit<TelegramRuntimeConfig, 'dbConfigured'>>,
): Promise<TelegramRuntimeConfig> {
  const entries = Object.entries(patch)
    .filter(([k, v]) => v !== undefined && k in TELEGRAM_FIELD_TO_KEY)
    .map(([k, v]) => [TELEGRAM_FIELD_TO_KEY[k], String(v).trim()] as const)
  for (const [key, value] of entries) {
    await db.setting.upsert({
      where: { key },
      create: { key, value },
      update: { value },
    })
  }
  resetTelegramConfigCache()
  return getTelegramConfig()
}

/** Remove panel-stored telegram config (falls back to env / mock mode). */
export async function deleteTelegramConfig(): Promise<void> {
  await db.setting.deleteMany({
    where: { key: { in: [...TELEGRAM_SETTING_KEYS] } },
  })
  resetTelegramConfigCache()
}
