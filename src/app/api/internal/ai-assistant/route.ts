// Service-to-service endpoint for the bot mini-service (port 3002).
// NO session auth — authenticated via the shared internal API key instead.
// Adds persistent conversation memory (ChatMessage) + panel toggles
// (aiEnabled/aiTone read straight from the Setting table) + productIds output.
// Also carries a tiny self-healing guard: when the sibling bot-service
// (:3002) is not reachable, it is (re)spawned as a detached child of the
// Next dev server process, so it survives this sandbox's shell-session
// cleanup (plain `nohup … &` from a tool shell does not).
import { spawn } from 'node:child_process'
import path from 'node:path'
import type { NextRequest } from 'next/server'
import { z } from 'zod'
import { db } from '@/lib/db'
import { fail, ok, readJson, route } from '@/lib/api'
import {
  fallbackWithoutAi,
  runAssistant,
  type AssistantResult,
  type HistoryMessage,
} from '@/lib/ai/assistant'

const bodySchema = z.object({
  telegramUserId: z.string().min(1),
  message: z.string().trim().min(1, 'پیام خالی است').max(1000),
  firstName: z.string().max(100).optional(),
})

const MEMORY_WINDOW = 16 // turns loaded for the model context
const MEMORY_MAX_ROWS = 200 // rows kept per user (older ones deleted)

// ─── bot-service self-healing guard ──────────────────────────────────────────

const BOT_SERVICE_DIR = path.join(process.cwd(), 'mini-services', 'bot-service')
const BOT_HEALTH_URL = 'http://127.0.0.1:3002/health'
const BOT_SPAWN_COOLDOWN_MS = 20_000
let lastBotSpawnAt = 0

/** (Re)start the bot mini-service when :3002 is unreachable. Never throws. */
async function ensureBotServiceRunning(): Promise<boolean> {
  if (Date.now() - lastBotSpawnAt < BOT_SPAWN_COOLDOWN_MS) return false
  lastBotSpawnAt = Date.now()
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 900)
  try {
    const res = await fetch(BOT_HEALTH_URL, { signal: controller.signal })
    if (res.ok) return true // already running
  } catch {
    // not reachable → spawn below
  } finally {
    clearTimeout(timer)
  }
  try {
    const child = spawn('bun', ['run', 'dev'], {
      cwd: BOT_SERVICE_DIR,
      detached: true,
      stdio: 'ignore',
      env: process.env,
    })
    child.unref()
    console.log('[api:internal/ai-assistant] bot-service (:3002) was down → spawned detached child')
    return true
  } catch (e) {
    console.error('[api:internal/ai-assistant] bot-service spawn failed', e)
    return false
  }
}

// Periodic supervision from within the Next server process (dev only).
// unref'd so it never keeps the event loop alive on shutdown.
if (process.env.NEXT_RUNTIME !== 'edge') {
  const supervisor = setInterval(() => {
    void ensureBotServiceRunning()
  }, 30_000)
  supervisor.unref?.()
}

export const POST = route(async (req: NextRequest) => {
  const key = req.headers.get('x-internal-key')
  if (!process.env.INTERNAL_API_KEY || key !== process.env.INTERNAL_API_KEY) {
    return fail('unauthorized', 401)
  }

  // best-effort: revive the sibling bot-service if it went down
  await ensureBotServiceRunning()

  const body = bodySchema.parse(await readJson(req))

  // Panel toggles — read directly from the Setting table (settings.ts is owned
  // by the Next-side agent and must NOT be imported here).
  let aiEnabled = true
  let aiTone: string | undefined
  try {
    const rows = await db.setting.findMany({ where: { key: { in: ['aiEnabled', 'aiTone'] } } })
    for (const r of rows) {
      if (r.key === 'aiEnabled') aiEnabled = r.value.trim().toLowerCase() !== 'false'
      if (r.key === 'aiTone' && r.value.trim()) aiTone = r.value.trim()
    }
  } catch {
    // settings read failure must not kill the assistant
  }

  // Persistent conversation memory — last N turns for this Telegram user (asc).
  let history: HistoryMessage[] = []
  try {
    const rows = await db.chatMessage.findMany({
      where: { telegramUserId: body.telegramUserId },
      orderBy: { createdAt: 'desc' },
      take: MEMORY_WINDOW,
    })
    history = rows
      .reverse()
      .map((r) => ({
        role: r.role === 'assistant' ? ('assistant' as const) : ('user' as const),
        content: r.content,
      }))
  } catch {
    // memory is best-effort
  }

  try {
    const result: AssistantResult = aiEnabled
      ? await runAssistant({
          telegramUserId: body.telegramUserId,
          message: body.message,
          firstName: body.firstName,
          history,
          aiTone,
        })
      : { ...(await fallbackWithoutAi(body.message)), toolsUsed: [] }

    await persistMemory(body.telegramUserId, body.message, result.reply)
    return ok({
      reply: result.reply,
      toolsUsed: result.toolsUsed,
      productIds: result.productIds,
    })
  } catch (e) {
    console.error('[api:internal/ai-assistant]', e)
    return fail('دستیار هوشمند موقتاً در دسترس نیست', 502)
  }
})

/** Store user+assistant turns and trim history to the last 200 rows per user. */
async function persistMemory(
  telegramUserId: string,
  userMessage: string,
  assistantReply: string,
): Promise<void> {
  try {
    await db.chatMessage.create({ data: { telegramUserId, role: 'user', content: userMessage } })
    await db.chatMessage.create({
      data: { telegramUserId, role: 'assistant', content: assistantReply },
    })
    const stale = await db.chatMessage.findMany({
      where: { telegramUserId },
      orderBy: { createdAt: 'desc' },
      skip: MEMORY_MAX_ROWS,
      select: { id: true },
    })
    if (stale.length > 0) {
      await db.chatMessage.deleteMany({ where: { id: { in: stale.map((r) => r.id) } } })
    }
  } catch (e) {
    console.error('[api:internal/ai-assistant] memory persist failed', e)
  }
}
