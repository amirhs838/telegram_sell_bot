import 'server-only'

import { existsSync } from 'node:fs'
import path from 'node:path'
import ZAI from 'z-ai-web-dev-sdk'
import { db } from '@/lib/db'

/**
 * Four-tier AI layer — designed to keep the bot ALIVE on a bare VPS where
 * neither the seller's key nor the platform gateway exists (root cause of the
 * "bot answers the same menu for every message" production bug):
 *
 *  Tier A (best, owner-requested default) — GOOGLE GEMINI.
 *    Sources, in order:
 *    1. `GEMINI_API_KEY` in .env (deploy-time)
 *    2. Setting row «geminiApiKey» — pasted from the admin panel (no SSH needed)
 *    Called on Google's OpenAI-compatible endpoint
 *    (generativelanguage.googleapis.com/v1beta/openai) with model gemini-2.0-flash
 *    (fast, excellent Persian, generous free tier).
 *
 *  Tier B — the seller's OWN Z.ai key. Sources, in order:
 *    1. `ZAI_API_KEY` in .env (deploy-time)
 *    2. Setting row «zaiApiKey» — pasted from the admin panel (no SSH needed)
 *    Called on the public OpenAI-compatible endpoint (api.z.ai/api/paas/v4).
 *
 *  Tier C (sandbox/dev) — the platform-managed z-ai-web-dev-sdk gateway.
 *    Only attempted when a .z-ai-config file actually exists (project/home/etc);
 *    on a customer VPS it never does, and every blind attempt wasted ~seconds
 *    before dying with "Configuration file not found".
 *
 *  Tier D (zero-config safety net) — a keyless OpenAI-compatible free
 *    gateway (text.pollinations.ai/openai, env-overridable). Keeps the sales
 *    assistant responsive out-of-the-box until the owner pastes their own key.
 *
 * Gemini/Z.ai health: an auth failure (401) is cached for a cooldown window so
 * every request doesn't pay the extra latency; re-probed after the cooldown.
 * 429 responses retry with real backoff (Retry-After aware) on all tiers.
 * EVERY leg failure is logged loudly — silent AI death must never happen again.
 */

// ─── Configuration ───────────────────────────────────────────────────────────

const PUBLIC_API_BASE = 'https://api.z.ai/api/paas/v4'

/** Google Gemini — OpenAI-compatible surface (same request/response shapes). */
const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta/openai'

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

// ─── Gemini key sources (env first, then the panel-pasted Setting copy) ─────

export function geminiEnvKey(): string {
  return (process.env.GEMINI_API_KEY ?? '').trim()
}

/** Owner-selectable Gemini model (default: fast + great Persian + free tier).
 *  NOTE: Gemini 3.x models are "thinking" models — hidden reasoning tokens
 *  consume the max_tokens budget, so the Gemini leg always raises the token
 *  ceiling and runs with reasoning_effort "low" for snappy sales replies. */
export function geminiModel(): string {
  return (process.env.GEMINI_TEXT_MODEL ?? 'gemini-3.5-flash').trim()
}

let geminiSettingKeyCache: { value: string; at: number } | null = null
async function geminiSettingKey(): Promise<string> {
  const now = Date.now()
  if (geminiSettingKeyCache && now - geminiSettingKeyCache.at < 30_000) return geminiSettingKeyCache.value
  let value = ''
  try {
    const row = await db.setting.findUnique({ where: { key: 'geminiApiKey' } })
    value = row?.value?.trim() ?? ''
  } catch {
    value = '' // DB hiccup must not break the AI
  }
  geminiSettingKeyCache = { value, at: now }
  return value
}

export async function resolveGeminiKey(): Promise<string> {
  const env = geminiEnvKey()
  if (env) return splitGeminiKeys(env)[0] ?? ''
  return splitGeminiKeys(await geminiSettingKey())[0] ?? ''
}

