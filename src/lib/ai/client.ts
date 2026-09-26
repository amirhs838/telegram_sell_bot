// AI client layer — z-ai-web-dev-sdk (backend only!) with JSON-mode helpers.
import ZAI from 'z-ai-web-dev-sdk'
import type { ZodType } from 'zod'

type ChatMessage = { role: 'assistant' | 'user'; content: string }

export class AiError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AiError'
  }
}

// Cached ZAI.create() singleton (survives HMR via globalThis).
const globalForAi = globalThis as unknown as { __zaiPromise?: Promise<ZAI> }

export function getZai(): Promise<ZAI> {
  if (!globalForAi.__zaiPromise) {
    globalForAi.__zaiPromise = ZAI.create().catch((e) => {
      // allow a retry on next call instead of caching the rejection forever
      globalForAi.__zaiPromise = undefined
      throw e
    })
  }
  return globalForAi.__zaiPromise
}

async function complete(messages: ChatMessage[]): Promise<string> {
  const zai = await getZai()
  const completion = await zai.chat.completions.create({
    messages,
    thinking: { type: 'disabled' },
    max_tokens: 900,
  })
  const content = completion.choices[0]?.message?.content
  if (typeof content !== 'string' || content.trim() === '') {
    throw new Error('پاسخ خالی از مدل زبانی')
  }
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
