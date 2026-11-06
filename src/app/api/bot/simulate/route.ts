import type { NextRequest } from 'next/server'
import { z } from 'zod'
import { ApiError, fail, ok, readJson, requireAuth, route } from '@/lib/api'

const BOT_SERVICE_URL = 'http://127.0.0.1:3002/simulate'

const simulateSchema = z.object({
  telegramUserId: z.string().min(1),
  text: z.string().optional(),
  callbackData: z.string().optional(),
  action: z.string().optional(),
})

export const POST = route(async (req: NextRequest) => {
  await requireAuth()

  const body = simulateSchema.parse(await readJson(req))
  const provided = [body.text, body.callbackData, body.action].filter((v) => v !== undefined)
  if (provided.length !== 1) {
    throw new ApiError(400, 'دقیقاً یکی از فیلدهای text، callbackData یا action الزامی است')
  }

  const payload: Record<string, string> = { telegramUserId: body.telegramUserId }
  if (body.text !== undefined) payload.text = body.text
  if (body.callbackData !== undefined) payload.callbackData = body.callbackData
  if (body.action !== undefined) payload.action = body.action

  let res: Response
  try {
    // 45s: AI-assisted replies can be slow.
    res = await fetch(BOT_SERVICE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(45_000),
      cache: 'no-store',
    })
  } catch {
    return fail('سرویس ربات در دسترس نیست', 502)
  }

  let json: unknown
  try {
    json = await res.json()
  } catch {
    return fail('پاسخ نامعتبر از سرویس ربات', 502)
  }

  if (!res.ok) {
    // Pass the bot's error JSON through with the same status when possible.
    return ok(json, res.status)
  }
  return ok(json)
})
