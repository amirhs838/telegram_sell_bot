import 'server-only'

import { existsSync } from 'node:fs'
import path from 'node:path'
import ZAI from 'z-ai-web-dev-sdk'
import { db } from '@/lib/db'

/**
 * Three-tier AI layer — designed to keep the bot ALIVE on a bare VPS where
 * neither the seller's key nor the platform gateway exists (root cause of the
 * "bot answers the same menu for every message" production bug):
 *
 *  Tier A (best) — the seller's OWN Z.ai key. Sources, in order:
 *    1. `ZAI_API_KEY` in .env (deploy-time)
 *    2. Setting row «zaiApiKey» — pasted from the admin panel (no SSH needed)
 *    Called on the public OpenAI-compatible endpoint (api.z.ai/api/paas/v4).
 *
 *  Tier B (sandbox/dev) — the platform-managed z-ai-web-dev-sdk gateway.
 *    Only attempted when a .z-ai-config file actually exists (project/home/etc);
 *    on a customer VPS it never does, and every blind attempt wasted ~seconds
 *    before dying with "Configuration file not found".
 *
 *  Tier C (zero-config safety net) — a keyless OpenAI-compatible free
 *    gateway (text.pollinations.ai/openai, env-overridable). Keeps the sales
 *    assistant responsive out-of-the-box until the owner pastes their own key.
 *
 * Tier-A health: an auth failure (401) is cached for a cooldown window so
 * every request doesn't pay the extra latency; re-probed after the cooldown.
 * 429 responses retry with real backoff (Retry-After aware) on all tiers.
 * EVERY leg failure is logged loudly — silent AI death must never happen again.
 */

// ─── Configuration ───────────────────────────────────────────────────────────

const PUBLIC_API_BASE = 'https://api.z.ai/api/paas/v4'

/** Keyless safety-net gateway (OpenAI-compatible POST endpoint). */
const FREE_API_BASE = (process.env.FREE_TEXT_API_BASE ?? 'https://text.pollinations.ai/openai').trim()
const FREE_TEXT_MODEL = (process.env.FREE_TEXT_MODEL ?? 'openai').trim()

export function userApiKey(): string {
  return (process.env.ZAI_API_KEY ?? '').trim()
}

/** Setting-row copy of the seller key (panel-editable), cached 30 s per process. */
let settingKeyCache: { value: string; at: number } | null = null
async function settingSellerKey(): Promise<string> {
  const now = Date.now()
  if (settingKeyCache && now - settingKeyCache.at < 30_000) return settingKeyCache.value
  let value = ''
  try {
    const row = await db.setting.findUnique({ where: { key: 'zaiApiKey' } })
    value = row?.value?.trim() ?? ''
  } catch {
    value = '' // DB hiccup must not break the AI
  }
  settingKeyCache = { value, at: now }
  return value
}

/** The seller key from .env, else the panel-pasted Setting copy. */
export async function resolveSellerKey(): Promise<string> {
  const env = userApiKey()
  if (env) return env
  return settingSellerKey()
}

// ─── Tier-B availability probe (cached once per process) ────────────────────

let platformGatewayUsable: boolean | null = null
function platformConfigAvailable(): boolean {
  if (platformGatewayUsable !== null) return platformGatewayUsable
  const candidates = [
    path.join(process.cwd(), '.z-ai-config'),
    path.join(process.env.HOME ?? '/root', '.z-ai-config'),
    '/etc/.z-ai-config',
  ]
  platformGatewayUsable = candidates.some((p) => existsSync(p))
  if (!platformGatewayUsable) {
    console.log('[ai:provider] no .z-ai-config → platform gateway tier skipped (bare-VPS mode)')
  }
  return platformGatewayUsable
}

export function chatModel(): string {
  return (process.env.AI_CHAT_MODEL ?? 'glm-4.5-flash').trim()
}

export function imageModel(): string {
  return (process.env.AI_IMAGE_MODEL ?? 'cogview-4').trim()
}

export function providerStatus(): {
  userKeyConfigured: boolean
  chatModel: string
  imageModel: string
  userKeyHealthy: boolean | null // null = not probed yet
  lastUserKeyError?: string
} {
  return {
    userKeyConfigured: userApiKey() !== '',
    chatModel: chatModel(),
    imageModel: imageModel(),
    userKeyHealthy: health.usable,
    lastUserKeyError: health.lastError,
  }
}

