import 'server-only'

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { logEvent } from '@/lib/logger'
import { AiError, getZai } from '@/lib/ai/client'

/**
 * AI Image Studio — turns a raw product photo into a professional studio shot.
 *
 * Pipeline (each AI call happens ONLY on an explicit seller click, never
 * automatically on upload — cost control):
 *   1. removeBackground()  → subject isolated from its original background
 *   2. composeStudioImage() → subject placed on a preset studio background
 *                             with jewelry-photography lighting
 *
 * ABSOLUTE RULE (Master prompt §3): the AI must NEVER redesign the product.
 * Every prompt includes hard preservation constraints, and the result is only
 * attached to the product after the seller previews and explicitly approves it.
 */

// ─── Background template library ─────────────────────────────────────────────

export type BackgroundTemplate = {
  key: string
  name: string
  description: string
  /** tailwind classes that render the preview swatch in the panel */
  previewClass: string
  /** English prompt fragment describing the background + lighting */
  prompt: string
}

export const BACKGROUND_LIBRARY: BackgroundTemplate[] = [
  {
    key: 'luxury_white_studio',
    name: 'استودیوی سفید لوکس',
    description: 'پس‌زمینه سفید با نور استودیویی و سایه نرم — مناسب کاتالوگ',
    previewClass:
      'bg-gradient-to-br from-white via-stone-50 to-stone-200 ring-1 ring-stone-200',
    prompt:
      'a luxury pure white studio background, seamless white sweep, soft even softbox lighting, gentle natural soft shadow directly under the product, minimal clean e-commerce catalog look',
  },
  {
    key: 'black_luxury',
    name: 'مشکی لوکس',
    description: 'پس‌زمینه مشکی عمیق با نور متمرکز — محصولات خاص',
    previewClass:
      'bg-gradient-to-br from-zinc-900 via-black to-zinc-800 ring-1 ring-zinc-700',
    prompt:
      'a deep black luxury background, focused spotlight on the product, controlled elegant reflections, high-end premium jewelry advertising look, rich contrast without glare',
  },
  {
    key: 'marble_luxury',
    name: 'مرمر لوکس',
    description: 'سطح مرمری روشن با بافت ظریف طبیعی',
    previewClass:
      'bg-gradient-to-br from-stone-100 via-stone-50 to-stone-300 ring-1 ring-stone-200',
    prompt:
      'a bright natural marble surface with delicate veining as the background, soft daylight studio lighting, gentle soft shadow, elegant jewelry photography',
  },
  {
    key: 'beige_velvet',
    name: 'مخمل بژ',
    description: 'مخمل کرم با نور گرم و ملایم — مناسب هدیه',
    previewClass:
      'bg-gradient-to-br from-amber-50 via-orange-100 to-amber-200 ring-1 ring-amber-200',
    prompt:
      'a soft cream beige velvet fabric background, warm gentle diffused lighting, cozy gift-presenting mood, subtle velvet texture, soft shadow',
  },
  {
    key: 'silver_reflection',
    name: 'بازتاب نقره‌ای',
    description: 'سطح تیره با بازتاب کنترل‌شده — نمایش درخشش فلز',
    previewClass:
      'bg-gradient-to-br from-slate-600 via-slate-500 to-slate-700 ring-1 ring-slate-400',
    prompt:
      'a dark grey reflective glossy surface with controlled silver reflections beneath the product, professional jewelry lighting that highlights the natural shine of the metal without exaggeration',
  },
  {
    key: 'premium_dark_studio',
    name: 'استودیوی تیره پریمیوم',
    description: 'خاکستری تیره با نور سینمایی و نور لبه‌ای',
    previewClass:
      'bg-gradient-to-br from-zinc-700 via-zinc-800 to-zinc-900 ring-1 ring-zinc-600',
    prompt:
      'a premium dark grey studio background with cinematic rim lighting outlining the edges of the product, professional advertising photography, dramatic but tasteful',
  },
  {
    key: 'soft_pink_studio',
    name: 'صورتی ملایم',
    description: 'پس‌زمینه صورتی ظریف با نور نرم — هدیه و زیورآلات زنانه',
    previewClass:
      'bg-gradient-to-br from-rose-50 via-pink-100 to-rose-200 ring-1 ring-rose-200',
    prompt:
      'a soft pastel pink studio background with delicate minimal design, gentle flattering soft light, feminine gift mood, subtle gradient',
  },
  {
    key: 'royal_luxury',
    name: 'رویال لوکس',
    description: 'سرمه‌ای عمیق با نورپردازی لوکس — تصاویر خاص',
    previewClass:
      'bg-gradient-to-br from-indigo-950 via-slate-900 to-indigo-900 ring-1 ring-indigo-800',
    prompt:
      'a deep royal navy blue background with luxurious fine lighting and very subtle elegant details, prestigious jewelry campaign look',
  },
]

