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

// ─── Hot-reload-safe polling supervisor ───────────────────────────────────────
// `bun --hot` re-evaluates this module on every file change while the process
// (and the PREVIOUS module's infinite polling loop) stays alive. Without this
// registry, every reload stacked ANOTHER polling loop on the same bot token —
// each with its own offset starting at 0 and its own update-id LRU — so the
// customer received 2..N copies of every reply. globalThis survives --hot
// reloads: the newest generation supersedes (aborts) all older ones.

type PollRegistry = {
  /** bumped at every module evaluation — only the current generation polls */
  gen: number
  /** aborts the in-flight long poll of the previous generation */
  abort: AbortController | null
}

const POLL_REG_KEY = '__silverlove_bot_poll_registry__'
const g = globalThis as unknown as { __silverlove_bot_poll_registry__?: PollRegistry }
const registry: PollRegistry = g[POLL_REG_KEY] ?? { gen: 0, abort: null }
g[POLL_REG_KEY] = registry

registry.gen += 1
const MY_GEN = registry.gen
if (registry.abort) {
  try {
    registry.abort.abort() // previous generation: cancel its in-flight poll
  } catch {
    // already dead
  }
}
const myAbort = new AbortController()
registry.abort = myAbort

// ─── Persisted getUpdates offset (per bot) ────────────────────────────────────
// Telegram confirms updates only via the offset of the NEXT getUpdates call,
// so an in-memory offset re-delivers every recent message after a restart or
// hot-reload handover → duplicates. Persisting it makes handover at-most-once.
const OFFSET_FILE = path.join(import.meta.dir, '.bot-offset.json')

function botIdOf(token: string): string {
  return token.split(':')[0] || 'unknown'
}

function readPersistedOffset(botId: string): number {
  try {
    const raw = JSON.parse(readFileSync(OFFSET_FILE, 'utf8')) as {
      botId?: string
      offset?: number
    }
    if (
      raw.botId === botId &&
      typeof raw.offset === 'number' &&
      Number.isFinite(raw.offset) &&
      raw.offset > 0
    ) {
      return Math.trunc(raw.offset)
    }
  } catch {
    // first run / unreadable → start from scratch
  }
  return 0
}

function persistOffset(botId: string, offset: number): void {
  try {
    writeFileSync(OFFSET_FILE, JSON.stringify({ botId, offset, at: Date.now() }))
  } catch {
    // best effort — worst case after a crash: a redelivered update
  }
}

async function pollingLoop(gen: number, abort: AbortController): Promise<void> {
  let offset = 0
  let currentBotId = ''
  console.log(`[bot-service] polling loop gen ${gen} active`)
  for (;;) {
    if (registry.gen !== gen) return // superseded by a hot reload → die quietly
    try {
      const mode = await resolveMode()
      if (mode === 'mock') {
        // No real bot connected yet — wait until the seller connects one
        // from the admin panel (config is re-read on each resolveMode()).
        await sleep(10_000)
        continue
      }
      const token = await currentBotToken()
      const botId = botIdOf(token)
      if (botId !== currentBotId) {
        if (currentBotId) {
          console.log(`[bot-service] bot changed → restarting polling (${botId})`)
        }
        currentBotId = botId
        offset = readPersistedOffset(botId) // offsets are per-bot, persisted
        seenUpdateIds.clear()
        console.log(`[bot-service] polling bot ${botId} from persisted offset ${offset}`)
      }
      // 25s server-side long-poll; the HTTP timeout (35s) always exceeds it
      const updates = await getUpdatesPolling(offset, 25, abort.signal)
      if (registry.gen !== gen) return // superseded mid-poll
      if (updates === null) {
        await sleep(3000) // backoff on API failure (incl. 409 with old loop)
        continue
      }
      if (updates.length > 0) {
        // Confirm the batch BEFORE handling: the offset lives on disk, so
        // neither a hot-reload handover nor a process restart can re-deliver
        // these updates (at-most-once beats duplicates for a sales bot).
        offset = Math.max(offset, ...updates.map((u) => u.update_id + 1))
        persistOffset(botId, offset)
      }
      for (const u of updates) {
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
      if (registry.gen !== gen || abort.signal.aborted) return
      console.error('[bot-service] polling loop error:', e)
      await sleep(3000)
    }
  }
}

// Polling runs unconditionally: it self-waits in mock mode and activates
// automatically (~10s) once a bot is connected from the admin panel.
// A module re-evaluation (--hot) aborts THIS loop and starts the next gen.
void pollingLoop(MY_GEN, myAbort).catch((e) =>
  console.error('[bot-service] polling crashed:', e),
)
console.log(`[bot-service] polling supervisor started (gen ${MY_GEN})`)

console.log(`[bot-service] listening on http://127.0.0.1:${PORT}`)
// handover test marker 2
