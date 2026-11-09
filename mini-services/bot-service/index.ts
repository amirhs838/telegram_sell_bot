/**
 * bot-service — HTTP surface + Telegram/Bale long-polling.
 *
 *   GET  /health   → {ok, mode, platforms:{telegram:{mode,botUsername}, bale:{...}}}
 *   POST /simulate → run handleUpdate() and return replies (Bot Lab simulator)
 *
 * In real mode (token set && not mock-forced) a sequential long-polling loop
 * PER PLATFORM forwards messenger updates through the SAME handleUpdate()
 * and sends replies back to the originating chat.
 * The process never crashes: every path is wrapped.
 */
import { existsSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import { handleUpdate, MAIN_KEYBOARD, type Reply, type UpdateInput } from './engine'
import {
  PLATFORMS,
  botUsername,
  currentBotToken,
  getUpdatesPolling,
  isMockMode,
  registerBotMenu,
  resolveMode,
  send,
  sendPhoto,
  sendTyping,
  type PhotoSource,
  type Platform,
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
  if (b.platform === 'bale' || b.platform === 'telegram') input.platform = b.platform
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
        const platforms: Record<string, { mode: string; botUsername?: string }> = {}
        for (const p of PLATFORMS) {
          const uname = await botUsername(p)
          platforms[p] = {
            mode: await resolveMode(p),
            ...(uname ? { botUsername: uname } : {}),
          }
        }
        const modes = PLATFORMS.map((p) => platforms[p]?.mode)
        return json({
          ok: true,
          // aggregate for legacy UI consumers: real when ANY platform is real
          mode: modes.includes('real') ? 'real' : 'mock',
          botUsername: platforms['telegram']?.botUsername,
          platforms,
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

function mapTelegramUpdate(u: TelegramUpdate, platform: Platform): UpdateInput | null {
  // Bale customers get a `bale:` prefixed id — the two id spaces are separate,
  // so Customer/ChatMessage/session rows never collide across messengers.
  const withPrefix = (id: number | string): string =>
    platform === 'bale' ? `bale:${id}` : String(id)
  if (u.callback_query) {
    return {
      telegramUserId: withPrefix(u.callback_query.from.id),
      firstName: u.callback_query.from.first_name,
      username: u.callback_query.from.username,
      callbackData: u.callback_query.data,
      callbackId: u.callback_query.id,
      platform,
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
        telegramUserId: withPrefix(u.message.from.id),
        firstName: u.message.from.first_name,
        username: u.message.from.username,
        photo: { fileId: largest.file_id, caption: u.message.caption },
        platform,
      }
    }
    if (u.message.text) {
      return {
        telegramUserId: withPrefix(u.message.from.id),
        firstName: u.message.from.first_name,
        username: u.message.from.username,
        text: u.message.text,
        platform,
      }
    }
  }
  return null
}

/** Deliver one reply: photo replies go through multipart sendPhoto. */
async function deliver(platform: Platform, chatId: string, r: Reply): Promise<void> {
  // No inline buttons on this reply → (re)assert the persistent bottom menu
  // keyboard, so the shop menu is always visible above the input field.
  const bottom = r.keyboard ? undefined : MAIN_KEYBOARD
  if (r.photo) {
    const source: PhotoSource = r.photo
    await sendPhoto(platform, chatId, source, r.text, r.keyboard, bottom)
  } else {
    await send(platform, chatId, r.text, r.keyboard, bottom)
  }
}

/**
 * «typing…» keep-alive for the duration of one handleUpdate: one chat action
 * immediately, then a re-send every 4s (Telegram shows it for ~5s per call,
 * Bale for ~6s). Typical AI turns take 2–4s; heavy tool rounds or a 60s AI
 * timeout would otherwise leave the customer staring at dead air.
 * Mock mode → no-op. Returns stop() for the finally-block; never throws.
 */
function startTypingKeepAlive(platform: Platform, chatId: string): () => void {
  if (isMockMode(platform)) return () => undefined
  void sendTyping(platform, chatId).catch(() => undefined)
  const timer = setInterval(() => void sendTyping(platform, chatId).catch(() => undefined), 4_000)
  timer.unref?.() // a typing indicator must never keep the process alive
  return () => clearInterval(timer)
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/**
 * Defensive redelivery guard: messenger long-poll guarantees at-least-once in
 * edge cases (offset reset on token change, 409 races with a stale poller).
 * The same update must NEVER be handled twice — keep a small LRU of recently
 * seen update ids, keyed per platform (the two id spaces are independent).
 */
const seenUpdateIds = new Set<string>()
const SEEN_UPDATE_LIMIT = 500
function isDuplicateUpdate(platform: Platform, updateId: number): boolean {
  const key = `${platform}:${updateId}`
  if (seenUpdateIds.has(key)) return true
  seenUpdateIds.add(key)
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
  /** aborts the in-flight long poll of the previous generation(s), per platform */
  aborts: Partial<Record<Platform, AbortController>>
}

const POLL_REG_KEY = '__silverlove_bot_poll_registry__'
const g = globalThis as unknown as { __silverlove_bot_poll_registry__?: PollRegistry }
const registry: PollRegistry = g[POLL_REG_KEY] ?? { gen: 0, aborts: {} }
g[POLL_REG_KEY] = registry

registry.gen += 1
const MY_GEN = registry.gen
for (const p of PLATFORMS) {
  const prev = registry.aborts[p]
  if (prev) {
    try {
      prev.abort() // previous generation: cancel its in-flight poll
    } catch {
      // already dead
    }
  }
}
const myAborts = {} as Record<Platform, AbortController>
for (const p of PLATFORMS) {
  myAborts[p] = new AbortController()
  registry.aborts[p] = myAborts[p]
}

// ─── Persisted getUpdates offset (per platform + per bot) ─────────────────────
// Messengers confirm updates only via the offset of the NEXT getUpdates call,
// so an in-memory offset re-delivers every recent message after a restart or
// hot-reload handover → duplicates. Persisting it makes handover at-most-once.
const OFFSET_FILE = path.join(import.meta.dir, '.bot-offset.json')

function botIdOf(token: string): string {
  return token.split(':')[0] || 'unknown'
}

type OffsetFileShape = {
  /** legacy single-platform format (telegram only) */
  botId?: string
  offset?: number
  /** current per-platform format */
  platforms?: Partial<Record<Platform, { botId: string; offset: number; at: number }>>
}

function readPersistedOffset(platform: Platform, botId: string): number {
  try {
    const raw = JSON.parse(readFileSync(OFFSET_FILE, 'utf8')) as OffsetFileShape
    const entry = raw.platforms?.[platform]
    if (
      entry &&
      entry.botId === botId &&
      typeof entry.offset === 'number' &&
      Number.isFinite(entry.offset) &&
      entry.offset > 0
    ) {
      return Math.trunc(entry.offset)
    }
    // legacy format → telegram's offset (bale starts fresh, as it should)
    if (platform === 'telegram' && !raw.platforms) {
      if (
        raw.botId === botId &&
        typeof raw.offset === 'number' &&
        Number.isFinite(raw.offset) &&
        raw.offset > 0
      ) {
        return Math.trunc(raw.offset)
      }
    }
  } catch {
    // first run / unreadable → start from scratch
  }
  return 0
}

function persistOffset(platform: Platform, botId: string, offset: number): void {
  try {
    let raw: OffsetFileShape = {}
    try {
      raw = JSON.parse(readFileSync(OFFSET_FILE, 'utf8')) as OffsetFileShape
    } catch {
      // no file yet — start a fresh structure
    }
    raw.platforms = raw.platforms ?? {}
    raw.platforms[platform] = { botId, offset, at: Date.now() }
    writeFileSync(OFFSET_FILE, JSON.stringify(raw))
  } catch {
    // best effort — worst case after a crash: a redelivered update
  }
}

async function pollingLoop(platform: Platform, gen: number, abort: AbortController): Promise<void> {
  let offset = 0
  let currentBotId = ''
  let lastMode: 'mock' | 'real' | null = null
  let pollFailures = 0
  let iters = 0
  console.log(`[bot-service] ${platform} polling loop gen ${gen} active`)
  for (;;) {
    if (registry.gen !== gen) return // superseded by a hot reload → die quietly
    iters++
    // Heartbeat: proves the loop is alive and shows WHERE it is (was silent
    // hangs before — unobservable wedged states after hot reloads).
    if (iters % 60 === 0) {
      console.log(
        `[bot-service] ${platform} heartbeat gen=${gen} iters=${iters} mode=${lastMode ?? '?'} bot=${currentBotId || '-'} offset=${offset} pollFailures=${pollFailures}`,
      )
    }
    try {
      const mode = await resolveMode(platform)
      if (mode !== lastMode) {
        console.log(
          `[bot-service] ${platform} mode → ${mode}${mode === 'real' ? ' (polling activated)' : ' (waiting for a bot to be connected in the panel)'}`,
        )
        if (mode === 'real') {
          // First activation (or reconnect): publish the bot's public menu —
          // / command list (+ the ☰ chat menu button on Telegram).
          void registerBotMenu(platform).catch(() => undefined) // never blocks polling
        }
        lastMode = mode
      }
      if (mode === 'mock') {
        // No real bot connected yet — wait until the seller connects one
        // from the admin panel (config is re-read on each resolveMode()).
        await sleep(10_000)
        continue
      }
      const token = await currentBotToken(platform)
      const botId = botIdOf(token)
      if (botId !== currentBotId) {
        if (currentBotId) {
          console.log(`[bot-service] ${platform} bot changed → restarting polling (${botId})`)
        }
        currentBotId = botId
        offset = readPersistedOffset(platform, botId) // offsets are per-platform+bot, persisted
        console.log(`[bot-service] polling ${platform} bot ${botId} from persisted offset ${offset}`)
      }
      // 25s server-side long-poll; the HTTP timeout (35s) always exceeds it
      const res = await getUpdatesPolling(platform, offset, 25, abort.signal)
      if (registry.gen !== gen) return // superseded mid-poll
      if ('error' in res) {
        pollFailures++
        if (pollFailures === 1 || pollFailures % 20 === 0) {
          console.error(
            `[bot-service] ${platform} getUpdates failed ×${pollFailures}: ${res.error} (bot=${currentBotId})`,
          )
        }
        await sleep(3000)
        continue
      }
      if (pollFailures > 0) {
        console.log(`[bot-service] ${platform} getUpdates recovered after ${pollFailures} failures`)
        pollFailures = 0
      }
      const updates = res.updates
      if (updates.length > 0) {
        // Confirm the batch BEFORE handling: the offset lives on disk, so
        // neither a hot-reload handover nor a process restart can re-deliver
        // these updates (at-most-once beats duplicates for a sales bot).
        offset = Math.max(offset, ...updates.map((u) => u.update_id + 1))
        persistOffset(platform, botId, offset)
      }
      for (const u of updates) {
        if (isDuplicateUpdate(platform, u.update_id)) continue
        try {
          const input = mapTelegramUpdate(u, platform)
          if (!input) continue
          const stopTyping = startTypingKeepAlive(platform, input.telegramUserId)
          try {
            const replies = await handleUpdate(input)
            for (const r of replies) {
              await deliver(platform, input.telegramUserId, r)
            }
          } finally {
            stopTyping()
          }
        } catch (e) {
          console.error('[bot-service] update handling error:', e)
        }
      }
    } catch (e) {
      if (registry.gen !== gen || abort.signal.aborted) return
      console.error(`[bot-service] ${platform} polling loop error:`, e)
      await sleep(3000)
    }
  }
}

// Polling runs unconditionally for BOTH platforms: each loop self-waits in
// mock mode and activates automatically (~10s) once its bot is connected from
// the admin panel. A module re-evaluation (--hot) aborts THIS generation's
// loops and starts the next gen.
for (const p of PLATFORMS) {
  void pollingLoop(p, MY_GEN, myAborts[p]).catch((e) =>
    console.error(`[bot-service] ${p} polling crashed:`, e),
  )
}
console.log(`[bot-service] polling supervisor started (gen ${MY_GEN}, platforms: ${PLATFORMS.join(', ')})`)

console.log(`[bot-service] listening on http://127.0.0.1:${PORT}`)
// handover test marker 2