// ─── Provider-A health cache (survives HMR via globalThis) ───────────────────

const AUTH_COOLDOWN_MS = 10 * 60 * 1000 // auth-failed key probed again after 10 min

type Health = {
  usable: boolean | null
  lastError?: string
  nextProbeAt: number
  lastProbeAt: number
}

const globalForHealth = globalThis as unknown as { __aiProviderHealth?: Health }
const health: Health = (globalForHealth.__aiProviderHealth ??= {
  usable: null,
  nextProbeAt: 0,
  lastProbeAt: 0,
})

function markAuthFailure(error: string) {
  health.usable = false
  health.lastError = error.slice(0, 300)
  health.lastProbeAt = Date.now()
  health.nextProbeAt = Date.now() + AUTH_COOLDOWN_MS
  console.error(
    `[ai:provider] user key rejected by api.z.ai (${error.slice(0, 120)}) — falling back to the platform gateway for the next ${AUTH_COOLDOWN_MS / 60000} min`,
  )
}

function markUsable() {
  health.usable = true
  health.lastError = undefined
  health.lastProbeAt = Date.now()
  health.nextProbeAt = Date.now()
}

function userKeyBlocked(): boolean {
  return userApiKey() === '' || (health.usable === false && Date.now() < health.nextProbeAt)
}

// ─── Low-level fetch helpers ─────────────────────────────────────────────────

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

type FetchOpts = { timeoutMs: number; retries: number }

async function publicFetch(
  path: string,
  body: Record<string, unknown>,
  opts: FetchOpts,
): Promise<unknown> {
  const key = userApiKey()
  let lastStatus = 0
  let lastBody = ''

  for (let attempt = 1; attempt <= opts.retries; attempt++) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), opts.timeoutMs)
    try {
      const res = await fetch(`${PUBLIC_API_BASE}${path}`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${key}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      })
      const text = await res.text()

      if (res.ok) {
        markUsable()
        return JSON.parse(text) as unknown
      }

      lastStatus = res.status
      lastBody = text.slice(0, 400)

      // Authentication/authorization problems → provider unusable, no retry.
      if (res.status === 401 || res.status === 403) {
        throw new AuthError(`HTTP ${res.status}: ${lastBody}`)
      }

      // Rate limit → real backoff (Retry-After first, then exponential).
      if (res.status === 429) {
        const retryAfter = Number(res.headers.get('retry-after'))
        const waitMs = Number.isFinite(retryAfter) && retryAfter > 0
          ? Math.min(retryAfter * 1000, 30_000)
          : Math.min(2000 * 2 ** (attempt - 1), 20_000)
        if (attempt < opts.retries) {
          console.warn(`[ai:provider] user-key 429 — backing off ${waitMs}ms (attempt ${attempt}/${opts.retries})`)
          await sleep(waitMs)
          continue
        }
        throw new RateError(lastBody)
      }

      // Other client errors are not worth retrying.
      if (res.status >= 400 && res.status < 500) {
        throw new Error(`HTTP ${res.status}: ${lastBody}`)
      }

      // 5xx → transient, retry with backoff.
      if (attempt < opts.retries) {
        await sleep(1500 * attempt)
        continue
      }
      throw new Error(`HTTP ${res.status}: ${lastBody}`)
    } catch (e) {
      if (e instanceof AuthError || e instanceof RateError) throw e
      if (attempt < opts.retries) {
        await sleep(1500 * attempt)
        continue
      }
      throw e
    } finally {
      clearTimeout(timer)
    }
  }
  throw new Error(`HTTP ${lastStatus || 0}: ${lastBody || 'no response'}`)
}

// ─── Shared error type ───────────────────────────────────────────────────────

export class AiError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AiError'
  }
}

class AuthError extends Error {}
class RateError extends Error {}

// ─── SDK (provider B) singleton ──────────────────────────────────────────────

const globalForSdk = globalThis as unknown as { __zaiSdkPromise?: Promise<ZAI> }

export function getSdk(): Promise<ZAI> {
  if (!globalForSdk.__zaiSdkPromise) {
    globalForSdk.__zaiSdkPromise = ZAI.create().catch((e) => {
      globalForSdk.__zaiSdkPromise = undefined
      throw e
    })
  }
  return globalForSdk.__zaiSdkPromise
}

