import type { NextRequest } from 'next/server'
import { z } from 'zod'
import { ApiError, ok, readJson, requireAuth, route } from '@/lib/api'
import { db } from '@/lib/db'
import { logEvent } from '@/lib/logger'
import { clientIp, rateLimit } from '@/lib/rate-limit'
import { AiError, chatJSON } from '@/lib/ai/client'

const bodySchema = z.object({
  roughInfo: z.string().trim().min(10, 'حداقل ۱۰ کاراکتر لازم است').max(2000),
})

/** Model-facing schema (snake_case JSON). Category list is enforced per-request. */
function buildSuggestionSchema(categoryNames: string[]) {
  return z
    .object({
      title: z.string().min(1).max(80),
      short_description: z.string().min(1).max(200),
      description: z.string().min(200).max(800),
      category_suggestion: z
        .string()
        .nullable()
        .refine((v) => v === null || categoryNames.includes(v), {
          message: 'category_suggestion باید یکی از دسته‌بندی‌های موجود یا null باشد',
        }),
      tags: z.array(z.string().min(1)).min(3).max(7),
      telegram_caption: z
        .string()
        .min(1)
        .max(900)
        .refine((v) => /قیمت\s*[:：]/.test(v) && v.includes('ربات ما را باز کنید'), {
          message: 'کپشن باید شامل خط «💰 قیمت: —» و «🛒 برای سفارش، ربات ما را باز کنید» باشد',
        }),
    })
    .superRefine((val, ctx) => {
      // Strictly factual: the generated content must never contain an invented price/stock figure.
      if (/(قیمت\s*[:：]\s*[^\s—–-])|([۰-۹0-9]{4,}\s*(تومان|ریال))/i.test(val.telegram_caption)) {
        ctx.addIssue({
          code: 'custom',
          path: ['telegram_caption'],
          message: 'کپشن نباید عدد قیمت یا موجودی داشته باشد (فقط «قیمت: —»)',
        })
      }
    })
}

type ModelSuggestion = z.infer<ReturnType<typeof buildSuggestionSchema>>

const SYSTEM_PROMPT = `تو متخصص تولید محتوای فروشگاه اینترنتی هستی و برای یک فروشگاه ایرانی محتوای فارسی می‌سازی.
با اطلاعات خام فروشنده، یک شیء JSON با این کلیدها بساز:
- "title": عنوان جذاب محصول، حداکثر ۸۰ کاراکتر
- "short_description": خلاصه یک‌تکه، حداکثر ۲۰۰ کاراکتر
- "description": توضیح کامل فارسی و بازاریابی، بین ۲۰۰ تا ۸۰۰ کاراکتر
- "category_suggestion": یکی از دسته‌بندی‌های ارائه‌شده؛ اگر هیچ‌کدام مناسب نیست null
- "tags": بین ۳ تا ۷ تگ فارسی کوتاه
- "telegram_caption": کپشن تلگرام حداکثر ۹۰۰ کاراکتر با ایموجی، که «حتماً» این دو خط را دارد:
«💰 قیمت: —» و «🛒 برای سفارش، ربات ما را باز کنید»

قوانین سخت:
- محتوا «فقط» بر اساس اطلاعات واقعی داده‌شده باشد؛ هیچ مشخصه، قیمت، موجودی یا ویژگی‌ای از خودت نساز.
- هرگز عدد قیمت یا موجودی در هیچ بخشی نیاور؛ در کپشن فقط «💰 قیمت: —» بگذار.
- لحن فارسی، دوستانه و حرفه‌ای باشد.
- فقط JSON معتبر برگردان، بدون markdown و بدون متن اضافه.`

export const POST = route(async (req: NextRequest) => {
  await requireAuth()

  const limiter = rateLimit(`ai-generate:${clientIp(req)}`, 20, 60_000)
  if (!limiter.allowed) {
    throw new ApiError(
      429,
      `تعداد درخواست‌ها بیش از حد مجاز است. ${limiter.retryAfterSec} ثانیه دیگر تلاش کنید.`,
    )
  }

  const body = bodySchema.parse(await readJson(req))
  const roughInfo = body.roughInfo

  const categories = await db.category.findMany({
    select: { name: true },
    orderBy: { name: 'asc' },
  })
  const categoryNames = categories.map((c) => c.name)

  const userMsg = [
    `اطلاعات خام محصول:\n"""${roughInfo}"""`,
    categoryNames.length
      ? `دسته‌بندی‌های موجود (category_suggestion باید دقیقاً یکی از این‌ها یا null باشد): ${JSON.stringify(categoryNames)}`
      : 'هنوز دسته‌بندی‌ای وجود ندارد؛ category_suggestion را null بگذار.',
  ].join('\n\n')

  let parsed: ModelSuggestion
  try {
    parsed = await chatJSON(SYSTEM_PROMPT, userMsg, buildSuggestionSchema(categoryNames), 3)
  } catch (e) {
    if (e instanceof AiError) throw new ApiError(502, e.message)
    throw e
  }

  await logEvent('ai.generate', 'تولید محتوای محصول', { roughLength: roughInfo.length })

  return ok({
    suggestion: {
      title: parsed.title,
      description: parsed.description,
      shortDescription: parsed.short_description,
      categorySuggestion: parsed.category_suggestion,
      tags: parsed.tags,
      telegramCaption: parsed.telegram_caption,
    },
  })
})
