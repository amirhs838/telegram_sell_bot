// AI client layer — dual-provider (seller's Z.ai key + platform gateway),
// with JSON-mode helpers. Backend only!
import type ZAI from 'z-ai-web-dev-sdk'
import type { ZodType } from 'zod'
import { AiError, chatComplete, getSdk, type ChatMsg } from '@/lib/ai/provider'

export type { ChatMsg }
export { AiError }

type ChatMessage = { role: 'assistant' | 'user'; content: string }

/**
 * Platform-gateway SDK singleton (survives HMR via globalThis).
 * Kept for SDK-only features (e.g. embeddings); chat/image go through
 * the dual-provider layer in '@/lib/ai/provider'.
 */
export function getZai(): Promise<ZAI> {
  return getSdk()
}

async function complete(messages: ChatMessage[]): Promise<string> {
  const { content } = await chatComplete(messages, { maxTokens: 900 })
  return content
}

function errMessage(e: unknown): string {
  if (e instanceof Error) return e.message
  return String(e)
}

/**
 * Extract a JSON object from a model response:
 * strips markdown fences, then takes the substring from the first `{` to the last `}`.
 */
function extractJson(raw: string): unknown {
  let text = raw.trim()
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i)
  if (fence && fence[1].includes('{')) text = fence[1].trim()
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start === -1 || end === -1 || end <= start) {
    throw new Error('پاسخ مدل شامل شیء JSON نبود')
  }
  return JSON.parse(text.slice(start, end + 1))
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Multi-turn JSON chat: validates the model response against `schema`.
 * On invalid JSON/schema the whole message list is retried up to `attempts` times.
 */
export async function chatJSONMessages<T>(
  messages: ChatMessage[],
  schema: ZodType<T>,
  attempts = 3,
): Promise<T> {
  let lastErr: unknown = undefined
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const content = await complete(messages)
      const parsed = schema.parse(extractJson(content))
      return parsed
    } catch (e) {
      lastErr = e
      if (attempt < attempts) await sleep(300 * attempt)
    }
  }
  console.error('[ai:chatJSON] attempts exhausted', lastErr)
  throw new AiError('سرویس هوش مصنوعی پاسخ معتبر برنگرداند')
}

/**
 * Single-turn JSON chat with self-correcting retries:
 * on failure the user message gets a Persian "previous answer was invalid" note appended.
 */
export async function chatJSON<T>(
  system: string,
  user: string,
  schema: ZodType<T>,
  attempts = 3,
): Promise<T> {
  let lastErr: unknown = undefined
  let currentUser = user
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const content = await complete([
        { role: 'assistant', content: system },
        { role: 'user', content: currentUser },
      ])
      const parsed = schema.parse(extractJson(content))
      return parsed
    } catch (e) {
      lastErr = e
      if (attempt < attempts) {
        currentUser = `${user}\n\nپاسخ قبلی نامعتبر بود: ${errMessage(e)}. فقط JSON معتبر برگردان.`
        await sleep(300 * attempt)
      }
    }
  }
  console.error('[ai:chatJSON] attempts exhausted', lastErr)
  throw new AiError('سرویس هوش مصنوعی پاسخ معتبر برنگرداند')
}

/** Plain text chat completion. */
export async function chatText(system: string, user: string): Promise<string> {
  try {
    return await complete([
      { role: 'assistant', content: system },
      { role: 'user', content: user },
    ])
  } catch (e) {
    if (e instanceof AiError) throw e
    console.error('[ai:chatText] failed', e)
    throw new AiError('سرویس هوش مصنوعی پاسخ معتبر برنگرداند')
  }
}