/**
 * Accepts one OR several Gemini API keys (comma / semicolon / newline /
 * Persian-comma separated). Multiple keys rotate the image quota: each AI
 * Studio project has its own tiny free daily image allowance, so 2–3 keys
 * multiply the number of studio renders per day.
 */
export function splitGeminiKeys(raw: string): string[] {
  return raw
    .split(/[\s,;،]+/)
    .map((k) => k.trim())
    .filter((k) => k.length >= 20)
}

/** Every Gemini key available for IMAGE work: .env first, then the panel. */
async function resolveGeminiImageKeys(): Promise<string[]> {
  const keys = [...splitGeminiKeys(geminiEnvKey()), ...splitGeminiKeys(await geminiSettingKey())]
  return [...new Set(keys)]
}

// ─── Gemini health cache (survives HMR via globalThis) ───────────────────────

const globalForGeminiHealth = globalThis as unknown as { __aiGeminiHealth?: Health }
const geminiHealth: Health = (globalForGeminiHealth.__aiGeminiHealth ??= {
  usable: null,
  nextProbeAt: 0,
  lastProbeAt: 0,
})

function geminiMarkAuthFailure(error: string) {
  geminiHealth.usable = false
  geminiHealth.lastError = error.slice(0, 300)
  geminiHealth.lastProbeAt = Date.now()
  geminiHealth.nextProbeAt = Date.now() + AUTH_COOLDOWN_MS
  console.error(
    `[ai:provider] Gemini key rejected by Google (${error.slice(0, 120)}) — skipping the Gemini tier for the next ${AUTH_COOLDOWN_MS / 60000} min`,
  )
}

function geminiMarkUsable() {
  geminiHealth.usable = true
  geminiHealth.lastError = undefined
  geminiHealth.lastProbeAt = Date.now()
  geminiHealth.nextProbeAt = Date.now()
}

function geminiBlocked(): boolean {
  return geminiHealth.usable === false && Date.now() < geminiHealth.nextProbeAt
}

/**
 * Gemini chat completion on the OpenAI-compatible endpoint. Same contract as
 * the Z.ai publicFetch leg: auth errors throw AuthError (→ cooldown), 429
 * backs off with Retry-After, 5xx retries, empty content throws.
 */
