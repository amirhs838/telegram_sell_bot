/**
 * bot-service — HTTP surface + Telegram long-polling.
 *
 *   GET  /health   → {ok, mode:'polling'|'mock', botUsername}
 *   POST /simulate → run handleUpdate() and return replies (Bot Lab simulator)
 *
 * In real mode (token set && TELEGRAM_MOCK !== 'true') a sequential
 * long-polling loop forwards Telegram updates through the SAME handleUpdate()
 * and sends replies back to the originating chat.
 * The process never crashes: every path is wrapped.
 */
import { handleUpdate, type Reply, type UpdateInput } from './engine'
import {
  botUsername,
  currentBotToken,
  getUpdatesPolling,
  resolveMode,
  send,
  type TelegramUpdate,
} from './telegram'

const PORT = 3002

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  })
}

function validateSimulateInput(body: unknown): UpdateInput {
  if (!body || typeof body !== 'object') {
    throw new Error('body must be a JSON object')
  }
  const b = body as Record<string, unknown>
  if (typeof b.telegramUserId !== 'string' || !b.telegramUserId) {
    throw new Error('telegramUserId (string) is required')
  }
  const input: UpdateInput = { telegramUserId: b.telegramUserId }
  if (typeof b.firstName === 'string') input.firstName = b.firstName
  if (typeof b.username === 'string') input.username = b.username
  if (typeof b.text === 'string') input.text = b.text
  if (typeof b.callbackData === 'string') input.callbackData = b.callbackData
  if (typeof b.callbackId === 'string') input.callbackId = b.callbackId
  if (typeof b.action === 'string') input.action = b.action
  return input
}

Bun.serve({
  port: PORT,
  async fetch(req): Promise<Response> {
    let pathname = '/'
    try {
      const url = new URL(req.url)
      pathname = url.pathname

      if (pathname === '/health' && req.method === 'GET') {
        return json({
          ok: true,
          mode: await resolveMode(),
          botUsername: (await botUsername()) || undefined,
        })
      }

      if (pathname === '/simulate' && req.method === 'POST') {
        const body = await req.json().catch(() => null)
        let input: UpdateInput
        try {
          input = validateSimulateInput(body)
        } catch (e) {
          return json({ error: e instanceof Error ? e.message : 'invalid input' }, 400)
        }
        const replies: Reply[] = await handleUpdate(input)
        return json({ replies })
      }

      return json({ error: 'not found' }, 404)
    } catch (e) {
      console.error(`[bot-service] request error on ${pathname}:`, e)
      return json({ error: 'internal error' }, 500)
    }
  },
})

// ─── Telegram long polling (activates when a real bot is connected) ──────────────

function mapTelegramUpdate(u: TelegramUpdate): UpdateInput | null {
  if (u.callback_query) {
    return {
      telegramUserId: String(u.callback_query.from.id),
      firstName: u.callback_query.from.first_name,
      username: u.callback_query.from.username,
      callbackData: u.callback_query.data,
      callbackId: u.callback_query.id,
    }
  }
  if (u.message?.text && u.message.from && u.message.chat?.type === 'private') {
    return {
      telegramUserId: String(u.message.from.id),
      firstName: u.message.from.first_name,
      username: u.message.from.username,
      text: u.message.text,
    }
  }
  return null
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function pollingLoop(): Promise<void> {
  let offset = 0
  let currentToken = ''
  for (;;) {
    try {
      const mode = await resolveMode()
      if (mode === 'mock') {
        // No real bot connected yet — wait until the seller connects one
        // from the admin panel (config is re-read on each resolveMode()).
        await sleep(10_000)
        continue
      }
      const token = await currentBotToken()
      if (token !== currentToken) {
        if (currentToken) {
          console.log('[bot-service] bot token changed → restarting polling with the new bot')
        }
        currentToken = token
        offset = 0 // offsets are per-bot; start fresh
      }
      const updates = await getUpdatesPolling(offset, 30)
      if (updates === null) {
        await sleep(3000) // backoff on API failure
        continue
      }
      for (const u of updates) {
        offset = Math.max(offset, u.update_id + 1)
        try {
          const input = mapTelegramUpdate(u)
          if (!input) continue
          const replies = await handleUpdate(input)
          for (const r of replies) {
            await send(input.telegramUserId, r.text, r.keyboard)
          }
        } catch (e) {
          console.error('[bot-service] update handling error:', e)
        }
      }
    } catch (e) {
      console.error('[bot-service] polling loop error:', e)
      await sleep(3000)
    }
  }
}

// Polling runs unconditionally: it self-waits in mock mode and activates
// automatically (~10s) once a bot is connected from the admin panel.
pollingLoop().catch((e) => console.error('[bot-service] polling crashed:', e))
console.log('[bot-service] polling supervisor started (waits for a real bot connection)')

console.log(`[bot-service] listening on http://127.0.0.1:${PORT}`)
