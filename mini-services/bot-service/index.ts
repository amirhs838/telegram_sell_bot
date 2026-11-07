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
import { existsSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import { handleUpdate, type Reply, type UpdateInput } from './engine'
import {
  botUsername,
  currentBotToken,
  getUpdatesPolling,
  resolveMode,
  send,
  sendPhoto,
  type PhotoSource,
  type TelegramUpdate,
} from './telegram'

const PORT = 3002

// ─── Single-instance guard ────────────────────────────────────────────────────
// Bun.serve uses SO_REUSEPORT on Linux, so two bot-service processes can bind
// :3002 simultaneously — and BOTH would run the polling loop on the same bot
// token, delivering every customer message twice. The lockfile makes the
// polling loop single-owner: a second process exits immediately.
const LOCK_FILE = path.join(import.meta.dir, '.bot-lock')

function lockPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0) // signal 0 = existence probe
    return true
  } catch {
    return false
  }
}

function acquireSingletonLock(): void {
  try {
    if (existsSync(LOCK_FILE)) {
      const raw = readFileSync(LOCK_FILE, 'utf8').trim()
      const pid = Number.parseInt(raw.split(':')[0] ?? '', 10)
      if (pid === process.pid) return // our own lock from a previous hot-reload pass
      if (Number.isFinite(pid) && lockPidAlive(pid)) {
        console.log(`[bot-service] another instance (pid ${pid}) already polls — exiting`)
        process.exit(0)
      }
      // stale lock (dead pid) → take over
      rmSync(LOCK_FILE, { force: true })
    }
    writeFileSync(LOCK_FILE, `${process.pid}:${Date.now()}`, { flag: 'wx' })
  } catch (e) {
    // 'wx' raced with another starter → let that one win
    console.log('[bot-service] lock held by a concurrent starter — exiting:', (e as Error).message)
    process.exit(0)
  }
}

function releaseSingletonLock(): void {
  try {
    if (existsSync(LOCK_FILE)) {
      const raw = readFileSync(LOCK_FILE, 'utf8').trim()
      if (raw.startsWith(`${process.pid}:`)) rmSync(LOCK_FILE, { force: true })
    }
  } catch {
    // best effort
  }
}

mkdirSync(import.meta.dir, { recursive: true })
acquireSingletonLock()
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    releaseSingletonLock()
    process.exit(0)
  })
}

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
  if (b.photo && typeof b.photo === 'object') {
    const p = b.photo as { fileId?: unknown; caption?: unknown }
    if (typeof p.fileId === 'string' && p.fileId) {
      input.photo = {
        fileId: p.fileId,
        ...(typeof p.caption === 'string' && p.caption ? { caption: p.caption } : {}),
      }
    }
  }
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
        return json({ replies: replies.map(sanitizeReplyForSim) })
      }

      return json({ error: 'not found' }, 404)
    } catch (e) {
      console.error(`[bot-service] request error on ${pathname}:`, e)
      return json({ error: 'internal error' }, 500)
    }
  },
})

// ─── Telegram long polling (activates when a real bot is connected) ──────────────

/** JSON-safe view of a Reply for the simulator: buffers → size summary. */
function sanitizeReplyForSim(r: Reply): Record<string, unknown> {
  let photo: Record<string, unknown> | undefined
  if (typeof r.photo === 'string') {
    photo = { kind: 'url', url: r.photo }
  } else if (r.photo && typeof r.photo === 'object') {
    photo = {
      kind: 'buffer',
      filename: r.photo.filename,
      bytes: r.photo.buffer.length,
    }
  }
  return {
    text: r.text,
    ...(r.keyboard ? { keyboard: r.keyboard } : {}),
    ...(photo ? { photo } : {}),
  }
}

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
  if (u.message && u.message.from && u.message.chat?.type === 'private') {
    // photos take priority over text (a caption rides along as customerNote)
    const photos = u.message.photo
    if (Array.isArray(photos) && photos.length > 0) {
      const largest = photos.reduce((a, b) =>
        b.width * b.height > a.width * a.height ? b : photos[0],
      )
      return {
        telegramUserId: String(u.message.from.id),
        firstName: u.message.from.first_name,
        username: u.message.from.username,
        photo: { fileId: largest.file_id, caption: u.message.caption },
      }
    }
    if (u.message.text) {
      return {
        telegramUserId: String(u.message.from.id),
        firstName: u.message.from.first_name,
        username: u.message.from.username,
        text: u.message.text,
      }
    }
  }
  return null
}

/** Deliver one reply: photo replies go through multipart sendPhoto. */
async function deliver(chatId: string, r: Reply): Promise<void> {
  if (r.photo) {
    const source: PhotoSource = r.photo
    await sendPhoto(chatId, source, r.text, r.keyboard)
  } else {
    await send(chatId, r.text, r.keyboard)
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/**
 * Defensive redelivery guard: Telegram long-poll guarantees at-least-once in
 * edge cases (offset reset on token change, 409 races with a stale poller).
 * The same update must NEVER be handled twice — keep a small LRU of recently
 * seen update_ids.
 */
const seenUpdateIds = new Set<number>()
const SEEN_UPDATE_LIMIT = 500
function isDuplicateUpdate(updateId: number): boolean {
  if (seenUpdateIds.has(updateId)) return true
  seenUpdateIds.add(updateId)
  if (seenUpdateIds.size > SEEN_UPDATE_LIMIT) {
    // drop the oldest half (Set iterates in insertion order)
    let drop = seenUpdateIds.size - Math.floor(SEEN_UPDATE_LIMIT / 2)
    for (const id of seenUpdateIds) {
      seenUpdateIds.delete(id)
      if (--drop <= 0) break
    }
  }
  return false
}

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
        seenUpdateIds.clear()
      }
      // 25s server-side long-poll; the HTTP timeout (35s) always exceeds it
      const updates = await getUpdatesPolling(offset, 25)
      if (updates === null) {
        await sleep(3000) // backoff on API failure
        continue
      }
      for (const u of updates) {
        offset = Math.max(offset, u.update_id + 1)
        if (isDuplicateUpdate(u.update_id)) continue
        try {
          const input = mapTelegramUpdate(u)
          if (!input) continue
          const replies = await handleUpdate(input)
          for (const r of replies) {
            await deliver(input.telegramUserId, r)
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
