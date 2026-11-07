import 'server-only'

import ZAI from 'z-ai-web-dev-sdk'

/**
 * Dual-provider AI layer.
 *
 *  Provider A (primary) — the seller's OWN Z.ai API key (`ZAI_API_KEY` in .env)
 *    called on the public OpenAI-compatible endpoint (api.z.ai/api/paas/v4).
 *    This is the key the shop owner pays for; per the Master prompt the bot AI
 *    and the Image Studio MUST run on it.
 *
 *  Provider B (fallback) — the platform-managed z-ai-web-dev-sdk gateway.
 *    Keeps the panel fully functional when the seller's key is missing,
 *    misconfigured or rate-limited.
 *
 * Provider health: an auth failure (401/“身份验证失败”) on provider A is cached
 * for a cooldown window so every request doesn't pay the extra latency; the key
 * is probed again automatically after the cooldown. 429 responses are retried
 * with real backoff (Retry-After aware) on BOTH providers.
 */

// ─── Configuration ───────────────────────────────────────────────────────────

const PUBLIC_API_BASE = 'https://api.z.ai/api/paas/v4'

export function userApiKey(): string {
  return (process.env.ZAI_API_KEY ?? '').trim()
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
  via: 'user-key' | 'platform'
}

/**
 * Chat completion: the seller's key first, the platform gateway as fallback.
 * Both legs get 429-aware retries; failures surface as Persian AiError.
 */
export async function chatComplete(
  messages: ChatMsg[],
  opts: { maxTokens?: number; timeoutMs?: number } = {},
): Promise<ChatResult> {
  const maxTokens = opts.maxTokens ?? 900
  const timeoutMs = opts.timeoutMs ?? 60_000

  // ── Provider A: seller's own key ──
  if (!userKeyBlocked()) {
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
        console.warn('[ai:provider] user-key chat failed → platform gateway:', (e as Error).message?.slice(0, 160))
      } else {
        console.warn('[ai:provider] user-key chat rate-limited → platform gateway')
      }
    }
  }

  // ── Provider B: platform gateway (z-ai-web-dev-sdk) ──
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
  if (typeof content !== 'string' || content.trim() === '') {
    throw new AiError('پاسخ خالی از مدل زبانی')
  }
  return { content, via: 'platform' }
}

export type ImageResult = { base64: string; via: 'user-key' | 'platform' }

/** Text → image. Seller key (cogview-4) first, platform gateway fallback. */
export async function generateImage(
  prompt: string,
  size = '1024x1024',
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
  size = '1024x1024',
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