// ─── Public provider API ─────────────────────────────────────────────────────

export type ChatMsg = { role: 'system' | 'assistant' | 'user'; content: string }

export type ChatResult = {
  content: string
  via: 'user-key' | 'platform' | 'free'
}

// ─── Tier C cooldown (survives HMR via globalThis) ──────────────────────────

/**
 * The free gateway enforces hard per-IP quotas (observed: HTTP 402 FREE_LIMIT,
 * «1 reply every 45 seconds per IP»). Hammering it per message wastes seconds
 * of customer latency, so once it reports a quota failure the tier is skipped
 * entirely for a cooldown window and the caller degrades immediately.
 */
const FREE_TIER_COOLDOWN_MS = 10 * 60 * 1000
const globalForFreeTier = globalThis as unknown as { __aiFreeTierBlockedUntil?: number }

function freeTierBlocked(): boolean {
  return (globalForFreeTier.__aiFreeTierBlockedUntil ?? 0) > Date.now()
}

function blockFreeTier(reason: string): void {
  globalForFreeTier.__aiFreeTierBlockedUntil = Date.now() + FREE_TIER_COOLDOWN_MS
  console.warn(
    `[ai:provider] free gateway quota exhausted (${reason}) → tier skipped for ${FREE_TIER_COOLDOWN_MS / 60000} min`,
  )
}

/**
 * Tier C — keyless OpenAI-compatible gateway. No auth header at all; keeps
 * the bot useful on a bare VPS with zero configuration. Env-overridable via
 * FREE_TEXT_API_BASE / FREE_TEXT_MODEL. Quota (402/429) failures arm the
 * cooldown instead of retrying — retrying cannot win against a per-IP quota.
 */
