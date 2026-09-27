// Service-to-service endpoint for the bot mini-service (port 3002).
// NO session auth — authenticated via the shared internal API key instead.
import type { NextRequest } from 'next/server'
import { z } from 'zod'
import { fail, ok, readJson, route } from '@/lib/api'
import { runAssistant } from '@/lib/ai/assistant'

const bodySchema = z.object({
  telegramUserId: z.string().min(1),
  message: z.string().trim().min(1, 'پیام خالی است').max(1000),
  firstName: z.string().max(100).optional(),
})

export const POST = route(async (req: NextRequest) => {
  const key = req.headers.get('x-internal-key')
  if (!process.env.INTERNAL_API_KEY || key !== process.env.INTERNAL_API_KEY) {
    return fail('unauthorized', 401)
  }

  const body = bodySchema.parse(await readJson(req))

  try {
    const { reply, toolsUsed } = await runAssistant({
      telegramUserId: body.telegramUserId,
      message: body.message,
      firstName: body.firstName,
    })
    return ok({ reply, toolsUsed })
  } catch (e) {
    console.error('[api:internal/ai-assistant]', e)
    return fail('دستیار هوشمند موقتاً در دسترس نیست', 502)
  }
})
