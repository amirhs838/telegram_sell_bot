import 'server-only'

import { existsSync } from 'node:fs'
import path from 'node:path'
import ZAI from 'z-ai-web-dev-sdk'
import { db } from '@/lib/db'

/**
 * Four-tier AI layer — owner-requested primary provider: OPENROUTER.
 *
 * OpenRouter (openrouter.ai) fronts hundreds of models behind ONE API key
 * billed per use from the seller's own credit balance — no more Google
 * free-tier daily quota roulette. The seller configures everything from the
 * admin panel (no SSH needed):
 *   • the API key     → Setting row «openRouterApiKey»  (env: OPENROUTER_API_KEY)
 *   • the TEXT model  → Setting row «aiTextModel»       (env: OPENROUTER_TEXT_MODEL)
 *                       — brain of the sales assistant + the RAG answerer
 *   • the IMAGE model → Setting row «aiImageModel»      (env: OPENROUTER_IMAGE_MODEL)
 *                       — engine of the AI Image Studio (cutout + composite)
 *
 *  Tier A (primary) — OPENROUTER on its OpenAI-compatible endpoint
 *    (openrouter.ai/api/v1).
 *  Tier B — the seller's OWN Z.ai key (env ZAI_API_KEY / Setting «zaiApiKey»).
 *  Tier C (sandbox/dev) — the platform-managed z-ai-web-dev-sdk gateway,
 *    only attempted when a .z-ai-config file actually exists.
 *  Tier D (zero-config safety net) — a keyless OpenAI-compatible free
 *    gateway (text.pollinations.ai/openai, env-overridable).
 *
 * Health: an OpenRouter auth/credit failure is cached for a cooldown window
 * on the TEXT tier (no per-message latency tax); IMAGE failures park the key
 * with a kind (quota | auth | credits | model) and a clear Persian message.
 * EVERY leg failure is logged loudly — silent AI death must never happen again.
 */

// ─── Configuration ───────────────────────────────────────────────────────────

/** OpenRouter — single OpenAI-compatible surface for text AND image models. */
const OPENROUTER_API_BASE = 'https://openrouter.ai/api/v1'

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

// ─── OpenRouter key sources (env first, then the panel-pasted Setting copy) ──

export function openRouterEnvKey(): string {
  return (process.env.OPENROUTER_API_KEY ?? '').trim()
}

let openRouterSettingKeyCache: { value: string; at: number } | null = null
async function openRouterSettingKey(): Promise<string> {
  const now = Date.now()
  if (openRouterSettingKeyCache && now - openRouterSettingKeyCache.at < 30_000)
    return openRouterSettingKeyCache.value
  let value = ''
  try {
    const row = await db.setting.findUnique({ where: { key: 'openRouterApiKey' } })
    value = row?.value?.trim() ?? ''
  } catch {
    value = '' // DB hiccup must not break the AI
  }
  openRouterSettingKeyCache = { value, at: now }
  return value
}

/** Called when the panel saves/clears the OpenRouter key so the next call reads fresh. */
export function invalidateOpenRouterSettingCache() {
  openRouterSettingKeyCache = null
}

export async function resolveOpenRouterKey(): Promise<string> {
  const env = openRouterEnvKey()
  if (env) return env
  return openRouterSettingKey()
}

export function keyFingerprint(key: string): string {
  return `${key.slice(0, 12)}…${key.slice(-4)}`
}

// ─── Model configuration (panel Setting row → env → sensible default) ────────

export const DEFAULT_TEXT_MODEL = (process.env.OPENROUTER_TEXT_MODEL ?? 'openai/gpt-4o-mini').trim()
export const DEFAULT_IMAGE_MODEL = (process.env.OPENROUTER_IMAGE_MODEL ?? 'google/gemini-nano-banana-2.1').trim()

/** Tried in order when the configured image model is not available for the key. */
const IMAGE_MODEL_FALLBACKS = [
  'google/gemini-3.1-flash-image',
  'bytedance-seed/seedream-5-0-flash',
  'openai/gpt-image-2.5-flare',
]

let modelCache: { text: string; image: string; at: number } | null = null