async function freeFetch(
  messages: ChatMsg[],
  maxTokens: number,
  timeoutMs: number,
  retries = 2,
): Promise<string> {
  let lastErr: unknown = null
  for (let attempt = 1; attempt <= retries; attempt++) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const res = await fetch(FREE_API_BASE, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: FREE_TEXT_MODEL,
          messages,
          max_tokens: maxTokens,
          temperature: 0.6,
        }),
        signal: controller.signal,
      })
      const text = await res.text()
      if (res.ok) {
        const data = JSON.parse(text) as {
          choices?: Array<{ message?: { content?: string }; text?: string }>
        }
        const content = data.choices?.[0]?.message?.content ?? data.choices?.[0]?.text
        if (typeof content === 'string' && content.trim() !== '') return content
        throw new Error('پاسخ خالی از گیت‌وی رایگان')
      }
      // Per-IP quota → arm the cooldown and fail fast; retries are pointless.
      if (res.status === 402 || res.status === 429) {
        blockFreeTier(`HTTP ${res.status}: ${text.slice(0, 120)}`)
        throw new Error(`free gateway quota (HTTP ${res.status})`)
      }
      lastErr = new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`)
      if (res.status >= 500 && attempt < retries) {
        await sleep(1500 * attempt)
        continue
      }
      throw lastErr
    } catch (e) {
      lastErr = e
      if (e instanceof Error && e.message.startsWith('free gateway quota')) throw e
      if (attempt < retries) {
        await sleep(1200 * attempt)
        continue
      }
      throw e
    } finally {
      clearTimeout(timer)
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr))
}

/**
 * Chat completion — three-tier chain: seller key → platform gateway → keyless
 * free gateway. Every leg failure is LOGGED; only when all three fail does the
 * caller see an AiError (route → 502 → bot deterministic fallback).
 */
export async function chatComplete(
  messages: ChatMsg[],
  opts: { maxTokens?: number; timeoutMs?: number } = {},
): Promise<ChatResult> {
  const maxTokens = opts.maxTokens ?? 900
  const timeoutMs = opts.timeoutMs ?? 60_000

  // ── Tier A: seller's own key (env or panel-pasted) ──
  const sellerKey = await resolveSellerKey()
  const keyOnCooldown = health.usable === false && Date.now() < health.nextProbeAt
  if (sellerKey && !keyOnCooldown) {
    try {
      const data = (await publicFetch(
        '/chat/completions',
        {
          model: chatModel(),
          messages,
          max_tokens: maxTokens,
          temperature: 0.6,
        },
        { timeoutMs, retries: 3 },
      )) as { choices?: Array<{ message?: { content?: string } }> }
      const content = data.choices?.[0]?.message?.content
      if (typeof content === 'string' && content.trim() !== '') {
        return { content, via: 'user-key' }
      }
      throw new Error('پاسخ خالی از مدل')
    } catch (e) {
      if (e instanceof AuthError) {
        markAuthFailure(e.message)
      } else if (!(e instanceof RateError)) {
        console.warn('[ai:provider] user-key chat failed → next tier:', (e as Error).message?.slice(0, 160))
      } else {
        console.warn('[ai:provider] user-key chat rate-limited → next tier')
      }
    }
  } else if (sellerKey && keyOnCooldown) {
    console.warn(`[ai:provider] user key on auth cooldown (${health.lastError?.slice(0, 80)}) → next tier`)
  }

  // ── Tier B: platform gateway (only when its config file exists) ──
  if (platformConfigAvailable()) {
    try {
      const sdk = await getSdk()
      const completion = await withBackoff(
        () =>
          sdk.chat.completions.create({
            messages: messages.map((m) => ({
              role: m.role === 'system' ? ('assistant' as const) : (m.role as 'assistant' | 'user'),
              content: m.content,
            })),
            thinking: { type: 'disabled' },
            max_tokens: maxTokens,
          }),
        3,
        timeoutMs,
      )
      const content = completion.choices[0]?.message?.content
      if (typeof content === 'string' && content.trim() !== '') {
        return { content, via: 'platform' }
      }
      throw new Error('پاسخ خالی از مدل زبانی')
    } catch (e) {
      console.error('[ai:provider] platform gateway chat failed → free tier:', (e as Error).message?.slice(0, 200))
    }
  }

  // ── Tier C: keyless free gateway (bare-VPS safety net) ──
  if (!freeTierBlocked()) {
    try {
      const content = await freeFetch(messages, maxTokens, timeoutMs)
      return { content, via: 'free' }
    } catch (e) {
      if (!(e instanceof Error && e.message.startsWith('free gateway quota'))) {
        console.error('[ai:provider] free gateway failed too — ALL AI tiers down:', (e as Error).message?.slice(0, 200))
      }
    }
  } else {
    console.warn('[ai:provider] free gateway on quota cooldown → all AI tiers unavailable')
  }

  throw new AiError('هیچ سرویس هوش مصنوعی در دسترس نیست')
}

export type ImageResult = { base64: string; via: 'user-key' | 'platform' }

/** Sizes accepted by the image gateway (SDK type union). */
export type AiImageSize = '1024x1024' | '768x1344' | '864x1152' | '1344x768' | '1152x864' | '1440x720' | '720x1440'

/** Text → image. Seller key (cogview-4) first, platform gateway fallback. */
export async function generateImage(
  prompt: string,
  size: AiImageSize = '1024x1024',
  timeoutMs = 150_000,
): Promise<ImageResult> {
  if (!userKeyBlocked()) {
    try {
      const data = (await publicFetch(
        '/images/generations',
        { model: imageModel(), prompt, size },
        { timeoutMs, retries: 2 },
      )) as { data?: Array<{ url?: string; b64_json?: string }> }
      const item = data.data?.[0]
      let base64 = item?.b64_json
      if (!base64 && item?.url) {
        const ctrl = new AbortController()
        const timer = setTimeout(() => ctrl.abort(), timeoutMs)
        try {
          const res = await fetch(item.url, { signal: ctrl.signal })
          if (res.ok) {
            base64 = Buffer.from(await res.arrayBuffer()).toString('base64')
          }
        } finally {
          clearTimeout(timer)
        }
      }
      if (base64 && base64.length > 100) {
        return { base64, via: 'user-key' }
      }
      throw new Error('پاسخ خالی از سرویس تصویر')
    } catch (e) {
      if (e instanceof AuthError) markAuthFailure(e.message)
      else console.warn('[ai:provider] user-key image-gen failed → platform:', (e as Error).message?.slice(0, 160))
    }
  }

  const sdk = await getSdk()
  const res = (await withBackoff(
    () => sdk.images.generations.create({ prompt, size }) as Promise<{ data?: Array<{ base64?: string }> }>,
    2,
    timeoutMs,
  )) as { data?: Array<{ base64?: string }> }
  const base64 = res?.data?.[0]?.base64
  if (typeof base64 !== 'string' || base64.length < 100) {
    throw new AiError('تولید تصویر ناموفق بود — لطفاً کمی بعد دوباره تلاش کنید')
  }
  return { base64, via: 'platform' }
}

/**
 * Image edit (background isolation / studio composition).
 * The public API exposes no universal edit endpoint, so this leg runs on the
 * platform gateway `images.generations.edit` with an optional model override
 * from AI_IMAGE_MODEL. If the seller's key ever gains an edit endpoint, set
 * AI_USER_EDIT_PATH to enable it.
 */
export async function editImage(
  prompt: string,
  dataUrl: string,
  size: AiImageSize = '1024x1024',
  timeoutMs = 150_000,
): Promise<ImageResult> {
  const userEditPath = (process.env.AI_USER_EDIT_PATH ?? '').trim()

  if (userEditPath && !userKeyBlocked()) {
    try {
      const data = (await publicFetch(
        userEditPath,
        { model: imageModel(), prompt, image: dataUrl, images: [{ url: dataUrl }], size },
        { timeoutMs, retries: 2 },
      )) as { data?: Array<{ b64_json?: string; base64?: string; url?: string }> }
      const item = data.data?.[0]
      let base64 = item?.b64_json ?? item?.base64
      if (!base64 && item?.url) {
        base64 = Buffer.from(await (await fetch(item.url)).arrayBuffer()).toString('base64')
      }
      if (base64 && base64.length > 100) {
        return { base64, via: 'user-key' }
      }
      throw new Error('پاسخ خالی از سرویس تصویر')
    } catch (e) {
      if (e instanceof AuthError) markAuthFailure(e.message)
      else console.warn('[ai:provider] user-key image-edit failed → platform:', (e as Error).message?.slice(0, 160))
    }
  }

  const sdk = await getSdk()
  const body: Record<string, unknown> = {
    prompt,
    image: dataUrl,
    images: [{ url: dataUrl }],
    size,
  }
  const model = process.env.AI_IMAGE_MODEL
  if (model) body.model = model

  const res = (await withBackoff(
    () =>
      sdk.images.generations.edit(
        body as unknown as Parameters<typeof sdk.images.generations.edit>[0],
      ) as Promise<{ base64?: string; data?: Array<{ base64?: string }> }>,
    2,
    timeoutMs,
  )) as { base64?: string; data?: Array<{ base64?: string }> }

  const base64 =
    typeof res?.base64 === 'string' ? res.base64 : res?.data?.[0]?.base64
  if (typeof base64 !== 'string' || base64.length < 100) {
    throw new AiError('پردازش تصویر ناموفق بود — لطفاً کمی بعد دوباره تلاش کنید')
  }
  return { base64, via: 'platform' }
}

// ─── Shared retry with 429-aware backoff (provider B leg) ────────────────────

async function withBackoff<T>(fn: () => Promise<T>, attempts: number, timeoutMs: number): Promise<T> {
  let lastErr: unknown = null
  for (let attempt = 1; attempt <= attempts; attempt++) {
    // The SDK has no abort support; race it against a timer instead.
    const result = await Promise.race([
      fn().then(
        (v) => ({ ok: true as const, v }),
        (e) => ({ ok: false as const, e }),
      ),
      new Promise<{ ok: false; e: Error }>((resolve) =>
        setTimeout(() => resolve({ ok: false, e: new Error('timeout') }), timeoutMs),
      ),
    ])
    const r = result as { ok: boolean; v?: T; e?: unknown }
    if (r.ok) return r.v as T
    lastErr = r.e
    const msg = r.e instanceof Error ? r.e.message : String(r.e)
    const isRate = msg.includes('429') || msg.toLowerCase().includes('too many')
    if (isRate && attempt < attempts) {
      const wait = Math.min(3000 * 2 ** (attempt - 1), 15_000)
      console.warn(`[ai:provider] platform gateway 429 — backing off ${wait}ms`)
      await sleep(wait)
      continue
    }
    if (!isRate && attempt < attempts) await sleep(800 * attempt)
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr))
}