async function geminiChatFetch(
  messages: ChatMsg[],
  model: string,
  maxTokens: number,
  opts: FetchOpts,
): Promise<unknown> {
  const key = await resolveGeminiKey()
  if (!key) throw new Error('کلید جمنای تنظیم نشده است')
  let lastStatus = 0
  let lastBody = ''

  for (let attempt = 1; attempt <= opts.retries; attempt++) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), opts.timeoutMs)
    try {
      const res = await fetch(`${GEMINI_API_BASE}/chat/completions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${key}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model,
          messages,
          max_tokens: maxTokens,
          temperature: 0.6,
          // Gemini 3.x is a thinking model — keep reasoning minimal for
          // conversational latency; without this + a raised token ceiling the
          // model returns EMPTY content (finish_reason "length") because the
          // budget was eaten by hidden reasoning tokens.
          reasoning_effort: 'low',
        }),
        signal: controller.signal,
      })
      const text = await res.text()

      if (res.ok) {
        geminiMarkUsable()
        return JSON.parse(text) as unknown
      }

      lastStatus = res.status
      lastBody = text.slice(0, 400)

      if (res.status === 401 || res.status === 403) {
        throw new AuthError(`HTTP ${res.status}: ${lastBody}`)
      }
      // Google reports malformed/invalid keys as 400 INVALID_ARGUMENT —
      // treat it as an auth failure so the cooldown applies (no per-message
      // retry tax for a dead key).
      if (res.status === 400 && lastBody.includes('API key')) {
        throw new AuthError(`HTTP 400: ${lastBody}`)
      }

      if (res.status === 429) {
        const retryAfter = Number(res.headers.get('retry-after'))
        const waitMs = Number.isFinite(retryAfter) && retryAfter > 0
          ? Math.min(retryAfter * 1000, 30_000)
          : Math.min(2000 * 2 ** (attempt - 1), 20_000)
        if (attempt < opts.retries) {
          console.warn(`[ai:provider] Gemini 429 — backing off ${waitMs}ms (attempt ${attempt}/${opts.retries})`)
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

/**
 * Targeted Gemini probe for the panel's «تست اتصال» button — NEVER falls back
 * to another tier, so a broken key is reported as broken instead of silently
 * passing via the free gateway.
 */
export async function probeGemini(): Promise<{
  ok: boolean
  error?: string
  latencyMs: number
  sample?: string
}> {
  const t0 = Date.now()
  const key = await resolveGeminiKey()
  if (!key) return { ok: false, error: 'کلید جمنای تنظیم نشده است', latencyMs: 0 }
  try {
    const data = (await geminiChatFetch(
      [
        { role: 'assistant', content: 'فقط یک واژه فارسی برگردان.' },
        { role: 'user', content: 'سلام' },
      ],
      geminiModel(),
      30,
      { timeoutMs: 30_000, retries: 2 },
    )) as { choices?: Array<{ message?: { content?: string } }> }
    const content = data.choices?.[0]?.message?.content
    if (typeof content === 'string' && content.trim() !== '') {
      return { ok: true, latencyMs: Date.now() - t0, sample: content.trim().slice(0, 60) }
    }
    return { ok: false, error: 'پاسخ خالی از جمنای', latencyMs: Date.now() - t0 }
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
  geminiKeyConfigured: boolean
  geminiModel: string
  chatModel: string
  imageModel: string
  userKeyHealthy: boolean | null // null = not probed yet
  geminiHealthy: boolean | null // null = not probed yet
  lastUserKeyError?: string
  lastGeminiError?: string
} {
  return {
    userKeyConfigured: userApiKey() !== '',
    geminiKeyConfigured: geminiEnvKey() !== '',
    geminiModel: geminiModel(),
    chatModel: chatModel(),
    imageModel: geminiImageModel(),
    userKeyHealthy: health.usable,
    geminiHealthy: geminiHealth.usable,
    lastUserKeyError: health.lastError,
    lastGeminiError: geminiHealth.lastError,
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
  via: 'gemini' | 'user-key' | 'platform' | 'free'
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
 * Chat completion — four-tier chain: Gemini (owner-requested default) →
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

  // ── Tier A: Google Gemini (env or panel-pasted key) ──
  const geminiKey = await resolveGeminiKey()
  if (geminiKey && !geminiBlocked()) {
    try {
      const data = (await geminiChatFetch(
        messages,
        geminiModel(),
        // thinking models burn hidden reasoning tokens from the same budget —
        // give the leg extra headroom so visible content never starves
        Math.max(maxTokens, 1600),
        { timeoutMs, retries: 3 },
      )) as { choices?: Array<{ message?: { content?: string } }> }
      const content = data.choices?.[0]?.message?.content
      if (typeof content === 'string' && content.trim() !== '') {
        return { content, via: 'gemini' }
      }
      throw new Error('پاسخ خالی از جمنای')
    } catch (e) {
      if (e instanceof AuthError) {
        geminiMarkAuthFailure(e.message)
      } else if (!(e instanceof RateError)) {
        console.warn('[ai:provider] Gemini chat failed → next tier:', (e as Error).message?.slice(0, 160))
      } else {
        console.warn('[ai:provider] Gemini rate-limited → next tier')
      }
    }
  } else if (geminiKey && geminiBlocked()) {
    console.warn(`[ai:provider] Gemini key on auth cooldown (${geminiHealth.lastError?.slice(0, 80)}) → next tier`)
  }

  // ── Tier B: seller's own key (env or panel-pasted) ──
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

// ─── Gemini image pipeline (native REST API — the seller's OWN key ONLY) ─────
//
// Master directive: EVERYTHING image-related (studio cutout, background
// composition, custom backgrounds) runs on Google Gemini directly and NEVER
// falls back to another image provider. Gemini's native generateContent API
// supports both text→image and image editing ("nano banana" models) with the
// same key used for chat.
//
// Quota reality: the free tier allows only a handful of image renders per
// project per day (resets ~08:00 UK / midnight US Pacific). The panel therefore
// accepts MULTIPLE keys (comma-separated) and this layer rotates them
// automatically: when one key's daily image quota is exhausted the next key is
// tried, so pasting 2–3 keys multiplies the daily renders.

const GEMINI_NATIVE_BASE = 'https://generativelanguage.googleapis.com/v1beta'

/** Owner-overridable image model (fast, image+text native, free-tier friendly). */
export function geminiImageModel(): string {
  return (process.env.GEMINI_IMAGE_MODEL ?? 'gemini-2.5-flash-image').trim()
}

/** Tried in order when the configured model is not available for a key. */
const GEMINI_IMAGE_MODEL_FALLBACKS = [
  'gemini-2.5-flash-image',
  'gemini-3.1-flash-image',
  'gemini-nano-banana-2.1',
]

export type GeminiImageResult = { base64: string; mimeType: string; via: string }

type GeminiPart = { text?: string; inlineData?: { mimeType: string; data: string } }
type GeminiGenerateResponse = {
  candidates?: Array<{ content?: { parts?: GeminiPart[] }; finishReason?: string }>
  promptFeedback?: { blockReason?: string }
}

// Per-key image cooldown (survives HMR via globalThis). When a key hits its
// daily image quota or auth fails, it is parked until retryDelay / cooldown so
// the next request goes straight to a healthy key instead of burning seconds.
type ImageKeyState = { blockedUntil: number; reason: string }
const globalForImageKeys = globalThis as unknown as {
  __aiGeminiImageKeyState?: Map<string, ImageKeyState>
}
const imageKeyState: Map<string, ImageKeyState> =
  globalForImageKeys.__aiGeminiImageKeyState ??= new Map()

function keyFingerprint(key: string): string {
  return `${key.slice(0, 10)}…${key.slice(-4)}`
}

function parkImageKey(key: string, untilMs: number, reason: string) {
  imageKeyState.set(keyFingerprint(key), {
    blockedUntil: Date.now() + untilMs,
    reason: reason.slice(0, 300),
  })
}

function imageKeyPark(key: string): ImageKeyState | null {
  const st = imageKeyState.get(keyFingerprint(key)) ?? null
  return st && Date.now() < st.blockedUntil ? st : null
}

/** Extract "message" from a Google error JSON body (best-effort). */
function googleErrorMessage(body: string): string {
  try {
    const j = JSON.parse(body) as { error?: { message?: string } }
    return j.error?.message ?? body.slice(0, 300)
  } catch {
    return body.slice(0, 300)
  }
}

/** Parse Google's RetryInfo delay ("43773s") from a 429 error body. */
function parseRetryDelaySeconds(body: string): number | null {
  const m = body.match(/"retryDelay"\s*:\s*"(\d+)s"/)
  if (m) {
    const n = Number(m[1])
    if (Number.isFinite(n) && n > 0) return n
  }
  return null
}

/**
 * One generateContent call against a specific key + model.
 * Throws AuthError (bad key), RateError (quota), MarkerError (model/policy /
 * modality issues — retryable with a different model or modality set), or
 * plain Error for transient HTTP problems.
 */
class MarkerError extends Error {}

async function geminiImageRequestOnce(
  key: string,
  model: string,
  parts: GeminiPart[],
  timeoutMs: number,
  modalities: string[] = ['IMAGE'],
): Promise<{ base64: string; mimeType: string }> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(
      `${GEMINI_NATIVE_BASE}/models/${encodeURIComponent(model)}:generateContent`,
      {
        method: 'POST',
        headers: { 'x-goog-api-key': key, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts }],
          generationConfig: { responseModalities: modalities },
        }),
        signal: controller.signal,
      },
    )
    const text = await res.text()

    if (res.ok) {
      const data = JSON.parse(text) as GeminiGenerateResponse
      const cand = data.candidates?.[0]
      const out = cand?.content?.parts?.find((p) => p.inlineData?.data)
      if (out?.inlineData?.data) {
        return { base64: out.inlineData.data, mimeType: out.inlineData.mimeType || 'image/png' }
      }
      const block = data.promptFeedback?.blockReason ?? cand?.finishReason
      if (block && block !== 'STOP') {
        throw new MarkerError(`BLOCKED:${block}`)
      }
      throw new MarkerError('NO_IMAGE')
    }

    const msg = googleErrorMessage(text)
    if (res.status === 429) throw new RateError(text)
    if (res.status === 401 || res.status === 403) throw new AuthError(msg)
    if (res.status === 400) {
      // Malformed/invalid keys surface as 400 INVALID_ARGUMENT — treat as auth.
      if (/api[_ ]?key/i.test(msg)) throw new AuthError(msg)
      throw new MarkerError(`BAD_REQUEST:${msg}`)
    }
    if (res.status === 404) throw new MarkerError(`MODEL_404:${model}`)
    throw new Error(`HTTP ${res.status}: ${msg}`)
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Shared runner: rotates ALL configured Gemini keys (env + panel) and, per
 * key, the configured model plus known-good fallbacks. NO non-Gemini image
 * provider is ever contacted — the studio is Gemini-only by design.
 */
async function runGeminiImage(
  parts: GeminiPart[],
  timeoutMs: number,
): Promise<GeminiImageResult> {
  const keys = await resolveGeminiImageKeys()
  if (keys.length === 0) {
    throw new AiError(
      'کلید جمنای تنظیم نشده است — از پنل، بخش تنظیمات، کلید گوگل جمنای را وارد کنید',
    )
  }

  const primary = geminiImageModel()
  const models = [primary, ...GEMINI_IMAGE_MODEL_FALLBACKS.filter((m) => m !== primary)]

  let sawQuota = false
  let sawAuth = false
  let sawBlock = ''
  let lastDetail = ''
  /** Earliest moment any parked key is expected to become usable again. */
  let quotaResetAt = 0

  for (const key of keys) {
    const parked = imageKeyPark(key)
    if (parked) {
      sawQuota = true // parked keys are parked for quota or auth
      lastDetail = parked.reason
      continue
    }
    for (const model of models) {
      try {
        const r = await geminiImageRequestOnce(key, model, parts, timeoutMs)
        imageKeyState.delete(keyFingerprint(key))
        console.log(`[ai:provider] gemini image OK via ${model}`)
        return { base64: r.base64, mimeType: r.mimeType, via: `gemini:${model}` }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        lastDetail = msg.slice(0, 300)

        if (e instanceof RateError) {
          // Daily/minute quota exhausted for this key's project — park it and
          // rotate to the next key. Google tells us the exact reset delay.
          const secs = parseRetryDelaySeconds(msg) ?? 300
          const wait = Math.min(Math.max(secs, 60), 26 * 3600) * 1000
          parkImageKey(key, wait, msg)
          sawQuota = true
          const resetHere = Date.now() + wait
          quotaResetAt = quotaResetAt === 0 ? resetHere : Math.min(quotaResetAt, resetHere)
          console.warn(
            `[ai:provider] gemini image quota exhausted on ${keyFingerprint(key)} — parked ${(wait / 3600000).toFixed(1)}h, trying next key`,
          )
          break
        }
        if (e instanceof AuthError) {
          parkImageKey(key, AUTH_COOLDOWN_MS, msg)
          sawAuth = true
          console.warn(
            `[ai:provider] gemini key rejected for images (${keyFingerprint(key)}) — parked 10 min`,
          )
          break
        }
        if (msg.startsWith('BLOCKED:')) {
          sawBlock = msg.slice('BLOCKED:'.length, 60)
          break // safety-blocked → other models won't help
        }
        if (msg.startsWith('MODEL_404:') || msg.startsWith('BAD_REQUEST:')) {
          if (msg.startsWith('BAD_REQUEST:') && /modalit/i.test(msg)) {
            // Model rejects IMAGE-only modality — retry once with TEXT+IMAGE.
            try {
              const r = await geminiImageRequestOnce(key, model, parts, timeoutMs, ['TEXT', 'IMAGE'])
              return { base64: r.base64, mimeType: r.mimeType, via: `gemini:${model}` }
            } catch (e2) {
              const msg2 = e2 instanceof Error ? e2.message : String(e2)
              lastDetail = msg2.slice(0, 300)
              if (e2 instanceof RateError) {
                const secs = parseRetryDelaySeconds(msg2) ?? 300
                const wait = Math.min(Math.max(secs, 60), 26 * 3600) * 1000
                parkImageKey(key, wait, msg2)
                sawQuota = true
                const resetHere = Date.now() + wait
                quotaResetAt = quotaResetAt === 0 ? resetHere : Math.min(quotaResetAt, resetHere)
                break
              }
              continue // next model
            }
          }
          continue // next model
        }
        // Transient HTTP / network error → next model, then next key.
        continue
      }
    }
  }

  if (sawQuota) {
    // Tell the seller EXACTLY when the quota resets (Google's own retry delay),
    // formatted in Iran local time — not a vague "tomorrow morning".
    let when = ''
    try {
      if (quotaResetAt > Date.now()) {
        when = new Intl.DateTimeFormat('fa-IR', {
          timeZone: 'Asia/Tehran',
          hour: '2-digit',
          minute: '2-digit',
        }).format(new Date(quotaResetAt))
      }
    } catch {
      when = ''
    }
    const resetLine = when
      ? `حدود ساعت ${when} به وقت ایران دوباره امتحان کنید`
      : 'کمی بعد دوباره امتحان کنید (سهمیهٔ روزانه شبانه بازنشانی می‌شود)'
    throw new AiError(
      `سهمیهٔ رایگان تصویر جمنای برای امروز تمام شده است — ${resetLine}، یا کلید جمنای دیگری در تنظیمات اضافه کنید (چند کلید را با کاما جدا کنید تا سهمیه‌ها جمع شوند)`,
    )
  }
  if (sawAuth) {
    throw new AiError('کلید جمنای برای تصویر پذیرفته نشد — کلید را در تنظیمات پنل بررسی کنید')
  }
  if (sawBlock) {
    throw new AiError(
      'جمنای این درخواست را به دلایل سیاست محتوا رد کرد — تصویر یا توضیح را کمی تغییر دهید و دوباره امتحان کنید',
    )
  }
  if (lastDetail.includes('aborted') || lastDetail.includes('timeout')) {
    throw new AiError('پردازش تصویر بیش از حد طول کشید — لطفاً دوباره تلاش کنید')
  }
  throw new AiError('تولید تصویر ناموفق بود — لطفاً کمی بعد دوباره تلاش کنید')
}

/** Text → image on the seller's own Gemini. */
export async function geminiImageGenerate(
  prompt: string,
  timeoutMs = 150_000,
): Promise<GeminiImageResult> {
  return runGeminiImage([{ text: prompt }], timeoutMs)
}

/**
 * Image editing (studio cutout / background composition) on the seller's own
 * Gemini. `dataUrls` holds 1–3 data URLs: the first is always the PRODUCT
 * photo; optional extra images (custom background reference) follow.
 */
export async function geminiImageEdit(
  prompt: string,
  dataUrls: string[],
  timeoutMs = 150_000,
): Promise<GeminiImageResult> {
  const parts: GeminiPart[] = [{ text: prompt }]
  for (const dataUrl of dataUrls.slice(0, 3)) {
    const m = dataUrl.match(/^data:([^;]+);base64,([\s\S]+)$/)
    if (!m) throw new AiError('قالب تصویر ورودی معتبر نیست')
    parts.push({ inlineData: { mimeType: m[1], data: m[2] } })
  }
  return runGeminiImage(parts, timeoutMs)
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