/**
 * Resolve BOTH configured models in one DB read (panel values win; env and
 * defaults are the fallback). Cached 30 s per process.
 */
export async function resolveAiModels(): Promise<{ text: string; image: string }> {
  const now = Date.now()
  if (modelCache && now - modelCache.at < 30_000) return { text: modelCache.text, image: modelCache.image }
  let text = ''
  let image = ''
  try {
    const rows = await db.setting.findMany({
      where: { key: { in: ['aiTextModel', 'aiImageModel'] } },
      select: { key: true, value: true },
    })
    text = (rows.find((r) => r.key === 'aiTextModel')?.value ?? '').trim()
    image = (rows.find((r) => r.key === 'aiImageModel')?.value ?? '').trim()
  } catch {
    // DB hiccup → fall through to env/defaults
  }
  const resolved = { text: text || DEFAULT_TEXT_MODEL, image: image || DEFAULT_IMAGE_MODEL }
  modelCache = { ...resolved, at: now }
  return resolved
}

export function invalidateAiModelCache() {
  modelCache = null
}

// ─── OpenRouter TEXT-tier health cache (survives HMR via globalThis) ─────────

const AUTH_COOLDOWN_MS = 10 * 60 * 1000 // auth/credit-failed key probed again after 10 min

type Health = {
  usable: boolean | null
  lastError?: string
  nextProbeAt: number
  lastProbeAt: number
}

const globalForOpenRouterHealth = globalThis as unknown as { __aiOpenRouterHealth?: Health }
const openRouterHealth: Health = (globalForOpenRouterHealth.__aiOpenRouterHealth ??= {
  usable: null,
  nextProbeAt: 0,
  lastProbeAt: 0,
})

function openRouterMarkAuthFailure(error: string) {
  openRouterHealth.usable = false
  openRouterHealth.lastError = error.slice(0, 300)
  openRouterHealth.lastProbeAt = Date.now()
  openRouterHealth.nextProbeAt = Date.now() + AUTH_COOLDOWN_MS
  console.error(
    `[ai:provider] OpenRouter key rejected (${error.slice(0, 120)}) — skipping the OpenRouter tier for the next ${AUTH_COOLDOWN_MS / 60000} min`,
  )
}

function openRouterMarkUsable() {
  openRouterHealth.usable = true
  openRouterHealth.lastError = undefined
  openRouterHealth.lastProbeAt = Date.now()
  openRouterHealth.nextProbeAt = Date.now()
}

function openRouterBlocked(): boolean {
  return openRouterHealth.usable === false && Date.now() < openRouterHealth.nextProbeAt
}

// ─── Shared error types ──────────────────────────────────────────────────────

export class AiError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AiError'
  }
}

class AuthError extends Error {}
class RateError extends Error {}
/** HTTP 402 — the OpenRouter credit balance is empty. */
class CreditsError extends Error {}
/** Model/policy/modality problems — retryable with a different model. */
class MarkerError extends Error {}

// ─── OpenRouter chat (TEXT tier A) ───────────────────────────────────────────

/**
 * OpenRouter chat completion on the OpenAI-compatible endpoint. Auth/credit
 * errors throw AuthError/CreditsError (→ cooldown), 429 backs off with
 * Retry-After, 5xx retries, empty content throws.
 */