export function getBackground(key: string): BackgroundTemplate | null {
  return BACKGROUND_LIBRARY.find((b) => b.key === key) ?? null
}

// ─── File helpers (upload dir — same storage as /api/uploads) ────────────────

const UPLOAD_DIR = path.join(process.cwd(), 'upload')
const SAFE_NAME_RE = /^[a-zA-Z0-9._-]+$/
const STUDIO_SIZE = '1024x1024' as const
const AI_TIMEOUT_MS = 150_000
const RETRY_ATTEMPTS = 2

async function readUploadBuffer(url: string): Promise<Buffer> {
  const name = url.replace(/^\/api\/uploads\//, '').trim()
  if (!name || name.includes('/') || name.includes('..') || !SAFE_NAME_RE.test(name)) {
    throw new AiError('آدرس تصویر ورودی معتبر نیست')
  }
  try {
    return await readFile(path.join(UPLOAD_DIR, name))
  } catch {
    throw new AiError('فایل تصویر ورودی پیدا نشد — لطفاً دوباره آپلود کنید')
  }
}

async function saveStudioImage(buffer: Buffer, kind: 'subject' | 'final'): Promise<string> {
  await mkdir(UPLOAD_DIR, { recursive: true })
  const name = `studio-${kind}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.png`
  await writeFile(path.join(UPLOAD_DIR, name), buffer)
  return `/api/uploads/${name}`
}

/** Downscale/normalize the AI output so it is ready for panel + Telegram use. */
async function normalizeOutput(raw: Buffer): Promise<Buffer> {
  try {
    const sharpModule = await import('sharp')
    const sharp = sharpModule.default
    return await sharp(raw)
      .resize(1024, 1024, { fit: 'inside', withoutEnlargement: true })
      .png({ compressionLevel: 8 })
      .toBuffer()
  } catch {
    return raw // sharp unavailable → keep the original bytes
  }
}

// ─── Prompt engineering ──────────────────────────────────────────────────────

const PRESERVE_RULES = `CRITICAL PRESERVATION RULES (highest priority):
- This is a REAL silver product for sale. Do NOT redesign, reshape, recolor or restyle it.
- Keep the product EXACTLY as in the source photo: same shape, same angle, same stones, same chain links, same clasp, same engravings, same proportions, same silver color and finish.
- Do NOT add any detail that is not in the source photo. Do NOT remove any real detail. Do NOT create a similar-but-different product.`

const REMOVE_BG_PROMPT = `Isolate the silver jewelry product from its background with pixel-perfect precision.
Preserve the delicate metal edges, thin chains, decorative stones, clasps and engravings exactly as they are.
Remove the old background, stray shadows and any distracting elements around the product.
Output: only the product, centered, on a pure uniform plain white background (#FFFFFF), professional jewelry photo, razor-sharp.
${PRESERVE_RULES}`

function composePrompt(bg: BackgroundTemplate): string {
  return `Place this exact silver product, unchanged, onto ${bg.prompt}.
The product stays fully sharp and identical to the source — only the background and lighting change.
Professional jewelry studio photography: softbox lighting, soft natural shadow under the product, controlled subtle reflections, premium commercial look.
No exaggerated glow, no artificial sparkles, no extra decorative props around the product.
${PRESERVE_RULES}`
}

// ─── AI calls ────────────────────────────────────────────────────────────────

type EditResult = { base64?: string; data?: Array<{ base64?: string }> }

async function callImageEdit(prompt: string, dataUrl: string): Promise<Buffer> {
  const zai = await getZai()
  let lastError: unknown = null

  for (let attempt = 1; attempt <= RETRY_ATTEMPTS; attempt++) {
    try {
      // `image` is the typed field; `images[]` is kept for forward-compat with
      // the documented array form — cast through Record to satisfy both.
      const body: Record<string, unknown> = {
        prompt,
        image: dataUrl,
        images: [{ url: dataUrl }],
        size: STUDIO_SIZE,
        ...(process.env.AI_IMAGE_MODEL ? { model: process.env.AI_IMAGE_MODEL } : {}),
      }
      const res = (await Promise.race([
        zai.images.generations.edit(
          body as unknown as Parameters<typeof zai.images.generations.edit>[0],
        ) as Promise<EditResult>,
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('timeout')), AI_TIMEOUT_MS),
        ),
      ])) as EditResult

      const base64 =
        typeof res?.base64 === 'string' ? res.base64 : typeof res?.data?.[0]?.base64 === 'string' ? res.data[0].base64 : undefined
      if (typeof base64 !== 'string' || base64.length < 100) {
        throw new Error('پاسخ خالی از سرویس تصویر')
      }
      const raw = Buffer.from(base64, 'base64')
      return await normalizeOutput(raw)
    } catch (e) {
      lastError = e
      const msg = e instanceof Error ? e.message : String(e)
      await logEvent(
        'studio.ai_error',
        `خطای سرویس تصویر (تلاش ${attempt}): ${msg.slice(0, 200)}`,
        { attempt, prompt: prompt.slice(0, 80) },
        'warn',
      )
      if (attempt < RETRY_ATTEMPTS) {
        await new Promise((r) => setTimeout(r, 1200 * attempt))
      }
    }
  }

  const detail = lastError instanceof Error ? lastError.message : String(lastError)
  if (detail.includes('timeout')) {
    throw new AiError('پردازش تصویر بیش از حد طول کشید — لطفاً دوباره تلاش کنید')
  }
  if (detail.includes('429') || detail.toLowerCase().includes('too many')) {
    throw new AiError('سرویس تصویر شلوغ است — چند لحظه بعد دوباره تلاش کنید')
  }
  throw new AiError('تولید تصویر ناموفق بود — لطفاً کمی بعد دوباره تلاش کنید')
}

