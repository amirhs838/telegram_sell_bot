// Admin-only AI connectivity probe. Two checks in one call:
//  1. OpenRouter probe (Tier A, owner-requested primary) — targeted, NEVER
//     falls back, so a broken key/model is reported as broken instead of
//     silently passing via a lower tier.
//  2. The full provider chain — reports which tier served the request overall
//     (openrouter → user-key → platform → free).
// Used by the panel's «تست اتصال» button — no more silent AI death.
import { ok, requireAuth, route } from '@/lib/api'
import { chatComplete, probeOpenRouter } from '@/lib/ai/provider'

export const POST = route(async () => {
  await requireAuth()
  const t0 = Date.now()

  // 1) targeted OpenRouter probe (always runs; reports "no key" when unset)
  const openrouter = await probeOpenRouter()

  // 2) the whole chain as the bot actually experiences it
  let chain: { ok: boolean; via?: string; latencyMs?: number; error?: string; sample?: string }
  try {
    const { content, via } = await chatComplete(
      [
        { role: 'assistant', content: 'فقط یک واژه فارسی برگردان.' },
        { role: 'user', content: 'سلام' },
      ],
      { maxTokens: 30, timeoutMs: 30_000 },
    )
    chain = { ok: true, via, latencyMs: Date.now() - t0, sample: content.trim().slice(0, 60) }
  } catch (e) {
    chain = { ok: false, latencyMs: Date.now() - t0, error: (e as Error).message.slice(0, 300) }
  }

  return ok({
    ok: chain.ok,
    via: chain.via,
    latencyMs: chain.latencyMs,
    error: chain.error,
    sample: chain.sample,
    openrouter,
  })
})