async function openRouterChatFetch(
  messages: ChatMsg[],
  model: string,
  maxTokens: number,
  opts: FetchOpts,
): Promise<unknown> {
  const key = await resolveOpenRouterKey()
  if (!key) throw new Error('کلید OpenRouter تنظیم نشده است')
  let lastStatus = 0
  let lastBody = ''

  for (let attempt = 1; attempt <= opts.retries; attempt++) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), opts.timeoutMs)
    try {
      const res = await fetch(`${OPENROUTER_API_BASE}/chat/completions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${key}`,
          'Content-Type': 'application/json',
          'X-Title': 'Silver Love Shop',
        },
        body: JSON.stringify({
          model,
          messages,
          max_tokens: maxTokens,
          temperature: 0.6,
        }),
        signal: controller.signal,
      })
      const text = await res.text()

      if (res.ok) {
        openRouterMarkUsable()
        return JSON.parse(text) as unknown
      }

      lastStatus = res.status
      lastBody = text.slice(0, 400)

      if (res.status === 401 || res.status === 403) {
        throw new AuthError(`HTTP ${res.status}: ${lastBody}`)
      }
      if (res.status === 402) {
        throw new CreditsError(`HTTP 402: ${lastBody}`)
      }

      if (res.status === 429) {
        const retryAfter = Number(res.headers.get('retry-after'))
        const waitMs = Number.isFinite(retryAfter) && retryAfter > 0
          ? Math.min(retryAfter * 1000, 30_000)
          : Math.min(2000 * 2 ** (attempt - 1), 20_000)
        if (attempt < opts.retries) {
          console.warn(`[ai:provider] OpenRouter 429 — backing off ${waitMs}ms (attempt ${attempt}/${opts.retries})`)
          await sleep(waitMs)
          continue
        }
        throw new RateError(lastBody)
      }

      if (res.status >= 400 && res.status < 500) {
        throw new Error(`HTTP ${res.status}: ${lastBody}`)
      }

      if (attempt < opts.retries) {
        await sleep(1500 * attempt)
        continue
      }
      throw new Error(`HTTP ${res.status}: ${lastBody}`)
    } catch (e) {
      if (e instanceof AuthError || e instanceof RateError || e instanceof CreditsError) throw e
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

/**
 * Targeted OpenRouter probe for the panel's «تست اتصال» button — NEVER falls
 * back to another tier, so a broken key/model is reported as broken instead
 * of silently passing via a lower tier.
 */
export async function probeOpenRouter(): Promise<{
  ok: boolean
  error?: string
  latencyMs: number
  sample?: string
}> {
  const t0 = Date.now()
  const key = await resolveOpenRouterKey()
  if (!key) return { ok: false, error: 'کلید OpenRouter تنظیم نشده است', latencyMs: 0 }
  const { text: model } = await resolveAiModels()
  try {
    const data = (await openRouterChatFetch(
      [
        { role: 'assistant', content: 'فقط یک واژه فارسی برگردان.' },
        { role: 'user', content: 'سلام' },
      ],
      model,
      30,
      { timeoutMs: 30_000, retries: 2 },
    )) as { choices?: Array<{ message?: { content?: string } }> }
    const content = data.choices?.[0]?.message?.content
    if (typeof content === 'string' && content.trim() !== '') {
      return { ok: true, latencyMs: Date.now() - t0, sample: content.trim().slice(0, 60) }
    }
    return { ok: false, error: 'پاسخ خالی از OpenRouter', latencyMs: Date.now() - t0 }
  } catch (e) {
    return { ok: false, error: (e as Error).message.slice(0, 300), latencyMs: Date.now() - t0 }
  }
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

export function providerStatus(): {
  userKeyConfigured: boolean
  openRouterKeyConfigured: boolean
  chatModel: string
  userKeyHealthy: boolean | null // null = not probed yet
  openRouterHealthy: boolean | null // null = not probed yet
  lastUserKeyError?: string
  lastOpenRouterError?: string
} {
  return {
    userKeyConfigured: userApiKey() !== '',
    openRouterKeyConfigured: openRouterEnvKey() !== '',
    chatModel: chatModel(),
    userKeyHealthy: health.usable,
    openRouterHealthy: openRouterHealth.usable,
    lastUserKeyError: health.lastError,
    lastOpenRouterError: openRouterHealth.lastError,
  }
}

// ─── Provider-B health cache (survives HMR via globalThis) ───────────────────

type HealthB = Health

const globalForHealth = globalThis as unknown as { __aiProviderHealth?: HealthB }
const health: HealthB = (globalForHealth.__aiProviderHealth ??= {
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
  via: 'openrouter' | 'user-key' | 'platform' | 'free'
}

// ─── Tier D cooldown (survives HMR via globalThis) ──────────────────────────

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
 * Tier D — keyless OpenAI-compatible gateway. No auth header at all; keeps
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
 * Chat completion — four-tier chain: OpenRouter (owner-requested primary) →
 * seller Z.ai key → platform gateway → keyless free gateway. Every leg
 * failure is LOGGED; only when all four fail does the caller see an AiError
 * (route → 502 → bot deterministic fallback).
 */
export async function chatComplete(
  messages: ChatMsg[],
  opts: { maxTokens?: number; timeoutMs?: number } = {},
): Promise<ChatResult> {
  const maxTokens = opts.maxTokens ?? 2000
  const timeoutMs = opts.timeoutMs ?? 60_000

  // ── Tier A: OpenRouter (env or panel-pasted key, configured text model) ──
  const orKey = await resolveOpenRouterKey()
  if (orKey && !openRouterBlocked()) {
    const { text: model } = await resolveAiModels()
    try {
      const data = (await openRouterChatFetch(messages, model, maxTokens, {
        timeoutMs,
        retries: 3,
      })) as { choices?: Array<{ message?: { content?: string } }> }
      const content = data.choices?.[0]?.message?.content
      if (typeof content === 'string' && content.trim() !== '') {
        return { content, via: 'openrouter' }
      }
      throw new Error('پاسخ خالی از OpenRouter')
    } catch (e) {
      if (e instanceof AuthError) {
        openRouterMarkAuthFailure(e.message)
      } else if (e instanceof CreditsError) {
        openRouterMarkAuthFailure(`اعتبار OpenRouter تمام شده: ${e.message}`)
      } else if (!(e instanceof RateError)) {
        console.warn('[ai:provider] OpenRouter chat failed → next tier:', (e as Error).message?.slice(0, 160))
      } else {
        console.warn('[ai:provider] OpenRouter rate-limited → next tier')
      }
    }
  } else if (orKey && openRouterBlocked()) {
    console.warn(`[ai:provider] OpenRouter key on cooldown (${openRouterHealth.lastError?.slice(0, 80)}) → next tier`)
  }

  // ── Tier B: seller's own Z.ai key (env or panel-pasted) ──
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

  // ── Tier C: platform gateway (only when its config file exists) ──
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

  // ── Tier D: keyless free gateway (bare-VPS safety net) ──
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

// ─── OpenRouter image pipeline (the seller's OWN key ONLY) ───────────────────
//
// Master directive: EVERYTHING image-related (studio cutout, background
// composition, custom backgrounds) runs on OpenRouter with the seller's own
// credit balance and NEVER falls back to another image provider.
//
// OpenRouter exposes a DEDICATED Image API:
//   POST /api/v1/images  { model, prompt, input_references?: [{type:'image_url', image_url:{url}}] }
//   → { data: [{ b64_json, media_type? }], usage? }
// Reference images may be HTTP(S) URLs or base64 data URLs — the studio sends
// the product photo (and an optional custom-background reference) as data URLs.
//
// Billing reality: image renders are billed per use from the OpenRouter
// credit balance (no daily zero-quota). Rate limits (429) park the key with
// OpenRouter's own Retry-After so the studio reports an honest wait time.

export type OpenRouterImageResult = { base64: string; mimeType: string; via: string }

type OpenRouterImageResponse = {
  data?: Array<{ b64_json?: string; media_type?: string }>
  error?: { code?: number | string; message?: string }
}

// Image parks (survive HMR via globalThis). Quota (429) parks the key until
// OpenRouter's Retry-After; auth parks 10 min; credits parks 15 min so the
// panel can warn the seller instead of hammering a dead balance.
type ImagePark = { blockedUntil: number; reason: string; kind: 'quota' | 'auth' | 'credits' | 'model' }
const globalForImageParks = globalThis as unknown as {
  __aiOpenRouterImageParks?: Map<string, ImagePark>
}
const imageParks: Map<string, ImagePark> = (globalForImageParks.__aiOpenRouterImageParks ??= new Map())

function parkImageKey(
  key: string,
  untilMs: number,
  reason: string,
  kind: ImagePark['kind'],
) {
  imageParks.set(keyFingerprint(key), {
    blockedUntil: Date.now() + untilMs,
    reason: reason.slice(0, 1000),
    kind,
  })
}

function imageKeyPark(key: string): ImagePark | null {
  const st = imageParks.get(keyFingerprint(key)) ?? null
  return st && Date.now() < st.blockedUntil ? st : null
}

function clearImagePark(key: string) {
  imageParks.delete(keyFingerprint(key))
}

/** The image model chain: configured primary first, then known-good fallbacks. */
async function imageModelCandidates(): Promise<string[]> {
  const { image: primary } = await resolveAiModels()
  return [primary, ...IMAGE_MODEL_FALLBACKS.filter((m) => m !== primary)]
}

/** Parse Retry-After seconds from a 429 response (JSON body, best-effort). */
function parseRetryAfterSeconds(body: string): number | null {
  const m = body.match(/"retry-after"\s*:\s*(\d+)/i)
  if (m) {
    const n = Number(m[1])
    if (Number.isFinite(n) && n > 0) return n
  }
  return null
}

/** Extract "message" from an OpenRouter error JSON body (best-effort). */
function openRouterErrorMessage(body: string): string {
  try {
    const j = JSON.parse(body) as { error?: { message?: string } }
    return j.error?.message ?? body.slice(0, 300)
  } catch {
    return body.slice(0, 300)
  }
}

/**
 * One POST /api/v1/images call against a specific image model.
 * Throws AuthError (bad key), RateError (rate limit), CreditsError (402),
 * MarkerError (model/policy issues — retryable with a different model), or
 * plain Error for transient HTTP problems.
 */
async function openRouterImageRequestOnce(
  key: string,
  model: string,
  prompt: string,
  referenceDataUrls: string[],
  timeoutMs: number,
): Promise<{ base64: string; mimeType: string }> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const body: Record<string, unknown> = { model, prompt }
    if (referenceDataUrls.length > 0) {
      body.input_references = referenceDataUrls.map((url) => ({
        type: 'image_url',
        image_url: { url },
      }))
    }
    const res = await fetch(`${OPENROUTER_API_BASE}/images`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
        'X-Title': 'Silver Love Shop',
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    })
    const text = await res.text()

    if (res.ok) {
      const data = JSON.parse(text) as OpenRouterImageResponse
      // OpenRouter surfaces provider-side failures inside a 200 response too.
      const inlineErr = data.error?.message
      const item = data.data?.find((i) => i.b64_json)
      if (item?.b64_json) {
        return { base64: item.b64_json, mimeType: item.media_type || 'image/png' }
      }
      if (inlineErr) throw new MarkerError(`PROVIDER_ERROR:${inlineErr.slice(0, 200)}`)
      throw new MarkerError('NO_IMAGE')
    }

    const msg = openRouterErrorMessage(text)
    if (res.status === 429) throw new RateError(msg || text.slice(0, 300))
    if (res.status === 401 || res.status === 403) throw new AuthError(msg)
    if (res.status === 402) throw new CreditsError(msg)
    if (res.status === 404) throw new MarkerError(`MODEL_404:${model}`)
    if (res.status === 400) throw new MarkerError(`BAD_REQUEST:${msg}`)
    throw new Error(`HTTP ${res.status}: ${msg}`)
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Shared runner: the configured OpenRouter image model first, then known-good
 * fallbacks. NO non-OpenRouter image provider is ever contacted — the studio
 * is OpenRouter-only by design.
 */
async function runOpenRouterImage(
  prompt: string,
  referenceDataUrls: string[],
  timeoutMs: number,
): Promise<OpenRouterImageResult> {
  const key = await resolveOpenRouterKey()
  if (!key) {
    throw new AiError(
      'کلید OpenRouter تنظیم نشده است — از پنل، بخش تنظیمات، کلید OpenRouter را وارد کنید',
    )
  }

  const parked = imageKeyPark(key)
  if (parked) {
    const when = formatTehranClock(parked.blockedUntil)
    if (parked.kind === 'auth') {
      throw new AiError('کلید OpenRouter برای تصویر پذیرفته نشد — درست بودن کلید را در تنظیمات بررسی کنید')
    }
    if (parked.kind === 'credits') {
      throw new AiError(
        'اعتبار حساب OpenRouter تمام شده است — از openrouter.ai/credits حساب را شارژ کنید و دوباره امتحان کنید',
      )
    }
    if (parked.kind === 'model') {
      throw new AiError('مدل تصویر در OpenRouter در دسترس نیست — نام مدل را در تنظیمات پنل بررسی کنید')
    }
    throw new AiError(
      when
        ? `سهمیهٔ مدل تصویر فعلاً پر است — حدود ساعت ${when} به وقت ایران دوباره امتحان کنید`
        : 'سهمیهٔ مدل تصویر فعلاً پر است — کمی بعد دوباره امتحان کنید',
    )
  }

  const models = await imageModelCandidates()
  let sawQuota = false
  let sawAuth = false
  let sawCredits = false
  let sawModel404 = false
  let sawBlock = ''
  let lastDetail = ''
  let quotaResetAt = 0

  for (const model of models) {
    try {
      const r = await openRouterImageRequestOnce(key, model, prompt, referenceDataUrls, timeoutMs)
      clearImagePark(key)
      console.log(`[ai:provider] openrouter image OK via ${model}`)
      return { base64: r.base64, mimeType: r.mimeType, via: `openrouter:${model}` }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      lastDetail = msg.slice(0, 300)

      if (e instanceof RateError) {
        // OpenRouter 429 bodies rarely carry a retry hint; park 30 min by
        // default (free-tier daily caps are the usual cause).
        const secs = parseRetryAfterSeconds(msg) ?? 1800
        const wait = Math.min(Math.max(secs * 1000, 60_000), 26 * 3600 * 1000)
        parkImageKey(key, wait, msg, 'quota')
        sawQuota = true
        const resetHere = Date.now() + wait
        quotaResetAt = quotaResetAt === 0 ? resetHere : Math.min(quotaResetAt, resetHere)
        console.warn(
          `[ai:provider] openrouter image rate-limited via ${model} — parked ${(wait / 60000).toFixed(0)} min`,
        )
        continue
      }
      if (e instanceof AuthError) {
        parkImageKey(key, AUTH_COOLDOWN_MS, msg, 'auth')
        sawAuth = true
        break
      }
      if (e instanceof CreditsError) {
        parkImageKey(key, 15 * 60 * 1000, msg, 'credits')
        sawCredits = true
        break
      }
      if (e instanceof MarkerError && msg.startsWith('MODEL_404:')) {
        sawModel404 = true
        continue // next fallback model
      }
      if (e instanceof MarkerError && (msg.startsWith('PROVIDER_ERROR:') || msg.startsWith('NO_IMAGE'))) {
        if (msg.startsWith('PROVIDER_ERROR:') && /safety|blocked|policy/i.test(msg)) {
          sawBlock = msg.replace('PROVIDER_ERROR:', '').slice(0, 60)
          break
        }
        sawBlock = msg.slice(0, 80)
        continue // next fallback model
      }
      // Transient HTTP / network error → next fallback model.
      continue
    }
  }

  if (sawCredits) {
    throw new AiError(
      'اعتبار حساب OpenRouter تمام شده است — از openrouter.ai/credits حساب را شارژ کنید (تصویرسازی بر اساس مصرف از اعتبار کم می‌شود، دیگر سهمیهٔ صفر روزانه وجود ندارد)',
    )
  }
  if (sawAuth) {
    throw new AiError('کلید OpenRouter برای تصویر پذیرفته نشد — درست بودن کلید را در تنظیمات پنل بررسی کنید')
  }
  if (sawQuota) {
    const when = quotaResetAt > Date.now() ? formatTehranClock(quotaResetAt) : ''
    throw new AiError(
      when
        ? `نرخ مدل تصویر فعلاً محدود شده است — حدود ساعت ${when} به وقت ایران دوباره امتحان کنید، یا مدل تصویر دیگری در تنظیمات پنل بگذارید`
        : 'نرخ مدل تصویر فعلاً محدود شده است — کمی بعد دوباره امتحان کنید، یا مدل تصویر دیگری در تنظیمات پنل بگذارید',
    )
  }
  if (sawModel404) {
    throw new AiError(
      'مدل تصویر در OpenRouter پیدا نشد — نام مدل را در تنظیمات پنل بررسی کنید (مثال درست: google/gemini-nano-banana-2.1)',
    )
  }
  if (sawBlock) {
    throw new AiError(
      'مدل تصویری برنگرداند — توضیح پس‌زمینه یا عکس ورودی را کمی تغییر دهید و دوباره امتحان کنید',
    )
  }
  if (lastDetail.includes('aborted') || lastDetail.includes('timeout')) {
    throw new AiError('پردازش تصویر بیش از حد طول کشید — لطفاً دوباره تلاش کنید')
  }
  throw new AiError('تولید تصویر ناموفق بود — لطفاً کمی بعد دوباره تلاش کنید')
}

function formatTehranClock(ms: number): string {
  try {
    return new Intl.DateTimeFormat('fa-IR', {
      timeZone: 'Asia/Tehran',
      hour: '2-digit',
      minute: '2-digit',
    }).format(new Date(ms))
  } catch {
    return ''
  }
}

/** Text → image on the seller's own OpenRouter credit balance. */
export async function openRouterImageGenerate(
  prompt: string,
  timeoutMs = 150_000,
): Promise<OpenRouterImageResult> {
  return runOpenRouterImage(prompt, [], timeoutMs)
}

/**
 * Image editing (studio cutout / background composition) on the seller's own
 * OpenRouter. `dataUrls` holds 1–3 data URLs: the first is always the PRODUCT
 * photo; optional extra images (custom background reference) follow.
 */
export async function openRouterImageEdit(
  prompt: string,
  dataUrls: string[],
  timeoutMs = 150_000,
): Promise<OpenRouterImageResult> {
  const refs: string[] = []
  for (const dataUrl of dataUrls.slice(0, 3)) {
    if (!/^data:[^;]+;base64,[\s\S]+$/.test(dataUrl)) {
      throw new AiError('قالب تصویر ورودی معتبر نیست')
    }
    refs.push(dataUrl)
  }
  return runOpenRouterImage(prompt, refs, timeoutMs)
}

// ─── Panel status (admin «وضعیت OpenRouter» box) ─────────────────────────────

export type OpenRouterAccount = {
  label: string | null
  isFreeTier: boolean
  usage: number | null
  limit: number | null
  limitRemaining: number | null
}

export type OpenRouterKeyStatus = {
  keyConfigured: boolean
  source: 'env' | 'panel' | 'none'
  fingerprint: string | null
  parkedUntil: number | null
  parkKind: 'quota' | 'auth' | 'credits' | 'model' | null
  parkReason: string | null
  textModel: string
  imageModel: string
}

/**
 * Live status for the panel's self-service OpenRouter manager: masked key
 * fingerprint + whether the image pipeline is currently parked (and why).
 */
export async function openRouterKeyStatus(): Promise<OpenRouterKeyStatus> {
  const env = openRouterEnvKey()
  const panel = await openRouterSettingKey()
  const key = env || panel
  const { text, image } = await resolveAiModels()
  const park = key ? imageKeyPark(key) : null
  return {
    keyConfigured: Boolean(key),
    source: env ? 'env' : panel ? 'panel' : 'none',
    fingerprint: key ? keyFingerprint(key) : null,
    parkedUntil: park && Date.now() < park.blockedUntil ? park.blockedUntil : null,
    parkKind: park ? park.kind : null,
    parkReason: park ? park.reason.slice(0, 200) : null,
    textModel: text,
    imageModel: image,
  }
}

/**
 * Best-effort credit balance lookup (GET /api/v1/key). Never throws — the
 * panel degrades to "وضعیت حساب در دسترس نیست" when OpenRouter is unreachable.
 */
export async function openRouterAccountInfo(): Promise<OpenRouterAccount | null> {
  const key = await resolveOpenRouterKey()
  if (!key) return null
  try {
    const res = await fetch(`${OPENROUTER_API_BASE}/key`, {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(8000),
    })
    if (!res.ok) return null
    const j = (await res.json()) as {
      data?: {
        label?: string
        limit?: number | null
        usage?: number
        limit_remaining?: number | null
        is_free_tier?: boolean
      }
    }
    if (!j.data) return null
    return {
      label: j.data.label ?? null,
      isFreeTier: Boolean(j.data.is_free_tier),
      usage: typeof j.data.usage === 'number' ? j.data.usage : null,
      limit: j.data.limit ?? null,
      limitRemaining: j.data.limit_remaining ?? null,
    }
  } catch {
    return null
  }
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
