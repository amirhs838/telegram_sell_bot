import type { NextRequest } from 'next/server'
import { z } from 'zod'
import { ok, readJson, requireAuth, route } from '@/lib/api'
import { logEvent } from '@/lib/logger'
import { getSettings, updateSettings } from '@/lib/settings'
import { getTelegramStatus } from '@/lib/telegram'

export const GET = route(async () => {
  await requireAuth()
  const settings = await getSettings()
  return ok({ settings, telegram: await getTelegramStatus() })
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
  aiEnabled: booleanish.optional(),
  aiTone: z.string().trim().max(1000, 'لحن هوش مصنوعی حداکثر ۱۰۰۰ کاراکتر است').optional(),
})

export const PUT = route(async (req: NextRequest) => {
  await requireAuth()
  const patch = patchSchema.parse(await readJson(req))

  const settings = await updateSettings(patch)
  await logEvent('settings.updated', 'تنظیمات فروشگاه به‌روزرسانی شد', {
    keys: Object.keys(patch),
  })
  return ok({ settings })
})
