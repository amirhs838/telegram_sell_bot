import type { NextRequest } from 'next/server'
import { z } from 'zod'
import { ok, readJson, requireAuth, route } from '@/lib/api'
import { logEvent } from '@/lib/logger'
import { getSettings, updateSettings } from '@/lib/settings'
import { getTelegramStatus } from '@/lib/telegram'
import { db } from '@/lib/db'
import {
  userApiKey,
  openRouterEnvKey,
  invalidateOpenRouterSettingCache,
  invalidateAiModelCache,
  resolveAiModels,
} from '@/lib/ai/provider'

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
  // OpenRouter (owner-requested primary brain + image engine) — same write-only pattern.
  let openRouterKeySource: 'env' | 'panel' | 'none' = 'none'
  if (openRouterEnvKey()) openRouterKeySource = 'env'
  else {
    const row = await db.setting
      .findUnique({ where: { key: 'openRouterApiKey' }, select: { value: true } })
      .catch(() => null)
    if (row?.value?.trim()) openRouterKeySource = 'panel'
  }
  const models = await resolveAiModels()
  return ok({
    settings,
    telegram: await getTelegramStatus(),
    ai: {
      keySource,
      openRouterKeySource,
      textModel: models.text,
      imageModel: models.image,
    },
  })
})

// Boolean-ish: accepts real booleans or 'true'/'false' strings from forms.
const booleanish = z
  .union([z.boolean(), z.string()])
  .transform((v) => (typeof v === 'boolean' ? v : v.trim().toLowerCase() === 'true'))

/** OpenRouter model slug: vendor/model with optional :variant suffix. */
const modelSlug = z
  .string()
  .trim()
  .max(200, 'نام مدل حداکثر ۲۰۰ کاراکتر است')
  .refine(
    (v) => v === '' || /^[a-zA-Z0-9._/-]+(:[a-zA-Z0-9._-]+)?$/.test(v),
    'قالب نام مدل درست نیست — مثال: openai/gpt-4o-mini یا google/gemini-nano-banana-2.1',
  )

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
  // Z.ai seller key (Tier B fallback) — write-only; GET never returns it
  zaiApiKey: z.string().trim().min(20, 'کلید واردشده کوتاه به نظر می‌رسد').max(200).optional(),
  zaiApiKeyClear: z.boolean().optional(),
  // OpenRouter key (owner-requested primary) — write-only; GET never returns it.
  openRouterApiKey: z.string().trim().min(20, 'کلید واردشده کوتاه به نظر می‌رسد').max(300).optional(),
  openRouterApiKeyClear: z.boolean().optional(),
  // Configured models — empty string resets to the default.
  aiTextModel: modelSlug.optional(),
  aiImageModel: modelSlug.optional(),
})

export const PUT = route(async (req: NextRequest) => {
  await requireAuth()
  const patch = patchSchema.parse(await readJson(req))

  // Secrets handled outside updateSettings (never part of the generic store).
  const {
    zaiApiKey,
    zaiApiKeyClear,
    openRouterApiKey,
    openRouterApiKeyClear,
    aiTextModel,
    aiImageModel,
    ...rest
  } = patch

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

  if (openRouterApiKeyClear) {
    await db.setting.deleteMany({ where: { key: 'openRouterApiKey' } })
    invalidateOpenRouterSettingCache()
    await logEvent('settings.updated', 'کلید OpenRouter از پنل حذف شد', { keys: ['openRouterApiKey'] })
  }
  if (openRouterApiKey !== undefined) {
    await db.setting.upsert({
      where: { key: 'openRouterApiKey' },
      create: { key: 'openRouterApiKey', value: openRouterApiKey },
      update: { value: openRouterApiKey },
    })
    invalidateOpenRouterSettingCache()
    await logEvent('settings.updated', 'کلید OpenRouter از پنل ذخیره شد', {
      keys: ['openRouterApiKey'],
    })
  }

  // Models are plain (non-secret) Setting rows; empty value = reset to default.
  for (const [field, key, label] of [
    [aiTextModel, 'aiTextModel', 'مدل متن'],
    [aiImageModel, 'aiImageModel', 'مدل تصویر'],
  ] as const) {
    if (field === undefined) continue
    if (field === '') {
      await db.setting.deleteMany({ where: { key } })
    } else {
      await db.setting.upsert({
        where: { key },
        create: { key, value: field },
        update: { value: field },
      })
    }
    await logEvent('settings.updated', `${label} به‌روزرسانی شد`, { keys: [key], value: field })
  }
  if (aiTextModel !== undefined || aiImageModel !== undefined) invalidateAiModelCache()

  const settings = await updateSettings(rest)
  return ok({ settings })
})
