import type { NextRequest } from 'next/server'
import { z } from 'zod'
import { ok, readJson, requireAuth, route } from '@/lib/api'
import { logEvent } from '@/lib/logger'
import { getSettings, updateSettings } from '@/lib/settings'
import { getTelegramStatus } from '@/lib/telegram'
import { db } from '@/lib/db'
import { userApiKey, geminiEnvKey, invalidateGeminiSettingCache } from '@/lib/ai/provider'

export const GET = route(async () => {
  await requireAuth()
  const settings = await getSettings()
  // AI key status (never the key itself): env key wins, then the panel-pasted copy.
  let keySource: 'env' | 'panel' | 'none' = 'none'
  if (userApiKey()) keySource = 'env'
  else {
    const row = await db.setting
      .findUnique({ where: { key: 'zaiApiKey' }, select: { value: true } })
      .catch(() => null)
    if (row?.value?.trim()) keySource = 'panel'
  }
  // Gemini (owner-requested default brain) — same write-only pattern.
  let geminiKeySource: 'env' | 'panel' | 'none' = 'none'
  if (geminiEnvKey()) geminiKeySource = 'env'
  else {
    const row = await db.setting
      .findUnique({ where: { key: 'geminiApiKey' }, select: { value: true } })
      .catch(() => null)
    if (row?.value?.trim()) geminiKeySource = 'panel'
  }
  return ok({ settings, telegram: await getTelegramStatus(), ai: { keySource, geminiKeySource } })
})

// Boolean-ish: accepts real booleans or 'true'/'false' strings from forms.
const booleanish = z
  .union([z.boolean(), z.string()])
  .transform((v) => (typeof v === 'boolean' ? v : v.trim().toLowerCase() === 'true'))

const patchSchema = z.object({
  storeName: z.string().trim().min(1, 'نام فروشگاه نمی‌تواند خالی باشد').max(100).optional(),
  storeDescription: z.string().max(1000).optional(),
  supportUsername: z
    .string()
    .trim()
    .max(100)
    .regex(/^@?[a-zA-Z0-9_]*$/, 'یوزرنیم تلگرام معتبر نیست')
    .optional(),
  // پیام خوش‌آمدگویی /start ربات — قالب آزاد با متغیرهای {name} و {store}
  welcomeMessage: z.string().max(2000, 'متن خوش‌آمد حداکثر ۲۰۰۰ کاراکتر است').optional(),
  aiEnabled: booleanish.optional(),
  aiTone: z.string().trim().max(1000, 'لحن هوش مصنوعی حداکثر ۱۰۰۰ کاراکتر است').optional(),
  // Z.ai seller key (Tier B) — write-only; GET never returns it
  zaiApiKey: z.string().trim().min(20, 'کلید واردشده کوتاه به نظر می‌رسد').max(200).optional(),
  zaiApiKeyClear: z.boolean().optional(),
  // Gemini key (Tier A — owner-requested default brain) — write-only; GET never returns it.
  // Accepts MULTIPLE keys separated by commas/newlines: the image studio rotates
  // them to multiply the free daily image quota of each AI Studio project.
  geminiApiKey: z.string().trim().min(20, 'کلید واردشده کوتاه به نظر می‌رسد').max(1000).optional(),
  geminiApiKeyClear: z.boolean().optional(),
})

export const PUT = route(async (req: NextRequest) => {
  await requireAuth()
  const patch = patchSchema.parse(await readJson(req))

  // Secret handled outside updateSettings (never part of the generic store).
  const { zaiApiKey, zaiApiKeyClear, geminiApiKey, geminiApiKeyClear, ...rest } = patch
  if (zaiApiKeyClear) {
    await db.setting.deleteMany({ where: { key: 'zaiApiKey' } })
    await logEvent('settings.updated', 'کلید هوش مصنوعی از پنل حذف شد', { keys: ['zaiApiKey'] })
  }
  if (zaiApiKey !== undefined) {
    await db.setting.upsert({
      where: { key: 'zaiApiKey' },
      create: { key: 'zaiApiKey', value: zaiApiKey },
      update: { value: zaiApiKey },
    })
    await logEvent('settings.updated', 'کلید هوش مصنوعی از پنل ذخیره شد', { keys: ['zaiApiKey'] })
  }
  if (geminiApiKeyClear) {
    await db.setting.deleteMany({ where: { key: 'geminiApiKey' } })
    invalidateGeminiSettingCache()
    await logEvent('settings.updated', 'کلید جمنای از پنل حذف شد', { keys: ['geminiApiKey'] })
  }
  if (geminiApiKey !== undefined) {
    await db.setting.upsert({
      where: { key: 'geminiApiKey' },
      create: { key: 'geminiApiKey', value: geminiApiKey },
      update: { value: geminiApiKey },
    })
    invalidateGeminiSettingCache()
    await logEvent('settings.updated', 'کلید جمنای از پنل ذخیره شد', { keys: ['geminiApiKey'] })
  }

  const settings = await updateSettings(rest)
  return ok({ settings })
})
