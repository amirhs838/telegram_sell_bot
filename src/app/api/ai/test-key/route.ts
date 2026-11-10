// Admin-only AI connectivity probe: runs a tiny chat completion through the
// three-tier provider chain and reports which tier served it + latency.
// Used by the panel's «تست اتصال هوش مصنوعی» button so the owner can confirm
// their Z.ai key (or the fallbacks) actually works — no more silent AI death.
import { ok, requireAuth, route } from '@/lib/api'
import { chatComplete } from '@/lib/ai/provider'

export const POST = route(async () => {
  await requireAuth()
  const t0 = Date.now()
  try {
    const { content, via } = await chatComplete(
      [
        { role: 'assistant', content: 'فقط یک واژه فارسی برگردان.' },
        { role: 'user', content: 'سلام' },
      ],
      { maxTokens: 30, timeoutMs: 30_000 },
    )
    return ok({
      ok: true,
      via,
      latencyMs: Date.now() - t0,
      sample: content.trim().slice(0, 60),
    })
  } catch (e) {
    return ok({
      ok: false,
      latencyMs: Date.now() - t0,
      error: (e as Error).message.slice(0, 300),
    })
  }
})