// ─── Public API ──────────────────────────────────────────────────────────────

/** Step 1: isolate the product from its original background. */
export async function removeBackground(imageUrl: string): Promise<string> {
  const buf = await readUploadBuffer(imageUrl)
  const mime = 'image/png'
  const dataUrl = `data:${mime};base64,${buf.toString('base64')}`
  const out = await callImageEdit(REMOVE_BG_PROMPT, dataUrl)
  const url = await saveStudioImage(out, 'subject')
  await logEvent('studio.subject', 'سوژه محصول از پس‌زمینه جدا شد', { imageUrl, url })
  return url
}

/** Step 2: place the (isolated) subject on a preset studio background. */
export async function composeStudioImage(
  sourceUrl: string,
  backgroundKey: string,
): Promise<string> {
  const bg = getBackground(backgroundKey)
  if (!bg) throw new AiError('پس‌زمینه انتخاب‌شده معتبر نیست')
  const buf = await readUploadBuffer(sourceUrl)
  const dataUrl = `data:image/png;base64,${buf.toString('base64')}`
  const out = await callImageEdit(composePrompt(bg), dataUrl)
  const url = await saveStudioImage(out, 'final')
  await logEvent('studio.composed', `تصویر استودیویی با پس‌زمینه «${bg.name}» ساخته شد`, {
    sourceUrl,
    backgroundKey,
    url,
  })
  return url
}
